import { clearAllSessions, clearSession, getSessionInfo } from '../ai/sessions.js'
import {
  currentPersonality,
  listPersonalities,
  personalityLabel,
  resolvePersonalityName,
  setActivePersonality,
} from '../ai/personalities.js'
import { getProvider, reloadAllSystemPrompts } from '../ai/providers.js'
import { config, ReasoningEffortSchema } from '../config.js'
import { runDigestNow } from '../memory/scheduler.js'
import {
  getChatThinking,
  getRoleForContext,
  setChatThinking,
} from '../wa/whitelist.js'

export type CommandContext = {
  jid: string
  address: string
  text: string
  senderNumber: string
  isGroup: boolean
  reply(text: string): Promise<void>
}

// Feature-level commands (/journal, /snooze, /tasks, etc.) are intentionally
// absent. The AI is the interface — the owner asks for things in natural
// language and the active provider acts via markers or by editing files.
// Only operational commands live here: reset, status, personality, reload,
// digest, and queue/schedule inspection.
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
    await ctx.reply(reply)
    return true
  }

  if (config.commands.status.includes(cmd)) {
    const provider = getProvider()
    const info = getSessionInfo(ctx.jid, provider.name)
    if (!info) {
      await ctx.reply('No session yet. Next message will bootstrap one.')
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
    await ctx.reply(lines.join('\n'))
    return true
  }

  if (cmd === 'thinking') {
    const provider = getProvider()
    const override = getChatThinking(ctx.address)
    const current = override ?? config.codex.reasoningEffort
    const source = override ? 'chat override' : 'default'
    const usage = `Use ${prefix}thinking ${ReasoningEffortSchema.options.join('|')} or ${prefix}thinking default.`

    if (args.length === 0) {
      const providerNote = provider.name === 'codex'
        ? ''
        : `\nActive provider is ${provider.name}; this setting applies when Codex is active.`
      await ctx.reply(`Thinking: ${current} (${source}).\n${usage}${providerNote}`)
      return true
    }

    const role = getRoleForContext(ctx.senderNumber, ctx.isGroup)
    if (role.name !== 'admin') {
      await ctx.reply('Only admins can change the thinking level.')
      return true
    }

    const requested = args[0]?.toLowerCase()
    if (requested === 'default') {
      setChatThinking(ctx.address, undefined)
      await ctx.reply(
        `Thinking reset to ${config.codex.reasoningEffort} (default) for this chat.`,
      )
      return true
    }

    const parsed = ReasoningEffortSchema.safeParse(requested)
    if (!parsed.success) {
      await ctx.reply(`Unknown thinking level. ${usage}`)
      return true
    }

    setChatThinking(ctx.address, parsed.data)
    const providerNote = provider.name === 'codex'
      ? ' Applies to the next Codex turn.'
      : ` It will apply when Codex is active; current provider is ${provider.name}.`
    await ctx.reply(`Thinking set to ${parsed.data} for this chat.${providerNote}`)
    return true
  }

  if (cmd === 'personality') {
    const available = listPersonalities()
    const usage = `Use ${prefix}personality <name>. Available: ${available.join(', ')}`
    if (args.length === 0) {
      await ctx.reply(
        `Personality: ${personalityLabel(currentPersonality())}.\n${usage}`,
      )
      return true
    }

    const role = getRoleForContext(ctx.senderNumber, ctx.isGroup)
    if (role.name !== 'admin') {
      await ctx.reply('Only admins can change the personality.')
      return true
    }

    const requested = resolvePersonalityName(args.join('-'))
    if (!requested) {
      await ctx.reply(`Unknown personality. ${usage}`)
      return true
    }

    setActivePersonality(requested)
    reloadAllSystemPrompts()
    const resetCount = clearAllSessions()
    await ctx.reply(
      `Personality set to ${personalityLabel(requested)}. Reset ${resetCount} provider session${resetCount === 1 ? '' : 's'} so the new personality applies immediately.`,
    )
    return true
  }

  if (config.commands.reload.includes(cmd)) {
    reloadAllSystemPrompts()
    const existed = clearSession(ctx.jid, getProvider().name)
    const reply = existed
      ? 'Personality reloaded and session reset.'
      : 'Personality reloaded.'
    await ctx.reply(reply)
    return true
  }

  if (cmd === 'digest') {
    await ctx.reply('Digesting memory now, this may take a moment.')
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
    await ctx.reply(formatQueuesSnapshot(snap))
    return true
  }

  if (cmd === 'reminders' || cmd === 'crons') {
    const { listChatSchedules, formatScheduleList } = await import(
      '../queue/schedule-list.js'
    )
    const { getTimezoneForSenderNumber } = await import(
      '../db/identity-sync.js'
    )
    const tz = getTimezoneForSenderNumber(ctx.senderNumber)
    const onlyKind = cmd === 'reminders' ? 'one-shot' : 'recurring'
    const items = listChatSchedules(ctx.address, onlyKind)
    await ctx.reply(formatScheduleList(items, tz, onlyKind))
    return true
  }

  if (cmd === 'threads') {
    if (!config.threads?.enabled) {
      await ctx.reply('threads are disabled in config. Set `threads.enabled: true` to turn on.')
      return true
    }
    const { handleThreadsCommand } = await import('../queue/thread-list.js')
    await ctx.reply(handleThreadsCommand(ctx.jid, args))
    return true
  }

  return false
}
