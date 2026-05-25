// Time expression parsing and resolution.
//
// Split into two stages so timezone application happens at resolve
// time, not parse time. The parser doesn't know whose timezone to
// use — it just produces a structured TimeExpression. The worker
// looks up the sender's timezone and calls resolveTimeExpression()
// to get a unix-second timestamp.
//
// Grammars supported (case-insensitive, trimmed):
//   in <n>(s|m|h|d)              relative
//   in <n> second(s)|minute(s)|hour(s)|day(s)
//   at <H>(:MM)?(am|pm)?         today, user-tz
//   tomorrow at <H>(:MM)?(am|pm)?
//   <mon|tue|wed|thu|fri|sat|sun> at <H>(:MM)?(am|pm)?
//   YYYY-MM-DD HH:MM             ISO-style, user-tz
//
// Past times today (e.g. user says "at 9am" at 11am) shift to
// tomorrow. Weekday targets land on the NEXT occurrence of that
// weekday including today if it's still in the future.

export type TimeExpression =
  | { kind: 'relative';  seconds: number }
  | { kind: 'today';     hour: number; minute: number }
  | { kind: 'tomorrow';  hour: number; minute: number }
  | { kind: 'weekday';   dayOfWeek: 0|1|2|3|4|5|6; hour: number; minute: number }
  | { kind: 'iso';       year: number; month: number; day: number; hour: number; minute: number }

const DOW_INDEX: Record<string, 0|1|2|3|4|5|6> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
}

const UNIT_SECONDS: Record<string, number> = {
  s: 1, second: 1, seconds: 1,
  m: 60, minute: 60, minutes: 60,
  h: 3600, hour: 3600, hours: 3600,
  d: 86400, day: 86400, days: 86400,
}

const REL_RE       = /^in\s+(\d+)\s*([a-z]+)$/i
const TODAY_RE     = /^at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i
const TOMORROW_RE  = /^tomorrow(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i
const WEEKDAY_RE   = /^(mon|tue|wed|thu|fri|sat|sun)(?:day)?(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i
const ISO_RE       = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})$/

export function parseTimeExpression(input: string): TimeExpression | null {
  const s = input.trim()

  const m1 = REL_RE.exec(s)
  if (m1) {
    const n = parseInt(m1[1]!, 10)
    const unit = m1[2]!.toLowerCase()
    const mult = UNIT_SECONDS[unit]
    if (!mult || n <= 0) return null
    return { kind: 'relative', seconds: n * mult }
  }

  const m2 = TODAY_RE.exec(s)
  if (m2) {
    const hm = parseHourMinute(m2[1]!, m2[2], m2[3])
    if (!hm) return null
    return { kind: 'today', hour: hm.hour, minute: hm.minute }
  }

  const m3 = TOMORROW_RE.exec(s)
  if (m3) {
    const hm = parseHourMinute(m3[1]!, m3[2], m3[3])
    if (!hm) return null
    return { kind: 'tomorrow', hour: hm.hour, minute: hm.minute }
  }

  const m4 = WEEKDAY_RE.exec(s)
  if (m4) {
    const dow = DOW_INDEX[m4[1]!.toLowerCase()]
    if (dow === undefined) return null
    const hm = parseHourMinute(m4[2]!, m4[3], m4[4])
    if (!hm) return null
    return { kind: 'weekday', dayOfWeek: dow, hour: hm.hour, minute: hm.minute }
  }

  const m5 = ISO_RE.exec(s)
  if (m5) {
    const year = parseInt(m5[1]!, 10)
    const month = parseInt(m5[2]!, 10)
    const day = parseInt(m5[3]!, 10)
    const hour = parseInt(m5[4]!, 10)
    const minute = parseInt(m5[5]!, 10)
    if (month < 1 || month > 12 || day < 1 || day > 31) return null
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
    return { kind: 'iso', year, month, day, hour, minute }
  }

  return null
}

function parseHourMinute(
  hStr: string,
  mStr: string | undefined,
  ampm: string | undefined,
): { hour: number; minute: number } | null {
  let h = parseInt(hStr, 10)
  const m = mStr ? parseInt(mStr, 10) : 0
  if (m < 0 || m > 59) return null

  if (ampm) {
    const meridiem = ampm.toLowerCase()
    if (h < 1 || h > 12) return null
    if (meridiem === 'am') h = h === 12 ? 0 : h
    else                   h = h === 12 ? 12 : h + 12
  } else {
    // 24h form when no am/pm
    if (h < 0 || h > 23) return null
  }
  return { hour: h, minute: m }
}

// Resolve to absolute unix seconds in the given timezone. Always
// returns a moment strictly in the future relative to `nowSec`.
export function resolveTimeExpression(
  expr: TimeExpression,
  tz: string,
  nowSec: number,
): number {
  if (expr.kind === 'relative') {
    return nowSec + expr.seconds
  }

  if (expr.kind === 'today') {
    const today = localCalendarDate(nowSec, tz)
    const candidate = makeDateInTz(
      today.year, today.month, today.day, expr.hour, expr.minute, tz,
    )
    // If already past today, roll to tomorrow.
    return candidate > nowSec
      ? candidate
      : makeDateInTz(today.year, today.month, today.day + 1, expr.hour, expr.minute, tz)
  }

  if (expr.kind === 'tomorrow') {
    const today = localCalendarDate(nowSec, tz)
    return makeDateInTz(today.year, today.month, today.day + 1, expr.hour, expr.minute, tz)
  }

  if (expr.kind === 'weekday') {
    // Walk forward 0..7 days in user-tz until day-of-week matches AND
    // the resulting moment is in the future.
    const today = localCalendarDate(nowSec, tz)
    for (let offset = 0; offset < 8; offset++) {
      const candidate = makeDateInTz(
        today.year, today.month, today.day + offset, expr.hour, expr.minute, tz,
      )
      const candidateDow = localCalendarDate(candidate, tz).dayOfWeek
      if (candidateDow === expr.dayOfWeek && candidate > nowSec) {
        return candidate
      }
    }
    // Shouldn't reach — fallback to a week from now.
    return nowSec + 7 * 86400
  }

  // ISO
  return makeDateInTz(expr.year, expr.month - 1, expr.day, expr.hour, expr.minute, tz)
}

// Build a unix-seconds for a given Y/M/D HH:MM interpreted in a named
// timezone. Guess-and-correct via Intl.DateTimeFormat — same technique
// the cron parser uses. Handles DST seamlessly.
function makeDateInTz(
  year: number, month: number, day: number,
  hour: number, minute: number,
  tz: string,
): number {
  const guessUtcMs = Date.UTC(year, month, day, hour, minute, 0)
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  })
  const parts = fmt.formatToParts(new Date(guessUtcMs))
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '0'
  let parsedHour = parseInt(get('hour'), 10)
  // Intl formats midnight as "24" in some locale/version combos; normalize.
  if (parsedHour === 24) parsedHour = 0
  const renderedUtcMs = Date.UTC(
    parseInt(get('year'), 10),
    parseInt(get('month'), 10) - 1,
    parseInt(get('day'), 10),
    parsedHour,
    parseInt(get('minute'), 10),
    parseInt(get('second'), 10),
  )
  const offsetMs = guessUtcMs - renderedUtcMs
  return Math.floor((guessUtcMs + offsetMs) / 1000)
}

// Decompose a unix-second into Y/M/D and day-of-week in a named
// timezone. Returns calendar fields as the local user would see
// them — used to compute "today" anchors before applying HH:MM.
function localCalendarDate(
  sec: number,
  tz: string,
): { year: number; month: number; day: number; dayOfWeek: 0|1|2|3|4|5|6 } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short',
  })
  const parts = fmt.formatToParts(new Date(sec * 1000))
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return {
    year: parseInt(get('year'), 10),
    month: parseInt(get('month'), 10) - 1,   // 0-indexed for makeDateInTz Date.UTC compat
    day: parseInt(get('day'), 10),
    dayOfWeek: (DOW_INDEX[get('weekday').toLowerCase()] ?? 0) as 0|1|2|3|4|5|6,
  }
}

// Human-readable formatter used in chat acks. Renders an absolute
// resolved time back into the user's local time.
export function formatLocalTime(unixSec: number, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(unixSec * 1000))
}
