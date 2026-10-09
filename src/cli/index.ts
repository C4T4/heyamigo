#!/usr/bin/env node
import { readFileSync, realpathSync } from 'fs'
import { dirname, resolve, sep } from 'path'
import { fileURLToPath } from 'url'
import { Command } from 'commander'

const pkgPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../package.json',
)
const pkgVersion = (JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
  version: string
}).version

const program = new Command()

program
  .name('heyamigo')
  .description('WhatsApp and Telegram AI bot powered by Claude, Codex, Grok, or Gemini')
  .version(pkgVersion)

program
  .command('setup')
  .description('Run the setup wizard')
  .action(async () => {
    const { runSetup } = await import('./setup.js')
    await runSetup()
  })

program
  .command('start')
  .description('Start the bot as a background service')
  .action(async () => {
    const { serviceCmd } = await import('./service.js')
    await serviceCmd('start')
  })

program
  .command('stop')
  .description('Stop the bot')
  .action(async () => {
    const { serviceCmd } = await import('./service.js')
    await serviceCmd('stop')
  })

program
  .command('restart')
  .description('Restart the bot')
  .action(async () => {
    const { serviceCmd } = await import('./service.js')
    await serviceCmd('restart')
  })

program
  .command('logs')
  .description('Tail live logs')
  .action(async () => {
    const { serviceCmd } = await import('./service.js')
    await serviceCmd('logs')
  })

program
  .command('status')
  .description('Check if the bot is running')
  .action(async () => {
    const { serviceCmd } = await import('./service.js')
    await serviceCmd('status')
  })

const chrome = program
  .command('chrome')
  .description('Manage the configured authenticated VNC Chrome')

for (const action of ['start', 'stop', 'restart', 'status'] as const) {
  const description = action === 'restart'
    ? 'Restart Chrome and recover the Xvfb/noVNC browser stack'
    : `${action[0]!.toUpperCase()}${action.slice(1)} the configured VNC Chrome`
  chrome
    .command(action)
    .description(description)
    .action(async () => {
      const { findProjectDir } = await import('./service.js')
      process.chdir(findProjectDir())
      const { chromeCmd } = await import('./chrome.js')
      try {
        await chromeCmd(action)
      } catch (err) {
        console.error((err as Error).message)
        process.exitCode = 1
      }
    })
}

const amigospace = program
  .command('amigospace')
  .description('Connect HeyAmigo to cloud Amigospace')

amigospace
  .command('connect')
  .description('Authorize this HeyAmigo installation with Amigospace')
  .action(async () => {
    const { findProjectDir } = await import('./service.js')
    process.chdir(findProjectDir())
    try {
      const { connectAmigospace } = await import('../amigospace/cli.js')
      await connectAmigospace()
    } catch (err) {
      console.error((err as Error).message)
      process.exitCode = 1
    }
  })

amigospace
  .command('status')
  .description('Show the Amigospace connector state without contacting the cloud')
  .action(async () => {
    const { findProjectDir } = await import('./service.js')
    process.chdir(findProjectDir())
    try {
      const { amigospaceStatus } = await import('../amigospace/cli.js')
      await amigospaceStatus()
    } catch (err) {
      console.error((err as Error).message)
      process.exitCode = 1
    }
  })

program
  .command('import <path>')
  .description('Import external knowledge folder into memory')
  .action(async (path: string) => {

    const { runImport } = await import('../memory/importer.js')
    try {
      await runImport(path)
    } catch (err) {
      console.error('Import failed:', (err as Error).message)
      process.exit(1)
    }
  })

program
  .command('update')
  .alias('upgrade')
  .description('Update heyamigo to the latest version')
  .action(async () => {
    const { execFileSync } = await import('child_process')
    let latest: string
    try {
      latest = execFileSync(
        'npm',
        ['view', '@c4t4/heyamigo', 'version'],
        { encoding: 'utf-8' },
      ).trim()
      if (!latest) throw new Error('npm returned an empty version')
    } catch {
      console.error('Could not check the latest npm version. Try again later.')
      process.exit(1)
    }

    console.log(`Current version: ${pkgVersion}`)
    console.log(`Latest version:  ${latest}`)

    if (latest === pkgVersion) {
      console.log('Already up to date.')
      return
    }

    const prefix = installedPrefix()
    if (!prefix) {
      console.error(
        'This heyamigo is not an npm global install, so update does not know where to write.\n' +
          'Run: curl -fsSL https://raw.githubusercontent.com/C4T4/heyamigo/main/scripts/install.sh | bash',
      )
      process.exit(1)
    }

    console.log(`Updating ${pkgVersion} → ${latest} in ${prefix}...`)
    try {
      execFileSync(
        'npm',
        ['install', '-g', '--prefix', prefix, `@c4t4/heyamigo@${latest}`],
        { stdio: 'inherit' },
      )
      console.log('\nUpdated. Restart the bot:')
      console.log('  heyamigo restart')
    } catch {
      console.error(
        'Update failed. Try manually: curl -fsSL https://raw.githubusercontent.com/C4T4/heyamigo/main/scripts/install.sh | bash',
      )
      process.exit(1)
    }
  })

// npm global layout is <prefix>/lib/node_modules/@c4t4/heyamigo/...
// The curl installer uses ~/.local. A plain `npm install -g` uses another
// prefix, so update must write back to the prefix of this running binary.
function installedPrefix(): string | null {
  const script = realpathSync(fileURLToPath(import.meta.url))
  const marker = `${sep}lib${sep}node_modules${sep}`
  const at = script.indexOf(marker)
  if (at <= 0) return null
  return script.slice(0, at)
}

program
  .command('dev')
  .description('Start in foreground with file watching (development)')
  .action(async () => {

    const { main } = await import('./start.js')
    await main()
  })

program.parse(process.argv)
