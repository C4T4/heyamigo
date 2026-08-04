import { spawn, spawnSync, type ChildProcess } from 'child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  statSync,
} from 'fs'
import { homedir } from 'os'
import { dirname, isAbsolute, resolve } from 'path'
import { fileURLToPath } from 'url'
import { assertBrowserCdpReady } from '../browser/cdp.js'
import {
  chromePidsForProfile,
  legacyChromeProfileDir,
  vncChromeProfileDir,
} from '../browser/chrome-profile.js'
import { config } from '../config.js'

const __pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

export type ChromeAction = 'start' | 'stop' | 'restart' | 'status'

type ManagedChrome = {
  binary: string
  cdpUrl: string
  port: number
  display: string
  userDataDir: string
  startUrl: string
  logFile: string
  connectTimeoutMs: number
}

function expandPath(input: string): string {
  if (input === '~') return homedir()
  if (input.startsWith('~/')) return resolve(homedir(), input.slice(2))
  return isAbsolute(input) ? input : resolve(process.cwd(), input)
}

function managedChrome(): ManagedChrome {
  const endpoint = new URL(config.browser.cdpUrl)
  if (
    endpoint.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '::1'].includes(endpoint.hostname)
  ) {
    throw new Error(
      `Refusing to manage non-local CDP endpoint ${config.browser.cdpUrl}`,
    )
  }
  const port = Number(endpoint.port || '80')
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid CDP port in ${config.browser.cdpUrl}`)
  }

  return {
    binary: config.browser.chromeBinary ?? 'auto',
    cdpUrl: config.browser.cdpUrl,
    port,
    display: config.browser.display,
    userDataDir: vncChromeProfileDir(),
    startUrl: config.browser.startUrl,
    logFile: expandPath(config.browser.logFile),
    connectTimeoutMs: config.browser.connectTimeoutMs,
  }
}

function resolveBinary(configured: string): string {
  const candidates = configured === 'auto'
    ? ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium']
    : [configured]
  for (const candidate of candidates) {
    if (candidate.includes('/')) {
      const path = expandPath(candidate)
      if (existsSync(path)) return path
      continue
    }
    const found = spawnSync('which', [candidate], { encoding: 'utf-8' })
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim()
  }
  throw new Error(
    configured === 'auto'
      ? 'Chrome/Chromium binary not found'
      : `Configured Chrome binary not found: ${configured}`,
  )
}

function managedChromePids(chrome: ManagedChrome): number[] {
  return chromePidsForProfile(chrome.port, chrome.userDataDir)
}

function legacyChromePids(chrome: ManagedChrome): number[] {
  return chromePidsForProfile(chrome.port, legacyChromeProfileDir())
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function cdpReady(chrome: ManagedChrome): Promise<boolean> {
  try {
    await assertBrowserCdpReady(chrome.cdpUrl, chrome.connectTimeoutMs)
    return true
  } catch {
    return false
  }
}

function assertProfile(chrome: ManagedChrome): void {
  if (!existsSync(chrome.userDataDir)) {
    throw new Error(
      `Configured Chrome profile does not exist: ${chrome.userDataDir}. Refusing to create a new profile.`,
    )
  }
  if (!statSync(chrome.userDataDir).isDirectory()) {
    throw new Error(`Configured Chrome profile is not a directory: ${chrome.userDataDir}`)
  }
}

function assertDisplay(chrome: ManagedChrome): void {
  const match = /^:(\d+)$/.exec(chrome.display)
  if (!match) throw new Error(`Invalid browser.display: ${chrome.display}`)
  const socket = `/tmp/.X11-unix/X${match[1]}`
  if (!existsSync(socket)) {
    throw new Error(
      `X display ${chrome.display} is not running (${socket} missing). Refusing to launch a different browser stack.`,
    )
  }
}

function displayNumber(chrome: ManagedChrome): string {
  const match = /^:(\d+)$/.exec(chrome.display)
  if (!match) throw new Error(`Invalid browser.display: ${chrome.display}`)
  return match[1]!
}

async function terminateChromePids(pids: number[]): Promise<void> {
  for (const pid of pids) process.kill(pid, 'SIGTERM')
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline && pids.some(isAlive)) {
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 250))
  }
  const remaining = pids.filter(isAlive)
  if (remaining.length > 0) {
    throw new Error(
      `Chrome did not stop cleanly (PID${remaining.length === 1 ? '' : 's'} ${remaining.join(', ')}). Refusing to force-kill it.`,
    )
  }
}

async function stopManagedChrome(chrome: ManagedChrome): Promise<void> {
  const pids = managedChromePids(chrome)
  if (pids.length > 0) {
    await terminateChromePids(pids)
    console.log('Chrome stopped')
    return
  }

  const legacyPids = legacyChromePids(chrome)
  if (legacyPids.length > 0) {
    await terminateChromePids(legacyPids)
    console.log('Legacy Chrome stopped; it will not be used again')
    return
  }

  if (await cdpReady(chrome)) {
    throw new Error(
      `CDP ${chrome.cdpUrl} belongs to an unknown browser; refusing to stop it.`,
    )
  }

  console.log('Chrome already stopped')
}

async function startManagedChrome(chrome: ManagedChrome): Promise<void> {
  assertProfile(chrome)
  assertDisplay(chrome)

  const pids = managedChromePids(chrome)
  const legacyPids = legacyChromePids(chrome)
  if (legacyPids.length > 0) {
    throw new Error(
      `Legacy Chrome profile is still running (PID${legacyPids.length === 1 ? '' : 's'} ${legacyPids.join(', ')}). Run: heyamigo chrome restart`,
    )
  }
  if (await cdpReady(chrome)) {
    if (pids.length === 0) {
      throw new Error(
        `CDP ${chrome.cdpUrl} is ready but does not belong to ${chrome.userDataDir}; refusing to use it.`,
      )
    }
    console.log(`Chrome already ready (PID${pids.length === 1 ? '' : 's'} ${pids.join(', ')})`)
    return
  }
  if (pids.length > 0) {
    throw new Error(
      `Configured Chrome process exists but CDP is unavailable (PID${pids.length === 1 ? '' : 's'} ${pids.join(', ')}). Run: heyamigo chrome restart`,
    )
  }

  const binary = resolveBinary(chrome.binary)
  mkdirSync(dirname(chrome.logFile), { recursive: true })
  const logFd = openSync(chrome.logFile, 'a')
  let child: ChildProcess
  const spawnError: { current: Error | null } = { current: null }
  try {
    const args = [
      '--no-first-run',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      `--remote-debugging-port=${chrome.port}`,
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${chrome.userDataDir}`,
      '--start-maximized',
      chrome.startUrl,
    ]
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      args.unshift('--no-sandbox')
    }
    child = spawn(binary, args, {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, DISPLAY: chrome.display },
    })
    child.once('error', (err) => {
      spawnError.current = err
    })
    child.unref()
  } finally {
    closeSync(logFd)
  }

  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 500))
    if (spawnError.current) {
      throw new Error(`Could not start ${binary}: ${spawnError.current.message}`)
    }
    if (await cdpReady(chrome)) {
      const startedPids = managedChromePids(chrome)
      if (startedPids.length === 0) {
        throw new Error('CDP became ready but the browser identity does not match the configured profile')
      }
      console.log(
        `Chrome ready at ${chrome.cdpUrl} (PID${startedPids.length === 1 ? '' : 's'} ${startedPids.join(', ')})`,
      )
      return
    }
  }
  throw new Error(
    `Chrome failed to expose CDP within 10s (spawn PID ${child.pid ?? 'unknown'}). Check: tail -n 50 ${chrome.logFile}`,
  )
}

async function restartBrowserStack(chrome: ManagedChrome): Promise<void> {
  assertProfile(chrome)
  const binary = resolveBinary(chrome.binary)
  const scriptPath = resolve(__pkgRoot, 'scripts', 'start-browser.sh')
  if (!existsSync(scriptPath)) {
    throw new Error(`Browser stack recovery script not found: ${scriptPath}`)
  }

  const displayNum = displayNumber(chrome)
  await stopManagedChrome(chrome)

  console.log('Checking and restarting Xvfb, Chrome, x11vnc, and noVNC...')
  const result = spawnSync('bash', [scriptPath, 'start'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      CDP_PORT: String(chrome.port),
      DISPLAY_NUM: displayNum,
      CHROME_BIN: binary,
      CHROME_LOG: chrome.logFile,
      CHROME_START_URL: chrome.startUrl,
    },
  })
  if (result.error) {
    throw new Error(`Browser stack restart failed: ${result.error.message}`)
  }
  if (result.status !== 0) {
    throw new Error(`Browser stack restart failed with exit code ${result.status ?? 'unknown'}`)
  }

  if (!(await cdpReady(chrome)) || managedChromePids(chrome).length === 0) {
    throw new Error(
      `Browser stack reported success, but ${chrome.cdpUrl} is not the canonical VNC Chrome`,
    )
  }
  console.log('Browser stack ready')
}

async function statusManagedChrome(chrome: ManagedChrome): Promise<void> {
  const pids = managedChromePids(chrome)
  const legacyPids = legacyChromePids(chrome)
  const ready = await cdpReady(chrome)
  console.log(`Profile: ${chrome.userDataDir}`)
  console.log(`CDP:     ${chrome.cdpUrl}`)
  if (ready && pids.length > 0) {
    console.log(`Status:  ready (PID${pids.length === 1 ? '' : 's'} ${pids.join(', ')})`)
    return
  }
  if (ready) {
    if (legacyPids.length > 0) {
      throw new Error(
        `Status: legacy Chrome profile is running (PID${legacyPids.length === 1 ? '' : 's'} ${legacyPids.join(', ')}); run: heyamigo chrome restart`,
      )
    }
    throw new Error('Status: CDP is ready, but it belongs to a different browser identity')
  }
  if (legacyPids.length > 0) {
    throw new Error(
      `Status: legacy Chrome profile process exists but CDP is unavailable (PID${legacyPids.length === 1 ? '' : 's'} ${legacyPids.join(', ')})`,
    )
  }
  if (pids.length > 0) {
    throw new Error(
      `Status: configured Chrome process exists but CDP is unavailable (PID${pids.length === 1 ? '' : 's'} ${pids.join(', ')})`,
    )
  }
  throw new Error('Status: stopped')
}

export async function chromeCmd(action: ChromeAction): Promise<void> {
  const chrome = managedChrome()
  switch (action) {
    case 'start':
      await startManagedChrome(chrome)
      break
    case 'stop':
      await stopManagedChrome(chrome)
      break
    case 'restart':
      await restartBrowserStack(chrome)
      break
    case 'status':
      await statusManagedChrome(chrome)
      break
  }
}
