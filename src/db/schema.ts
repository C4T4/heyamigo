// Schema source of truth. Every DDL change goes here first, then
// `npx drizzle-kit generate` produces a SQL migration in migrations/.
// Direct ALTER/CREATE/DROP outside this flow is forbidden — see the
// "Cardinal rule" section in refactor.md.

import { sqliteTable, text, integer, primaryKey, index } from 'drizzle-orm/sqlite-core'

// ──────────────────────────────────────────────────────────────────
// Identity
// ──────────────────────────────────────────────────────────────────

// Canonical humans the bot knows about. One row per real person; same
// person on multiple channels = multiple rows in `identities`, one row
// here.
export const persons = sqliteTable('persons', {
  id:          text('id').primaryKey(),
  displayName: text('display_name'),
  timezone:    text('timezone'),
  createdAt:   integer('created_at').notNull(),
})

// Channel-addressable identities resolving to a person. Address is
// channel-prefixed: wa:dm:..., wa:group:..., tg:dm:..., etc.
export const identities = sqliteTable('identities', {
  personId: text('person_id').notNull().references(() => persons.id),
  address:  text('address').notNull().unique(),
  addedAt:  integer('added_at').notNull(),
}, t => ({
  pk: primaryKey({ columns: [t.personId, t.address] }),
}))

// ──────────────────────────────────────────────────────────────────
// Runtime control
// ──────────────────────────────────────────────────────────────────

// Worker registry. Every worker (chat, async, browser, sender, memory,
// orchestrator) inserts a row at startup and updates last_seen as a
// heartbeat. Orchestrator uses this for liveness detection and
// graceful shutdown drain (see refactor.md §Workers).
export const workers = sqliteTable('workers', {
  id:          text('id').primaryKey(),       // `${hostname}-${pid}-${slot}`
  kind:        text('kind').notNull(),        // 'chat'|'async'|'browser'|'sender'|'memory'|'orchestrator'
  status:      text('status').notNull(),      // 'idle'|'busy'|'draining'|'dead'
  currentJob:  text('current_job'),           // 'queue:id' if busy
  lastSeen:    integer('last_seen').notNull(),
  startedAt:   integer('started_at').notNull(),
}, t => ({
  byKindStatus: index('workers_by_kind_status').on(t.kind, t.status),
  byLastSeen:   index('workers_by_last_seen').on(t.lastSeen),
}))

// Bot-wide control signals. Insert a row to request shutdown/pause/
// reload; orchestrator picks it up on its next tick. Single-key, so
// using PK on key gives us upsert semantics.
export const control = sqliteTable('control', {
  key:          text('key').primaryKey(),     // 'shutdown'|'pause'|'reload_config'
  value:        text('value'),
  requestedBy:  text('requested_by'),
  requestedAt:  integer('requested_at').notNull(),
})
