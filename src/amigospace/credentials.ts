import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

const MAXIMUM_REFRESH_TOKEN_BYTES = 65_536

export function credentialPath(path: string): string {
  return isAbsolute(path) ? path : resolve(path)
}

function parseRefreshToken(value: string): string {
  if (
    value.length < 1 ||
    Buffer.byteLength(value, 'utf8') > MAXIMUM_REFRESH_TOKEN_BYTES ||
    !/^[\x21-\x7e]+$/.test(value)
  ) {
    throw new Error('Amigospace returned an invalid refresh credential')
  }
  return value
}

function requirePrivateOwnership(stat: {
  mode: number
  uid: number
}): void {
  const currentUserId = process.getuid?.()
  if (
    (stat.mode & 0o077) !== 0 ||
    (currentUserId !== undefined && stat.uid !== currentUserId)
  ) {
    throw new Error('Amigospace credential storage is not private to this user')
  }
}

async function requireSecureDirectory(path: string): Promise<void> {
  let directory
  try {
    directory = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    )
    const stat = await directory.stat()
    if (!stat.isDirectory()) {
      throw new Error('Amigospace credential storage is not a directory')
    }
    requirePrivateOwnership(stat)
  } finally {
    await directory?.close()
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  )
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

export async function prepareCredentialDirectory(path: string): Promise<void> {
  const absolutePath = credentialPath(path)
  const directoryPath = dirname(absolutePath)
  await mkdir(directoryPath, { recursive: true, mode: 0o700 })
  await requireSecureDirectory(directoryPath)
}

export async function storeRefreshToken(
  path: string,
  refreshToken: string,
): Promise<void> {
  const absolutePath = credentialPath(path)
  const value = parseRefreshToken(refreshToken)
  await prepareCredentialDirectory(absolutePath)

  const directoryPath = dirname(absolutePath)
  const temporaryPath = join(
    directoryPath,
    `.${basename(absolutePath)}.${randomUUID()}.tmp`,
  )
  let temporary
  try {
    temporary = await open(
      temporaryPath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    )
    await temporary.writeFile(`${value}\n`, 'utf8')
    await temporary.sync()
    await temporary.close()
    temporary = undefined
    await rename(temporaryPath, absolutePath)
    await syncDirectory(directoryPath)
  } finally {
    await temporary?.close()
    await rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}

export async function refreshTokenConfigured(path: string): Promise<boolean> {
  const absolutePath = credentialPath(path)
  let file
  try {
    await requireSecureDirectory(dirname(absolutePath))
    file = await open(
      absolutePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    )
    const stat = await file.stat()
    if (
      !stat.isFile() ||
      stat.size < 1 ||
      stat.size > MAXIMUM_REFRESH_TOKEN_BYTES + 2
    ) {
      throw new Error('Amigospace credential file is invalid')
    }
    requirePrivateOwnership(stat)
    return true
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return false
    }
    throw error
  } finally {
    await file?.close()
  }
}
