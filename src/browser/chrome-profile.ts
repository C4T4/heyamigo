import { readFileSync, readdirSync, readlinkSync } from 'fs'
import { homedir } from 'os'
import { basename, resolve } from 'path'

export function vncChromeProfileDir(): string {
  return resolve(homedir(), '.config', 'google-chrome-novnc')
}

export function legacyChromeProfileDir(): string {
  return resolve(homedir(), '.chrome-shared')
}

export function procCmdlineHasArg(
  rawCmdline: string,
  name: string,
  expected: string,
): boolean {
  // Normal Linux processes expose NUL-separated argv entries. Snap Chromium
  // can rewrite argv[0] into one space-separated process-title string after
  // launch, so normalize both representations before matching exact flags.
  const args = rawCmdline
    .split('\0')
    .flatMap((entry) => entry.split(/\s+/))
    .filter(Boolean)
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
      const rawCmdline = readFileSync(`/proc/${entry}/cmdline`, 'utf-8')
      if (
        procCmdlineHasArg(rawCmdline, '--remote-debugging-port', String(port)) &&
        procCmdlineHasArg(rawCmdline, '--user-data-dir', userDataDir)
      ) {
        result.push(pid)
      }
    } catch {
      // Process exited or /proc entry became unreadable while scanning.
    }
  }
  return result
}
