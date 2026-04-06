import type { WAMessage, WASocket } from 'baileys'
import { clearSession, getSessionInfo } from '../ai/sessions.js'
import { reloadSystemPrompt } from '../ai/claude.js'
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

export async function tryCommand(ctx: CommandContext): Promise<boolean> {
  const prefix = config.commands.prefix
  const trimmed = ctx.text.trim()
  if (!trimmed.startsWith(prefix)) return false

  const cmd = trimmed.slice(prefix.length).split(/\s+/)[0]?.toLowerCase() ?? ''
  if (!cmd) return false

  if (config.commands.reset.includes(cmd)) {
    const existed = clearSession(ctx.jid)
    const reply = existed
      ? 'Session reset. Next message will bootstrap a fresh Claude session.'
      : 'No session to reset.'
    await sendText(ctx.sock, ctx.jid, reply, ctx.quoted)
    return true
  }

  if (config.commands.status.includes(cmd)) {
    const info = getSessionInfo(ctx.jid)
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
      const max = config.claude.contextWindow
      const used = info.usage.totalContextTokens
      const leftPct = Math.max(0, 100 - (used / max) * 100).toFixed(1)
      lines.push(
        `Context: ${used.toLocaleString()} / ${max.toLocaleString()} (${leftPct}% left)`,
      )
      lines.push(`Turns: ${info.usage.numTurns}`)
    }
    await sendText(ctx.sock, ctx.jid, lines.join('\n'), ctx.quoted)
    return true
  }

  if (config.commands.reload.includes(cmd)) {
    reloadSystemPrompt()
    const existed = clearSession(ctx.jid)
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

  return false
}
