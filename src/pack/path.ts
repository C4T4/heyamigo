import { resolve } from 'path'

const DEFAULT_PACK = './config/pack.json'

// One answer for "where is the pack" shared by the loader and the Amigospace
// connector, so the installer writes the same file the loader reads.
export function packPath(): string {
  return resolve(process.cwd(), process.env.HEYAMIGO_PACK || DEFAULT_PACK)
}
