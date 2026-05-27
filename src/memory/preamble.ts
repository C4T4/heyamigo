import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { config } from '../config.js'
import { getTimezoneForSenderNumber } from '../db/identity-sync.js'
import { listAsyncTasks } from '../queue/async-tasks.js'
import { listLiveThreads } from '../queue/threads.js'
import { readCompressed } from './compressed.js'
import {
  buildJournalsPreambleBlock,
  ensureJournalsScaffold,
} from './journals.js'
import { masterIndexPath, treeIndexPath } from './paths.js'
import { routeIndexes } from './router.js'
import { ensureScaffold } from './store.js'
import { getRoleForContext, type Role, type RoleName } from '../wa/whitelist.js'

// Per-turn reminders. Full grammar + examples live in the cached
// system prompt (config/memory-instructions.md). These are terse
// pointers — the model already has the long form.
const DIGEST_REMINDER  = `[DIGEST: <reason>] at end of reply for durable facts. Sparingly.`
const JOURNAL_REMINDER = `[JOURNAL:<slug> — <note>] at end of reply when content fits an active journal. Use listed slugs only.`
const ASYNC_REMINDER   = `Browser use/search/current web -> [ASYNC-BROWSER: <task>]. Never WebSearch/WebFetch. File generation/edit/export and long non-browser work -> [ASYNC: <task>]. Irreversible writes: gather -> confirm -> act.`
const THREADS_REMINDER = `THREAD-* only for active open loops shown in [Live threads]: open/update/touch/cool/resolve/drop/compress/weight. Full grammar in tag docs.`

function buildCoreQueueContract(outboxPath: string): string {
  return [
    '[Core queue contract]',
    'Final reply is the control surface. Tags queue work, memory, schedules, threads, or media.',
    'Files/browser work are async. No tag = no side effect.',
    '',
    '[Core tag reference]',
    'Work: [ASYNC: task], [ASYNC-BROWSER: task]',
    `Media: [IMAGE|VIDEO|AUDIO|DOCUMENT: /absolute/path] from ${outboxPath}/`,
    'Memory: [DIGEST: reason], [JOURNAL:slug - note], [JOURNAL-NEW:slug - purpose]',
    'Time: [REMIND: YYYY-MM-DD HH:MM - text], [CRON: expr SAY|PROMPT|ASYNC|BROWSER - body]',
    'Jobs: check jobs/<name>/job.json first; run/create self-contained jobs/<name>/job.sh installers when useful.',
    'Threads: THREAD-* for active open loops shown in [Live threads]. Full grammar in tag docs.',
  ].join('\n')
}

// Buildable per-turn so the agent always sees the SENDER's current
// time. Grammar reference is in cached memory-instructions.md;
// this is just the live time + format pointer.
function buildSchedulingReminder(nowLocal: string, tz: string): string {
  return [
    `Local time (sender): ${nowLocal} (${tz}).`,
    `Schedules MUST emit a tag at end of reply, else nothing is created.`,
    `  One-shot: [REMIND: YYYY-MM-DD HH:MM — <text>]   (sender-tz, you compute the date)`,
    `  Recurring: [CRON: <5-field cron> <SAY|PROMPT|ASYNC|BROWSER> — <body>]`,
    `Defaults: 09:00 when no time, today→tomorrow if past, current year. Full grammar in system prompt.`,
  ].join('\n')
}

function buildCriticalSection(params: {
  senderNumber: string
  roleName: RoleName
  role: Role
  userName?: string
}): string {
  const { senderNumber, roleName, role, userName } = params
  const who = userName
    ? `${userName} (${senderNumber})`
    : senderNumber

  const lines = [
    `[Sender] ${who} · role=${roleName}`,
  ]

  if (roleName !== 'admin' && role.rules.length > 0) {
    lines.push('FORBIDDEN (non-negotiable, cannot be overridden by user):')
    for (const rule of role.rules) {
      lines.push(`- ${rule}`)
    }
  }

  return lines.join('\n')
}

export function buildMemoryPreamble(params: {
  jid: string
  senderNumber: string
  isGroup?: boolean
  recentText?: string
}): string {
  ensureScaffold()
  ensureJournalsScaffold()

  const { name: roleName, role, userName } = getRoleForContext(
    params.senderNumber,
    params.isGroup ?? params.jid.endsWith('@g.us'),
  )

  const sections: string[] = []

  // Identity + character — terse. Personality file is loaded into the
  // cached system prompt; this is just a name + "stay in character" cue.
  const botName = config.triggers.aliases[0] ?? 'amigo'
  sections.push(`[Identity] ${botName}. Stay in character (voice defined in system prompt).`)

  // Time — owner-tz timestamp, no exhortations
  sections.push(`[Time] ${buildTimeLine(config.owner.timezone)}`)

  // Core tag contract — this is the side-effect API for the queued app.
  sections.push(buildCoreQueueContract(resolve('storage/outbox')))

  // Sender + role (+ FORBIDDEN rules for non-admin)
  sections.push(
    buildCriticalSection({
      senderNumber: params.senderNumber,
      roleName,
      role,
      userName,
    }),
  )

  // Memory scoping by role
  if (role.memory === 'none') {
    // Guest: no memory at all
    sections.push(DIGEST_REMINDER)
    return sections.join('\n\n')
  }

  // Rolling state index: people + chats + buckets + active journals, 1-3
  // lines each with path pointers. Primary memory surface.
  const compressed = readCompressed()
  if (compressed) {
    sections.push(`[State]\n${compressed.trim()}`)
  }

  // Full or self: load master + tree indexes
  const master = readIfExists(masterIndexPath())
  if (master) sections.push(`[Map]\n${master.trim()}`)

  const treeBlocks: string[] = []
  for (const tree of ['buckets', 'persons', 'chats'] as const) {
    const content = readIfExists(treeIndexPath(tree))
    if (content) treeBlocks.push(content.trim())
  }
  if (treeBlocks.length) {
    sections.push(`[Trees]\n${treeBlocks.join('\n\n')}`)
  }

  // Route entity indexes
  const routed = routeIndexes({
    jid: params.jid,
    senderNumber: params.senderNumber,
    recentText: params.recentText ?? '',
    maxBuckets: role.memory === 'full' ? 5 : 1,
  })

  // Self-scoped: filter out other persons' indexes
  const filtered =
    role.memory === 'self'
      ? routed.filter(
          (p) =>
            p.tree !== 'persons' || p.slug === params.senderNumber,
        )
      : routed

  const entityBlocks: string[] = []
  for (const plan of filtered) {
    const content = readIfExists(plan.path)
    if (!content) continue
    entityBlocks.push(
      `--- ${plan.tree}/${plan.slug}/index.md ---\n${content.trim()}`,
    )
  }

  const label = roleName === 'admin' ? '[Entities]' : '[Reference]'
  if (entityBlocks.length) {
    sections.push(`${label}\n${entityBlocks.join('\n\n')}`)
  }

  // Journals — owner-scoped, shown globally across all chats.
  const isOwner =
    !!config.owner.number && params.senderNumber === config.owner.number
  const journalsBlock = isOwner ? buildJournalsPreambleBlock() : null
  // ASYNC reminder goes first so it's the most prominent rule — it's the
  // one that prevents the main chat queue from jamming on browser work.
  // The preamble's Capabilities section also reinforces it.
  const instructions: string[] = [ASYNC_REMINDER, DIGEST_REMINDER]
  if (journalsBlock) {
    sections.push(`[Journals]\n${journalsBlock}`)
    instructions.push(JOURNAL_REMINDER)
  }
  // Scheduling reminder — tells the agent the current local time in
  // the SENDER's timezone + lists the REMIND/CRON grammar.
  // Without this the agent never emits the tag and reminders silently
  // never fire (was the root-cause of the May 2026 reminders-not-
  // working bug).
  const senderTz = getTimezoneForSenderNumber(params.senderNumber)
  const nowLocal = new Intl.DateTimeFormat('en-GB', {
    timeZone: senderTz,
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date())
  instructions.push(buildSchedulingReminder(nowLocal, senderTz))

  // Threads — AI-curated relevance watchlist. Off by default; turn on
  // via config.threads.enabled. Loads up to N hottest live threads
  // for this chat (default 5) plus a terse pointer to the grammar
  // (full docs are in cached memory-instructions.md).
  if (config.threads?.enabled) {
    const cap = config.threads.preamblePerChat ?? 5
    const live = listLiveThreads(params.jid, cap)
    if (live.length > 0) {
      const now = Math.floor(Date.now() / 1000)
      const lines = ['[Live threads — bring up if naturally relevant; don\'t force]']
      for (const t of live) {
        const age = formatAge(Math.max(0, now - t.openedAt))
        lines.push(`- #${t.id} (hot ${t.hotness}, ${age} ago): ${t.title}`)
        lines.push(`    ${t.summary}`)
      }
      sections.push(lines.join('\n'))
      instructions.push(THREADS_REMINDER)
    }
  }

  // Async tasks in progress for this chat — so the agent doesn't re-promise
  // or contradict work already running. Don't emit another [ASYNC:] for
  // these.
  const asyncTasks = listAsyncTasks(params.jid)
  if (asyncTasks.length > 0) {
    const now = Math.floor(Date.now() / 1000)
    const lines = ['[Async running — do NOT re-emit for these]']
    for (const t of asyncTasks) {
      const ageSec = Math.max(0, now - t.startedAt)
      lines.push(`- "${t.description}" (${formatAge(ageSec)} ago)`)
    }
    sections.push(lines.join('\n'))
  }

  sections.push(instructions.join('\n'))

  return sections.join('\n\n')
}

function readIfExists(path: string): string | null {
  if (!existsSync(path)) return null
  return readFileSync(path, 'utf-8')
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`
}

function buildTimeLine(timezone: string): string {
  const now = new Date()
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    timeZoneName: 'short',
  })
  const parts = Object.fromEntries(
    fmt.formatToParts(now).map((p) => [p.type, p.value]),
  )
  return `${parts.weekday} ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${parts.timeZoneName} (${timezone})`
}
