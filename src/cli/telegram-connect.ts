import * as p from '@clack/prompts'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

type TelegramUser = {
  id: number
  is_bot?: boolean
  first_name?: string
  last_name?: string
  username?: string
}

type TelegramMessage = {
  message_id: number
  chat: { id: number; type: string }
  from?: TelegramUser
}

type TelegramUpdate = {
  update_id: number
  message?: TelegramMessage
}

const TOKEN_RE = /^\d{6,}:[A-Za-z0-9_-]{20,}$/

function connectedNote(name: string): string {
  return [
    'Connected.',
    '',
    'This chat is how you talk to me. Write here and I reply. You do not have to say my name.',
    '',
    `I stay quiet in groups until you turn that group on. Then people say "${name}" to reach me.`,
  ].join('\n')
}

function heyamigoIsRunning(projectDir: string): boolean {
  const pidFile = resolve(projectDir, 'storage/heyamigo.pid')
  if (!existsSync(pidFile)) return false
  const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10)
  if (!Number.isFinite(pid)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function telegram<T>(
  token: string,
  method: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(method === 'getUpdates' ? 20_000 : 15_000),
  })
  let payload: { ok?: boolean; result?: T; description?: string }
  try {
    payload = await res.json() as { ok?: boolean; result?: T; description?: string }
  } catch {
    throw new Error(`Telegram ${method} returned HTTP ${res.status}`)
  }
  if (!res.ok || !payload.ok || payload.result === undefined) {
    throw new Error(payload.description || `Telegram ${method} returned HTTP ${res.status}`)
  }
  return payload.result
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf-8')
}

function savedToken(configPath: string): string {
  try {
    const telegram = readJson(configPath).telegram
    if (!telegram || typeof telegram !== 'object') return ''
    const token = (telegram as { botToken?: unknown }).botToken
    return typeof token === 'string' ? token.trim() : ''
  } catch {
    return ''
  }
}

function saveToken(configPath: string, token: string): void {
  const cfg = readJson(configPath)
  const current = cfg.telegram
  const telegram = current && typeof current === 'object'
    ? { ...(current as Record<string, unknown>) }
    : {}
  const interval = telegram.pollIntervalMs
  cfg.telegram = {
    ...telegram,
    enabled: true,
    botToken: token,
    pollIntervalMs: typeof interval === 'number' ? interval : 1000,
  }
  writeJson(configPath, cfg)
}

function allowOwner(
  accessPath: string,
  userKey: string,
  displayName: string,
): void {
  const access = readJson(accessPath)
  const users = access.users && typeof access.users === 'object'
    ? { ...(access.users as Record<string, unknown>) }
    : {}
  if (!users[userKey]) {
    users[userKey] = { role: 'admin', name: displayName || 'Owner' }
    access.users = users
  }
  const dms = access.dms && typeof access.dms === 'object'
    ? access.dms as { defaultMode?: unknown; allowed?: unknown }
    : {}
  const allowed = Array.isArray(dms.allowed) ? [...dms.allowed] : []
  if (!allowed.some((entry) => {
    return !!entry && typeof entry === 'object' &&
      (entry as { number?: unknown }).number === userKey
  })) {
    allowed.push({
      number: userKey,
      mode: 'active',
      triggerMode: 'all',
      proactive: false,
    })
  }
  access.dms = {
    defaultMode: typeof dms.defaultMode === 'string' ? dms.defaultMode : 'off',
    allowed,
  }
  writeJson(accessPath, access)
}

function displayName(user: TelegramUser): string {
  const full = [user.first_name, user.last_name].filter(Boolean).join(' ').trim()
  if (full && user.username) return `${full} (@${user.username})`
  return full || (user.username ? `@${user.username}` : 'Owner')
}

async function askToken(): Promise<string | null> {
  p.log.info(
    'In Telegram, open @BotFather and send /newbot. Paste the token it gives you.',
  )
  for (let attempt = 1; attempt <= 3; attempt++) {
    const entered = await p.password({
      message: 'Telegram bot token',
    })
    if (p.isCancel(entered)) return null
    const token = entered.trim()
    if (!TOKEN_RE.test(token)) {
      p.log.error('That is not a bot token. It looks like 123456789:AAH...')
      continue
    }
    try {
      const me = await telegram<TelegramUser>(token, 'getMe')
      if (!me.username || me.is_bot === false) {
        throw new Error('Telegram did not return a bot account')
      }
      p.log.success(`Bot: @${me.username}`)
      return token
    } catch (err) {
      p.log.error(err instanceof Error ? err.message : String(err))
    }
  }
  return null
}

async function waitForOwner(token: string, botId: number): Promise<{
  user: TelegramUser
  chatId: number
  updateId: number
} | null> {
  const deadline = Date.now() + 45_000
  let offset = 0
  while (Date.now() < deadline) {
    const updates = await telegram<TelegramUpdate[]>(token, 'getUpdates', {
      offset,
      timeout: 10,
      allowed_updates: ['message'],
    })
    for (const update of updates) {
      offset = update.update_id + 1
      const msg = update.message
      const from = msg?.from
      if (!msg || !from || from.is_bot || from.id === botId) continue
      if (msg.chat.type !== 'private') continue
      return { user: from, chatId: msg.chat.id, updateId: update.update_id }
    }
  }
  return null
}

export async function connectTelegram(opts: {
  projectDir: string
  name: string
}): Promise<'connected' | 'kept' | 'skipped' | 'busy' | 'failed'> {
  const configPath = resolve(opts.projectDir, 'config/config.json')
  const accessPath = resolve(opts.projectDir, 'config/access.json')
  if (!existsSync(configPath) || !existsSync(accessPath)) {
    p.cancel('config/config.json and config/access.json are required. Run: heyamigo setup')
    return 'failed'
  }

  const existing = savedToken(configPath)
  if (existing) {
    const choice = await p.select({
      message: 'A Telegram bot token is already saved. What should happen?',
      options: [
        { value: 'keep', label: 'Keep it' },
        { value: 'replace', label: 'Connect a different bot' },
      ],
      initialValue: 'keep',
    })
    if (p.isCancel(choice) || choice === 'keep') {
      p.log.success('Telegram already connected')
      return 'kept'
    }
  } else {
    const want = await p.confirm({
      message: 'Connect Telegram?',
      initialValue: true,
    })
    if (p.isCancel(want) || !want) {
      p.log.info('Skipped Telegram. Connect later: heyamigo telegram connect')
      return 'skipped'
    }
  }

  if (heyamigoIsRunning(opts.projectDir)) {
    p.log.warning(
      'HeyAmigo is running, so Telegram was not connected. Stop it, then run:\n\n  heyamigo stop\n  heyamigo telegram connect',
    )
    return 'busy'
  }

  const token = await askToken()
  if (!token) {
    p.log.warning('Telegram was not connected.')
    return 'failed'
  }

  const me = await telegram<TelegramUser>(token, 'getMe')
  await telegram<boolean>(token, 'deleteWebhook', { drop_pending_updates: false })

  let owner: Awaited<ReturnType<typeof waitForOwner>> = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    p.log.step(`Open https://t.me/${me.username} and send any message.`)
    const waiting = p.spinner()
    waiting.start(`Waiting for a message to @${me.username}`)
    try {
      owner = await waitForOwner(token, me.id)
    } catch (err) {
      waiting.stop('Telegram did not answer')
      p.log.error(err instanceof Error ? err.message : String(err))
      return 'failed'
    }
    if (owner) {
      waiting.stop(`Message received from ${displayName(owner.user)}`)
      break
    }
    waiting.stop(`No message yet (${attempt}/3)`)
    if (attempt < 3) {
      const retry = await p.confirm({
        message: 'Keep waiting for the Telegram message?',
        initialValue: true,
      })
      if (p.isCancel(retry) || !retry) break
    }
  }

  if (!owner) {
    p.log.warning('Telegram was not connected. The token was not saved.')
    return 'failed'
  }

  const userKey = `tg_${owner.user.id}`
  saveToken(configPath, token)
  allowOwner(accessPath, userKey, displayName(owner.user))

  try {
    await telegram(token, 'sendMessage', {
      chat_id: owner.chatId,
      text: connectedNote(opts.name),
    })
    await telegram(token, 'getUpdates', {
      offset: owner.updateId + 1,
      timeout: 0,
    })
  } catch (err) {
    p.log.error(err instanceof Error ? err.message : String(err))
    p.log.warning(
      `The token is saved and ${userKey} is allowed, but the connected note was not sent.`,
    )
    return 'failed'
  }

  p.log.success(`Telegram connected. ${userKey} can message @${me.username}.`)
  return 'connected'
}

export function telegramAlias(projectDir: string): string {
  try {
    const triggers = readJson(resolve(projectDir, 'config/config.json')).triggers
    const aliases = triggers && typeof triggers === 'object'
      ? (triggers as { aliases?: unknown }).aliases
      : undefined
    if (Array.isArray(aliases)) {
      const name = aliases.find((alias) =>
        typeof alias === 'string' && alias.trim() && alias !== 'heyamigo',
      )
      if (typeof name === 'string') return name
    }
  } catch {
    // The caller still has a name to put in the note.
  }
  return 'amigo'
}
