import { bootBot, installShutdownSignals } from './boot.js'
import { logger } from './logger.js'

installShutdownSignals()

bootBot().catch((err) => {
  logger.error({ err }, 'fatal error during boot')
  process.exit(1)
})
