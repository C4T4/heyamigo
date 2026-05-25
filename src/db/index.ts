// Process-wide SQLite handle. Initialized once at boot in src/index.ts
// (and in any other entry point that needs DB access, like `setup`).
// Workers and other modules get the handle via `getDb()` — never open
// their own.

import type Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { resolve } from 'path'
import * as schema from './schema.js'
import { runMigrations } from './migrate.js'
import { checkSchemaDrift } from './check.js'

let rawDb: Database.Database | null = null
let ormDb: BetterSQLite3Database<typeof schema> | null = null

export function dbPath(): string {
  return resolve(process.cwd(), 'storage', 'heyamigo.db')
}

// Run migrations + drift check + open the singleton. Call once per
// process at boot. Idempotent — subsequent calls return the existing
// handle without re-migrating.
export function initDb(): BetterSQLite3Database<typeof schema> {
  if (ormDb) return ormDb
  const path = dbPath()
  rawDb = runMigrations(path)
  checkSchemaDrift(rawDb)
  ormDb = drizzle(rawDb, { schema })
  return ormDb
}

export function getDb(): BetterSQLite3Database<typeof schema> {
  if (!ormDb) throw new Error('db not initialized; call initDb() at boot')
  return ormDb
}

export function getRawDb(): Database.Database {
  if (!rawDb) throw new Error('db not initialized; call initDb() at boot')
  return rawDb
}

// Used by graceful shutdown.
export function closeDb(): void {
  if (rawDb) {
    rawDb.close()
    rawDb = null
    ormDb = null
  }
}
