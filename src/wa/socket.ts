import type { Boom } from '@hapi/boom'
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestWaWebVersion,
  type WASocket,
} from 'baileys'
import QRCode from 'qrcode'
import { config } from '../config.js'
import { logger } from '../logger.js'
import { initAuth } from './auth.js'

export type SocketListener = (sock: WASocket) => void

let currentSocket: WASocket | null = null
let currentQr: string | null = null
let pairingCodeShown = false
let reconnectAttempts = 0
const MAX_RECONNECT_ATTEMPTS = 10
let onNewSocket: SocketListener | null = null

export function getSocket(): WASocket | null {
  return currentSocket
}

export function getCurrentQr(): string | null {
  return currentQr
}

export async function startSocket(
  listener?: SocketListener,
): Promise<WASocket> {
  if (listener) onNewSocket = listener

  const { state, saveCreds } = await initAuth()

  const { version, isLatest } = await fetchLatestWaWebVersion({})
  logger.info({ version, isLatest }, 'using WA Web version')

  const sock = makeWASocket({
    auth: state,
    version,
    browser: Browsers.macOS(config.whatsapp.browserName),
    logger: logger.child({ module: 'baileys' }) as never,
    // Don't emit events for messages we send ourselves — eliminates echo
    // loops and avoids double-storing outbound messages (outgoing.ts
    // persists them explicitly).
    emitOwnEvents: false,
  })

  currentSocket = sock
  onNewSocket?.(sock)

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      currentQr = qr
      const ascii = await QRCode.toString(qr, { type: 'utf8', margin: 2 })
      process.stdout.write(
        '\nScan this QR in WhatsApp → Settings → Linked Devices → Link a device\n',
      )
      process.stdout.write(ascii + '\n')

      // Also show pairing code (works on any terminal, even broken QR rendering)
      if (!pairingCodeShown && config.owner.number) {
        pairingCodeShown = true
        sock
          .requestPairingCode(config.owner.number)
          .then((code) => {
            process.stdout.write(
              `\nOr enter pairing code: ${code}\n` +
                `WhatsApp → Linked Devices → Link with phone number\n\n`,
            )
          })
          .catch(() => undefined)
      }
    }

    if (connection === 'open') {
      logger.info({ user: sock.user }, 'connection open')
      reconnectAttempts = 0
      currentQr = null
      pairingCodeShown = false
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode
      const loggedOut = statusCode === DisconnectReason.loggedOut
      logger.warn({ statusCode, loggedOut }, 'connection closed')

      currentSocket = null

      if (loggedOut) {
        logger.error(
          'logged out — delete storage/auth and restart to re-pair',
        )
        return
      }

      reconnectAttempts += 1
      if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
        logger.fatal(
          { attempts: reconnectAttempts },
          'max reconnect attempts reached, giving up',
        )
        process.exit(1)
      }

      const delayMs = Math.min(2000 * reconnectAttempts, 30000)
      logger.info({ attempt: reconnectAttempts, delayMs }, 'reconnecting')
      setTimeout(() => {
        void startSocket().catch((err) =>
          logger.error({ err }, 'reconnect failed'),
        )
      }, delayMs)
    }
  })

  return sock
}
