import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import Database from 'better-sqlite3'
import type { BrowserContext, Page } from 'playwright-core'
import { TaskScopedBrowserContext } from '../src/browser/scoped-context.js'
import { BrowserTabLeaseStore } from '../src/browser/tab-leases.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function createLeaseDatabase(): { path: string; db: Database.Database } {
  const dir = mkdtempSync(join(tmpdir(), 'heyamigo-tab-broker-test-'))
  temporaryDirectories.push(dir)
  const path = join(dir, 'test.db')
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE browser_tab_leases (
      target_id text PRIMARY KEY NOT NULL,
      owner_task_id text NOT NULL,
      browser_context_id text,
      opener_target_id text,
      url text NOT NULL,
      title text NOT NULL,
      created_by_task integer DEFAULT 0 NOT NULL,
      claimed_at integer NOT NULL,
      heartbeat_at integer NOT NULL,
      lease_expires_at integer NOT NULL
    );
    CREATE INDEX btab_leases_by_owner ON browser_tab_leases (owner_task_id);
    CREATE INDEX btab_leases_by_expiry ON browser_tab_leases (lease_expires_at);
  `)
  return { path, db }
}

class FakePage extends EventEmitter {
  private closed = false

  constructor(
    readonly targetId: string,
    private currentUrl: string,
    private currentTitle: string,
    private readonly parent: FakePage | null = null,
  ) {
    super()
  }

  url(): string { return this.currentUrl }
  async title(): Promise<string> { return this.currentTitle }
  isClosed(): boolean { return this.closed }
  async opener(): Promise<FakePage | null> { return this.parent }
  async bringToFront(): Promise<void> {}

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.emit('close')
  }
}

class FakeBrowserContext extends EventEmitter {
  private readonly allPages: FakePage[] = []
  private sequence = 0

  addExisting(targetId: string, url: string, title: string): FakePage {
    const page = new FakePage(targetId, url, title)
    this.allPages.push(page)
    return page
  }

  pages(): FakePage[] {
    return this.allPages.filter((page) => !page.isClosed())
  }

  async newPage(): Promise<FakePage> {
    const page = new FakePage(`new-${++this.sequence}`, 'about:blank', '')
    this.allPages.push(page)
    this.emit('page', page)
    return page
  }

  openPopup(opener: FakePage, targetId: string, url: string): FakePage {
    const page = new FakePage(targetId, url, 'Popup', opener)
    this.allPages.push(page)
    this.emit('page', page)
    return page
  }

  async newCDPSession(page: FakePage) {
    return {
      async send(method: string) {
        assert.equal(method, 'Target.getTargetInfo')
        return {
          targetInfo: {
            targetId: page.targetId,
            browserContextId: 'default-context',
            openerId: (await page.opener())?.targetId,
          },
        }
      },
      async detach() {},
    }
  }
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('condition not reached before timeout')
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
}

test('only one browser task can lease a stable CDP target at a time', () => {
  const { path, db } = createLeaseDatabase()
  const first = new BrowserTabLeaseStore(db, 120)
  const second = BrowserTabLeaseStore.open(path, 120)

  const input = {
    targetId: 'target-1',
    browserContextId: 'default',
    openerTargetId: null,
    url: 'https://example.com',
    title: 'Example',
    createdByTask: false,
  }
  assert.equal(first.claim({ ...input, ownerTaskId: 'task-a' }, 100).ok, true)

  const blocked = second.claim({ ...input, ownerTaskId: 'task-b' }, 101)
  assert.equal(blocked.ok, false)
  assert.equal(blocked.lease.ownerTaskId, 'task-a')

  const afterExpiry = second.claim({ ...input, ownerTaskId: 'task-b' }, 221)
  assert.equal(afterExpiry.ok, true)
  assert.equal(afterExpiry.lease.ownerTaskId, 'task-b')

  second.close()
  db.close()
})

test('task contexts isolate existing tabs, own multiple pages, and adopt popups', async () => {
  const { path, db } = createLeaseDatabase()
  const raw = new FakeBrowserContext()
  const existing = raw.addExisting('existing-1', 'https://facebook.com', 'Facebook')
  const storeA = new BrowserTabLeaseStore(db, 120)
  const scopedA = new TaskScopedBrowserContext(
    raw as unknown as BrowserContext,
    storeA,
    'task-a',
  )
  await scopedA.initialize()
  const contextA = scopedA.asBrowserContext()

  assert.deepEqual(contextA.pages(), [])
  const candidates = await scopedA.listCandidates()
  assert.deepEqual(candidates.map((tab) => [tab.tabId, tab.status]), [
    ['existing-1', 'available'],
  ])

  const claimed = await scopedA.claimExisting('existing-1')
  assert.equal(claimed.ok, true)
  assert.deepEqual(contextA.pages(), [existing as unknown as Page])

  const created = await contextA.newPage() as unknown as FakePage
  assert.equal(contextA.pages().length, 2)
  const popup = raw.openPopup(created, 'popup-1', 'https://facebook.com/dialog')
  await waitFor(() => contextA.pages().length === 3)

  const storeB = BrowserTabLeaseStore.open(path, 120)
  const scopedB = new TaskScopedBrowserContext(
    raw as unknown as BrowserContext,
    storeB,
    'task-b',
  )
  await scopedB.initialize()
  const contextB = scopedB.asBrowserContext()
  assert.deepEqual(contextB.pages(), [])
  assert.equal((await scopedB.claimExisting('existing-1')).ok, false)

  await scopedA.dispose()
  assert.equal(existing.isClosed(), false, 'claimed user tab must remain open')
  assert.equal(created.isClosed(), true, 'task-created tab must be cleaned up')
  assert.equal(popup.isClosed(), true, 'task-created popup must be cleaned up')
  assert.equal((await scopedB.claimExisting('existing-1')).ok, true)

  await scopedB.dispose()
  storeB.close()
  db.close()
})

test('expired task-created tabs are closed while expired user tabs are preserved', async () => {
  const { db } = createLeaseDatabase()
  const raw = new FakeBrowserContext()
  const userTab = raw.addExisting('user-tab', 'https://instagram.com', 'Instagram')
  const orphanTab = raw.addExisting('orphan-tab', 'about:blank', 'Old task tab')
  const store = new BrowserTabLeaseStore(db, 10)

  const common = {
    ownerTaskId: 'crashed-task',
    browserContextId: 'default-context',
    openerTargetId: null,
  }
  assert.equal(store.claim({
    ...common,
    targetId: 'user-tab',
    url: userTab.url(),
    title: await userTab.title(),
    createdByTask: false,
  }, 100).ok, true)
  assert.equal(store.claim({
    ...common,
    targetId: 'orphan-tab',
    url: orphanTab.url(),
    title: await orphanTab.title(),
    createdByTask: true,
  }, 100).ok, true)

  const recovery = new TaskScopedBrowserContext(
    raw as unknown as BrowserContext,
    store,
    'recovery-task',
  )
  await recovery.initialize()

  assert.equal(userTab.isClosed(), false)
  assert.equal(orphanTab.isClosed(), true)
  assert.equal(store.get('user-tab'), null)
  assert.equal(store.get('orphan-tab'), null)

  await recovery.dispose()
  db.close()
})
