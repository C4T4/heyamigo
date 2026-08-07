export function isStaleSessionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const msg = err.message.toLowerCase()
  return (
    msg.includes('no conversation found') ||
    msg.includes('session not found') ||
    msg.includes('no session found') ||
    msg.includes('invalid session identifier') ||
    msg.includes('input token count exceeds the maximum') ||
    msg.includes('maximum context length') ||
    msg.includes('context window exceeded') ||
    msg.includes('gemini returned empty response text')
  )
}
