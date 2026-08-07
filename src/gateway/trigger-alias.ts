function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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
