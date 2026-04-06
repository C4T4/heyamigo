import { appendFile, mkdir, readFile } from 'fs/promises'
import { resolve } from 'path'
import { config } from '../config.js'

export type StoredMessage = {
  id: string
  jid: string
  direction: 'in' | 'out'
  fromMe: boolean
  sender: string
  senderNumber: string
  pushName?: string
  timestamp: number
  text: string
  messageType: string
  mediaType?: 'image' | 'video' | 'audio' | 'document' | 'sticker'
  mediaPath?: string
  mediaMime?: string
}

let dirReady = false

async function ensureDir(): Promise<void> {
  if (dirReady) return
  await mkdir(resolve(process.cwd(), config.storage.messagesDir), {
    recursive: true,
  })
  dirReady = true
}

function fileFor(jid: string): string {
  return resolve(process.cwd(), config.storage.messagesDir, `${jid}.jsonl`)
}

export async function append(msg: StoredMessage): Promise<void> {
  await ensureDir()
  const line = JSON.stringify(msg) + '\n'
  await appendFile(fileFor(msg.jid), line, 'utf-8')
}

export async function readLast(
  jid: string,
  n: number,
): Promise<StoredMessage[]> {
  try {
    const content = await readFile(fileFor(jid), 'utf-8')
    const lines = content.trimEnd().split('\n').filter(Boolean)
    const tail = lines.slice(-n)
    return tail.map((l) => JSON.parse(l) as StoredMessage)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}
