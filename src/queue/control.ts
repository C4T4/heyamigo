// Helpers for the control table — the bot's runtime signalling
// channel. SIGTERM, /shutdown chat command, or external trigger all
// insert a control row; the orchestrator picks it up on its next tick
// and acts.
//
// Single-row-per-key: PK on `key` gives natural upsert semantics.

import { eq } from 'drizzle-orm'
import { getDb } from '../db/index.js'
import { control } from '../db/schema.js'

export type ControlKey = 'shutdown' | 'pause' | 'reload_config'

export function requestControl(
  key: ControlKey,
  value: string | null = null,
  requestedBy: string | null = null,
): void {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  db.insert(control)
    .values({ key, value, requestedBy, requestedAt: now })
    .onConflictDoUpdate({
      target: control.key,
      set: { value, requestedBy, requestedAt: now },
    })
    .run()
}

export function readControl(key: ControlKey): {
  value: string | null
  requestedBy: string | null
  requestedAt: number
} | null {
  const db = getDb()
  const row = db.select().from(control).where(eq(control.key, key)).get()
  if (!row) return null
  return {
    value: row.value,
    requestedBy: row.requestedBy,
    requestedAt: row.requestedAt,
  }
}

export function clearControl(key: ControlKey): boolean {
  const db = getDb()
  const result = db
    .delete(control)
    .where(eq(control.key, key))
    .returning({ key: control.key })
    .all()
  return result.length > 0
}
