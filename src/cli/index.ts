#!/usr/bin/env node
import { readFileSync } from 'fs'
import { dirname, resolve } from 'path'
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
  .description('WhatsApp and Telegram AI bot powered by Claude, Codex, or Grok')
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
  chrome
    .command(action)
    .description(`${action[0]!.toUpperCase()}${action.slice(1)} the configured VNC Chrome`)
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

    console.log(`Updating ${pkgVersion} → ${latest}...`)
    try {
      execFileSync(
        'npm',
        ['install', '-g', `@c4t4/heyamigo@${latest}`],
        { stdio: 'inherit' },
      )
      console.log('\nUpdated. Restart the bot:')
      console.log('  heyamigo restart')
    } catch {
      console.error('Update failed. Try manually: npm install -g @c4t4/heyamigo@latest')
      process.exit(1)
    }
  })

program
  .command('dev')
  .description('Start in foreground with file watching (development)')
  .action(async () => {

    const { main } = await import('./start.js')
    await main()
  })

program.parse(process.argv)
