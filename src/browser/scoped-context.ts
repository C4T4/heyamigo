import { EventEmitter } from 'events'
import type { BrowserContext, Page } from 'playwright-core'
import { BrowserTabLeaseStore } from './tab-leases.js'

type TargetInfo = {
  targetId: string
  browserContextId: string | null
  openerTargetId: string | null
}

type ManagedPage = TargetInfo & {
  page: Page
}

export type BrowserTabCandidate = {
  tabId: string
  title: string
  url: string
  status: 'available' | 'owned-by-this-task' | 'busy'
}

export type ClaimTabResult =
  | { ok: true; candidate: BrowserTabCandidate }
  | { ok: false; reason: string }

async function pageTitle(page: Page): Promise<string> {
  return page.title().catch(() => '')
}

// Filters one real Chrome BrowserContext down to the stable CDP targets leased
// by a single browser task. Playwright MCP receives this proxy and therefore
// cannot enumerate, select, or act on another task's pages even if its model
// ignores the prompt-level ownership instructions.
export class TaskScopedBrowserContext {
  private readonly pageEvents = new EventEmitter()
  private readonly byTargetId = new Map<string, ManagedPage>()
  private readonly mapping = new WeakMap<Page, Promise<ManagedPage>>()
  private readonly visibleTargetIds = new Set<string>()
  private proxyContext: BrowserContext | null = null
  private disposed = false

  private readonly onRawPage = (page: Page): void => {
    void this.adoptPageIfOwnedPopup(page).catch(() => undefined)
  }

  constructor(
    private readonly rawContext: BrowserContext,
    private readonly leases: BrowserTabLeaseStore,
    readonly taskId: string,
  ) {}

  async initialize(): Promise<void> {
    for (const page of this.rawContext.pages()) {
      await this.mapPage(page)
    }
    await this.cleanupExpiredLeases()

    for (const lease of this.leases.listOwned(this.taskId)) {
      if (this.byTargetId.has(lease.targetId)) {
        this.visibleTargetIds.add(lease.targetId)
      } else {
        this.leases.release(lease.targetId, this.taskId)
      }
    }

    this.rawContext.on('page', this.onRawPage)
  }

  asBrowserContext(): BrowserContext {
    if (this.proxyContext) return this.proxyContext

    let proxy: BrowserContext
    proxy = new Proxy(this.rawContext, {
      get: (target, property) => {
        if (property === 'pages') return () => this.ownedPages()
        if (property === 'newPage') return () => this.newOwnedPage()

        if (
          property === 'on' ||
          property === 'addListener' ||
          property === 'once' ||
          property === 'off' ||
          property === 'removeListener'
        ) {
          return (event: string | symbol, listener: (...args: unknown[]) => void) => {
            if (event === 'page') {
              if (property === 'once') this.pageEvents.once(event, listener)
              else if (property === 'off' || property === 'removeListener') {
                this.pageEvents.off(event, listener)
              } else {
                this.pageEvents.on(event, listener)
              }
              return proxy
            }
            const method = Reflect.get(target, property, target) as (...args: unknown[]) => unknown
            return method.call(target, event, listener)
          }
        }

        if (property === 'removeAllListeners') {
          return (event?: string | symbol) => {
            if (event === 'page') {
              this.pageEvents.removeAllListeners(event)
              return proxy
            }
            return (this.rawContext as unknown as EventEmitter).removeAllListeners(event)
          }
        }

        const value = Reflect.get(target, property, target) as unknown
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value
      },
    })
    this.proxyContext = proxy
    return proxy
  }

  async listCandidates(): Promise<BrowserTabCandidate[]> {
    await this.refreshPages()
    await this.cleanupExpiredLeases()
    await this.refreshOwnedMetadata()

    const candidates: BrowserTabCandidate[] = []
    for (const managed of this.byTargetId.values()) {
      if (managed.page.isClosed()) continue
      const lease = this.leases.getActive(managed.targetId)
      candidates.push({
        tabId: managed.targetId,
        title: await pageTitle(managed.page),
        url: managed.page.url(),
        status: !lease
          ? 'available'
          : lease.ownerTaskId === this.taskId
            ? 'owned-by-this-task'
            : 'busy',
      })
    }
    return candidates.sort((a, b) => a.tabId.localeCompare(b.tabId))
  }

  async claimExisting(tabId: string): Promise<ClaimTabResult> {
    await this.refreshPages()
    await this.cleanupExpiredLeases()
    const managed = this.byTargetId.get(tabId)
    if (!managed || managed.page.isClosed()) {
      return { ok: false, reason: `Tab ${tabId} is no longer open.` }
    }

    const claim = await this.claimManagedPage(managed, false)
    if (!claim.ok) {
      return {
        ok: false,
        reason: `Tab ${tabId} is currently owned by another browser task.`,
      }
    }

    this.expose(managed)
    return {
      ok: true,
      candidate: {
        tabId,
        title: claim.lease.title,
        url: claim.lease.url,
        status: 'owned-by-this-task',
      },
    }
  }

  heartbeat(): number {
    return this.leases.renewOwner(this.taskId)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.rawContext.off('page', this.onRawPage)

    const owned = this.leases.listAllOwned(this.taskId)
    for (const lease of owned) {
      if (!lease.createdByTask) continue
      const managed = this.byTargetId.get(lease.targetId)
      if (managed && !managed.page.isClosed()) {
        await managed.page.close().catch(() => undefined)
      }
    }
    this.leases.releaseOwner(this.taskId)
    this.visibleTargetIds.clear()
    this.pageEvents.removeAllListeners()
  }

  private ownedPages(): Page[] {
    const pages: Page[] = []
    for (const lease of this.leases.listOwned(this.taskId)) {
      if (!this.visibleTargetIds.has(lease.targetId)) continue
      const managed = this.byTargetId.get(lease.targetId)
      if (managed && !managed.page.isClosed()) pages.push(managed.page)
    }
    return pages
  }

  private async newOwnedPage(): Promise<Page> {
    const page = await this.rawContext.newPage()
    const managed = await this.mapPage(page)
    const claim = await this.claimManagedPage(managed, true)
    if (!claim.ok) {
      await page.close().catch(() => undefined)
      throw new Error(`New tab ${managed.targetId} was claimed by another task.`)
    }
    this.expose(managed)
    return page
  }

  private expose(managed: ManagedPage): void {
    if (this.visibleTargetIds.has(managed.targetId)) return
    this.visibleTargetIds.add(managed.targetId)
    this.pageEvents.emit('page', managed.page)
  }

  private async adoptPageIfOwnedPopup(page: Page): Promise<void> {
    const managed = await this.mapPage(page)
    if (this.visibleTargetIds.has(managed.targetId)) return

    let openerTargetId = managed.openerTargetId
    if (!openerTargetId) {
      const opener = await page.opener().catch(() => null)
      if (opener) openerTargetId = (await this.mapPage(opener)).targetId
    }
    if (!openerTargetId) return

    const openerLease = this.leases.getActive(openerTargetId)
    if (openerLease?.ownerTaskId !== this.taskId) return

    const popup: ManagedPage = { ...managed, openerTargetId }
    this.byTargetId.set(popup.targetId, popup)
    const claim = await this.claimManagedPage(popup, true)
    if (claim.ok) this.expose(popup)
  }

  private async claimManagedPage(
    managed: ManagedPage,
    createdByTask: boolean,
  ): Promise<ReturnType<BrowserTabLeaseStore['claim']>> {
    return this.leases.claim({
      targetId: managed.targetId,
      ownerTaskId: this.taskId,
      browserContextId: managed.browserContextId,
      openerTargetId: managed.openerTargetId,
      url: managed.page.url(),
      title: await pageTitle(managed.page),
      createdByTask,
    })
  }

  private async mapPage(page: Page): Promise<ManagedPage> {
    const existing = this.mapping.get(page)
    if (existing) return existing

    const pending = (async () => {
      const session = await this.rawContext.newCDPSession(page)
      try {
        const response = await session.send('Target.getTargetInfo') as {
          targetInfo: {
            targetId: string
            browserContextId?: string
            openerId?: string
          }
        }
        const managed: ManagedPage = {
          page,
          targetId: response.targetInfo.targetId,
          browserContextId: response.targetInfo.browserContextId ?? null,
          openerTargetId: response.targetInfo.openerId ?? null,
        }
        this.byTargetId.set(managed.targetId, managed)
        page.once('close', () => {
          this.visibleTargetIds.delete(managed.targetId)
          this.byTargetId.delete(managed.targetId)
          this.leases.release(managed.targetId, this.taskId)
        })
        return managed
      } finally {
        await session.detach().catch(() => undefined)
      }
    })()
    this.mapping.set(page, pending)
    return pending
  }

  private async refreshPages(): Promise<void> {
    for (const page of this.rawContext.pages()) {
      await this.mapPage(page)
    }
  }

  private async refreshOwnedMetadata(): Promise<void> {
    for (const lease of this.leases.listOwned(this.taskId)) {
      const managed = this.byTargetId.get(lease.targetId)
      if (!managed || managed.page.isClosed()) continue
      this.leases.updateMetadata(lease.targetId, this.taskId, {
        url: managed.page.url(),
        title: await pageTitle(managed.page),
      })
    }
  }

  private async cleanupExpiredLeases(): Promise<void> {
    for (const lease of this.leases.listExpired()) {
      const managed = this.byTargetId.get(lease.targetId)
      if (lease.createdByTask && managed && !managed.page.isClosed()) {
        await managed.page.close().catch(() => undefined)
      }
      this.leases.deleteExpired(lease.targetId)
    }
  }
}

export function renderTabCandidates(candidates: BrowserTabCandidate[]): string {
  if (candidates.length === 0) return 'No open Chrome tabs are available.'
  return candidates.map((tab) =>
    `- ${tab.tabId} [${tab.status}] ${tab.title || '(untitled)'} — ${tab.url}`,
  ).join('\n')
}
