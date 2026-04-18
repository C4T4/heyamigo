import type { WAMessage, WASocket } from 'baileys'
import { clearSession, getSessionInfo } from '../ai/sessions.js'
import { reloadSystemPrompt } from '../ai/claude.js'
import { config } from '../config.js'
import {
  createJournal,
  getJournal,
  isValidSlug,
  listJournals,
  readEntries,
  snoozeJournal,
  updateJournalStatus,
  type JournalStatus,
} from '../memory/journals.js'
import { runDigestNow } from '../memory/scheduler.js'
import { sendText } from '../wa/sender.js'

export type CommandContext = {
  sock: WASocket
  jid: string
  text: string
  senderNumber: string
  quoted?: WAMessage
}

export async function tryCommand(ctx: CommandContext): Promise<boolean> {
  const prefix = config.commands.prefix
  const trimmed = ctx.text.trim()
  if (!trimmed.startsWith(prefix)) return false

  const cmd = trimmed.slice(prefix.length).split(/\s+/)[0]?.toLowerCase() ?? ''
  if (!cmd) return false

  if (config.commands.reset.includes(cmd)) {
    const existed = clearSession(ctx.jid)
    const reply = existed
      ? 'Session reset. Next message will bootstrap a fresh Claude session.'
      : 'No session to reset.'
    await sendText(ctx.sock, ctx.jid, reply, ctx.quoted)
    return true
  }

  if (config.commands.status.includes(cmd)) {
    const info = getSessionInfo(ctx.jid)
    if (!info) {
      await sendText(
        ctx.sock,
        ctx.jid,
        'No session yet. Next message will bootstrap one.',
        ctx.quoted,
      )
      return true
    }
    const lines = [`Session: ${info.sessionId.slice(0, 8)}…`]
    if (info.usage) {
      const max = config.claude.contextWindow
      const used = info.usage.totalContextTokens
      const leftPct = Math.max(0, 100 - (used / max) * 100).toFixed(1)
      lines.push(
        `Context: ${used.toLocaleString()} / ${max.toLocaleString()} (${leftPct}% left)`,
      )
      lines.push(`Turns: ${info.usage.numTurns}`)
    }
    await sendText(ctx.sock, ctx.jid, lines.join('\n'), ctx.quoted)
    return true
  }

  if (config.commands.reload.includes(cmd)) {
    reloadSystemPrompt()
    const existed = clearSession(ctx.jid)
    const reply = existed
      ? 'Personality reloaded and session reset.'
      : 'Personality reloaded.'
    await sendText(ctx.sock, ctx.jid, reply, ctx.quoted)
    return true
  }

  if (cmd === 'digest') {
    await sendText(
      ctx.sock,
      ctx.jid,
      'Digesting memory now, this may take a moment.',
      ctx.quoted,
    )
    runDigestNow({
      jid: ctx.jid,
      number: ctx.senderNumber || undefined,
      reason: 'manual /digest',
    }).catch(() => undefined)
    return true
  }

  if (cmd === 'journal' || cmd === 'journals') {
    if (!isOwner(ctx.senderNumber)) {
      await sendText(
        ctx.sock,
        ctx.jid,
        'Journals are owner-only.',
        ctx.quoted,
      )
      return true
    }
    const rest = trimmed.slice(prefix.length + cmd.length).trim()
    await handleJournalCmd(ctx, rest)
    return true
  }

  if (cmd === 'snooze') {
    if (!isOwner(ctx.senderNumber)) {
      await sendText(
        ctx.sock,
        ctx.jid,
        'Snooze is owner-only.',
        ctx.quoted,
      )
      return true
    }
    const rest = trimmed.slice(prefix.length + cmd.length).trim()
    await handleSnoozeCmd(ctx, rest)
    return true
  }

  return false
}

async function handleSnoozeCmd(
  ctx: CommandContext,
  rest: string,
): Promise<void> {
  const [slugRaw, durationRaw] = rest.split(/\s+/)
  const slug = (slugRaw ?? '').toLowerCase()
  const duration = (durationRaw ?? '24h').toLowerCase()
  if (!slug) {
    await sendText(
      ctx.sock,
      ctx.jid,
      'Usage: /snooze <slug> [duration]\nDuration: e.g. 6h, 2d (default 24h)',
      ctx.quoted,
    )
    return
  }
  if (!getJournal(slug)) {
    await sendText(ctx.sock, ctx.jid, `No journal "${slug}".`, ctx.quoted)
    return
  }
  const secs = parseDuration(duration)
  if (!secs) {
    await sendText(
      ctx.sock,
      ctx.jid,
      `Bad duration "${duration}". Use formats like 6h, 2d, 30m.`,
      ctx.quoted,
    )
    return
  }
  const until = Math.floor(Date.now() / 1000) + secs
  snoozeJournal(slug, until)
  await sendText(
    ctx.sock,
    ctx.jid,
    `Snoozed "${slug}" for ${duration}. No nudges until ${new Date(
      until * 1000,
    ).toISOString().slice(0, 16).replace('T', ' ')} UTC.`,
    ctx.quoted,
  )
}

function parseDuration(raw: string): number | null {
  const m = raw.match(/^(\d+)\s*([mhd])$/)
  if (!m) return null
  const n = Number(m[1])
  const u = m[2]
  if (!Number.isFinite(n) || n <= 0) return null
  if (u === 'm') return n * 60
  if (u === 'h') return n * 3600
  if (u === 'd') return n * 86400
  return null
}

function isOwner(senderNumber: string): boolean {
  return !!config.owner.number && senderNumber === config.owner.number
}

async function handleJournalCmd(
  ctx: CommandContext,
  rest: string,
): Promise<void> {
  const [subRaw, ...argParts] = rest.split(/\s+/)
  const sub = (subRaw ?? 'list').toLowerCase()
  const args = argParts.join(' ').trim()

  if (sub === 'list' || sub === '') {
    const journals = listJournals()
    if (journals.length === 0) {
      await sendText(
        ctx.sock,
        ctx.jid,
        'No journals yet. Create one with:\n/journal create <slug> <purpose>',
        ctx.quoted,
      )
      return
    }
    const lines = ['Journals:']
    for (const j of journals) {
      lines.push(`- ${j.slug} [${j.status}]: ${j.purpose || j.name}`)
    }
    await sendText(ctx.sock, ctx.jid, lines.join('\n'), ctx.quoted)
    return
  }

  if (sub === 'create' || sub === 'new') {
    const [slugRaw, ...purposeParts] = args.split(/\s+/)
    const slug = (slugRaw ?? '').toLowerCase()
    const purpose = purposeParts.join(' ').trim()
    if (!slug || !purpose) {
      await sendText(
        ctx.sock,
        ctx.jid,
        'Usage: /journal create <slug> <purpose>\nExample: /journal create health Track sleep, symptoms, meds, mood',
        ctx.quoted,
      )
      return
    }
    if (!isValidSlug(slug)) {
      await sendText(
        ctx.sock,
        ctx.jid,
        `Invalid slug "${slug}". Use lowercase letters, digits, hyphens. Max 48 chars.`,
        ctx.quoted,
      )
      return
    }
    if (getJournal(slug)) {
      await sendText(
        ctx.sock,
        ctx.jid,
        `Journal "${slug}" already exists.`,
        ctx.quoted,
      )
      return
    }
    try {
      const j = createJournal({
        slug,
        name: titleCase(slug),
        purpose,
      })
      await sendText(
        ctx.sock,
        ctx.jid,
        `Journal "${j.slug}" created and active. I'll start tagging relevant entries. Use /journal show ${j.slug} to inspect.`,
        ctx.quoted,
      )
    } catch (err) {
      await sendText(
        ctx.sock,
        ctx.jid,
        `Create failed: ${(err as Error).message}`,
        ctx.quoted,
      )
    }
    return
  }

  if (sub === 'show' || sub === 'info') {
    const slug = args.split(/\s+/)[0]?.toLowerCase() ?? ''
    const j = getJournal(slug)
    if (!j) {
      await sendText(
        ctx.sock,
        ctx.jid,
        `No journal "${slug}".`,
        ctx.quoted,
      )
      return
    }
    const lines = [
      `${j.name} (${j.slug}) [${j.status}]`,
      j.purpose,
    ]
    if (j.fields.length) lines.push(`Fields: ${j.fields.join(', ')}`)
    if (j.cadence.checkin) lines.push(`Check-in: ${j.cadence.checkin}`)
    if (j.cadence.followup_after)
      lines.push(`Follow-up after: ${j.cadence.followup_after}`)
    if (j.cadence.nudge_if_silent)
      lines.push(`Nudge if silent: ${j.cadence.nudge_if_silent}`)
    const entries = readEntries(j.slug, 5)
    if (entries.length) {
      lines.push('', 'Recent entries:')
      for (const e of entries) {
        const d = new Date(e.ts * 1000)
          .toISOString()
          .slice(0, 16)
          .replace('T', ' ')
        lines.push(`- [${d}] ${e.note}`)
      }
    } else {
      lines.push('', '(no entries yet)')
    }
    await sendText(ctx.sock, ctx.jid, lines.join('\n'), ctx.quoted)
    return
  }

  if (sub === 'entries') {
    const [slugRaw, nRaw] = args.split(/\s+/)
    const slug = (slugRaw ?? '').toLowerCase()
    const n = Math.max(1, Math.min(50, Number(nRaw) || 10))
    if (!getJournal(slug)) {
      await sendText(
        ctx.sock,
        ctx.jid,
        `No journal "${slug}".`,
        ctx.quoted,
      )
      return
    }
    const entries = readEntries(slug, n)
    if (!entries.length) {
      await sendText(
        ctx.sock,
        ctx.jid,
        `No entries in "${slug}" yet.`,
        ctx.quoted,
      )
      return
    }
    const lines = [`Last ${entries.length} entries in "${slug}":`]
    for (const e of entries) {
      const d = new Date(e.ts * 1000)
        .toISOString()
        .slice(0, 16)
        .replace('T', ' ')
      lines.push(`- [${d}] (${e.source}) ${e.note}`)
    }
    await sendText(ctx.sock, ctx.jid, lines.join('\n'), ctx.quoted)
    return
  }

  if (sub === 'pause' || sub === 'resume' || sub === 'archive' || sub === 'activate') {
    const slug = args.split(/\s+/)[0]?.toLowerCase() ?? ''
    if (!getJournal(slug)) {
      await sendText(
        ctx.sock,
        ctx.jid,
        `No journal "${slug}".`,
        ctx.quoted,
      )
      return
    }
    const status: JournalStatus =
      sub === 'pause'
        ? 'paused'
        : sub === 'archive'
          ? 'archived'
          : 'active'
    const updated = updateJournalStatus(slug, status)
    await sendText(
      ctx.sock,
      ctx.jid,
      `Journal "${slug}" is now ${updated?.status}.`,
      ctx.quoted,
    )
    return
  }

  await sendText(
    ctx.sock,
    ctx.jid,
    [
      'Journal commands:',
      '/journal list',
      '/journal create <slug> <purpose>',
      '/journal show <slug>',
      '/journal entries <slug> [n]',
      '/journal pause|resume|archive <slug>',
    ].join('\n'),
    ctx.quoted,
  )
}

function titleCase(slug: string): string {
  return slug
    .split('-')
    .map((p) => (p ? p[0]!.toUpperCase() + p.slice(1) : p))
    .join(' ')
}
