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

## 2026-05-24  Phase 3  Deferred

refactor.md Phase 3 is "always-async on images" — route media-bearing
inbound to the async lane + ack inline. As written, this assumes the
chat lane is the bottleneck being unblocked. With single-concurrency
fastq, that's true today.

But the actual fix is "parallel chat workers" (Phase 4). Once chat
has N pooled workers serialized per-address, the bottleneck disappears
naturally — a heavy image task on chat A doesn't block chat B.

If I shipped Phase 3 against the existing async-task lane, the image
handling would use a different agent framing (background-worker
prompt) than the chat track. That's a regression in UX — the agent's
voice would change between text and image messages.

Decision: defer Phase 3 until after Phase 4. Once chat is parallelized,
either Phase 3 becomes unnecessary (problem solved) OR the
implementation is much cleaner (route through chat lane as normal, the
pool handles concurrency).

## 2026-05-24  Phase 4  Per-address serialization in claim filter

The defining feature of the inbound queue. `claimNextInbound` does:

```sql
WHERE status='pending'
  AND address NOT IN (SELECT address FROM inbound WHERE status='claimed')
```

Two workers claim simultaneously → they MUST get different addresses
(if there are messages for both available). Same address → strict
order, only one worker at a time per chat.

Validated end-to-end with 4 messages (2 per address, 2 addresses):
- worker-1 + worker-2 each claim a distinct address
- worker-3 claims null (both addresses busy)
- worker-1 finishes → worker-3 picks up the next msg on the freed
  address

This is the single most important correctness invariant of the whole
refactor. Get this wrong and replies arrive out of order in chat,
which breaks conversational coherence. Get it right and the bot
scales linearly with concurrent active chats.

Implementation note: did the busy-addresses lookup as a `notInArray`
in TS rather than a subquery, because drizzle's subquery API is
awkward and the busy set is tiny in practice (≤ N where N = chat
worker pool size, ≤5 for our use case). If it ever scales past
hundreds of busy addresses simultaneously, swap to a SQL subquery.

## 2026-05-24  Phase 4  Inbound backoff slower than outbound

Outbound: 1s/5s/30s/2min.
Inbound: 5s/30s/2min/5min.

Reason: a transient inbound failure usually means the AI provider
timed out or the model rate-limited us. Retrying in 1s would just hit
the same wall + burn tokens. The 5min cap means a really wedged
provider gives us a 5min cooldown before DLQ, which is closer to
what the rate-limit headers typically request.

If we ever see ops where the inbound failure mode is something fast
to recover (e.g. local resource contention), tune the schedule.

## 2026-05-24  Phase 4  externalMsgId as inbound idempotency

Outbound uses `idempotency_key` (an arbitrary string set by the
producer). Inbound uses `external_msg_id` (the channel-native message
id). Different fields, same role.

Why split: outbound idempotency is producer-driven ("don't double-
send if I crash + retry"). Inbound idempotency is platform-driven
("don't double-process if WA delivers the same message twice on
reconnect"). The channel-native id is the natural key for the second
case; we never make it up.

Sparse unique index — enforced only when externalMsgId is set. Lets
us insert internal messages (cron-fired self-prompts in later phases)
without conjuring fake message ids.

## 2026-05-24  Phase 4  Two entry points → one boot module

Found while refactoring: heyamigo has TWO main() functions —
`src/index.ts` (the npm package's `main` entry) and `src/cli/start.ts`
(the CLI binary's `dev` subcommand). Originally they did very similar
work; over time they'd drift.

After Phase 0/1/2/3 changes, src/index.ts was up to date but
cli/start.ts was still calling the old replayPending path. Worse,
cli/start.ts is the ACTUAL production entry (npm bin →
dist/cli/index.js → cli/start.ts.main()). Users running `heyamigo
start` would have been running pre-refactor code.

Fix: extracted everything into `src/boot.ts` (`bootBot` +
`installShutdownSignals`). Both entry files now do ~5 lines of glue.

Lesson: anywhere there's a duplicate "main" function, it's a drift
bomb. Worth a one-off check for any other parallel paths
(e.g. supervisor.ts, cli/index.ts subcommands) to make sure they go
through the shared boot when they need the queues.

## 2026-05-24  Phase 4  Typing indicator deferred (regression)

The old incoming.ts started a typing-indicator heartbeat at message
arrival and stopped it after handleReply finished. With the chat
worker pool, the worker (not the gateway) owns that lifecycle, AND
typing is a channel-specific action (Telegram has its own typing API).

Right architecture: add `sendTyping(externalId, state)` to
ChannelAdapter, have the chat worker call it at busy/idle
transitions. ~30 lines, deferred to a follow-up commit.

Today's regression: no typing indicator. Bot still works, just no
"typing…" UI in chats.

## 2026-05-24  Phase 4  Producer-built Job vs claim-time rebuild

Two options for how the chat worker gets the Job:
  (a) Producer (incoming.ts) builds the Job at enqueue time,
      serializes into inbound.payload, worker deserializes.
  (b) Producer puts only raw fields in inbound, worker rebuilds the
      Job at claim time.

Option (b) is cleaner architecturally — fresh state at claim time
means a retry after memory updates would use fresh context. But it
requires moving buildMemoryPreamble + buildInitPayload + getSession
into the worker, AND buildInitPayload needs the WASocket (group
metadata lookup).

For Phase 4 I chose (a): less code moved, less risk. The Job is built
once at ingest and replayed verbatim if the worker retries. Acceptable
for now; if retry-with-fresh-memory becomes important, the migration
is well-scoped (move 3 functions, give worker access to getSocket()).

## 2026-05-24  Phase 4  Old fastq queue stays, just orphaned

`src/queue/queue.ts` and `src/queue/persistence.ts` no longer have
any importers (verified via grep). Left them in place rather than
deleted — they're harmless, and a separate cleanup commit makes the
swap diff smaller / easier to review.

`replayPending` is no longer needed at all: the inbound table IS the
source of truth, so anything pending at restart gets claimed by the
new chat workers automatically. No special replay path.

Validated by booting the bot to QR-code-display, observing all
expected log lines (backup → migrate → identity sync → orchestrator →
sender → chat pool of 5 → scheduler → socket), confirming all 8
expected tables exist in the fresh DB.

## 2026-05-24  Phase 7  /queues snapshot format

Shipped the `/queues` chat command early (refactor.md says Phase 7
"optional") because with 5 parallel chat workers + sender + cron
firings, the bot now has a lot more moving parts. Without
observability, "is something stuck?" is unanswerable from chat.

Output format chosen for **mobile WhatsApp readability**: bold section
headers, 2-space indented detail lines, `·` separator between fields.
~10-15 lines typical. Fits on a phone without scrolling. The
markdown bold (`*foo*`) renders natively in WA.

Sections:
- queues: pending / in-flight / failed / dlq per table
- workers: counts by kind × status, surfaces stale (>30s no
  heartbeat) and dead workers
- stuck: claims past their TTL (outbound 60s, inbound 360s) — these
  are about to be reclaimed by the orchestrator
- failures: top 5 recent rows with attempts > 0
- crons: next 5 due, with relative time

One bug found in writing: stuck-claim query checked
`status='claimed'`, but outbound transitions through 'sending' during
the adapter call. Fixed to match either. Detection of stale outbound
claims now works.

## 2026-05-24  Phase 7  Slash command via late dynamic import

`/queues` handler in commands.ts uses `await import(
'../queue/observability.js')` instead of a static import. Reason:
commands.ts is already loaded early (before DB init for some paths)
and importing observability.ts would transitively load the singleton
DB handle module. Lazy import means the command only pulls the module
on first invocation, after the DB is definitely initialized.

Pattern worth repeating for other DB-touching commands that get
wired up later.

## 2026-05-24  Phase 5a  Memory writes through single worker (no obs log yet)

Phase 5 in refactor.md has two parts: (a) memory_writes queue with
single-writer serialization, (b) observations log replacing the
journal/profile/brief split. Shipped (a) only.

The race window from Phase 4 was real: 5 parallel chat workers calling
appendEntry/createJournal/scheduleDigest directly on the same files
could lose data on full-file rewrites or fork journal-creation
attempts. (a) closes that without changing the storage model.

Implementation:
- memory_writes table (op + payload JSON + idempotency_key + claim
  cols). One queue, four ops today: append_journal, create_journal,
  trigger_digest, mark_compressed_dirty.
- Memory worker: single concurrency by design. Drains FIFO. Op
  switch dispatches to existing handlers in src/memory/.
- worker.ts + async-tasks.ts (general + browser lanes) all stopped
  calling memory handlers directly. They enqueueMemoryWrite. Memory
  worker drains serially.

Idempotency keys: `chat-<jid>-<ts>-<kind>-<index>` / `async-<task-id>-...`
/ `browser-<task-id>-...`. A retry of the producing call (e.g. chat
worker retry on transient AI failure) re-enqueues with the same key
→ memory writes don't double-apply.

What part (b) — observations log — would do that (a) doesn't:
- Replace per-feature memory files (profile.md, brief.md,
  journals/*/entries.jsonl) with one observations table.
- Profiles / journals become views (queries).
- Cross-person observations become natural (subject vs speaker).
- Compressed.md becomes generated rollup.

That's a fundamentally different data model and a much bigger change
(touches the agent tag set: [OBSERVE: person=X kind=fact ...]
replaces [JOURNAL:] / part of [DIGEST:]; touches the digest pipeline;
needs a backfill from existing markdown to observations rows). Worth
doing as its own focused project later. The race-condition gap is
closed; the rest is incremental.

Validated end-to-end: enqueued create + append + duplicate-append +
mark_dirty → all 3 unique rows reach 'done', journal file created on
disk with exactly 1 entry (duplicate blocked by idempotency).

## 2026-05-24  Phase 6  Per-tag permission gate (file-based)

Implemented per-role tag allowlist in access.json. Existing tools
allowlist stays untouched — tools and tags are independent gates:
- tools: what the AI itself can call (Read, Bash, etc.)
- tags: what bot-internal side effects it can trigger (DIGEST,
  ASYNC, SEND-TEXT, etc.)

Defaults in DEFAULT_ROLES:
- admin → tags: 'all' (no restriction)
- user  → tags: ['DIGEST', 'JOURNAL', 'JOURNAL-NEW']
- guest → tags: [] — pure chat, no side effects at all.

Schema field is optional. Existing access.json files (no `tags`)
keep working — the field defaults via the per-field merge in
resolveRoles to whatever DEFAULT_ROLES defines for that role name.

filterFlagsByRole in digest-flag.ts is the enforcement point. Runs
right after extractFlags in queue/worker.ts. Stripped tags get
logged ('tags stripped by role gate') so we can spot users who keep
hitting the gate.

async-tasks doesn't need its own gate. It already drops [ASYNC:] /
[ASYNC-BROWSER:] from its own output (no recursion). So the gate at
chat-track entry covers escalation completely.

Validated with three role tiers: guest strips everything, user
passes journals but strips async+sendText, admin passes all.

## 2026-05-24  Phase 4  Browser pool (minimal, in-memory)

Bumped async-tasks browserQueue concurrency from 1 → config-driven
(default 3). Dropped persistent agent session entirely — every
browser task is a fresh agent run.

Why "minimal" and not "durable browser ticket queue":
- The bot's existing browser usage doesn't need crash resilience
  for in-flight browser tasks (acceptable to re-trigger from chat).
- A SQLite-backed browser_tasks table is a lot of new code for
  marginal value over the current in-memory fastq.
- The headline parallelism win (multiple browser tasks at once)
  comes from concurrency bump + persistent-session drop, not from
  the storage swap.

Trade-off accepted: cross-task agent memory is gone. The chat-track
agent's [ASYNC-BROWSER:] descriptions are self-contained, so this is
fine in practice. Removed:
- loadBrowserSession / saveBrowserSession / resetBrowserSession
- browser-session-<provider>.json files (no longer touched; existing
  files become orphans on disk, harmless)
- BrowserSessionState type

Tab isolation enforced by prompt instruction: the worker's first
action is `browser_tabs({action: 'new'})`; subsequent operations
stick to that tab; close on finish. Other workers' tabs are visible
via the shared Chrome but the prompt forbids touching them.

Risk: tab leak if a worker crashes before closing. The browser tab
janitor cron (refactor.md mentions this) would handle that — not
shipped yet; for now expect to occasionally need a Chrome restart
during dev.

Config: `config.browser.maxWorkers` (default 3). 5 was refactor.md's
target but 3 is safer for shared rate-limited sites like IG/TT.

Migration to durable browser queue (the "real" Phase 4 browser pool
per refactor.md) is now well-scoped: copy the inbound queue pattern,
make a browser_tasks table, swap fastq for claim/done. Deferred until
in-flight crash resilience for browser tasks becomes a felt need.

## 2026-05-24  Phase 3  Reframed as "media ack" not "always async"

Original Phase 3 in refactor.md: "route media-bearing inbound to
async + send inline ack." The premise was the chat lane was a
bottleneck for image-heavy chats.

After Phase 4's chat worker pool, that premise no longer holds:
- Different chats are fully parallel (5 workers)
- Per-chat reply ordering is the right invariant (don't let reply N+1
  arrive before reply N)
- Per-chat serialization IS the desired behavior — re-routing images
  through the async lane would break ordering for that chat

The actual UX gap left over from Phase 4 is the typing indicator
regression: users get no immediate feedback that the bot received
their message, especially painful for image messages that take 5-30s
to analyze.

Shipped a smaller, better-targeted fix: on media-bearing inbound,
send a quick "looking…" text via outbound IMMEDIATELY (sub-second,
microseconds to enqueue + ~1s for sender worker to push). Chat
worker then processes the actual reply normally. User gets one ack
+ one reply.

Configurable via reply.ackOnMedia (default true) and
reply.mediaAckText (default 'looking…'). Owner-bot-friendly default
behavior, easy to disable.

Idempotency on the ack: `media-ack-<msg-id>` so a Baileys retransmit
of the same incoming message doesn't double-ack.

Long-term: ChannelAdapter.sendTyping() would let us bring back the
genuine typing indicator across channels (Telegram has its own
typing API). That's a separate small commit — next entry.

## 2026-05-24  Phase 2  Last setInterval migrated to cron

memory/scheduler.ts's sweepTimer → enqueueCron('memory-sweep',
'@every <sweepIntervalMs>s', internal handler). Same cadence, same
body; orchestrator drives it. stopScheduler no longer clears the
interval (cron row is durable, orchestrator handles shutdown).

Remaining setIntervals in the codebase are worker heartbeats (sender,
memory, chat, orchestrator) — those correctly stay as setInterval
because heartbeats must fire even when the orchestrator tick loop is
delayed.

## 2026-05-24  Phase 4  Typing indicator regression closed

ChannelAdapter gained optional sendTyping(externalId, state).
BaileysAdapter implements via sock.sendPresenceUpdate.

Chat worker's startTyping() fires 'composing' every 10s (WA presence
expires ~15s) for the duration of a claimed job. stopTyping clears
the interval and sends 'paused' on completion.

Optional on the interface → channels without typing support silently
skip. Errors swallowed in the adapter (typing is UX nicety, never
block real send work).

Closes the regression from Phase 4's swap. Typing indicator is back
to roughly pre-refactor behavior.

## 2026-05-24  Phase 4  Durable browser ticket queue

In-memory fastq → SQLite-backed browser_tasks table. Tasks now
survive process crashes; orchestrator reclaims stuck rows via TTL.

Schema mostly mirrors inbound (id, address, status, attempts,
nextAttemptAt, lastError, claimedBy, claimedAt, createdAt, updatedAt)
plus browser-specific fields: description, originatingMessage,
senderNumber, senderName, allowedTools (JSON string).

NO per-address serialization (unlike inbound). Multiple browser
tasks for the same chat CAN run concurrently — each opens its own
tab on the shared Chrome, replies go via outbound which preserves
per-chat ordering naturally.

TTL chosen at 20 min — generous because browser tasks routinely run
5-15 min (Playwright sessions are slow).

Backoff: 30s / 5min / DLQ. Sparser than other queues because most
browser failures are deterministic (login wall, bot detection) and
won't benefit from rapid retries.

Architecture:
- src/queue/browser-queue.ts: enqueueBrowserJob + claim/done/retry
  helpers + reclaimStuckBrowserTasks for orchestrator.
- src/queue/browser-worker.ts: pool of N workers (config.browser
  .maxWorkers, default 3). Each claims a row, converts to the
  existing AsyncTask shape, calls runBrowserTask (existing body,
  just exported now).
- async-tasks.ts enqueueBrowserTask refactored: builds AsyncTask
  for return-value compat (callers in worker.ts don't change), but
  inserts into browser_tasks instead of pushing to fastq.

Worker pool registers in workers table on start, heartbeats every
5s, dies on stopBrowserWorkers.

DLQ ack: when a browser task hits max retries, the worker sends a
user-facing 'failed, ask me again' message to the originating chat.
Mirrors what the old in-memory path did on failure.

Validated end-to-end:
- 2 tasks inserted, 2 workers claimed in parallel (different ids).
- Third claim returns null (no more pending).
- markDone with wrong worker fails (claimed_by check).
- Boot path starts all workers: orchestrator, sender, memory,
  browser pool (3), chat pool (5), scheduler.
- All 10 expected tables exist on a fresh DB.

Last bit of in-memory fastq is the GENERAL async lane (the non-
browser [ASYNC:] tasks). Could migrate to its own SQLite-backed
queue with the same pattern, but that's a small additional win and
deferred.

## 2026-05-25  Estimates  Job duration estimation (image-gen first)

Plugin-architecture estimator system. Each kind is a self-contained
file under src/estimates/, registered via registerEstimator() at
module load. Outside callers touch only `classify(ctx)` and
`estimate(ctx)`.

Always-returns-an-estimate semantics: when a kind matches, the
estimator falls back to its `defaultMs` if no samples exist.
0 → default; 1 → that one sample; N → mean of last 20 done rows.

Layout:
- src/estimates/types.ts — interfaces
- src/estimates/registry.ts — registerEstimator/classify/estimate/
  querySamplesForKind/aggregateMean/humanDur
- src/estimates/image-gen.ts — first plugin (regex matcher,
  defaultMs=30s, custom format text)
- src/estimates/index.ts — imports all plugins (their imports trigger
  self-registration) and re-exports the public surface

Schema: ALTER TABLE inbound ADD kind TEXT + index on (kind, status).
Set at ingest in gateway/incoming.ts from classify(ctx). Chat worker
writes the duration sample naturally when it marks status='done'.

incoming.ts integration:
- classify(ctx) → if matched, immediately enqueueOutbound the
  estimate text + tag inbound row with the kind.
- If NO estimator matched AND media is present, fall back to the
  existing "looking…" media-ack so that UX doesn't regress.

Decisions:
- mean, not median (user spec). Vulnerable to outliers; range
  disclosure mitigates. Could swap to trimmed-mean later.
- Sample limit 20. Past that, freshness > breadth.
- Confidence buckets: <5 low, 5-9 medium, ≥10 high. Future hedging
  language can hook off this.
- Range disclosed only when stddev > 50% of mean (otherwise a single
  point estimate).

Validated end-to-end on a fresh DB:
- 0 samples       → "generating image, ~30s" (default)
- 1 sample (35s)  → "generating image, ~35s"
- 4 samples       → "generating image, ~34s" (low confidence)
- 5 with outlier  → "generating image, anywhere from ~1s to ~3min"
- "hi how are you" → no classification → no estimate

Adding the next kind (browser:ig, voice-gen, …) = drop file alongside
image-gen.ts + add one import line to estimates/index.ts. No other
code changes.

## 2026-05-25  Stats  Context % showed 7018% (cumulative-vs-per-turn bug)

User saw a footer reading `15s · 14015k↑ (6566k cached) 22k↓ · ⚠ 7018% ctx`.
14M tokens per turn is impossible against a 200k window.

Root cause: the bot was designed assuming providers report per-turn
usage (true for Claude CLI's `result.usage`). When we added Codex
support, Codex's `turn.completed.usage` reports CUMULATIVE totals
across the whole resume thread. After many turns the cumulative
total dwarfed the window, producing nonsense percentages.

Fix:

1. **AiProvider gains `usageReportingMode: 'per-turn' | 'cumulative'`.**
   Claude = per-turn, Codex = cumulative. Provider declares its own
   semantics; worker dispatches off this.

2. **SessionUsage gains `cumulative*` fields** (optional, back-compat).
   Stores the running cumulative so the next turn can delta against
   it.

3. **Worker.ts callClaude does delta math.**
   - If cumulative provider: turn = current - prev. Cumulative
     stored = current (the CLI's running total).
   - If per-turn provider: turn = current. Cumulative stored = prev +
     current (we maintain the running sum ourselves for /status).
   - Math.max(0, …) protects against the rare counter-reset case.
   - First-turn-after-deploy fallback: if cumulative* not stored
     yet, use the buggy plain `inputTokens` as the cumulative
     baseline. Loses one turn of accuracy then recovers.

4. **outputTokens NO LONGER in totalContextTokens.** Output is the
   response, not the prompt. Context % should be prompt-only
   (input + cache_read + cache_create). Old code summed output
   too, which would have been wrong even on Claude.

5. **Cosmetic clamp in footer.** If computed pct > 120%, skip the
   ctx callout entirely. Catches:
   - The one-time recovery turn after this fix deploys (stale
     pre-fix data still in baseline → wrong delta).
   - Any future provider that introduces a new semantic surprise.
   Better to show nothing than `7018% ctx`.

6. **`/status` reads the same per-turn `totalContextTokens`** so the
   "X / 200k (Y% left, last turn)" line is now meaningful instead of
   sum-of-all-turns-ever.

Validated all four matrix cells (cumulative-fresh, cumulative-
running, per-turn-fresh, per-turn-running) + the bug-recovery
scenario. Bug-recovery turn shows 3290% (impossible, hidden by
clamp); next turn would be accurate.

## 2026-05-25  Timeouts  Bumped spawn caps + matching claim TTLs (/goal support)

User wanted CLI /goal mode to work without bot-side detection or
routing. /goal in Claude Code / Codex can run multi-hour sessions;
old 5min main-lane spawn cap killed them prematurely.

Bumps in src/ai/spawn.ts:
  main:       5 min → 30 min
  async:     15 min → 60 min
  background: 3 min →  5 min   (small bump for safety; these are
                                housekeeping ops that should be fast)

Critical co-change in queue files — claim TTL MUST exceed spawn
timeout. Otherwise the orchestrator's stuck-claim reclaimer fires
on a still-running spawn and a second worker claims the same row,
producing duplicate work:

  src/queue/inbound.ts        CLAIM_TTL: 6 min → 35 min
  src/queue/browser-queue.ts  CLAIM_TTL: 20min → 65 min

5min headroom past spawn cap = orchestrator only reclaims rows whose
worker actually died (process crashed, OOM-killed, etc.), not rows
whose worker is still running near the cap.

Outbound (60s) + memory_writes (60s) TTLs unchanged — those workers
don't spawn AI calls, just file I/O / Baileys send. Fast operations,
short TTLs stay appropriate.

Known side effect: per-address serialization means a 30min /goal
locks that ONE chat for 30min. Different chats are unaffected (chat
pool has 5 workers serving different addresses in parallel). If
multi-threading within one chat ever becomes a felt need, the route-
goals-to-async option I sketched earlier closes that gap. For now,
acceptable.

Three files changed:
  - src/ai/spawn.ts: TIMEOUT_MS constants
  - src/queue/inbound.ts: CLAIM_TTL_SECONDS
  - src/queue/browser-queue.ts: CLAIM_TTL_SECONDS

No new behavior — just larger caps. /goal traffic now survives long
enough to complete.
