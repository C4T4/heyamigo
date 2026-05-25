# Refactor scrap log

Decision log for the heavy refactor described in `refactor.md`. Each
entry: what came up, what I chose, why. Append-only; if a decision is
revised later, add a new entry that points back, don't edit history.

Format: `YYYY-MM-DD  Phase N  short title` followed by the body.

---

## 2026-05-24  Phase 0  Starting work

Plan for the opening commit cycle:
- Install `drizzle-orm` + `drizzle-kit` + `better-sqlite3`.
- Schema in `src/db/schema.ts` — Phase 0 tables only (persons,
  identities, workers, control). Queue tables come in Phase 1.
- `drizzle.config.ts` at repo root (drizzle-kit's default).
- Migration files at `migrations/` (repo root) per the open-questions
  decision in refactor.md.
- `src/db/migrate.ts` — pre-migration `VACUUM INTO` backup glue +
  drizzle's `migrate()` call.
- `src/db/check.ts` — drift introspection. Compares
  `sqlite_master` rows to drizzle's expected schema, refuses to start
  on mismatch.
- `src/db/address.ts` — Address type + parseAddress/formatAddress.
- Wire DB init into the boot path in `src/index.ts`. **Additive only**
  — existing flat-file storage (`sessions.json`, memory files,
  access.json) remains the source of truth for now. SQLite carries new
  data (persons, workers, control) and provides the migration
  scaffolding. Real swap-overs happen in later phases.

## 2026-05-24  Phase 0  better-sqlite3 over node:sqlite

Node 22+ ships a native `node:sqlite`. Considered using it instead of
better-sqlite3. Rejected because:
- We support node >=18 (per package.json engines); node:sqlite needs 22.
- drizzle-orm's sqlite dialect targets better-sqlite3 by default. Using
  node:sqlite would require drizzle's `bun-sqlite` adapter or custom
  glue; not "keep it simple."
- better-sqlite3 is the reference path for drizzle examples; less
  guessing about edge cases.

## 2026-05-24  Phase 0  Migration files location

Repo root `migrations/` chosen over `src/migrations/`:
- drizzle-kit default — zero config friction.
- They're plain SQL, not application code; keeping them out of `src/`
  signals that intent.
- `tsconfig.json` excludes them by default (rootDir=src), so no build
  surprises.

## 2026-05-24  Phase 0  Schema.ts shape

Single file `src/db/schema.ts` for now. As the schema grows past ~5-10
tables, split per-area (`src/db/schema/queues.ts`,
`src/db/schema/identity.ts`) and re-export from an index. Not worth
the ceremony at 4 tables.

## 2026-05-24  Phase 0  Migration name discipline

First mistake: ran `drizzle-kit generate` without `--name`, got
`0000_empty_mysterio.sql`. Renamed the file manually → broke the
journal because drizzle tracks migrations by `tag` (the filename
stem), not by content hash. Recovered by deleting + regenerating with
`--name phase0_identity_control`.

**Rule going forward:** always pass `--name <descriptive_snake_case>`
to `drizzle-kit generate`. Never rename a generated migration file
post-hoc — it desyncs the journal silently.

## 2026-05-24  Phase 0  Address representation

JID-to-address mapping in `src/db/address.ts`. Kept the full JID
(including `@s.whatsapp.net` or `@g.us` suffix) as the `externalId`
rather than stripping it to just the number. Reasons:
- Lossless round-trip (no risk of mis-reconstructing the JID).
- Easier debugging (the address string is human-readable).
- `@lid` and `@newsletter` get mapped to wa:dm and wa:group
  respectively but their suffixes survive, so we never accidentally
  hand `1234567` (a number) to Baileys when it expected
  `1234567@s.whatsapp.net`.

Trade-off: addresses are longer (~30 chars vs ~10). Worth it for
correctness; storage is cheap.

## 2026-05-24  Phase 0  WAL mode for SQLite

`initDb` sets `journal_mode = WAL` immediately on open. Two reasons:
- Litestream requires WAL to stream WAL frames.
- Concurrent readers + one writer works much better in WAL than the
  default rollback journal. Multiple workers will be reading the queue
  tables while the orchestrator writes.

Side effect: creates `heyamigo.db-shm` and `heyamigo.db-wal` files
alongside the DB. Backups (`VACUUM INTO`) handle this transparently
— the snapshot is a single file.

## 2026-05-24  Phase 0  Drift check scope

`src/db/check.ts` only checks (a) declared tables exist, (b) declared
columns exist, (c) no unexpected tables exist, (d) no unexpected
columns exist. **Does NOT check:** column types, indexes, foreign
keys, constraints.

Reasons for narrow scope:
- SQLite stores column type as advisory text ("INTEGER", "TEXT") and
  affinity, not strict. Type comparison gets philosophical fast.
- drizzle's index DDL doesn't always match what SQLite stores in
  `sqlite_master.sql` byte-for-byte (whitespace, quoting, order).
- Strict-as-possible drift check + flaky internals = false-positive
  treadmill. Narrow but reliable beats strict-but-flaky.

The check catches the two failure modes that actually bite: out-of-
band `CREATE TABLE` and "forgot to generate a migration." That's the
80/20.

## 2026-05-24  Phase 0  Smoke test pattern

Validated Phase 0 end-to-end by:
1. `npm run build`
2. `cd /tmp/scratch && mkdir -p config && cp $repo/config/config.example.json config/`
3. `node -e "import(...).initDb()"` from the scratch dir
4. Inspect with `sqlite3 storage/heyamigo.db .tables`
5. Inject drift (`CREATE TABLE rogue`), re-run initDb, expect throw

Both happy path and drift-detection path verified. Worth scripting
this as `scripts/smoke-db.sh` later, but not yet — current footprint
is small enough to redo by hand.

## 2026-05-24  Phase 0  Additive-not-replacing

The DB is open + workers/control/persons/identities tables exist, but
**nothing reads or writes them yet**. All existing flat-file storage
(sessions.json, memory/, access.json) remains the source of truth.
Phase 0 only delivers the scaffolding. Real swap-overs (sessions →
DB queue, access.json sync to persons table, etc.) happen in the
later phases that need them.

This means Phase 0 is genuinely zero-risk to ship: even if there's a
bug in the migration runner, the bot still operates on flat files.

## 2026-05-24  Phase 0  Package-relative migrations path

First version of `runMigrations` resolved `migrations/` from
`process.cwd()`. That's wrong for npm-installed users: cwd is the
user's project directory, not the package install. The migration SQL
files ship inside the package's `files` array, so the path has to be
package-relative.

Used the same `__pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')`
trick that `src/cli/setup.ts` already uses. From `dist/db/migrate.js`
two `..` jumps lands at the package root, which is where
`migrations/` lives.

Also added `migrations/` to the `package.json` `files` array so it
actually ships when published.

Validated: ran initDb from a scratch dir with no local migrations/ —
worked. Migrations resolved from the package install path.

Pattern to remember: anything the bot needs at runtime that ships with
the package (migration SQL, config templates, personalities,
knowledge files) must (a) be in the `files` array, (b) be resolved
relative to the package root, not cwd.

## 2026-05-24  Phase 0  Reversed plan on access.json transform

refactor.md said Phase 0 would "transform access.json from JID-keyed
to person-keyed format, preserving original as .bak". After actually
reading the existing schema in `src/wa/whitelist.ts`, I'm reversing
that decision.

The existing access.json is richer than the doc captured: it has
`roles` (with description/memory/tools/rules/maxFileBytes/dailyTokenLimit),
`users` (number→{role,name}), `defaults` (groupRole/dmRole), `groups`
(array with allowedSenders/proactive/mode), and `dms` (defaultMode +
allowed array). There's no benefit to restructuring it just for
multi-channel readiness — the file works.

**New decision: don't touch access.json at all in Phase 0.** Instead,
derive `persons` + `identities` rows from the existing file via a
sync function. The file stays authoritative; DB rows are a derived
view so future queue rows can JOIN against `person_id` cheaply.

Mapping logic in `src/db/identity-sync.ts`:
- `config.owner.number` → `person-owner` (with display name from
  matching access.users entry if any).
- Each entry in `access.users` → `person-<digits-only>` (unless it
  matches the owner number, in which case it collapses into
  `person-owner`).
- Each entry in `access.dms.allowed` → ensure person exists (might
  already from `users`).
- Groups are addresses, not persons — skipped.
- Idempotent: re-running upserts display_name and adds new
  identities, never deletes.

Cost of the reversal: refactor.md is now slightly out of date. The
broader access-control-stays-file-based posture (already in the doc)
absorbs this neatly though — the doc says "DB tables are populated
from access.json on boot, not the reverse" which is exactly what's
implemented. No doc edit needed; this scrap entry captures the
narrower decision.

## 2026-05-24  Phase 0  Person ID format

`person-<digits-only>` derived from the phone number. Stable +
deterministic + human-readable. Tradeoffs:
- Predictable: a new sync of the same access.json always produces the
  same person IDs, so re-running can't accidentally fork identity.
- Not anonymous: the number is in the ID. For a single-owner bot this
  is fine; for any multi-tenant future, we'd want opaque UUIDs.
- The owner gets the special id `person-owner` instead of
  `person-<their-number>`. Makes owner-specific code paths
  self-documenting.

If we ever want to merge two persons (`[MERGE-PERSONS:]` marker in
refactor.md), we use the merge_persons op in memory_writes to point
all identities at the surviving person_id and delete the dead one.

## 2026-05-24  Phase 1  Quoting deferred (known regression)

`handleReply` used to embed the original WAMessage as a quoted reply
in group chats (`config.reply.quoteInGroups`). The Baileys API needs
the full WAMessage object embedded in `contextInfo`, not just an id.

The outbound queue carries only `quote_msg_id` (a string). To support
quoting properly through the queue we'd need to:
  (a) serialize the WAMessage into the outbound row JSON, or
  (b) keep an in-memory LRU of recent WAMessages by id that the
      sender worker can rehydrate from.

Option (b) is the right answer (lossless, no schema growth) but
deferred. For Phase 1, group replies just lose the quote — visible
regression. Note this in the refactor.md tracker and fix in a small
follow-up slice once Phase 1 is stable.

## 2026-05-24  Phase 1  Post-send bookkeeping = sender worker's job

The pre-refactor `handleReply` did three things per piece:
  1. Send via `sock.sendMessage`
  2. `await append(...)` to the message log
  3. `unlinkSync(filePath)` for media files

If we keep (2) and (3) in `handleReply` while routing (1) through a
queue, the log gets populated BEFORE the send actually happens. Worse,
if the bot crashes mid-queue, the message log claims the bot said
things it didn't.

Decision: move (2) and (3) into the sender worker, in a `afterSend`
hook that runs *after* `markOutboundDone` returns true. The log
reflects what was actually sent. Media files get cleaned up only when
the send succeeded.

Edge: file cleanup is opt-out for files in `config.storage.mediaDir`
(inbound media has its own retention cron). Everything else
(claude-generated outbox stuff, files Claude wrote to /tmp) gets
unlinked.

## 2026-05-24  Phase 1  Idempotency key format

`reply-<jid>-<ts>-<piece-idx>` and `initiate-<jid>-<ts>-<piece-idx>`.

Why include the timestamp: handleReply might be called multiple times
for the same job (e.g. orchestrator reclaims a slow chat worker and
the original eventually returns). Without a timestamp, the second
call's inserts would collide with the first's by piece index and
silently no-op (good — that's idempotency) — but if the jobs are
actually different (different replies), the second one would be
swallowed.

The timestamp guarantees different invocations get different key
prefixes; collisions only happen within a single invocation (which
is what we want, to dedupe). Once the inbound queue lands in Phase 4
we'll switch to `from-inbound-<id>-<piece-idx>` which is cleaner —
the inbound id is stable per message regardless of when handleReply
fires.

## 2026-05-24  Phase 1  Backoff schedule + TTL + max attempts

- Backoff: 1s, 5s, 30s, 2min. After the 4th attempt → DLQ.
- TTL for sender-side reclaim: 60s (config? no — hardcoded for now,
  fine for single-instance sender).
- Max outbound media cap: 25MB (matches WA limits for most kinds).
  Configurable via `reply.maxOutboundMediaBytes`, null = unlimited.

These are all judgment calls picked from refactor.md. Worth revisiting
if real ops show different numbers are needed.

## 2026-05-24  Phase 1  Sender worker stays single-instance

Pool size 1. Two reasons:
  - Preserves per-address message ordering naturally (the only worker
    has to send them in claim order).
  - WA throttles per-IP; multiple parallel senders don't help and
    risk bans.
If we ever want per-channel parallelism (e.g. one WA sender + one TG
sender), we'd add a `channel` filter to the claim query so each
sender only picks rows for its channel. Cheap to add later.

## 2026-05-24  Phase 1  Baileys error classification

Transient vs Permanent split is a heuristic based on substrings in
the error message ("connection closed", "timed out", "socket", etc).
Brittle but pragmatic — Baileys doesn't expose typed errors. If we
ever miscategorize and DLQ a transient error or retry-loop a
permanent one, add to the substring list and ship.

Worst case: a permanent error miscategorized as transient gets
retried 4 times then DLQ'd. Visible in `outbound` rows, no data loss.
Acceptable.

## 2026-05-24  Phase 1  SEND-* tag scope cut

refactor.md tag inventory listed four SEND-* tags:
  - `[SEND-IMAGE: path — caption]`
  - `[SEND-DOC: path — caption]`
  - `[SEND-AUDIO: path]`
  - `[SEND-TEXT: address=X body=Y]`

Reality check after seeing the existing code: the bot already supports
inline `[FILE:]`, `[IMAGE:]`, `[VIDEO:]`, `[AUDIO:]`, `[DOCUMENT:]`
tags via `extractFiles()` in `gateway/outgoing.ts`, and my Phase 1
refactor routed those cleanly through the new outbound queue. The
first three SEND-* tags would just duplicate existing functionality
with slightly different ergonomics (trailing position + explicit
caption vs inline + adjacent-text caption).

Decision: **defer SEND-IMAGE / SEND-DOC / SEND-AUDIO indefinitely**.
The existing `[FILE:]` family already covers the use case and is
working end-to-end through the queue. Adding parallel tags creates
two ways to do the same thing → drift, agent confusion, more code.

**Ship `[SEND-TEXT: address=X body="..."]` only.** It's the genuinely
new capability: cross-chat text send. Without it, the agent has no
way to text a different chat than the one it's responding in. Wired
through worker.ts (main chat replies) AND both async-task lanes
(general + browser) so any agent context can use it.

Payload format: `address=<addr> body="<text>"`. Body in double
quotes so it can contain spaces. Future extension if needed:
multiple `address=` entries for multi-target broadcast (not yet).

Parser validates both address and body are present; missing either
→ the tag is dropped silently with a log line. Safer than partial.

If we ever need explicit-caption media markers, revisit then. For
now: simpler tag surface, less duplication.

## 2026-05-24  Phase 2  Orchestrator tick interval = 500ms

Polling-based design (vs event-driven). Tick interval 500ms is the
compromise between:
  - Responsiveness: shutdown signal picked up within ~500ms of being
    written; stuck-claim reclaim happens within ~500ms of TTL expiry.
  - Database load: 2 reads/sec at idle (control table + workers
    table). Trivial for SQLite.
  - Battery / cpu: 2 wakeups/sec is fine for a long-running daemon.

If we ever want sub-second responsiveness (probably not for our use
case), the right path is a NOTIFY-style mechanism — but SQLite has no
LISTEN/NOTIFY. We'd have to use file watches or in-process event
emitters. Not worth it.

## 2026-05-24  Phase 2  Worker-dead threshold = 30s

`WORKER_DEAD_AFTER_SECONDS = 30` means a worker is declared dead if
its last_seen is older than 30s. Heartbeats fire every 5s, so a live
worker should never trigger this — even with 1 missed heartbeat (5s
delay) we'd be at 10s, well under threshold.

The threshold being 30s gives a comfortable margin for:
  - Brief GC pauses
  - Network/disk hiccups (the heartbeat is a DB write)
  - Slow handlers that don't yield often

If we ever want stricter detection (e.g. browser worker crashed
mid-task and we want its job back fast), bump heartbeat to 1s and
threshold to 5s. Trade-off: more DB writes.

## 2026-05-24  Phase 2  Graceful shutdown via control table, not signal

Old design: SIGTERM handler calls stopSenderWorker + closeDb + exit
inline. Problem: any in-flight send gets aborted mid-call → message
may or may not have been delivered; outbound row may or may not be
marked done.

New design: SIGTERM writes a `shutdown` row to the control table.
Orchestrator picks it up, marks self draining, waits until no worker
has status='busy', then runs the drain hook (stopSenderWorker +
closeDb) and exits.

Why this is better:
  - Workers complete their CURRENT job before exiting. Outbound rows
    don't get orphaned in `sending` state with the worker dead.
  - Same mechanism works for /shutdown chat command, HTTP webhook,
    `heyamigo shutdown` CLI — all just write to the same table.
  - Pause/reload signals piggyback on the same control infrastructure.

Safety net: 30s force-exit timer set when shutdown is requested. If a
worker truly hangs and never frees its claim, the bot exits anyway.
Orphaned `sending` rows get reclaimed on next boot via TTL check.

Validated end-to-end: started orchestrator, registered a fake busy
worker, requested shutdown, watched orchestrator wait (not exit),
freed the fake worker, watched orchestrator exit cleanly.

## 2026-05-24  Phase 2  Cron recurrence formats (no general cron parser)

refactor.md left the cron expression format open. Surveyed the
existing setInterval timers in the codebase:
- memory sweep: every 3h
- journal observer pass: same 3h sweep
- journal nudge tick: every Nm (configurable, default 10m or so)
- media retention prune: daily-ish
- prompt log prune: daily-ish
- daily token quota reset: midnight in owner tz

None of them need cron expressions like `0 */4 * * MON-FRI`. Three
formats cover all:
  - `@every <n><s|m|h|d>`     for the "every N units" cases
  - `@daily HH:MM`            for the midnight resets and daily prunes
  - `@weekly DOW HH:MM`       for future "every Sunday rebuild logins"

Decision: ship just these three. No general cron parser. If we ever
need it, drop in `croner` or similar — but adding now would be
unjustified surface area.

The `@daily` and `@weekly` formats fire in **owner timezone**, not
UTC. Implemented via Intl.DateTimeFormat + a guess-and-correct
makeDateInTz helper. Avoids pulling in luxon/date-fns for the one
calculation we need.

## 2026-05-24  Phase 2  Cron name uniqueness for recurring only

`crons.name` has a UNIQUE index, but **only when recurrence IS NOT
NULL** (partial index). Why:
- Recurring crons are typically registered once at boot and might be
  re-registered on every startup. Uniqueness gives us natural upsert
  — `enqueueCron({name: 'memory-sweep', recurrence: '@every 3h', ...})`
  on every boot just keeps one row.
- One-shots (`recurrence: null`) are usually agent-emitted
  (`[REMIND: ...]`) — multiple distinct reminders might share an
  agent-generated name. Don't constrain those.

If we ever want named one-shots with uniqueness too, agents can pick
unique names. The default is "no constraint, multiples allowed."

## 2026-05-24  Phase 2  Cron-dispatch is per-target-queue

`src/queue/cron-dispatch.ts` switches on `enqueueInto`. Today only
`outbound` is wired (the only queue that exists). When inbound /
async / memory_writes queues land in Phase 4 + Phase 5, add their
dispatch arms. The cron table schema doesn't change.

Idempotency for cron-fired outbound: dispatcher fills in
`idempotency_key = cron-<name>-<now-seconds>` if the payload doesn't
specify one. Means the same recurring cron firing twice within the
same second (shouldn't happen, but cron tick + retry could in theory)
won't double-insert. One-shot crons can supply their own key if they
need cross-process dedup.

## 2026-05-24  Phase 2  Added 'internal' cron target

Original refactor.md cron design assumed all targets were queues
(inbound / async / outbound / memory_writes). Reality: a lot of the
existing setInterval timers are pure in-process work — call a
function, no queue involved. journal-nudge-tick is the obvious example
(it just runs `runNudgeTick()`).

Without an 'internal' target, every timer migration would have to
wait until its appropriate queue exists (Phase 4 inbound, Phase 5
memory_writes). That's blocking.

Added `enqueueInto: 'internal'`. Payload shape: `{ handler: <name> }`.
The dispatcher looks the name up in a registry (`src/queue/cron-
handlers.ts`) and invokes the function. Registry is populated by
modules at boot via `registerInternalCronHandler(name, fn)`.

This is the right escape hatch: we get to migrate timers immediately
without inventing a queue per category, and the registry surface is
tiny (~30 lines). Long-term we'd expect each handler to either stay
internal (genuinely process-local work) or get rewritten as a
queue+worker pair when the work needs distribution / crash
resilience.

## 2026-05-24  Phase 2  Migrated journal-nudge tick to cron (proof)

First setInterval moved to a cron entry. Picked the nudge tick because:
- Simple body (one function call), no queue interactions yet.
- Independent of the existing sweep — risk-isolated.
- High-frequency enough (every 5 min) to be observable in testing.

Pattern:
```
registerInternalCronHandler('journal-nudge-tick', runNudgeTickSafe)
enqueueCron({
  name: 'journal-nudge-tick',
  enqueueInto: 'internal',
  payload: { handler: 'journal-nudge-tick' },
  recurrence: '@every 300s',
})
```

The `enqueueCron` is idempotent on name for recurring → restarting the
bot doesn't reset the nextRunAt or duplicate the row. First boot ever
schedules first run at `now + 300s`, matching setInterval's "first
callback after the interval" semantics.

Validated end-to-end: started orchestrator + scheduler with `@every
1s` recurrence and a counting handler; observed 3 firings in 2.5s
(orchestrator ticks every 500ms, so each due cron gets dispatched
within ~500ms of its nextRunAt). lastRunAt advances after each fire.

Bulk migration of the remaining setIntervals (sweep, prune timers,
daily quota reset) deferred to a future commit. The pattern is proven
and each timer migration is now mechanical.

## 2026-05-24  Phase 2  stopScheduler does NOT delete the nudge cron

Old `stopScheduler` cleared the nudge setInterval. Migration changed
the question: do we delete the cron row when stopping, or leave it?

Decision: leave it. The cron row is durable state; stopping the
process should not edit it (would be surprising and would re-arm on
next boot anyway since `enqueueCron` is idempotent).

For "actually disable nudges" the user-facing knob is
`setCronEnabled('journal-nudge-tick', false)`. For full removal there's
`deleteNudgeCron()` (exported). Neither is reachable by users yet —
add a `/nudge off` / `/nudge on` chat command in Phase 7's
observability work.
