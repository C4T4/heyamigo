import { spawn } from 'child_process'
import { existsSync, readFileSync, statSync } from 'fs'
import { resolve } from 'path'
import { config } from '../config.js'
import { logger } from '../logger.js'
import { logPrompt } from '../promptlog.js'
import { memoryRoot } from './paths.js'
import { ensureScaffold } from './store.js'

function loadImportPrompt(source: string, target: string): string {
  const path = resolve(process.cwd(), config.memory.importInstructionsFile)
  if (!existsSync(path)) {
    throw new Error(
      `import instructions file missing: ${path}\nCreate one or set memory.importInstructionsFile in config.json`,
    )
  }
  const raw = readFileSync(path, 'utf-8')
  const today = new Date().toISOString().slice(0, 10)
  return raw
    .replaceAll('{{SOURCE}}', source)
    .replaceAll('{{TARGET}}', target)
    .replaceAll('{{DATE}}', today)
}

export async function runImport(sourcePath: string): Promise<void> {
  const absSource = resolve(sourcePath)
  if (!existsSync(absSource) || !statSync(absSource).isDirectory()) {
    throw new Error(`source path does not exist or is not a directory: ${absSource}`)
  }
  ensureScaffold()
  const memDir = resolve(process.cwd(), memoryRoot())
  const prompt = loadImportPrompt(absSource, memDir)

  logger.info({ source: absSource, target: memDir }, 'starting memory import')

  const args = [
    '-p',
    '--output-format',
    'text',
    '--model',
    config.claude.model,
    '--add-dir',
    absSource,
    '--add-dir',
    memDir,
  ]
  if (config.memory.importPermissionMode === 'bypass') {
    args.push('--dangerously-skip-permissions')
  } else {
    args.push('--permission-mode', 'acceptEdits')
  }

  const startedAt = Date.now()
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: process.cwd(),
    })

    let stdoutCapture = ''
    let stderrCapture = ''

    child.stdout?.on('data', (chunk: Buffer) => {
      const s = chunk.toString('utf-8')
      stdoutCapture += s
      process.stdout.write(s)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      const s = chunk.toString('utf-8')
      stderrCapture += s
      process.stderr.write(s)
    })

    child.on('error', (err) => {
      void logPrompt({
        ts: Math.floor(startedAt / 1000),
        caller: 'importer',
        args,
        input: prompt,
        error: `spawn failed: ${err.message}`,
        durationMs: Date.now() - startedAt,
      })
      rejectPromise(new Error(`import spawn failed: ${err.message}`))
    })

    child.on('close', (code) => {
      const durationMs = Date.now() - startedAt
      void logPrompt({
        ts: Math.floor(startedAt / 1000),
        caller: 'importer',
        args,
        input: prompt,
        output: stdoutCapture,
        error:
          code === 0
            ? stderrCapture
              ? `stderr: ${stderrCapture.slice(0, 500)}`
              : undefined
            : `exit ${code}, stderr: ${stderrCapture.slice(0, 500)}`,
        durationMs,
      })
      if (code === 0) {
        logger.info(
          { durationMs, outputChars: stdoutCapture.length },
          'import complete',
        )
        resolvePromise()
      } else {
        logger.error(
          { code, stderr: stderrCapture.slice(0, 1000), durationMs },
          'import failed',
        )
        rejectPromise(
          new Error(
            `import exited with code ${code}\nstderr: ${stderrCapture.slice(0, 500)}`,
          ),
        )
      }
    })

    child.stdin.write(prompt)
    child.stdin.end()
  })
}
