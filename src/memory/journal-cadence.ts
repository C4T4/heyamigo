// Cadence parsing and "is due?" evaluation for journals.
//
// Supported shapes:
//   "daily HH:MM"        — daily at HH:MM in owner.timezone (e.g. "daily 21:00")
//   "Xh"                 — every X hours (e.g. "24h")
//   "Xd"                 — every X days (e.g. "3d")
//   "Xm"                 — every X minutes (only for testing; rounded up)
//
// Quiet hours shape: "HH:MM-HH:MM" (may span midnight: "22:00-08:00")

export type Cadence =
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'interval'; seconds: number }

export function parseCadence(raw: string | undefined): Cadence | null {
  if (!raw) return null
  const s = raw.trim().toLowerCase()
  const daily = s.match(/^daily\s+(\d{1,2}):(\d{2})$/)
  if (daily) {
    const hour = Number(daily[1])
    const minute = Number(daily[2])
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
    return { kind: 'daily', hour, minute }
  }
  const iv = s.match(/^(\d+)\s*([mhd])$/)
  if (iv) {
    const n = Number(iv[1])
    const unit = iv[2]
    if (!Number.isFinite(n) || n <= 0) return null
    const secs =
      unit === 'm' ? n * 60 : unit === 'h' ? n * 3600 : n * 86400
    return { kind: 'interval', seconds: secs }
  }
  return null
}

// Returns unix seconds (ts) of the next scheduled firing AFTER the given
// "lastFiredTs" (or since "now" if never fired). For daily cadences, the time
// is computed in the owner's timezone.
export function nextFireTs(params: {
  cadence: Cadence
  lastFiredTs: number | null
  now: number
  timezone: string
}): number {
  const { cadence, lastFiredTs, now, timezone } = params
  if (cadence.kind === 'interval') {
    const base = lastFiredTs ?? now
    return base + cadence.seconds
  }
  // daily HH:MM in timezone
  const anchor = lastFiredTs ?? now
  // Start from the day of anchor, then walk forward until target time > anchor.
  let target = dailyTargetTs(anchor, cadence, timezone)
  while (target <= anchor) {
    target = dailyTargetTs(target + 1, cadence, timezone)
  }
  return target
}

// For a given reference ts, compute the unix ts for HH:MM that same day in the
// given timezone. May be earlier than ref if the clock time is past HH:MM.
function dailyTargetTs(
  refTs: number,
  cadence: Extract<Cadence, { kind: 'daily' }>,
  timezone: string,
): number {
  const parts = timezoneParts(refTs, timezone)
  // Construct an ISO-like string for "that date at HH:MM in tz" and convert
  // back to epoch via UTC offset derived from parts.
  const y = parts.year
  const mo = parts.month
  const d = parts.day
  const ts = zonedDateTimeToEpoch(
    y,
    mo,
    d,
    cadence.hour,
    cadence.minute,
    timezone,
  )
  return ts
}

type TzParts = {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

export function timezoneParts(tsSeconds: number, timezone: string): TzParts {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
  const p = Object.fromEntries(
    fmt.formatToParts(new Date(tsSeconds * 1000)).map((x) => [x.type, x.value]),
  )
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    second: Number(p.second),
  }
}

// Convert a local (zoned) date-time to epoch seconds. Uses Intl to derive the
// UTC offset for that zone at that wall time.
function zonedDateTimeToEpoch(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
): number {
  // Start with the wall time treated as UTC, then correct by the tz offset.
  const asUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0)
  // Get what that UTC moment looks like in the target timezone
  const parts = timezoneParts(Math.floor(asUtcMs / 1000), timezone)
  // Compute the diff between the wall time we wanted and what we got
  const wantedMs = asUtcMs
  const gotMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    0,
  )
  const offsetMs = gotMs - wantedMs
  return Math.floor((asUtcMs - offsetMs) / 1000)
}

// Quiet hours: is the given time inside the quiet-hours window (in tz)?
// Accepts "HH:MM-HH:MM" (e.g. "22:00-08:00" = 10pm to 8am next day).
export function isInQuietHours(params: {
  now: number
  window: string | undefined
  timezone: string
}): boolean {
  const { now, window, timezone } = params
  if (!window) return false
  const m = window.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/)
  if (!m) return false
  const startH = Number(m[1])
  const startM = Number(m[2])
  const endH = Number(m[3])
  const endM = Number(m[4])
  const parts = timezoneParts(now, timezone)
  const curMin = parts.hour * 60 + parts.minute
  const startMin = startH * 60 + startM
  const endMin = endH * 60 + endM
  if (startMin <= endMin) {
    // Non-wrapping window: [start, end)
    return curMin >= startMin && curMin < endMin
  }
  // Wrapping window: [start, 24:00) ∪ [00:00, end)
  return curMin >= startMin || curMin < endMin
}
