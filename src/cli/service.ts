import { spawn, spawnSync, execSync } from 'child_process'
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const __distCli = dirname(fileURLToPath(import.meta.url))

function findProjectDir(): string {
  // Check cwd first, then common locations
  const candidates = [
    process.cwd(),
    resolve(process.cwd(), 'heyamigo'),
    resolve(process.env.HOME || '/root', 'heyamigo'),
  ]
  for (const dir of candidates) {
    if (
      existsSync(resolve(dir, 'config/config.json')) ||
      existsSync(resolve(dir, 'config/config.example.json'))
    ) {
      return dir
    }
  }
  return process.cwd()
}

const cwd = findProjectDir()
const PID_FILE = resolve(cwd, 'storage/heyamigo.pid')
const LOG_FILE = resolve(cwd, 'storage/logs/heyamigo.log')

function readPid(): number | null {
  if (!existsSync(PID_FILE)) return null
  const raw = readFileSync(PID_FILE, 'utf-8').trim()
  const pid = parseInt(raw, 10)
  return isNaN(pid) ? null : pid
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function cleanPid(): void {
  if (existsSync(PID_FILE)) unlinkSync(PID_FILE)
}

export async function serviceCmd(
  action: 'start' | 'stop' | 'restart' | 'logs' | 'status',
): Promise<void> {
  switch (action) {
    case 'start': {
      const existing = readPid()
      if (existing && isAlive(existing)) {
        console.log(`Already running (PID: ${existing})`)
        return
      }
      cleanPid()
      mkdirSync(dirname(LOG_FILE), { recursive: true })
      const logFd = openSync(LOG_FILE, 'a')
      const child = spawn(
        process.execPath,
        [resolve(__distCli, 'supervisor.js')],
        {
          detached: true,
          stdio: ['ignore', logFd, logFd],
          cwd,
          env: { ...process.env, NODE_ENV: 'production' },
        },
      )
      child.unref()
      if (child.pid) {
        writeFileSync(PID_FILE, String(child.pid))
        console.log(`Started (PID: ${child.pid})`)
        console.log(`Logs: npx @c4t4/heyamigo logs`)
      } else {
        console.error('Failed to start')
      }
      break
    }

    case 'stop': {
      const pid = readPid()
      if (!pid || !isAlive(pid)) {
        console.log('Not running')
        cleanPid()
        return
      }
      process.kill(pid, 'SIGTERM')
      // Wait briefly for clean shutdown
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 500))
        if (!isAlive(pid)) break
      }
      cleanPid()
      console.log('Stopped')
      break
    }

    case 'restart': {
      await serviceCmd('stop')
      await serviceCmd('start')
      break
    }

    case 'logs': {
      if (!existsSync(LOG_FILE)) {
        console.log('No logs yet. Start the bot first: npx @c4t4/heyamigo start')
        return
      }
      spawnSync('tail', ['-f', '-n', '50', LOG_FILE], {
        stdio: 'inherit',
      })
      break
    }

    case 'status': {
      const pid = readPid()
      if (pid && isAlive(pid)) {
        console.log(`Running (PID: ${pid})`)
      } else {
        console.log('Not running')
        cleanPid()
      }
      break
    }
  }
}
