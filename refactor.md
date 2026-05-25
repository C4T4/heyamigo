# Refactor: heyamigo as a job system

Working doc. Captures the agreed direction from a design discussion.
Not a spec yet — this is the architecture and the trade-offs that led
there. Build in phases; recommended order at the bottom.

## End state we're after

- Multiple users across multiple channels (WhatsApp, eventually Telegram
  and others) send multiple messages → parallel execution, ordered
  within each chat.
- One canonical identity per human across channels. Memory follows the
  person, not the channel address.
- Memory stays consistent across all parallel sessions, no lost writes.
- Inbound + outbound media (images, files, docs, audio) round-trip on
  any channel.
- Browser work runs on a worker pool sharing one logged-in Chrome.
- Schedules and recurring tasks live in a cron table, not in code.
- Crashes don't block anything — claimed-but-not-completed work is
  reclaimed; in-flight async jobs survive restarts.
- The agent can send media back to chat by emitting a tag, same way it
  delegates async work today.
- Schema can evolve without losing data; backups are automatic.

## The architecture, in four primitives

Everything in the system is one of:

- **Queues** — durable state buckets with claim/TTL/retry semantics.
- **Workers** — pure consumers that drain queues, never fight for the
  same job (atomic claim).
- **Tags** — markers the agent emits in its reply that map directly to
  queue inserts. The tag set is the agent's API for triggering work.
- **Interfaces** — swappable backends behind stable contracts. Lets us
  change Claude→Codex, Baileys→Telegram, files→SQLite without rewriting
  the callers.

That's the whole model. Every feature is one of these four.

---

## Identity model — Address + Person

Today everything is keyed by WhatsApp JID. JIDs encode platform + scope
implicitly (`@g.us` = group, `@s.whatsapp.net` = DM), which breaks the
moment we add Telegram or anything else. Fix: lock in a multi-channel
address shape *now*, before Phase 1, so the queue rows carry the right
field from day one.

### Address

```ts
type Address = {
  channel:     'whatsapp' | 'telegram' | 'signal' | ...
  scope:       'dm' | 'group'
  external_id: string   // platform-native id (jid for WA, chat_id for TG)
}
```

Serialized as a flat string in queue rows:
```
wa:dm:17867@s.whatsapp.net
wa:group:120363@g.us
tg:dm:user_12345
tg:group:-100123456
system:cron:42
```

Inbound, outbound, async, browser, and crons all carry `address: string`.
Sender worker parses `address.channel` and dispatches to the right
ChannelAdapter. The `system:*` prefix is reserved for bot-internal
messages (cron-fired self-prompts, etc.) — see "System inbound" below.

### Person

Same human can show up on multiple channels. Memory attaches to **the
person**, not to one channel's address for them.

```sql
CREATE TABLE persons (
  id            TEXT PRIMARY KEY,  -- 'person-abc'
  display_name  TEXT,
  timezone      TEXT,
  created_at    INTEGER
);

CREATE TABLE identities (
  person_id     TEXT NOT NULL REFERENCES persons(id),
  address       TEXT NOT NULL UNIQUE,  -- 'wa:dm:1786@s.whatsapp.net'
  added_at      INTEGER,
  PRIMARY KEY (person_id, address)
);
```

- Inbound message arrives → look up `person_id` via `identities.address`
  → enqueue inbound with both `address` and `person_id`.
- The owner is `person-owner`, can have identities `wa:dm:1786...` AND
  `tg:dm:12345` — one memory, two channels.
- Group chats are addressed by the group `address`; members within are
  persons resolved from sender addresses. Group inbound rows carry both
  `address` (the group) and `actor_address` + `actor_person_id` (the
  sender within the group).
- A new sender with no known identity → auto-create a person + identity
  row, or queue for owner approval (configurable).

---

## Queues

One SQLite file (`storage/heyamigo.db`, better-sqlite3). All queues
share the same table shape:

```sql
CREATE TABLE <queue> (
  id              INTEGER PRIMARY KEY,
  status          TEXT NOT NULL,   -- pending | claimed | done | failed | dlq
  claimed_by      TEXT,            -- worker id
  claimed_at      INTEGER,         -- unix seconds; TTL-based reclaim
  attempts        INTEGER NOT NULL DEFAULT 0,
  payload         TEXT NOT NULL,   -- queue-specific JSON
  address         TEXT,            -- channel-prefixed address (where applicable)
  person_id       TEXT,            -- canonical person, when resolvable
  idempotency_key TEXT,            -- nullable; UNIQUE when set
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX <queue>_idemp ON <queue>(idempotency_key) WHERE idempotency_key IS NOT NULL;
```

Claim is one atomic statement:
```sql
UPDATE <queue> SET status='claimed', claimed_by=?, claimed_at=?
WHERE id = (SELECT id FROM <queue> WHERE status='pending' ORDER BY id LIMIT 1)
RETURNING *;
```

For inbound + browser, the claim filter serializes per-address so reply
order is preserved per chat (different chats run in parallel):
```sql
WHERE status='pending'
  AND (address IS NULL OR address NOT IN (
        SELECT address FROM <queue> WHERE status='claimed' AND address IS NOT NULL
      ))
```

### Idempotency

Three primitives, layered:

1. **`idempotency_key` on inserts.** Outbound rows generated from
   inbound `X` use `idempotency_key='from-inbound-X'`. A slow chat
   worker that gets reclaimed and *eventually* comes back to insert its
   outbound will hit the UNIQUE constraint and no-op — no double send.

2. **`claimed_by` check on completion.** Only the holder can mark `done`:
   ```sql
   UPDATE <queue> SET status='done', updated_at=?
   WHERE id=? AND status='claimed' AND claimed_by=?
   ```
   If a slow worker returns after TTL-reclaim, this UPDATE matches zero
   rows; the worker logs "stale claim" and exits. The job is already
   being handled (or done) by someone else.

3. **Wrap related inserts in a SQLite transaction.** Chat worker writes
   outbound + memory_write together:
   ```ts
   db.transaction(() => {
     insertOutbound({...})
     insertMemoryWrite({...})
     markInboundDone(ticketId, claimedBy)
   }).immediate()  // BEGIN IMMEDIATE → no race window
   ```
   All-or-nothing; if any insert fails, none commit.

These three together cover: crashes, slow workers, double-claims,
partial writes.

### The six queues

| Queue | What it holds | Drained by |
|---|---|---|
| `inbound` | Messages received on any channel, awaiting reply | chat workers (pool) |
| `outbound` | Replies (text + media) waiting to be sent on any channel | sender worker (single, rate-limited) |
| `async` | General background tasks the agent delegated | async workers (pool, no browser) |
| `browser` | Browser tasks (scraping, automation) | browser workers (pool, share Chrome) |
| `memory_writes` | Memory mutations (observe, digest trigger, person merge, etc.) | memory worker (single, serializes) |
| `crons` | Schedules (recurring + one-shot). Not really a queue — a table polled by the orchestrator that fires inserts into the others. | orchestrator |

### Inbound + outbound — the middleman pattern

```
       inbound queue                            outbound queue
   ┌──────────────────┐                     ┌────────────────────┐
   │ msg from channel │                     │ kind, text,        │
   │ address,         │                     │ media_path,        │
   │ person_id, ...   │                     │ address, quote_id, │
   │ status, attempts │                     │ status, attempts   │
   └────────┬─────────┘                     └─────────┬──────────┘
            │                                         ▲
            │ claimed by                              │ inserts (text +
            ▼                                         │  optional media)
   ┌──────────────────┐    AI/agent reply     ┌────────────────┐
   │  chat workers    │──────────────────────▶│  sender worker │
   │  (Codex/Claude)  │   (just an INSERT)    │ (per-channel   │
   └──────────────────┘                       │  adapter)      │
                                              └────────┬───────┘
                                                       │ drains
                                                       ▼
                                              WA / Telegram / ...
```

AI workers never call Baileys or any channel SDK directly. Their job
ends when the reply lands in `outbound`. The sender worker is the
**only** thing that touches channel adapters — single place for rate-
limiting, retry, ordering, throttling.

### Outbound schema (channel-agnostic, media-capable)

```sql
CREATE TABLE outbound (
  id              INTEGER PRIMARY KEY,
  address         TEXT NOT NULL,  -- 'wa:dm:...' | 'tg:group:...' etc.
  kind            TEXT NOT NULL,  -- 'text' | 'image' | 'video' | 'audio' | 'document'
  text            TEXT,           -- caption for media, or message body for text
  media_path      TEXT,           -- relative path under storage/outbox or storage/media
  media_mime      TEXT,
  media_bytes     INTEGER,        -- enforced cap, default 25MB
  quote_msg_id    TEXT,           -- channel-specific reply id
  idempotency_key TEXT,
  status, attempts, claimed_by, claimed_at, created_at, updated_at
);
```

Sender worker:
1. Parses `address` → picks the channel adapter.
2. Switches on `kind` → calls the right adapter method.
3. Enforces `media_bytes` cap; over-cap → `failed` with reason.
4. Outbox files cleaned by a cron after N days.

### memory_writes — the concurrency fix

Without this queue, N parallel chat workers all editing memory race and
lose data. Chosen path: **every memory mutation is a queue entry**,
drained by one memory worker.

```sql
-- payload examples
{"op":"observe", "person_id":"...", "topic":"workouts", "body":"..."}
{"op":"trigger_digest", "address":"...", "reason":"..."}
{"op":"create_topic", "person_id":"...", "slug":"...", "purpose":"..."}
{"op":"merge_persons", "from":"person-x", "into":"person-y"}
```

All memory writes happen single-threaded inside the memory worker →
atomic by construction, no locks needed. Pending mutations survive
restart, drain on next boot.

Trade-off: read-after-write latency. Chat worker A enqueues "user on
bulk" at t=0; worker B at t=1s won't see it in memory yet. For durable
observations this is fine.

---

## Observations log — replacing the journal/profile/brief split

Today memory is fragmented across five "kinds" and the agent has to
mentally route every observation:

- `persons/<number>/profile.md`
- `chats/<jid>/brief.md`
- `buckets/<slug>/index.md`
- `journals/<slug>/entries.jsonl`
- `compressed.md`

Unify into one log; profiles, briefs, journals become **views** over it.

```sql
CREATE TABLE observations (
  id                INTEGER PRIMARY KEY,
  ts                INTEGER NOT NULL,
  source            TEXT NOT NULL,    -- 'reactive' | 'observer' | 'async' | 'manual' | 'cron'
  person_id         TEXT,             -- the person this is about (subject)
  source_person_id  TEXT,             -- person who said it (often = person_id, sometimes not)
  address           TEXT,             -- the channel/chat this came from
  topic             TEXT,             -- optional grouping ('workouts', 'sleep', 'dating')
  kind              TEXT NOT NULL,    -- 'fact' | 'entry' | 'note' | 'preference'
  body              TEXT NOT NULL,
  source_msg_id     TEXT,             -- the inbound row that triggered this, if any
  meta              TEXT               -- json: tags, fields captured, etc.
);
CREATE INDEX obs_person ON observations(person_id, ts);
CREATE INDEX obs_topic  ON observations(person_id, topic, ts);
CREATE INDEX obs_chat   ON observations(address, ts);
```

`person_id` is the *subject*; `source_person_id` is the *speaker*.
Usually identical (alice says something about herself), but covers
cross-person observations ("Alice told me Bob is bulking" → `person_id=bob`,
`source_person_id=alice`).

**Profiles / briefs / journals become queries:**

- Profile for person X: `WHERE person_id=X AND kind IN ('fact','preference')`
- Workouts journal for X: `WHERE person_id=X AND topic='workouts' AND kind='entry'`
- Brief for chat Y: `WHERE address=Y AND kind IN ('note','fact') AND person_id IS NULL`

**Journals as a feature** become named saved queries with their own
cadence (nudges, observer sweeps):

```sql
CREATE TABLE topics (
  person_id     TEXT NOT NULL REFERENCES persons(id),
  slug          TEXT NOT NULL,           -- 'workouts'
  purpose       TEXT NOT NULL,
  fields        TEXT,                    -- json array, what to capture
  cadence       TEXT,                    -- json: check-in interval, silent-nudge threshold
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (person_id, slug)
);
```

**Compressed.md becomes a generated rollup** — cron job runs every N
hours, queries observations, writes the markdown summary the agent
reads in its preamble.

---

## Workers

Workers are pure consumers. They poll a queue (via the orchestrator),
claim an entry, do the work, mark it done or failed. They never share
state directly. Each worker registers itself in a `workers` table for
liveness + observability:

```sql
CREATE TABLE workers (
  id            TEXT PRIMARY KEY,            -- ${hostname}-${pid}-${slot}
  kind          TEXT NOT NULL,               -- 'chat' | 'async' | 'browser' | 'sender' | 'memory'
  status        TEXT NOT NULL,               -- 'idle' | 'busy' | 'draining' | 'dead'
  current_job   TEXT,                        -- 'queue:id' if busy
  last_seen     INTEGER NOT NULL,            -- heartbeat (every 5s)
  started_at    INTEGER NOT NULL
);
```

| Worker | Pool size | Constraint | Notes |
|---|---|---|---|
| Chat | 5 (config) | Per-address serialized | Calls AiProvider.ask(), writes reply to outbound |
| Async (general) | 3 (config) | None | Calls AiProvider.runTask(), writes reply to outbound |
| Browser | 5 (config) | Share one Chrome via pooled MCP processes, own 1-3 tabs each | Drops persistent-session model; each task fresh |
| Sender | 1 | Per-address order preserved naturally | Rate-limited, exponential backoff. Dispatches by channel adapter. |
| Memory | 1 | Serializes by design | All observation writes happen here |
| Orchestrator | 1 | The dispatcher itself | Polls queues, expires stale claims, fires cron jobs, applies control signals |

### Failure-mode coverage

| Failure today | What you'd see with the queue model |
|---|---|
| AI worker crashes mid-reply | inbound stuck in `claimed` past TTL → reclaimed; `workers.status='dead'` |
| Channel socket disconnects | outbound piles up in `pending`, drains on reconnect |
| Channel send hangs forever | outbound stuck in `sending` past timeout → reclaimed, retried |
| Codex times out at 4 min | inbound `failed`, attempts++, retry or DLQ after N |
| Concurrency too high → channel bans | rate-limit lives on the sender worker alone |
| 5 messages in 2s from one user | inbound queues them, workers parallelize, sender preserves per-address order |
| Memory write loses data under load | impossible — memory worker is single-threaded |
| Multiple users / channels simultaneously | natively parallel via per-address claim filter |
| Slow worker returns after reclaim | `claimed_by` check fails on `markDone` → safe no-op |
| Duplicate work generated | `idempotency_key` UNIQUE constraint blocks the second insert |

### Browser worker pool

Keep one Chrome (the logged-in profile is mandatory). Parallelize via
tabs.

```
Chrome (:9222) ← one process, owns profile + IG/TT logins
  │
  ├─ Worker 1: MCP playwright #1 (long-lived) → tabs [A1, A2, A3]
  ├─ Worker 2: MCP playwright #2 (long-lived) → tabs [B1]
  ├─ Worker 3: MCP playwright #3 (long-lived) → tabs [C1, C2]
  ├─ Worker 4: idle slot (MCP idle)
  └─ Worker 5: idle slot (MCP idle)
```

Targets:
- `maxWorkers`: 5
- `maxTabsPerWorker`: 3
- Ceiling: 15 tabs (~1-1.5GB tab memory + base Chrome)

**MCP server pooling.** One MCP playwright process per browser worker
slot, spawned at boot, reused across tasks. Saves ~1-2s cold-start per
task. Each MCP gets its own session-id at startup, so tab ownership
within an MCP is naturally scoped. Health check: per-MCP heartbeat;
restart only the dead one, never the whole pool.

**Hard trade-off:** drop the persistent agent session (cross-task agent
memory). Markdown writeups + observations already capture what matters
between tasks; the agent session memory wasn't load-bearing.

**Race conditions to defend against:**
1. Tab ownership not enforced by Playwright across MCPs. Defenses:
   prompt discipline → naming convention → custom MCP wrapper filtering
   by session.
2. Cleanup: workers close tabs on finish. Janitor cron sweeps stale tabs.
3. Same-site throttling = real ceiling. 5 workers on IG = 1 IP rate-
   limited. Practical gain ~2-3× on diverse workloads, not 5×.

### Orchestrator

One small loop (~150 lines):
1. Read `control` table — apply pause/resume/shutdown if set.
2. Expire stale claims (worker dead or slow past TTL → return to pending,
   mark worker `dead`).
3. Poll `crons` table → enqueue rows whose `next_run_at <= now`.
4. Dispatch pending tickets from each queue to free workers in their
   pool.
5. Log queue depths.

### Graceful shutdown via queue + heartbeat

Shutdown is a control-table row, not a signal handler. Same mechanism
works for `pause` and any future bot-wide control.

```sql
CREATE TABLE control (
  key           TEXT PRIMARY KEY,            -- 'shutdown' | 'pause' | 'reload_config'
  value         TEXT,
  requested_by  TEXT,
  requested_at  INTEGER NOT NULL
);
```

**Shutdown flow:**

```
1. SIGTERM hook (or /shutdown command, or HTTP POST) inserts
   control(key='shutdown', value='requested')
2. Orchestrator's next tick sees the row → flips draining=true,
   updates own workers.status='draining'
3. Orchestrator stops dispatching new claims; only expiry/cron/control
   logic continues
4. Workers continue current claim, mark done, then UPDATE workers
   SET status='idle'
5. Workers heartbeat every 5s (UPDATE workers SET last_seen=now)
6. Orchestrator polls: when count(*) from workers where status='busy'
   = 0 → exit cleanly, clear the control row on the way out
7. Hard timeout (30s default): force-exit. Any still-claimed rows get
   reclaimed by next boot's TTL check.
```

**Three free wins from this design:**
- **Liveness detection during normal ops.** Orchestrator sees
  `last_seen > 30s ago AND status='busy'` → worker is dead/stuck;
  reclaim its job AND mark `status='dead'`. No special RPC needed.
- **Pause/resume the whole bot.** Insert `control(key='pause')` →
  orchestrator stops dispatching, queues fill, no work lost. Delete the
  row → resumes. Useful during deploys, debugging, "stop bothering me
  for 2 hours."
- **Observability for free.** `SELECT * FROM workers` shows who's alive
  and what they're doing in real time.

### Sender worker state machine

```
pending ──claim──▶ sending ──ok──▶ done
                       │
                       ├──transient fail──▶ pending (attempts++, backoff)
                       │
                       └──permanent fail──▶ failed (DLQ after attempts > N)
```
Backoff: 1s → 5s → 30s → 2min → give up.

---

## Tags

The agent's reply is parsed for markers; each marker maps to a queue
insert. Tags are the **only** way the agent triggers side-effects.

`address` defaults to "where the message came from" for tags that act
on a chat.

| Tag | Lands in | Purpose |
|---|---|---|
| `[ASYNC: <task>]` | async queue | Long-running general work; reply arrives as a second message |
| `[ASYNC-BROWSER: <task>]` | browser queue | Browser-driven task on a fresh tab in the shared Chrome |
| `[SEND-IMAGE: path — caption]` | outbound (kind=image) | Agent generated/saved an image and wants to send it |
| `[SEND-DOC: path — caption]` | outbound (kind=document) | PDF/CSV/etc. |
| `[SEND-AUDIO: path]` | outbound (kind=audio) | Voice note |
| `[SEND-TEXT: address=<addr> body="..."]` | outbound (kind=text) | Reply to a *different* chat than the source |
| `[OBSERVE: person=X [source-person=Y] [topic=Z] kind=<fact\|entry\|note\|preference> body="..."]` | memory_writes (op=observe) | Record an observation. Replaces today's `[JOURNAL]`, `[JOURNAL-NEW]`, and most of `[DIGEST]` |
| `[TOPIC-NEW: person=X slug=Y purpose="..." [fields=...] [cadence=...]]` | memory_writes (op=create_topic) | Stand up a new tracked topic for a person |
| `[DIGEST: reason]` | memory_writes (op=trigger_digest) | Force-regenerate compressed view / per-person rollups |
| `[MERGE-PERSONS: from=X into=Y]` | memory_writes (op=merge_persons) | Owner-initiated identity merge across channels |
| `[CRON: recurrence — payload]` | crons table | Schedule recurring work |
| `[REMIND: in 2h — text]` | crons table (one-shot) | One-time future action |

**Strict semantics:** markers are bonus persistence, never a substitute
for the chat reply text. Clean (marker-stripped) text is always sent
first; markers fire in parallel.

---

## Interfaces

Stable contracts so backends are swappable in isolation.

| Interface | Current backend(s) | Status | Future-proofing |
|---|---|---|---|
| `AiProvider` | Claude, Codex | ✅ shipped | Add a third by writing one file |
| `ChannelAdapter` | Baileys (WhatsApp) | not abstracted yet | Add `TelegramAdapter` later; sender worker stays untouched |
| `Queue` | in-memory fastq | 🚧 to do | SQLite-backed; later swap to Postgres if needed |
| `Memory` | flat markdown + jsonl | 🚧 to do (Phase 5) | Rebuild as observations table; views become queries |
| `Storage` (media blobs) | filesystem | not abstracted yet | Could become S3/GCS later |

**ChannelAdapter:**
```ts
interface ChannelAdapter {
  channel: string
  send(addr: Address, msg: OutboundMessage): Promise<{ msg_id: string }>
  start(onInbound: (msg: InboundMessage) => void): Promise<void>
}
```

The point of interfaces isn't future-proofing for its own sake — it's
that **changing the backend should be a one-file diff**, not a
codebase-wide grep-and-replace.

---

## Schedules — the crons table

```sql
CREATE TABLE crons (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  enqueue_into  TEXT NOT NULL,   -- 'inbound' | 'async' | 'outbound' | 'memory_writes'
  payload       TEXT NOT NULL,   -- JSON passed to the target queue
  recurrence    TEXT,            -- cron expression OR null for one-shot
  next_run_at   INTEGER NOT NULL,
  last_run_at   INTEGER,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);
```

**Replaces today's hardcoded timers:**
- Memory sweep
- Topic-observer pass (formerly journal-observer)
- Topic-nudge ticks (formerly journal-nudger)
- Media retention prune
- Daily token quota reset
- Prompt log prune
- Browser tab janitor (new)
- Outbox file cleanup (new)
- Compressed rollup regeneration
- Database backup (new — see Migrations & Backups)

**Unlocks new feature surface:**
- `[CRON:...]` marker
- `[REMIND:...]` one-shot scheduler
- "Snooze conversation for 2 hours"
- Per-topic cadence overrides
- "Re-validate IG/TT logins every Sunday" → cron row firing into
  browser queue

### System inbound (cron-fired self-prompts)

When `[REMIND: in 2h]` fires, the cron inserts an inbound row with
`address='system:cron:<id>'` and payload containing the original
person/context. The chat worker treats it as a self-prompt ("you
scheduled this earlier — text the owner now"). The reply still goes
through outbound to the real WA/TG address (resolved from the payload).

---

## Migrations & Backups — never lose production data

The bot already has productive data. Every schema change must be safe
to apply on top of it without losing or corrupting anything. AI-written
migration runners are exactly the wrong place to roll our own — use a
battle-tested framework.

### Migration framework — Drizzle (used minimally)

**Pick: drizzle-orm + drizzle-kit.** Use the minimum surface:
- `drizzle-orm` for **schema definitions** (one TypeScript source of
  truth — also gives us types in callers).
- `drizzle-kit generate` to produce **plain SQL migration files** when
  the schema changes. Files are committed to the repo and reviewed by
  a human before merging.
- `drizzle-orm/better-sqlite3/migrator` to **apply pending migrations
  at boot**. Tiny one-liner; no separate CLI runner needed.

What we **don't** use, to keep things simple:
- `drizzle-kit push` (no-migrations dev mode — too magical for prod data).
- `drizzle-kit pull` (reverse-engineering — we own the schema).
- Heavy relational query syntax (`relations()`, `with: { … }`). Stick
  to the basic typed query builder; drop to raw `sql\`...\`` when it's
  cleaner.
- ORM-style "model" patterns. The schema files are just table
  declarations.

```ts
// src/db/schema.ts — the one source of truth for table shape
import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core'

export const topics = sqliteTable('topics', {
  personId:  text('person_id').notNull(),
  slug:      text('slug').notNull(),
  purpose:   text('purpose').notNull(),
  cadence:   text('cadence'),
  status:    text('status').notNull().default('active'),
  createdAt: integer('created_at').notNull(),
}, t => ({
  pk: primaryKey({ columns: [t.personId, t.slug] }),
}))
```

```bash
# When you change schema.ts, generate a migration file:
npx drizzle-kit generate
# → produces migrations/0007_add_topics.sql (plain SQL, human-reviewable)
```

```ts
// src/db/migrate.ts — called from the boot path
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'

export function runMigrations(dbPath: string) {
  preMigrationBackup(dbPath)  // VACUUM INTO storage/backups/pre-migration-<ts>.db
  const db = drizzle(new Database(dbPath))
  migrate(db, { migrationsFolder: './migrations' })
}
```

That's the whole thing. ~3 lines of glue, schema definitions, one
config file (`drizzle.config.ts`). No down migrations, no push mode,
no codegen magic beyond "write a `.sql` file from a schema diff."

**Skip:** knex, typeorm, MikroORM, umzug. Drizzle's minimal surface
covers it.

### Production-deploy workflow

The whole point of the framework is making schema changes safe on a
running bot with real data. Workflow per change:

1. **Edit `src/db/schema.ts`** to reflect the new shape.
2. **Generate the migration**: `npx drizzle-kit generate`. Drizzle
   diffs schema vs the snapshot of the last generated migration and
   writes a new `migrations/NNNN_*.sql` file.
3. **Read the generated SQL.** Always. It's plain SQL — verify it does
   what you expect (especially for renames/drops; drizzle's diff sees
   "column gone + new column" as a drop+add, not a rename). Edit the
   SQL by hand if you need the atomic-rename pattern instead. The
   migration file is what runs in prod, not the diff inference.
4. **Dry-run against prod-shape data:**
   ```
   cp storage/heyamigo.db /tmp/test.db
   DB_PATH=/tmp/test.db node -e "require('./dist/db/migrate').runMigrations(process.env.DB_PATH)"
   ```
   Verify it applies cleanly. Inspect with `sqlite3 /tmp/test.db .schema`.
5. **Commit + push the SQL file AND the updated `schema.ts`.** Both are
   now immutable.
6. **Deploy.** On bot boot:
   - `runMigrations()` runs.
   - **Pre-migration backup first** (`VACUUM INTO`) — only when there
     are pending migrations.
   - Drizzle's migrator reads `__drizzle_migrations` table, computes
     pending, applies in a transaction.
   - If any throws → transaction rolls back, bot refuses to start,
     error logged. Restore is one CLI call away.
   - If all succeed → bot starts normally.

**The bot never starts with an unmigrated schema.** This is the single
production-safety guarantee that matters: code and schema versions are
always in lockstep.

### Cardinal rule: every schema change goes through drizzle

DDL is drizzle-only. Application data (INSERT/UPDATE/DELETE through
the workers) is whatever — typed query builder or raw SQL, doesn't
matter. But **the shape of the database** is owned by `src/db/schema.ts`
+ committed migration files, and nothing else may change it.

If you bypass drizzle with an ad-hoc `ALTER TABLE` (sqlite CLI in prod,
a one-off "fix", a hot-patch on the live DB), the `__drizzle_migrations`
table no longer matches reality. The next `drizzle-kit generate` will
produce a diff against the wrong baseline, the next deploy will either
fail or — worse — silently apply a "migration" that breaks the
inconsistent schema. There's no good recovery path that doesn't involve
manually rebuilding the migrations table from scratch.

**Forbidden:**
- `sqlite3 storage/heyamigo.db` followed by any `CREATE`/`ALTER`/`DROP`.
- "Just this once" schema patches in prod to fix a bug.
- Running unfinished migration SQL by hand to "test."
- Editing the production DB to recover from a bad migration. Restore
  from backup instead.

**Required for any schema change, without exception:**
1. Edit `src/db/schema.ts`.
2. `npx drizzle-kit generate` → produces SQL file in `migrations/`.
3. Read the SQL.
4. Commit both files together.
5. Deploy.

**Defenses to enforce the rule:**

- **Boot-time drift check.** After running pending migrations, the boot
  path introspects the live schema (via better-sqlite3's
  `db.prepare("SELECT sql FROM sqlite_master WHERE type='table'")`) and
  compares against drizzle's expected schema. Any drift → bot refuses
  to start, logs the diff. This catches both "you forgot to generate a
  migration" and "someone touched the DB out-of-band."
- **CI check.** Pre-merge hook runs `drizzle-kit generate --dry` and
  fails if the schema and migrations are out of sync (i.e., a schema
  change was committed without a matching migration file).
- **No SQL CLI on prod hosts.** Operationally — `sqlite3` binary isn't
  installed on the deploy box. To inspect prod, copy the DB locally and
  query there. Slightly inconvenient, prevents 99% of "let me just fix
  this" temptation.
- **`db check` chat command.** `/db check` runs the drift introspection
  on demand and reports. Useful both as a regular health check and as
  the first step when something feels off.

**If drift happens anyway** (because it eventually will, especially
during dev): the recovery is to `litestream restore` to a known-good
point, then re-deploy with the correct schema state. Don't try to
patch the migrations table by hand.

### Migration safety principles (framework-agnostic)

These are dev discipline, not framework features. Bake them in:

1. **Forward-only.** `down()` is non-functional by policy. To undo, write
   a new forward migration that reverses the change. Down migrations
   are rarely tested and almost always broken when you need them.
2. **Migration files are immutable after ship.** Never edit an applied
   file. Always add a new one. If you edit a file after it's been
   applied somewhere, the deployed schema diverges silently from what
   the framework thinks is applied.
3. **Never drop+add in one migration.** Use **two-phase** changes for
   anything destructive:
   - Phase A (migration N): add new column, code dual-writes.
   - Live for a release cycle: backfill complete, all writes use new
     column, no code reads old.
   - Phase B (migration N+k): drop old column.
4. **Atomic rename pattern for SQLite** (modern SQLite has `RENAME
   COLUMN`, but for table-shape changes prefer this for safety):
   ```sql
   CREATE TABLE outbound_new ( /* new schema */ );
   INSERT INTO outbound_new SELECT ... FROM outbound;
   DROP TABLE outbound;
   ALTER TABLE outbound_new RENAME TO outbound;
   /* recreate indexes */
   ```
   All inside one migration file → one transaction → atomic.
5. **Backfills go in migrations**, in the same transaction as the
   schema change that needs them. Never rely on application code to
   backfill — that creates a window where the schema is inconsistent.
6. **Pre-migration backup is non-negotiable.** A 10-line glue function
   in the boot path runs `VACUUM INTO 'storage/backups/pre-migration-<ts>.db'`
   before invoking the migrator. Trivial, atomic, saves you when
   something goes wrong.
7. **Test against prod-shape data before every deploy.** The dry-run
   step above. Especially important for backfills — a migration that
   takes 200ms on an empty DB might take 4 minutes on real data.

### Backup framework — Litestream

For continuous backup, use **Litestream**. It's a small Go daemon that
streams the SQLite WAL to a backup target (S3, GCS, SFTP, local dir),
giving point-in-time recovery to any second within the retention
window. Used in production by serious deployments (Fly.io built it).
Zero application code involved.

```yaml
# litestream.yml
dbs:
  - path: /app/storage/heyamigo.db
    replicas:
      - url: s3://my-bucket/heyamigo
        retention: 30d
      - path: /backup/local/heyamigo   # second target, defense in depth
        retention: 30d
```

Run `litestream replicate -config litestream.yml` next to the bot
(systemd service, docker sidecar, whatever). Restore: `litestream
restore -o storage/heyamigo.db s3://my-bucket/heyamigo`.

**Skip:** writing our own backup-on-cron logic. Litestream does it
better and is the right tool.

### Backup layers (defense in depth)

| Trigger | What's captured | Retention | Where |
|---|---|---|---|
| Continuous (Litestream) | Every WAL frame | configurable, default 30d | S3/GCS/SFTP/local |
| Pre-migration | DB file via `VACUUM INTO` | last 10 | `storage/backups/pre-migration-<ts>.db` |
| Manual `/snapshot` chat command | DB + `storage/media/` + `storage/outbox/` tarball | indefinite (user managed) | `storage/backups/manual-<ts>.tgz` |
| External (user's responsibility) | rsync `storage/` to off-box | indefinite | offsite |

Litestream is the primary recovery path. Pre-migration local snapshots
are insurance against framework bugs. Manual snapshots are for "I'm
about to do something scary." External rsync is the user's call.

### Restore

CLI: `heyamigo restore <backup.db>` or `heyamigo restore --from-litestream <url>`:
1. Refuse if bot is running (`workers` table has live rows). Force with
   `--force`.
2. Move current `storage/heyamigo.db` aside to
   `storage/heyamigo.before-restore-<ts>.db`.
3. Copy/replicate backup into place.
4. Start bot. Migrations run as normal — restored DB may predate
   current schema; migrator brings it forward (and takes its own
   pre-migration backup, so you can re-restore if that fails too).

### Storage file layout

```
storage/
  heyamigo.db                 ← SQLite (queues, observations, persons, control, etc.)
  media/                      ← inbound media blobs
  outbox/                     ← outbound media the agent generated
  backups/
    pre-migration-*.db
    manual-*.tgz
  auth/                       ← Baileys session state
```

Litestream's replica state lives wherever you point it (S3 bucket,
mounted volume, etc.) — outside `storage/`.

---

## Access control — stays file-based

`access.json` is already in production with real data. Don't migrate it
to the database. Extend the schema instead so roles attach to
`person_id` (cross-channel) but ownership and editing stays in the
file.

```jsonc
// config/access.json
{
  "defaults": {
    "unknown_role": "stranger",
    "auto_create_persons": true
  },
  "roles": {
    "owner": {
      "tools": "all",
      "tags": "all",
      "limits": { "daily_tokens": null, "max_file_mb": 100 }
    },
    "friend": {
      "tools": ["Read", "Grep", "Glob", "Bash", "WebFetch"],
      "tags": ["ASYNC", "OBSERVE", "SEND-IMAGE", "SEND-DOC"],
      "limits": { "daily_tokens": 100000, "max_file_mb": 5 }
    },
    "stranger": {
      "tools": ["Read", "WebFetch"],
      "tags": [],
      "limits": { "daily_tokens": 5000, "max_file_mb": 1 }
    },
    "blocked": null
  },
  "persons": {
    "person-owner": {
      "display_name": "Cata",
      "role": "owner",
      "addresses": [
        "wa:dm:17867276503@s.whatsapp.net",
        "tg:dm:user_12345"
      ]
    },
    "person-alex": {
      "display_name": "Alex",
      "role": "friend",
      "addresses": ["wa:dm:5491234@s.whatsapp.net"]
    }
  }
}
```

**Migration from today's JID-keyed format is one-shot at boot:**
- Each existing entry → wraps into a `person-<hash>` with the JID as a
  `wa:dm:...` address.
- Owner becomes `person-owner`.
- The transformed file is written back; the original is preserved as
  `access.json.pre-v0.9.bak`.

**Resolution at message arrival:**
1. Inbound message has `address: 'wa:dm:1786...'`.
2. Look up address across `persons.*.addresses` → find `person-owner`.
3. Look up `persons['person-owner'].role` → `'owner'`.
4. Look up `roles.owner` → tool list, tag list, limits.
5. Apply to the chat worker call: restrict tools, gate tags, enforce
   limits.

If no person matches the address:
- If `auto_create_persons=true` → create a new entry with role from
  `defaults.unknown_role`, write back to file, notify owner via outbound.
- Else → role is `defaults.unknown_role`, no file write (in-memory only).

**Reload semantics.** `/reload` (already exists) re-reads `access.json`.
File-watcher could pick up edits automatically; not required for v1.

**No database tables for access.** The `persons` and `identities`
tables described in the Identity model still exist (queue rows
reference them) but they're *populated from access.json on boot*, not
the source of truth. Two writes per new person on auto-create: file +
DB row. Acceptable because new persons are rare events.

**Permission enforcement points** (same as the DB-backed design):
- Tools restricted at the AiProvider call site (`runTask({ allowedTools })`).
- Disallowed tags stripped from agent output post-parse — if a
  stranger emits `[CRON:...]`, drop silently and log a warning.
- Daily token limits enforced before the AI call (existing behavior).
- File-size limits enforced at media upload (existing behavior).

**`[GRANT-ROLE:]` marker** still works, but it edits `access.json`
through the memory worker (single writer = no race on file edits).

---

## Observability — concrete queries

```sql
-- "is something stuck?"
SELECT count(*) FROM inbound       WHERE status='claimed' AND claimed_at < ?(now-120);
SELECT count(*) FROM outbound      WHERE status='sending' AND claimed_at < ?(now-30);
SELECT count(*) FROM memory_writes WHERE status='claimed' AND claimed_at < ?(now-60);

-- "what's the backlog?"
SELECT 'inbound'       n, count(*) FROM inbound       WHERE status='pending'
UNION ALL SELECT 'outbound',      count(*) FROM outbound      WHERE status='pending'
UNION ALL SELECT 'async',         count(*) FROM async         WHERE status='pending'
UNION ALL SELECT 'browser',       count(*) FROM browser       WHERE status='pending'
UNION ALL SELECT 'memory_writes', count(*) FROM memory_writes WHERE status='pending';

-- "are workers alive?"
SELECT kind, status, count(*) FROM workers
  WHERE last_seen > ?(now-30) GROUP BY kind, status;

-- "what's failing repeatedly?"
SELECT * FROM outbound WHERE attempts >= 3 ORDER BY updated_at DESC LIMIT 10;

-- "dead-lettered today?"
SELECT count(*) FROM dlq WHERE created_at >= ?(today_start);

-- "what crons are due next?"
SELECT name, enqueue_into, next_run_at FROM crons
  WHERE enabled=1 ORDER BY next_run_at LIMIT 10;

-- "who is the most active person across all channels?"
SELECT person_id, count(*) c FROM observations
  WHERE ts >= ?(now - 7days) GROUP BY person_id ORDER BY c DESC LIMIT 10;

-- "schema state" (Drizzle tracks in __drizzle_migrations)
SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 5;
```

A `/queues` slash command runs these and replies as a chat message.
The bot introspects itself.

---

## Special case — images always async

When media is present on inbound, route to the async queue instead of
the chat lane. Send a short inline ack ("looking…") via outbound. The
real reply arrives later via async worker. ~20 lines in
`gateway/incoming.ts`; lands cleanly inside the queue model.

---

## Phased migration

Lowest risk first. Each phase ships independently and earns its keep
before the next starts.

### Phase 0 — Identity model + Drizzle + Litestream (~1.5 days, before everything)
Pure infrastructure + utility work:
- Add deps: `better-sqlite3`, `drizzle-orm`, `drizzle-kit` (dev).
- `src/db/schema.ts` with `persons`, `identities`, `workers`, `control`
  tables.
- `drizzle.config.ts` pointing at schema + `migrations/`.
- `npx drizzle-kit generate` → first migration `0001_init.sql`. Review
  the generated SQL; commit both schema + migration.
- `src/db/migrate.ts`: pre-migration `VACUUM INTO` backup + drizzle
  migrator call. Invoked from the boot path.
- `src/db/check.ts`: post-migration drift check (introspect live
  schema, compare against drizzle's expected, refuse to start on
  mismatch). Ships with Phase 0 so the discipline is enforced from day
  one, not bolted on later.
- Install Litestream on the deploy host, point it at the bot's SQLite
  file, replicate to S3 (or whichever target).
- `parseAddress(jid) → Address` helper.
- One-shot transform of `access.json` from JID-keyed to person-keyed
  format (preserving the file as the source of truth; the `persons`
  table is populated *from* it on boot, not the reverse).
- Backfill `persons` + `identities` from `access.json` on first boot.

### Phase 1 — Outbound queue + ChannelAdapter (~1.5 days)
- Media-capable outbound table
- `[SEND-*]` tag handlers
- ChannelAdapter interface + BaileysAdapter
- Sender worker, retry, backoff, rate-limit, media-size cap
- Idempotency keys, claimed_by completion check
- Foundation for everything that follows

### Phase 2 — Cron table + orchestrator skeleton + graceful shutdown (~1.5 days)
- Orchestrator polling loop
- `control` table + shutdown/pause semantics
- Worker heartbeats
- Cron migration: each `setInterval` moves to a cron row
- Daily/weekly backup crons

### Phase 3 — Always-async on images (~0.5 day)
Route media-bearing inbound to async + inline ack.

### Phase 4 — Inbound + async + browser ticket queues, MCP pooling (~4 days)
The hot-path rewrite.
- Move chat-track from fastq to SQLite inbound queue
- Move async lanes similarly
- Browser lane → multi-worker pool, drop persistent session
- Long-lived MCP processes (one per browser slot)
- Tab ownership + cleanup janitor
- Per-address serialization

### Phase 5 — Observations log + memory_writes (~2 days)
- `observations` + `topics` tables
- Memory worker draining memory_writes queue
- Migrate `[JOURNAL]`/`[JOURNAL-NEW]`/`[DIGEST]` → `[OBSERVE]`/`[TOPIC-NEW]`/`[DIGEST]`
- Generated views replace profile.md / brief.md / journals/*.jsonl
- Compressed rollup regenerated from observations on cron
- Backfill: read existing markdown/jsonl into observation rows

### Phase 6 — Access control extension (~0.5 day)
Stays file-based; just extend the existing access.json schema.
- One-shot transform from JID-keyed to person-keyed format (preserves
  original as `access.json.pre-v0.9.bak`).
- Per-tag permission gate in chat worker (reads from `roles.<X>.tags`).
- `[GRANT-ROLE:]` marker edits access.json via the memory worker.
- `/reload` already re-reads the file; no new mechanism needed.

### Phase 7 — Observability + dashboards (~1 day, optional)
- `/queues` slash command
- Periodic queue-depth logging
- DLQ inspector
- HTTP endpoint for external monitoring (bearer-token auth)

### Phase 8 — Second ChannelAdapter (when needed)
Implement `TelegramAdapter`, wire into config. Sender + queue schema
already support it from Phase 1.

**Total core work: ~2 weeks.** Phases 7-8 are separate, days-scale
when actually needed.

---

## Honest risks

- **Premature complexity.** Mitigation: ship phases independently;
  live with each for at least a few days.
- **SQLite lock contention.** At owner-bot scale (1000 msgs/day),
  irrelevant. If we ever need real concurrency, swap behind Queue.
- **Crash semantics need testing.** The `claimed_by` check on `markDone`
  is the load-bearing primitive. Write a test for "slow worker comes
  back after reclaim."
- **Browser tab leaks during dev.** Janitor must be solid; expect to
  restart Chrome occasionally during Phase 4.
- **Memory read-after-write latency.** Fine for durable observations;
  problematic only if a feature ever depends on real-time consistency.
- **Person identity merge conflicts.** Owner-initiated merge via
  `[MERGE-PERSONS:]` handles it.
- **Channel adapter inconsistency.** WA quotes, TG replies, edits,
  reactions all differ. Either lowest-common-denominator OR an opaque
  `channel_extras: json` column the adapter reads.
- **Migration mistakes.** The single biggest data-loss risk. Defenses:
  forward-only, immutable files, two-phase destructive changes,
  pre-migration backup, `--dry-run` before risky ones.

## What we'd lose by NOT doing this

- Bot stays a hobby-grade single-process thing
- No crash resilience
- No programmatic interface for external triggers
- Cron-like features keep being hardcoded
- Browser parallelism capped at 1
- Memory writes silently lose data under any parallelism
- Adding Telegram is a codebase-wide rewrite
- Memory remains a five-place taxonomy
- AI can't send media back without bespoke wiring
- "Is the bot stuck?" stays a vibes-based answer
- Schema changes risk data loss
- No backup/restore story

## Open questions to decide before Phase 1

- SQLite file location: `storage/heyamigo.db` (co-located for backup
  parity).
- Migration files location: `migrations/` at repo root (drizzle-kit
  default). Schema in `src/db/schema.ts`. Both are committed.
- Litestream replica target: S3? GCS? An SFTP box you already own?
  Whatever you trust. Configurable per-deploy.
- Worker IDs: `${hostname}-${pid}-${slot}` is enough.
- Rip fastq entirely after Phase 4? Yes — one queue mechanism is simpler
  than two.
- Outbox retention: match `storage.mediaRetentionDays` (default 7).
- Outbound media size cap: 25MB? 50MB? WA limits vary by type.
- Auto-create persons on first contact, or require owner approval?
  Default auto + `[NEW-PERSON:]` notification to owner; off-switch
  in `access.json`.
- How to handle channel-specific message features (reactions, edits,
  reply threading)? Lowest-common-denominator OR opaque
  `channel_extras: json` column.
- Litestream retention: 30d default OK? Storage cost scales with
  message volume + retention.
- `access.json` schema migration: do it as part of Phase 0 (atomically
  with the DB tables) or defer until Phase 6? Probably Phase 0 — the
  identity model depends on the new format anyway.

## Out of scope / deferred (declared so they don't creep in)

- Multi-tenant (one process serving multiple bot identities).
- Per-person AI provider selection.
- Real-time consistency for memory reads.
- Down-migrations.
- Distributed deployment (multi-node).
- Web UI / dashboard beyond the `/queues` chat command.
