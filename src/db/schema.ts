// Schema source of truth. Every DDL change goes here first, then
// `npx drizzle-kit generate` produces a SQL migration in migrations/.
// Direct ALTER/CREATE/DROP outside this flow is forbidden — see the
// "Cardinal rule" section in refactor.md.

import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, primaryKey, index, uniqueIndex } from 'drizzle-orm/sqlite-core'

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

// ──────────────────────────────────────────────────────────────────
// Outbound queue (Phase 1)
// ──────────────────────────────────────────────────────────────────

// Replies waiting to be sent on any channel. Workers (chat / async /
// browser) insert rows here; the sender worker drains by channel
// adapter. AI code never touches the WA socket directly.
//
// Status lifecycle:
//   pending → sending → done   (happy path)
//   sending → pending          (transient fail, attempts++, backoff)
//   sending → failed           (permanent fail, kept for inspection)
//   sending → dlq              (attempts > N; dead-letter)
//
// idempotency_key prevents double-sends when a worker is reclaimed
// after TTL and its delayed insert collides with the replacement
// worker's insert. Format suggested: `from-inbound-<id>` or
// `from-async-<task-id>`.
export const outbound = sqliteTable('outbound', {
  id:             integer('id').primaryKey({ autoIncrement: true }),
  address:        text('address').notNull(),   // 'wa:dm:...' | 'wa:group:...' | etc.
  kind:           text('kind').notNull(),      // 'text'|'image'|'video'|'audio'|'document'
  text:           text('text'),                // body or caption
  mediaPath:      text('media_path'),          // relative to storage/ when set
  mediaMime:      text('media_mime'),
  mediaBytes:     integer('media_bytes'),      // enforced cap
  quoteMsgId:     text('quote_msg_id'),
  idempotencyKey: text('idempotency_key'),

  status:         text('status').notNull(),    // 'pending'|'sending'|'done'|'failed'|'dlq'
  attempts:       integer('attempts').notNull().default(0),
  nextAttemptAt:  integer('next_attempt_at'),  // unix seconds; null = ready immediately
  lastError:      text('last_error'),

  claimedBy:      text('claimed_by'),
  claimedAt:      integer('claimed_at'),

  createdAt:      integer('created_at').notNull(),
  updatedAt:      integer('updated_at').notNull(),
}, t => ({
  byStatusNext: index('outbound_by_status_next').on(t.status, t.nextAttemptAt),
  byAddress:    index('outbound_by_address').on(t.address),
  // Sparse unique: enforced only when idempotencyKey is non-null.
  uniqIdemp:    uniqueIndex('outbound_idempotency_key_uq')
                   .on(t.idempotencyKey)
                   .where(sql`${t.idempotencyKey} IS NOT NULL`),
}))

// ──────────────────────────────────────────────────────────────────
// Cron table (Phase 2.2)
// ──────────────────────────────────────────────────────────────────

// Schedules. Not really a queue — a *table polled by the orchestrator*
// that fires inserts into the other queues when next_run_at <= now.
//
// recurrence:
//   null              → one-shot (deleted after firing)
//   '@every <n><unit>' → 'every 30s', 'every 5m', 'every 3h', 'every 7d'
//   '@daily HH:MM'    → daily at owner-tz local time
//   '@weekly DOW HH:MM' → weekly at owner-tz local time
//                        DOW = mon|tue|wed|thu|fri|sat|sun
// (Cron expressions intentionally NOT supported until we need them —
// own@every / @daily / @weekly covers every existing setInterval.)
export const crons = sqliteTable('crons', {
  id:          integer('id').primaryKey({ autoIncrement: true }),
  name:        text('name').notNull(),         // human-readable; uniqueness enforced for non-oneshot
  enqueueInto: text('enqueue_into').notNull(), // 'inbound'|'async'|'outbound'|'memory_writes'
  payload:     text('payload').notNull(),      // JSON passed to the target queue
  recurrence:  text('recurrence'),             // null = one-shot
  nextRunAt:   integer('next_run_at').notNull(),
  lastRunAt:   integer('last_run_at'),
  enabled:     integer('enabled').notNull().default(1), // SQLite bool = int
  createdAt:   integer('created_at').notNull(),
}, t => ({
  byDue:    index('crons_by_due').on(t.enabled, t.nextRunAt),
  // Named recurring crons must be unique — prevents accidental
  // duplicate schedules from setup wizard re-runs etc. One-shots
  // (recurrence IS NULL) can have any name.
  uniqName: uniqueIndex('crons_name_uq')
              .on(t.name)
              .where(sql`${t.recurrence} IS NOT NULL`),
}))

// ──────────────────────────────────────────────────────────────────
// Inbound queue (Phase 4)
// ──────────────────────────────────────────────────────────────────

// Messages received on any channel, waiting to be processed by a
// chat worker. The chat worker pool claims rows with per-address
// serialization (one in-flight job per chat preserves reply order),
// runs the AI provider, and enqueues outbound rows with the reply.
//
// `address` is the chat-level address (a group's address, or a DM's
// address). `actor_address` is the within-chat sender — for DMs it
// equals `address`; for groups it identifies which member sent the
// message. `person_id` and `actor_person_id` are the resolved
// person identities (nullable when resolution fails, e.g. an unknown
// member of a group).
//
// Idempotency: external_msg_id (channel-native message id, e.g.
// Baileys message key id). The same channel message arriving twice
// (network retransmit, replay on reconnect) maps to one row.
export const inbound = sqliteTable('inbound', {
  id:                  integer('id').primaryKey({ autoIncrement: true }),
  address:             text('address').notNull(),      // chat-level address
  actorAddress:        text('actor_address'),          // sender within chat; null = self/system
  personId:            text('person_id'),              // resolved chat owner (DM partner / group)
  actorPersonId:       text('actor_person_id'),        // resolved sender
  externalMsgId:       text('external_msg_id'),        // channel-native msg id (idempotency)
  text:                text('text').notNull(),         // body or media tag
  mediaPath:           text('media_path'),             // path relative to storage/ when media
  mediaMime:           text('media_mime'),
  mediaBytes:          integer('media_bytes'),
  pushName:            text('push_name'),              // sender's display name at send time
  triggerReason:       text('trigger_reason'),         // 'alias'|'mention'|'reply'|'owner'|...
  // 'pending'|'claimed'|'done'|'failed'|'dlq'
  status:              text('status').notNull(),
  attempts:            integer('attempts').notNull().default(0),
  nextAttemptAt:       integer('next_attempt_at'),
  lastError:           text('last_error'),

  claimedBy:           text('claimed_by'),
  claimedAt:           integer('claimed_at'),

  receivedAt:          integer('received_at').notNull(),  // unix sec when WA delivered
  createdAt:           integer('created_at').notNull(),   // unix sec when row inserted
  updatedAt:           integer('updated_at').notNull(),
}, t => ({
  byStatusNext: index('inbound_by_status_next').on(t.status, t.nextAttemptAt),
  byAddress:    index('inbound_by_address').on(t.address),
  byPerson:     index('inbound_by_person').on(t.personId, t.receivedAt),
  // Sparse unique on external_msg_id: enforced only when set. Same
  // pattern as outbound's idempotency_key.
  uniqExtId:    uniqueIndex('inbound_external_msg_id_uq')
                   .on(t.externalMsgId)
                   .where(sql`${t.externalMsgId} IS NOT NULL`),
}))
