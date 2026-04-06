#!/usr/bin/env node
import { execFileSync } from 'child_process'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')

try {
  execFileSync(
    'npx',
    ['tsx', resolve(root, 'src/cli/index.ts'), ...process.argv.slice(2)],
    { stdio: 'inherit', cwd: root },
  )
} catch (err) {
  process.exit(err.status ?? 1)
}
