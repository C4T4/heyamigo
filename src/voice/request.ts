const VOICE_REQUEST_PATTERNS = [
  /\b(?:reply|respond|answer|send|say|speak|talk)\b.{0,40}\b(?:voice|audio|spoken|out loud|aloud)\b/i,
  /\b(?:voice|audio|spoken)\b.{0,40}\b(?:reply|response|answer|message|note)\b/i,
  /\b(?:send|reply with|respond with)\b.{0,20}\b(?:a )?(?:voice note|voice message|audio message)\b/i,
  /\b(?:can you|could you|please)?\s*(?:speak|say it out loud|talk to me)\b/i,
  /\b(?:responde|contestame|contesta|habla|dilo)\b.{0,40}\b(?:voz|audio|hablado)\b/i,
  /\b(?:mensaje|nota|respuesta)\b.{0,40}\b(?:de voz|en audio)\b/i,
]

export function wantsVoiceReply(text: string): boolean {
  const cleaned = text.trim()
  if (!cleaned) return false
  return VOICE_REQUEST_PATTERNS.some((re) => re.test(cleaned))
}
