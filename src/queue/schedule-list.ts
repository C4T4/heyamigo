// Helpers for the /reminders and /crons chat commands. Lists pending
// cron rows that target a particular chat address, formatted for
// reading on a phone.

import { and, asc, eq, like } from 'drizzle-orm'
import { getDb } from '../db/index.js'
import { crons } from '../db/schema.js'
import { formatLocalTime } from './time-expr.js'

export type ScheduleItem = {
  id: number
  name: string
  recurrence: string | null
  nextRunAt: number
  bodyPreview: string
}

// Pull crons whose payload targets the given chat address. We tag
// chat-emitted crons with names prefixed by 'chat-cron-' (recurring)
// or 'chat-remind-' (one-shot), so a LIKE filter on the JSON address
// is the simplest way to scope per chat.
export function listChatSchedules(
  chatAddress: string,
  kind: 'one-shot' | 'recurring',
): ScheduleItem[] {
  const db = getDb()
  // SQLite has no JSON containment operator that's portable; use a
  // simple substring search on the serialized payload. Payloads
  // include `"address":"<addr>"` which is unique enough.
  const addressNeedle = `%"address":"${chatAddress.replace(/"/g, '\\"')}"%`
  const rows = db
    .select()
    .from(crons)
    .where(
      and(
        eq(crons.enabled, 1),
        like(crons.payload, addressNeedle),
      ),
    )
    .orderBy(asc(crons.nextRunAt))
    .all()

  return rows
    .filter((r) =>
      kind === 'one-shot' ? r.recurrence === null : r.recurrence !== null,
    )
    .map((r) => ({
      id: r.id,
      name: r.name,
      recurrence: r.recurrence,
      nextRunAt: r.nextRunAt,
      bodyPreview: extractBodyPreview(r.payload),
    }))
}

function extractBodyPreview(payload: string): string {
  try {
    const obj = JSON.parse(payload) as { text?: string }
    const t = obj.text ?? ''
    return t.length > 80 ? t.slice(0, 77) + '...' : t
  } catch {
    return ''
  }
}

export function formatScheduleList(
  items: ScheduleItem[],
  tz: string,
  kind: 'one-shot' | 'recurring',
): string {
  if (items.length === 0) {
    return kind === 'one-shot'
      ? 'No reminders pending for this chat.'
      : 'No recurring schedules for this chat.'
  }
  const header = kind === 'one-shot' ? '*Pending reminders*' : '*Recurring schedules*'
  const lines: string[] = [header]
  for (const item of items) {
    const when = formatLocalTime(item.nextRunAt, tz)
    const tail = item.recurrence ? ` · ${item.recurrence}` : ''
    lines.push(`  ${when}${tail}`)
    if (item.bodyPreview) lines.push(`    "${item.bodyPreview}"`)
  }
  lines.push(`Timezone: ${tz}`)
  return lines.join('\n')
}
