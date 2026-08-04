import Database from 'better-sqlite3'

export const DEFAULT_TAB_LEASE_TTL_SECONDS = 120

export type BrowserTabLease = {
  targetId: string
  ownerTaskId: string
  browserContextId: string | null
  openerTargetId: string | null
  url: string
  title: string
  createdByTask: boolean
  claimedAt: number
  heartbeatAt: number
  leaseExpiresAt: number
}

export type ClaimBrowserTabInput = {
  targetId: string
  ownerTaskId: string
  browserContextId?: string | null
  openerTargetId?: string | null
  url: string
  title: string
  createdByTask: boolean
}

type LeaseRow = {
  target_id: string
  owner_task_id: string
  browser_context_id: string | null
  opener_target_id: string | null
  url: string
  title: string
  created_by_task: number
  claimed_at: number
  heartbeat_at: number
  lease_expires_at: number
}

function unixNow(): number {
  return Math.floor(Date.now() / 1000)
}

function fromRow(row: LeaseRow): BrowserTabLease {
  return {
    targetId: row.target_id,
    ownerTaskId: row.owner_task_id,
    browserContextId: row.browser_context_id,
    openerTargetId: row.opener_target_id,
    url: row.url,
    title: row.title,
    createdByTask: row.created_by_task === 1,
    claimedAt: row.claimed_at,
    heartbeatAt: row.heartbeat_at,
    leaseExpiresAt: row.lease_expires_at,
  }
}

// A tiny cross-process registry around the browser_tab_leases table. Every
// task-scoped MCP process opens its own SQLite connection; WAL + the atomic
// UPSERT below make competing claims deterministic without a broker daemon.
export class BrowserTabLeaseStore {
  private readonly ownsConnection: boolean

  constructor(
    private readonly db: Database.Database,
    private readonly ttlSeconds = DEFAULT_TAB_LEASE_TTL_SECONDS,
    ownsConnection = false,
  ) {
    this.ownsConnection = ownsConnection
    this.db.pragma('busy_timeout = 5000')
  }

  static open(
    databasePath: string,
    ttlSeconds = DEFAULT_TAB_LEASE_TTL_SECONDS,
  ): BrowserTabLeaseStore {
    const db = new Database(databasePath)
    db.pragma('journal_mode = WAL')
    return new BrowserTabLeaseStore(db, ttlSeconds, true)
  }

  close(): void {
    if (this.ownsConnection) this.db.close()
  }

  claim(
    input: ClaimBrowserTabInput,
    now = unixNow(),
  ): { ok: true; lease: BrowserTabLease } | { ok: false; lease: BrowserTabLease } {
    const expiresAt = now + this.ttlSeconds
    const result = this.db.prepare(`
      INSERT INTO browser_tab_leases (
        target_id,
        owner_task_id,
        browser_context_id,
        opener_target_id,
        url,
        title,
        created_by_task,
        claimed_at,
        heartbeat_at,
        lease_expires_at
      ) VALUES (
        @targetId,
        @ownerTaskId,
        @browserContextId,
        @openerTargetId,
        @url,
        @title,
        @createdByTask,
        @now,
        @now,
        @expiresAt
      )
      ON CONFLICT(target_id) DO UPDATE SET
        owner_task_id = excluded.owner_task_id,
        browser_context_id = excluded.browser_context_id,
        opener_target_id = excluded.opener_target_id,
        url = excluded.url,
        title = excluded.title,
        created_by_task = CASE
          WHEN browser_tab_leases.owner_task_id = excluded.owner_task_id
            THEN MAX(browser_tab_leases.created_by_task, excluded.created_by_task)
          ELSE excluded.created_by_task
        END,
        claimed_at = CASE
          WHEN browser_tab_leases.owner_task_id = excluded.owner_task_id
            THEN browser_tab_leases.claimed_at
          ELSE excluded.claimed_at
        END,
        heartbeat_at = excluded.heartbeat_at,
        lease_expires_at = excluded.lease_expires_at
      WHERE browser_tab_leases.owner_task_id = excluded.owner_task_id
         OR browser_tab_leases.lease_expires_at <= @now
    `).run({
      ...input,
      browserContextId: input.browserContextId ?? null,
      openerTargetId: input.openerTargetId ?? null,
      createdByTask: input.createdByTask ? 1 : 0,
      now,
      expiresAt,
    })

    const lease = this.get(input.targetId)
    if (!lease) {
      throw new Error(`tab lease disappeared after claim: ${input.targetId}`)
    }
    return result.changes > 0 && lease.ownerTaskId === input.ownerTaskId
      ? { ok: true, lease }
      : { ok: false, lease }
  }

  get(targetId: string): BrowserTabLease | null {
    const row = this.db
      .prepare('SELECT * FROM browser_tab_leases WHERE target_id = ?')
      .get(targetId) as LeaseRow | undefined
    return row ? fromRow(row) : null
  }

  getActive(targetId: string, now = unixNow()): BrowserTabLease | null {
    const row = this.db
      .prepare(`
        SELECT * FROM browser_tab_leases
        WHERE target_id = ? AND lease_expires_at > ?
      `)
      .get(targetId, now) as LeaseRow | undefined
    return row ? fromRow(row) : null
  }

  listOwned(ownerTaskId: string, now = unixNow()): BrowserTabLease[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM browser_tab_leases
        WHERE owner_task_id = ? AND lease_expires_at > ?
        ORDER BY claimed_at, rowid
      `)
      .all(ownerTaskId, now) as LeaseRow[]
    return rows.map(fromRow)
  }

  listAllOwned(ownerTaskId: string): BrowserTabLease[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM browser_tab_leases
        WHERE owner_task_id = ?
        ORDER BY claimed_at, rowid
      `)
      .all(ownerTaskId) as LeaseRow[]
    return rows.map(fromRow)
  }

  listExpired(now = unixNow()): BrowserTabLease[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM browser_tab_leases
        WHERE lease_expires_at <= ?
        ORDER BY lease_expires_at, target_id
      `)
      .all(now) as LeaseRow[]
    return rows.map(fromRow)
  }

  renewOwner(ownerTaskId: string, now = unixNow()): number {
    const result = this.db
      .prepare(`
        UPDATE browser_tab_leases
        SET heartbeat_at = ?, lease_expires_at = ?
        WHERE owner_task_id = ? AND lease_expires_at > ?
      `)
      .run(now, now + this.ttlSeconds, ownerTaskId, now)
    return result.changes
  }

  updateMetadata(
    targetId: string,
    ownerTaskId: string,
    metadata: { url: string; title: string },
    now = unixNow(),
  ): boolean {
    const result = this.db
      .prepare(`
        UPDATE browser_tab_leases
        SET url = ?, title = ?, heartbeat_at = ?, lease_expires_at = ?
        WHERE target_id = ? AND owner_task_id = ? AND lease_expires_at > ?
      `)
      .run(
        metadata.url,
        metadata.title,
        now,
        now + this.ttlSeconds,
        targetId,
        ownerTaskId,
        now,
      )
    return result.changes > 0
  }

  release(targetId: string, ownerTaskId: string): boolean {
    const result = this.db
      .prepare(`
        DELETE FROM browser_tab_leases
        WHERE target_id = ? AND owner_task_id = ?
      `)
      .run(targetId, ownerTaskId)
    return result.changes > 0
  }

  releaseOwner(ownerTaskId: string): number {
    return this.db
      .prepare('DELETE FROM browser_tab_leases WHERE owner_task_id = ?')
      .run(ownerTaskId).changes
  }

  deleteExpired(targetId: string, now = unixNow()): boolean {
    const result = this.db
      .prepare(`
        DELETE FROM browser_tab_leases
        WHERE target_id = ? AND lease_expires_at <= ?
      `)
      .run(targetId, now)
    return result.changes > 0
  }
}
