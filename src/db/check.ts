// Schema drift detector. Runs after migrations succeed. Compares the
// live database's table set against the set drizzle's schema.ts
// declares, refuses to start on mismatch.
//
// What this catches:
//   - "Forgot to run `drizzle-kit generate` after editing schema.ts"
//     → migration didn't include the new table; drift detected.
//   - "Someone ran `ALTER TABLE` directly in prod" → extra columns or
//     missing columns vs. schema.ts.
//
// What this does NOT catch (intentionally — keeps the check simple
// and predictable):
//   - Column type changes that SQLite stored compatibly.
//   - Index differences (drizzle doesn't always emit identical CREATE
//     INDEX text; comparing index DDL is fragile).
//   - Drift in non-drizzle tables (e.g. __drizzle_migrations itself).
//
// If we ever need stricter checking, add it here behind a config flag.
// Start strict-but-narrow; loosen if it bites.

import type Database from 'better-sqlite3'
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core'
import { logger } from '../logger.js'
import * as schema from './schema.js'

type ColumnInfo = { name: string; notnull: number; pk: number; type: string }

export class SchemaDriftError extends Error {
  constructor(public readonly diffs: string[]) {
    super(`schema drift detected:\n  - ${diffs.join('\n  - ')}`)
    this.name = 'SchemaDriftError'
  }
}

export function checkSchemaDrift(db: Database.Database): void {
  const diffs: string[] = []

  // Discover declared tables by walking the schema module's exports.
  // SQLiteTable is a real class; instanceof is the cleanest discriminator.
  const declared = Object.values(schema)
    .filter((v: unknown): boolean => v instanceof SQLiteTable)
    .map(t => getTableConfig(t as SQLiteTable))

  const liveTables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle_%'",
    )
    .all() as Array<{ name: string }>
  const liveTableNames = new Set(liveTables.map(r => r.name))

  for (const t of declared) {
    if (!liveTableNames.has(t.name)) {
      diffs.push(`missing table: ${t.name}`)
      continue
    }
    const liveCols = db
      .prepare(`PRAGMA table_info(${t.name})`)
      .all() as ColumnInfo[]
    const liveColNames = new Set(liveCols.map(c => c.name))
    const declaredColNames = new Set(t.columns.map(c => c.name))

    for (const c of t.columns) {
      if (!liveColNames.has(c.name)) {
        diffs.push(`${t.name}: missing column "${c.name}"`)
      }
    }
    for (const name of liveColNames) {
      if (!declaredColNames.has(name)) {
        diffs.push(`${t.name}: unexpected column "${name}" (drift)`)
      }
    }
  }

  // Unexpected tables (drift from out-of-band CREATE TABLE)
  for (const name of liveTableNames) {
    if (!declared.some(t => t.name === name)) {
      diffs.push(`unexpected table "${name}" (drift)`)
    }
  }

  if (diffs.length > 0) {
    logger.fatal({ diffs }, 'schema drift detected; bot refuses to start')
    throw new SchemaDriftError(diffs)
  }

  logger.debug({ tables: declared.map(t => t.name) }, 'schema check passed')
}
