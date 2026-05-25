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
