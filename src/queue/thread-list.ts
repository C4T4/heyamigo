// /threads chat command handler. Formats listings + handles
// subcommands: delete, pause, resume, resolve, drop, compress,
// touch, weight.
//
// Phone-readable plain text — same shape as schedule-list.ts.

import {
  compressThread,
  deleteThread,
  dropThread,
  getThread,
  listAllThreads,
  resolveThread,
  setThreadEnabled,
  touchThread,
  type ThreadRow,
} from './threads.js'
import {
  listCategoryWeights,
  setCategoryWeight,
} from './thread-weights.js'

export function handleThreadsCommand(jid: string, args: string[]): string {
  const sub = args[0]?.toLowerCase()

  if (!sub) {
    return formatList(listAllThreads(jid))
  }

  // Subcommand: weight <category> <0-100>
  if (sub === 'weight') {
    if (args.length === 1) return formatWeights(listCategoryWeights())
    const category = args[1]?.toLowerCase()
    const weight = parseInt(args[2] ?? '', 10)
    if (!category || !Number.isFinite(weight) || weight < 0 || weight > 100) {
      return 'Usage: /threads weight <category> <0-100>'
    }
    setCategoryWeight(category, weight)
    return `Category "${category}" weight set to ${weight}.`
  }

  // All remaining subcommands take an id as args[1] and optional note as
  // the rest joined.
  const id = parseInt(args[1] ?? '', 10)
  if (!Number.isFinite(id) || id <= 0) {
    return `Usage: /threads ${sub} <id> [note]`
  }
  const noteTokens = args.slice(2)
  const note = noteTokens.join(' ').trim()

  if (sub === 'delete') {
    return deleteThread(id) ? `Thread #${id} deleted.` : `Thread #${id} not found.`
  }
  if (sub === 'pause') {
    return setThreadEnabled(id, false)
      ? `Thread #${id} paused.`
      : `Thread #${id} not found.`
  }
  if (sub === 'resume') {
    return setThreadEnabled(id, true)
      ? `Thread #${id} resumed.`
      : `Thread #${id} not found.`
  }
  if (sub === 'resolve') {
    const row = resolveThread(id, note || 'manual')
    return row
      ? `Thread #${id} resolved: ${row.resolutionNote}`
      : `Thread #${id} not found.`
  }
  if (sub === 'drop') {
    const row = dropThread(id, note || 'manual')
    return row
      ? `Thread #${id} dropped: ${row.resolutionNote}`
      : `Thread #${id} not found.`
  }
  if (sub === 'compress') {
    const row = compressThread(id, note || 'manual')
    return row
      ? `Thread #${id} compressed: ${row.resolutionNote}`
      : `Thread #${id} not found.`
  }
  if (sub === 'touch') {
    const row = touchThread(id)
    return row
      ? `Thread #${id} touched (hotness now ${row.hotness}).`
      : `Thread #${id} not found.`
  }
  if (sub === 'show') {
    const row = getThread(id)
    return row ? formatOne(row) : `Thread #${id} not found.`
  }

  return [
    'Usage:',
    '  /threads                          list all threads in this chat',
    '  /threads show <id>                show one thread in detail',
    '  /threads resolve <id> <note>      mark resolved (answer found)',
    '  /threads drop <id> <reason>       mark dropped (stale)',
    '  /threads compress <id> <note>     mark moved into cold memory',
    '  /threads touch <id>               bump hotness manually',
    '  /threads pause <id>               disable (hide from preamble)',
    '  /threads resume <id>              re-enable',
    '  /threads delete <id>              permanent delete',
    '  /threads weight                   list category weights',
    '  /threads weight <category> <0-100>  override category weight',
  ].join('\n')
}

function formatList(rows: ThreadRow[]): string {
  if (rows.length === 0) return 'No threads in this chat yet.'
  const live = rows.filter((r) => r.status === 'live')
  const closed = rows.filter((r) => r.status !== 'live')
  const lines: string[] = []
  if (live.length > 0) {
    lines.push('*Live threads*')
    for (const r of live) lines.push(formatRow(r))
  }
  if (closed.length > 0) {
    lines.push('')
    lines.push('*Closed*')
    for (const r of closed.slice(0, 10)) lines.push(formatRow(r))
    if (closed.length > 10) lines.push(`  …and ${closed.length - 10} older`)
  }
  return lines.join('\n')
}

function formatRow(r: ThreadRow): string {
  const age = formatAge(Math.floor(Date.now() / 1000) - r.openedAt)
  const status = r.status === 'live' ? `hot ${r.hotness}` : r.status
  const en = r.enabled ? '' : ' [paused]'
  const cost = formatCost(r.totalInputTokens, r.totalOutputTokens)
  const costSuffix = cost ? ` · ${cost}` : ''
  const lines = [`  #${r.id}  ${status}  ${age} ago${en}  ${r.title}${costSuffix}`]
  if (r.summary) lines.push(`       ${r.summary}`)
  if (r.resolutionNote) lines.push(`       → ${r.resolutionNote}`)
  return lines.join('\n')
}

function formatOne(r: ThreadRow): string {
  const age = formatAge(Math.floor(Date.now() / 1000) - r.openedAt)
  const lines = [
    `*Thread #${r.id}* — ${r.title}`,
    `Status: ${r.status}${r.enabled ? '' : ' (paused)'}`,
    `Hotness: ${r.hotness}`,
    `Opened: ${age} ago`,
    `Last touched: ${formatAge(Math.floor(Date.now() / 1000) - r.lastTouchedAt)} ago`,
    `Summary: ${r.summary}`,
  ]
  if (r.linkedMemory) lines.push(`Linked: ${r.linkedMemory}`)
  if (r.resolutionNote) lines.push(`Resolution: ${r.resolutionNote}`)
  const cost = formatCost(r.totalInputTokens, r.totalOutputTokens)
  if (cost) lines.push(`Cost: ${cost}`)
  return lines.join('\n')
}

function formatWeights(rows: Array<{ category: string; weight: number; samples: number }>): string {
  if (rows.length === 0) return 'No category weights learned yet.'
  const sorted = [...rows].sort((a, b) => b.weight - a.weight)
  const lines = ['*Category weights* (higher = AI surfaces more)']
  for (const r of sorted) {
    lines.push(`  ${r.category.padEnd(20)} ${r.weight} (${r.samples} samples)`)
  }
  return lines.join('\n')
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86400)}d`
}

function formatCost(input: number, output: number): string {
  const total = input + output
  if (total === 0) return ''
  const compact = (n: number) =>
    n < 1000 ? `${n}` : n < 10_000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`
  return `${compact(input)}↑ ${compact(output)}↓`
}
