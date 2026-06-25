import { dirname } from 'path'
import { getProvider } from '../ai/providers.js'
import { config } from '../config.js'
import { logger } from '../logger.js'

const UNTRANSCRIBABLE = '[UNTRANSCRIBABLE]'

export async function transcribeAudioFile(params: {
  path: string
  mime?: string | null
  address?: string
  externalMsgId?: string
}): Promise<string | null> {
  const cfg = config.audio.transcription
  if (!cfg.enabled) return null

  try {
    const provider = getProvider()
    const result = await provider.runTask({
      input: [
        'Transcribe the audio file at this exact path.',
        '',
        params.path,
        '',
        'Return only the spoken transcript text.',
        `If the file is not readable or cannot be transcribed, return exactly ${UNTRANSCRIBABLE}.`,
        'Do not answer the speaker. Do not summarize. Do not add labels, markdown, or commentary.',
      ].join('\n'),
      caller: 'audio-transcription',
      mode: 'read-only',
      lane: 'background',
      includeSystemPrompt: false,
      addDirs: [dirname(params.path), config.storage.mediaDir],
    })

    const text = cleanupTranscript(result.reply)
    if (!text) return null
    logger.info(
      {
        provider: provider.name,
        address: params.address,
        externalMsgId: params.externalMsgId,
        chars: text.length,
      },
      'audio transcribed',
    )
    return text
  } catch (err) {
    logger.warn(
      {
        err,
        provider: config.ai.provider,
        address: params.address,
        externalMsgId: params.externalMsgId,
      },
      'audio transcription failed',
    )
    return null
  }
}

function cleanupTranscript(reply: string): string | null {
  let text = reply.trim()
  if (!text) return null
  text = text.replace(/^```(?:text)?\s*/i, '').replace(/\s*```$/i, '').trim()
  text = text.replace(/^transcript:\s*/i, '').trim()
  if (!text || text === UNTRANSCRIBABLE) return null
  return text
}
