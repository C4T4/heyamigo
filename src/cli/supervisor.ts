#!/usr/bin/env node
/**
 * Supervisor: runs the bot, restarts on crash.
 * Spawned by `heyamigo start` as a detached process.
 */
import { spawn, type ChildProcess } from 'child_process'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const __distCli = dirname(fileURLToPath(import.meta.url))
const RESTART_DELAY_MS = 5000
const cwd = process.cwd()
let child: ChildProcess | null = null
let shuttingDown = false

function run(): void {
  child = spawn(
    process.execPath,
    [resolve(__distCli, 'start.js')],
    { stdio: 'inherit', cwd, env: { ...process.env, NODE_ENV: 'production' } },
  )

  child.on('exit', (code, signal) => {
    if (shuttingDown) {
      process.exit(0)
    }
    const ts = new Date().toISOString()
    console.error(
      `[${ts}] Bot exited (code=${code}, signal=${signal}), restarting in ${RESTART_DELAY_MS / 1000}s...`,
    )
    setTimeout(run, RESTART_DELAY_MS)
  })
}

process.on('SIGTERM', () => {
  shuttingDown = true
  child?.kill('SIGTERM')
  setTimeout(() => process.exit(0), 3000)
})

process.on('SIGINT', () => {
  shuttingDown = true
  child?.kill('SIGINT')
  setTimeout(() => process.exit(0), 3000)
})

run()
