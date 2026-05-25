import type { WAMessage, WASocket } from 'baileys'
import { clearSession, getSessionInfo } from '../ai/sessions.js'
import { getProvider, reloadAllSystemPrompts } from '../ai/providers.js'
import { config } from '../config.js'
import { runDigestNow } from '../memory/scheduler.js'
import { sendText } from '../wa/sender.js'

export type CommandContext = {
  sock: WASocket
  jid: string
  text: string
  senderNumber: string
  quoted?: WAMessage
}

// Feature-level commands (/journal, /snooze, /tasks, etc.) are intentionally
// absent. Claude is the interface — the owner asks for things in natural
// language and Claude acts via markers or by editing files directly.
// Only operational commands live here: reset, status, reload, digest.
export async function tryCommand(ctx: CommandContext): Promise<boolean> {
  const prefix = config.commands.prefix
  const trimmed = ctx.text.trim()
  if (!trimmed.startsWith(prefix)) return false

  const afterPrefix = trimmed.slice(prefix.length)
  const tokens = afterPrefix.split(/\s+/)
  const cmd = tokens[0]?.toLowerCase() ?? ''
  const args = tokens.slice(1)
  if (!cmd) return false

  if (config.commands.reset.includes(cmd)) {
    const provider = getProvider()
    const existed = clearSession(ctx.jid, provider.name)
    const reply = existed
      ? `Session reset. Next message will bootstrap a fresh ${provider.name} session.`
      : 'No session to reset.'
    await sendText(ctx.sock, ctx.jid, reply, ctx.quoted)
    return true
  }

  if (config.commands.status.includes(cmd)) {
    const provider = getProvider()
    const info = getSessionInfo(ctx.jid, provider.name)
    if (!info) {
      await sendText(
        ctx.sock,
        ctx.jid,
        'No session yet. Next message will bootstrap one.',
        ctx.quoted,
      )
      return true
    }
    const lines = [`Session: ${info.sessionId.slice(0, 8)}…`]
    if (info.usage) {
      const max = provider.contextWindow
      const used = info.usage.totalContextTokens
      // Clamp leftPct to [0, 100] so stale or inconsistent data
      // doesn't surface a negative or >100 percentage.
      const leftRatio = Math.max(0, Math.min(1, 1 - used / max))
      const leftPct = (leftRatio * 100).toFixed(1)
      lines.push(
        `Context: ${used.toLocaleString()} / ${max.toLocaleString()} (${leftPct}% left, last turn)`,
      )
      lines.push(`Turns: ${info.usage.numTurns}`)
    }
    await sendText(ctx.sock, ctx.jid, lines.join('\n'), ctx.quoted)
    return true
  }

  if (config.commands.reload.includes(cmd)) {
    reloadAllSystemPrompts()
    const existed = clearSession(ctx.jid, getProvider().name)
    const reply = existed
      ? 'Personality reloaded and session reset.'
      : 'Personality reloaded.'
    await sendText(ctx.sock, ctx.jid, reply, ctx.quoted)
    return true
  }

  if (cmd === 'digest') {
    await sendText(
      ctx.sock,
      ctx.jid,
      'Digesting memory now, this may take a moment.',
      ctx.quoted,
    )
    runDigestNow({
      jid: ctx.jid,
      number: ctx.senderNumber || undefined,
      reason: 'manual /digest',
    }).catch(() => undefined)
    return true
  }

  if (cmd === 'queues') {
    const { takeQueuesSnapshot, formatQueuesSnapshot } = await import(
      '../queue/observability.js'
    )
    const snap = takeQueuesSnapshot()
    await sendText(ctx.sock, ctx.jid, formatQueuesSnapshot(snap), ctx.quoted)
    return true
  }

  if (cmd === 'reminders' || cmd === 'crons') {
    const { listChatSchedules, formatScheduleList } = await import(
      '../queue/schedule-list.js'
    )
    const { formatAddress, jidToAddress } = await import(
      '../db/address.js'
    )
    const { getTimezoneForSenderNumber } = await import(
      '../db/identity-sync.js'
    )
    const chatAddress = formatAddress(jidToAddress(ctx.jid))
    const tz = getTimezoneForSenderNumber(ctx.senderNumber)
    const onlyKind = cmd === 'reminders' ? 'one-shot' : 'recurring'
    const items = listChatSchedules(chatAddress, onlyKind)
    await sendText(
      ctx.sock,
      ctx.jid,
      formatScheduleList(items, tz, onlyKind),
      ctx.quoted,
    )
    return true
  }

  if (cmd === 'threads') {
    if (!config.threads?.enabled) {
      await sendText(
        ctx.sock,
        ctx.jid,
        'threads are disabled in config. Set `threads.enabled: true` to turn on.',
        ctx.quoted,
      )
      return true
    }
    const { handleThreadsCommand } = await import('../queue/thread-list.js')
    await sendText(
      ctx.sock,
      ctx.jid,
      handleThreadsCommand(ctx.jid, args),
      ctx.quoted,
    )
    return true
  }

  return false
}
