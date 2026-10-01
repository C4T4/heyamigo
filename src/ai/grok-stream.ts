// Grok `--output-format streaming-json` emits every assistant text chunk,
// including the status sentence written before a tool call. The reply is the
// text after the last tool_call. If the model never writes again after a tool,
// the earlier text is kept so the chat does not go silent.

type StreamEvent = {
  type?: unknown
  data?: unknown
}

export function assembleGrokStreamReply(stdout: string): string {
  let current = ''
  let kept = ''
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let ev: StreamEvent
    try {
      ev = JSON.parse(trimmed) as StreamEvent
    } catch {
      continue
    }
    if (ev.type === 'text' && typeof ev.data === 'string') {
      current += ev.data
      continue
    }
    if (ev.type === 'tool_call') {
      if (current.trim()) kept = current
      current = ''
    }
  }
  return current.trim() ? current : kept
}
