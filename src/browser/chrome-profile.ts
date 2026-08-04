import { readFileSync, readdirSync, readlinkSync } from 'fs'
import { homedir } from 'os'
import { basename, resolve } from 'path'

export function vncChromeProfileDir(): string {
  return resolve(homedir(), '.config', 'google-chrome-novnc')
}

export function legacyChromeProfileDir(): string {
  return resolve(homedir(), '.chrome-shared')
}

function hasArg(args: string[], name: string, expected: string): boolean {
  return args.some(
    (arg, index) =>
      arg === `${name}=${expected}` ||
      (arg === name && args[index + 1] === expected),
  )
}

export function chromePidsForProfile(port: number, userDataDir: string): number[] {
  if (process.platform !== 'linux') return []

  const result: number[] = []
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    const pid = Number(entry)
    try {
      const exe = basename(readlinkSync(`/proc/${entry}/exe`)).toLowerCase()
      if (!exe.includes('chrome') && !exe.includes('chromium')) continue
      const args = readFileSync(`/proc/${entry}/cmdline`, 'utf-8')
        .split('\0')
        .filter(Boolean)
      if (
        hasArg(args, '--remote-debugging-port', String(port)) &&
        hasArg(args, '--user-data-dir', userDataDir)
      ) {
        result.push(pid)
      }
    } catch {
      // Process exited or /proc entry became unreadable while scanning.
    }
  }
  return result
}
