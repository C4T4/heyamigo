import { mkdirSync } from 'fs'
import { resolve } from 'path'
import { useMultiFileAuthState } from 'baileys'
import { config } from '../config.js'

export async function initAuth() {
  const authDir = resolve(process.cwd(), config.whatsapp.authDir)
  mkdirSync(authDir, { recursive: true })
  return useMultiFileAuthState(authDir)
}
