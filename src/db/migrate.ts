// Migration runner. Called once at boot from src/index.ts before any
// worker spins up. Order: pre-migration backup → drizzle migrator →
// drift check (in src/db/check.ts). If anything throws, the bot
// refuses to start.

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { logger } from '../logger.js'

// Resolve `migrations/` relative to the package install, not cwd. When
// installed via npm, the bot runs from the user's project dir but the
// migration SQL files ship inside @c4t4/heyamigo. From src/db/migrate.ts:
//   dist/db/migrate.js  ←  __filename
//   dist/db/            ←  dirname
//   dist/               ←  ../
//   <pkg root>/         ←  ../../
//   <pkg root>/migrations
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const MIGRATIONS_FOLDER = resolve(PKG_ROOT, 'migrations')
const BACKUP_DIR_NAME = 'backups'
const KEEP_PRE_MIGRATION_BACKUPS = 10

// VACUUM INTO is atomic and produces a fully consistent copy even
// while the DB is being written to. Trivial insurance before any
// schema change. Skip if no pending migrations to avoid noise on
// no-op boots.
function preMigrationBackup(dbPath: string): string | null {
  // Cheap check: open the DB, ask the migrator what would happen.
  // We can't easily query "what's pending" without invoking drizzle's
  // internals, so instead we check whether our migrations folder has
  // more entries than the drizzle tracking table claims.
  const sqlFiles = existsSync(MIGRATIONS_FOLDER)
    ? readdirSync(MIGRATIONS_FOLDER).filter(f => f.endsWith('.sql'))
    : []
  if (sqlFiles.length === 0) return null

  let appliedCount = 0
  if (existsSync(dbPath)) {
    const probe = new Database(dbPath, { readonly: true, fileMustExist: true })
    try {
      const row = probe
        .prepare(
          "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'",
        )
        .get() as { n: number }
      if (row.n > 0) {
        const counted = probe
          .prepare('SELECT count(*) AS n FROM __drizzle_migrations')
          .get() as { n: number }
        appliedCount = counted.n
      }
    } finally {
      probe.close()
    }
  }

  if (appliedCount >= sqlFiles.length) return null // up to date, nothing to back up for

  const backupDir = resolve(dirname(dbPath), BACKUP_DIR_NAME)
  mkdirSync(backupDir, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = resolve(backupDir, `pre-migration-${ts}.db`)

  if (existsSync(dbPath)) {
    const tmp = new Database(dbPath, { readonly: true, fileMustExist: true })
    try {
      tmp.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`)
    } finally {
      tmp.close()
    }
    logger.info({ backupPath }, 'pre-migration backup written')
  } else {
    // No DB yet — nothing to back up. Boot will create it fresh.
    return null
  }

  rotatePreMigrationBackups(backupDir)
  return backupPath
}

function rotatePreMigrationBackups(backupDir: string): void {
  const files = readdirSync(backupDir)
    .filter(f => f.startsWith('pre-migration-') && f.endsWith('.db'))
    .map(f => ({ name: f, path: resolve(backupDir, f), mtime: statSync(resolve(backupDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  const toDelete = files.slice(KEEP_PRE_MIGRATION_BACKUPS)
  for (const f of toDelete) {
    try {
      unlinkSync(f.path)
    } catch (err) {
      logger.warn({ err, file: f.name }, 'failed to delete old backup')
    }
  }
}

export function runMigrations(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true })
  const backupPath = preMigrationBackup(dbPath)

  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')         // required for litestream
  db.pragma('foreign_keys = ON')

  const drizzleDb = drizzle(db)
  try {
    migrate(drizzleDb, { migrationsFolder: MIGRATIONS_FOLDER })
  } catch (err) {
    logger.fatal(
      { err, backupPath },
      'migration failed; refusing to start. restore the pre-migration backup if needed.',
    )
    db.close()
    throw err
  }

  if (backupPath) {
    logger.info('migrations applied successfully')
  }
  return db
}
