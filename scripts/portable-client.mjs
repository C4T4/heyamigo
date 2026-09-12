#!/usr/bin/env node
// One Amigo per private volume. Cloud mode separately authenticates with its scoped credential.
import { spawn } from 'node:child_process'
import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  lstat,
  realpath,
  copyFile,
  constants,
} from 'node:fs/promises'
import { resolve, join, isAbsolute, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function binding(env) {
  if (!uuid.test(env.AMIGO_WORKSPACE_ID ?? '') || !uuid.test(env.AMIGO_AGENT_ID ?? ''))
    throw new Error('Set AMIGO_WORKSPACE_ID and AMIGO_AGENT_ID from the owning Cloud account.')
  return {
    version: 1,
    workspaceId: env.AMIGO_WORKSPACE_ID.toLowerCase(),
    agentId: env.AMIGO_AGENT_ID.toLowerCase(),
  }
}

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077)
    throw new Error('Amigo storage must be an owner-only directory, not a symbolic link.')
  return realpath(path)
}

async function privateFile(path) {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077)
    throw new Error('Amigo state files must be owner-only regular files.')
}

export async function openState(env, initialize = false) {
  const requested = env.AMIGO_STATE_DIR
  if (!requested || !isAbsolute(requested))
    throw new Error('AMIGO_STATE_DIR must be an absolute private volume path.')
  const expected = binding(env)
  const root = await privateDirectory(requested)
  const manifest = join(root, 'amigo.json')
  try {
    await privateFile(manifest)
  } catch (error) {
    if (error.code !== 'ENOENT' || !initialize) throw error
    if ((await readdir(root)).length)
      throw new Error('Refusing to adopt a non-empty volume without an Amigo identity.')
    await writeFile(manifest, JSON.stringify(expected, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  }
  const saved = JSON.parse(await readFile(manifest, 'utf8'))
  if (
    Object.keys(saved).sort().join(',') !== 'agentId,version,workspaceId' ||
    saved.version !== expected.version ||
    saved.workspaceId !== expected.workspaceId ||
    saved.agentId !== expected.agentId
  )
    throw new Error(
      'This volume belongs to a different Amigo or uses an unsupported state version.',
    )
  for (const directory of [
    'home',
    'home/.config',
    'home/.cache',
    'home/.config/google-chrome-novnc',
    'config',
    'config/personalities',
    'config/knowledge',
    'storage',
    'storage/auth',
    'storage/memory',
    'storage/media',
    'storage/messages',
    'storage/logs',
    'storage/prompts',
    'storage/outbox',
  ])
    await privateDirectory(join(root, directory))
  if (initialize) {
    const config = JSON.parse(
      await readFile(join(packageRoot, 'config/config.example.json'), 'utf8'),
    )
    config.whatsapp.enabled = false
    config.telegram = { ...config.telegram, enabled: false, botToken: '' }
    config.amigospace = { ...config.amigospace, enabled: false }
    config.browser.cdpUrl = 'http://127.0.0.1:9222'
    const access = JSON.parse(
      await readFile(join(packageRoot, 'config/access.example.json'), 'utf8'),
    )
    access.users = {}
    access.groups = []
    access.chatPreferences = {}
    access.dms = { defaultMode: 'off', allowed: [] }
    for (const [name, value] of [
      ['config.json', config],
      ['access.json', access],
    ])
      await writeFile(join(root, 'config', name), JSON.stringify(value, null, 2) + '\n', {
        flag: 'wx',
        mode: 0o600,
      }).catch((error) => {
        if (error.code !== 'EEXIST') throw error
      })
    for (const name of ['memory-instructions.md', 'import-instructions.md'])
      await copyFile(
        join(packageRoot, 'config', name),
        join(root, 'config', name),
        constants.COPYFILE_EXCL,
      ).catch((error) => {
        if (error.code !== 'EEXIST') throw error
      })
    for (const name of await readdir(join(packageRoot, 'config/personalities')))
      if (name.endsWith('.md'))
        await copyFile(
          join(packageRoot, 'config/personalities', name),
          join(root, 'config/personalities', name),
          constants.COPYFILE_EXCL,
        ).catch((error) => {
          if (error.code !== 'EEXIST') throw error
        })
  }
  for (const name of ['config.json', 'access.json']) await privateFile(join(root, 'config', name))
  return { root, identity: expected }
}

export async function checkState(env) {
  const state = await openState(env)
  const config = JSON.parse(await readFile(join(state.root, 'config/config.json'), 'utf8'))
  try {
    await lstat(join(state.root, 'config/config.local.json'))
    throw new Error('Portable clients use one config.json; merge local overrides before migration.')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const paths = [
    config.whatsapp.authDir,
    config.storage.messagesDir,
    config.storage.sessionsFile,
    config.storage.mediaDir,
    config.memory.dir,
    config.memory.instructionsFile,
    config.memory.importInstructionsFile,
    config.claude.personalityFile,
    ...(config.claude.addDirs ?? []),
    config.browser.logFile,
    config.amigospace?.credentialFile,
  ].filter((value) => value !== undefined)
  for (const path of paths) {
    if (typeof path !== 'string' || !path || isAbsolute(path) || path.includes('\\'))
      throw new Error('Portable data paths must be relative to the Amigo volume.')
    const rel = relative(state.root, resolve(state.root, path))
    if (!rel || rel === '..' || rel.startsWith('../'))
      throw new Error('A configured data path escapes the Amigo volume.')
    let current = state.root
    for (const part of rel.split('/')) {
      current = join(current, part)
      try {
        if ((await lstat(current)).isSymbolicLink())
          throw new Error('Configured data paths cannot contain symbolic links.')
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
  }
  if (env.AMIGO_BROWSER_ENABLED === '1' && config.browser.cdpUrl !== 'http://127.0.0.1:9222')
    throw new Error('The portable browser must use its own loopback endpoint.')
  return { ...state, config }
}

async function closeBrowser(browser) {
  try {
    const response = await fetch('http://127.0.0.1:9222/json/version', {
      signal: AbortSignal.timeout(1000),
    })
    const endpoint = new URL((await response.json()).webSocketDebuggerUrl)
    if (
      endpoint.protocol !== 'ws:' ||
      endpoint.hostname !== '127.0.0.1' ||
      endpoint.port !== '9222'
    )
      throw new Error('Unexpected private browser endpoint.')
    await new Promise((done, fail) => {
      const socket = new WebSocket(endpoint)
      const timer = setTimeout(() => {
        socket.close()
        fail(new Error('Browser shutdown timed out.'))
      }, 5000)
      socket.addEventListener(
        'open',
        () => socket.send(JSON.stringify({ id: 1, method: 'Browser.close' })),
        {
          once: true,
        },
      )
      socket.addEventListener(
        'close',
        () => {
          clearTimeout(timer)
          done()
        },
        { once: true },
      )
      socket.addEventListener(
        'error',
        () => {
          clearTimeout(timer)
          fail(new Error('Browser shutdown failed.'))
        },
        { once: true },
      )
    })
  } catch {
    browser.kill('SIGTERM')
  }
}

async function supervise(children, timeoutMs = 30000, browser) {
  let stopping = false
  let exitCode = 0
  let timer
  const stop = () => {
    if (stopping) return
    stopping = true
    for (const child of children) {
      if (child === browser) void closeBrowser(child)
      else child.kill('SIGTERM')
    }
    timer = setTimeout(() => {
      for (const child of children) child.kill('SIGKILL')
    }, timeoutMs)
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  await Promise.all(
    children.map(
      (child) =>
        new Promise((done) => {
          child.once('error', () => {
            exitCode = 1
            stop()
          })
          child.once('close', (code) => {
            if (!stopping) exitCode = code ?? 1
            stop()
            done()
          })
        }),
    ),
  )
  clearTimeout(timer)
  process.exitCode = exitCode
}

async function main() {
  process.umask(0o077)
  const command = process.argv[2]
  if (
    !['init', 'check', 'start', '_run', 'configure-cloud', 'cloud-start', '_cloud_run'].includes(
      command,
    )
  )
    throw new Error(
      'Usage: portable-client.mjs init|check|start|configure-cloud <file>|cloud-start. Configure AMIGO_STATE_DIR, AMIGO_WORKSPACE_ID, AMIGO_AGENT_ID.',
    )
  if (command === 'init') {
    const state = await openState(process.env, true)
    console.log(
      JSON.stringify({ status: 'initialized', ...state.identity, connections: 'disabled' }),
    )
    return
  }
  const state = await checkState(process.env)
  if (command === 'configure-cloud') {
    if (!process.argv[3])
      throw new Error('Supply the private connection file downloaded from Cloud.')
    const { configureCloud } = await import('./cloud-client.mjs')
    await configureCloud(process.env, process.argv[3])
    console.log(
      JSON.stringify({ status: 'cloud_configured', ...state.identity, connected: 'not_checked' }),
    )
    return
  }
  if (command === 'check') {
    let cloudControl = 'not_configured'
    try {
      await privateFile(join(state.root, 'cloud-connection.json'))
      cloudControl = 'configured_not_checked'
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    console.log(
      JSON.stringify({
        status: 'state_valid',
        ...state.identity,
        configuredChannels: {
          whatsapp: state.config.whatsapp.enabled !== false,
          telegram: !!state.config.telegram.enabled,
        },
        connected: 'not_checked',
        cloudControl,
      }),
    )
    return
  }
  if (process.platform !== 'linux')
    throw new Error('Run the portable client in its Linux container.')
  const cloud = command === 'cloud-start' || command === '_cloud_run'
  if (cloud) {
    const { loadCloudConnection } = await import('./cloud-client.mjs')
    await loadCloudConnection(process.env)
  } else {
    try {
      await lstat(join(state.root, 'cloud-connection.json'))
      throw new Error(
        'This Client is assigned to Cloud. Use cloud-start to avoid running a competing standalone bot.',
      )
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  const entry = join(packageRoot, cloud ? 'scripts/cloud-client.mjs' : 'dist/index.js')
  await lstat(entry)
  if (command === 'start' || command === 'cloud-start') {
    const lock = join(state.root, '.runtime.lock')
    await writeFile(lock, '', { flag: 'wx', mode: 0o600 }).catch((error) => {
      if (error.code !== 'EEXIST') throw error
    })
    await privateFile(lock)
    await supervise(
      [
        spawn(
          'flock',
          [
            '--nonblock',
            '--conflict-exit-code',
            '75',
            '--no-fork',
            lock,
            process.execPath,
            fileURLToPath(import.meta.url),
            cloud ? '_cloud_run' : '_run',
          ],
          { stdio: 'inherit', env: process.env },
        ),
      ],
      35000,
    )
    return
  }
  // Fresh per-Amigo HOME is intentional; never inherit the operator's model/browser sessions.
  const env = {
    ...process.env,
    HOME: join(state.root, 'home'),
    XDG_CONFIG_HOME: join(state.root, 'home/.config'),
    XDG_CACHE_HOME: join(state.root, 'home/.cache'),
  }
  // Drop host-specific CLI configuration overrides; credentials must be provisioned for this client.
  for (const name of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'NODE_OPTIONS']) delete env[name]
  const children = []
  if (process.env.AMIGO_BROWSER_ENABLED === '1')
    children.push(
      spawn(
        process.env.AMIGO_CHROME_BINARY ?? 'chromium',
        [
          '--headless=new',
          '--remote-debugging-port=9222',
          '--remote-debugging-address=127.0.0.1',
          `--user-data-dir=${join(state.root, 'home/.config/google-chrome-novnc')}`,
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-sync',
          'about:blank',
        ],
        { cwd: state.root, env, stdio: ['ignore', 'ignore', 'inherit'] },
      ),
    )
  children.push(spawn(process.execPath, [entry], { cwd: state.root, env, stdio: 'inherit' }))
  await supervise(
    children,
    30000,
    process.env.AMIGO_BROWSER_ENABLED === '1' ? children[0] : undefined,
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
