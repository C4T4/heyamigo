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

const telegram = program
  .command('telegram')
  .description('Connect a Telegram bot')

telegram
  .command('connect')
  .description('Save a BotFather token, then turn on the chat that messages the bot')
  .action(async () => {
    const { findProjectDir } = await import('./service.js')
    const projectDir = findProjectDir()
    process.chdir(projectDir)
    try {
      const { connectTelegram, telegramAlias } = await import('./telegram-connect.js')
      const result = await connectTelegram({
        projectDir,
        name: telegramAlias(projectDir),
      })
      if (result === 'failed' || result === 'busy') process.exitCode = 1
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
    const install =
      'curl -fsSL https://heyamigo.org/install.sh | bash'
    console.log(`Current version: ${pkgVersion}`)
    console.log('Installing the latest HeyAmigo...')
    try {
      execFileSync('bash', ['-c', install], {
        stdio: 'inherit',
        env: { ...process.env, HEYAMIGO_UPDATE: '1' },
      })
    } catch {
      console.error(`Update failed. Run it again:\n\n  ${install}`)
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
