function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Word-boundary alias match. "claude" in a group still wakes the agent;
// whether anything is posted is the model's call (empty reply = silent).
export function firstMatchingAlias(
  text: string,
  aliases: readonly string[],
): string | null {
  for (const alias of aliases) {
    const re = new RegExp(
      `(^|[^a-zA-Z0-9_])${escapeRegex(alias)}([^a-zA-Z0-9_]|$)`,
      'i',
    )
    if (re.test(text)) return alias
  }
  return null
}

// A name-only ping is a liveness check, not an agent task. Sending it through
// an unrestricted CLI can make the model search the project for its own name
// instead of simply acknowledging the user.
export function isBareAliasInvocation(
  text: string,
  aliases: readonly string[],
): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  return aliases.some((alias) => {
    const re = new RegExp(
      `^[^a-zA-Z0-9_]*${escapeRegex(alias)}[^a-zA-Z0-9_]*$`,
      'i',
    )
    return re.test(trimmed)
  })
}

// Bot replies get an italic stats footer like `_5.8s · grok-default · +digest_`.
// Used to tell "quoted the bot" from "quoted the owner" when they share a WA account.
export function looksLikeBotStatsFooter(text: string): boolean {
  return /_\d+(?:\.\d+)?s · /.test(text)
}

export function isBotStoredMessageId(storedId: string): boolean {
  return storedId.startsWith('outbound-')
}

export function storedIdMatchesWaMsg(
  storedId: string,
  waMsgId: string,
): boolean {
  return isBotStoredMessageId(storedId) && storedId.endsWith(`-${waMsgId}`)
}

// The model sometimes narrates silence ("No reply.", "Staying silent…")
// instead of returning empty. Those must not be posted.
export function isSilenceNarration(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return true
  if (trimmed.length > 400) return false
  const lower = trimmed.toLowerCase()
  if (
    /^(no reply\.?|staying silent\b.*|not (an? )?(invocation|request)\b.*)$/i.test(
      trimmed,
    )
  ) {
    return true
  }
  if (
    /\b(staying silent|not (an? )?invocation|not invoking the bot|nothing posts to the chat|this is not an invocation)\b/i.test(
      lower,
    )
  ) {
    return true
  }
  if (
    trimmed.length < 160 &&
    /\b(no reply|not for me|not addressed to me)\b/i.test(lower)
  ) {
    return true
  }
  return false
}
