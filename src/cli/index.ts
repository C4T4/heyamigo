#!/usr/bin/env node
import { Command } from 'commander'

const program = new Command()

program
  .name('heyamigo')
  .description('WhatsApp AI Bot powered by Claude')
  .version('0.1.0')

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
    const { execSync } = await import('child_process')
    console.log('Updating @c4t4/heyamigo...')
    try {
      execSync('npm install @c4t4/heyamigo@latest', { stdio: 'inherit' })
      console.log('\nUpdated. Restart the bot:')
      console.log('  npx @c4t4/heyamigo restart')
    } catch {
      console.error('Update failed. Try manually: npm install @c4t4/heyamigo@latest')
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
