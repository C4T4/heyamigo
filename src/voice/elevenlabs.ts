import { randomUUID } from 'crypto'
import { mkdir, stat, writeFile } from 'fs/promises'
import { resolve } from 'path'
import { config } from '../config.js'
import { logger } from '../logger.js'

export type VoiceFile = {
  path: string
  mime: string
  bytes: number
}

const ELEVENLABS_TTS_BASE_URL = 'https://api.elevenlabs.io/v1/text-to-speech'

function outputMeta(outputFormat: string): { ext: string; mime: string } {
  if (outputFormat.startsWith('mp3')) return { ext: 'mp3', mime: 'audio/mpeg' }
  if (outputFormat.startsWith('opus')) return { ext: 'opus', mime: 'audio/opus' }
  if (outputFormat.startsWith('wav')) return { ext: 'wav', mime: 'audio/wav' }
  if (outputFormat.startsWith('pcm')) return { ext: 'pcm', mime: 'audio/L16' }
  if (outputFormat.startsWith('ulaw')) return { ext: 'ulaw', mime: 'audio/basic' }
  if (outputFormat.startsWith('alaw')) return { ext: 'alaw', mime: 'audio/basic' }
  return { ext: 'bin', mime: 'application/octet-stream' }
}

async function outboxVoicePath(outputFormat: string): Promise<{ path: string; mime: string }> {
  const meta = outputMeta(outputFormat)
  const dir = resolve(process.cwd(), 'storage/outbox')
  await mkdir(dir, { recursive: true })
  return {
    path: resolve(dir, `voice-${Date.now()}-${randomUUID()}.${meta.ext}`),
    mime: meta.mime,
  }
}

export async function synthesizeVoiceReply(text: string): Promise<VoiceFile | null> {
  const voice = config.voice
  if (!voice.enabled) return null
  if (voice.provider !== 'elevenlabs') return null

  const apiKey = process.env[voice.apiKeyEnv]
  if (!apiKey) {
    logger.warn(
      { apiKeyEnv: voice.apiKeyEnv },
      'voice reply skipped; API key env var is not set',
    )
    return null
  }
  if (!voice.voiceId.trim()) {
    logger.warn('voice reply skipped; voice.voiceId is not configured')
    return null
  }

  const cleaned = text.trim()
  if (!cleaned) return null
  if (cleaned.length > voice.maxChars) {
    logger.warn(
      { chars: cleaned.length, maxChars: voice.maxChars },
      'voice reply skipped; text is too long',
    )
    return null
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), voice.timeoutMs)
  timeout.unref()

  try {
    const url = new URL(`${ELEVENLABS_TTS_BASE_URL}/${encodeURIComponent(voice.voiceId)}`)
    url.searchParams.set('output_format', voice.outputFormat)

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'xi-api-key': apiKey,
      },
      body: JSON.stringify({
        text: cleaned,
        model_id: voice.modelId,
      }),
      signal: controller.signal,
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      logger.warn(
        { status: res.status, body: body.slice(0, 500) },
        'voice reply synthesis failed',
      )
      return null
    }

    const buffer = Buffer.from(await res.arrayBuffer())
    const file = await outboxVoicePath(voice.outputFormat)
    await writeFile(file.path, buffer)
    const s = await stat(file.path)
    logger.info(
      { path: file.path, chars: cleaned.length, bytes: s.size },
      'voice reply synthesized',
    )
    return { path: file.path, mime: file.mime, bytes: s.size }
  } catch (err) {
    logger.warn(
      { err, timeout: (err as Error).name === 'AbortError' ? voice.timeoutMs : undefined },
      'voice reply synthesis failed',
    )
    return null
  } finally {
    clearTimeout(timeout)
  }
}
