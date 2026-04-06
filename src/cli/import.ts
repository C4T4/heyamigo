import { runImport } from '../memory/importer.js'

async function main() {
  const source = process.argv[2]
  if (!source) {
    console.error('Usage: npm run import -- <path-to-source-folder>')
    process.exit(1)
  }
  try {
    await runImport(source)
    process.exit(0)
  } catch (err) {
    console.error('Import failed:', (err as Error).message)
    process.exit(1)
  }
}

void main()
