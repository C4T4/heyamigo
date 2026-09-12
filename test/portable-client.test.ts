import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, readFile, writeFile, rename, symlink, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openState, checkState } from '../scripts/portable-client.mjs'

async function fixture(fn: (root: string, env: Record<string, string>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'portable-amigo-'))
  const env = {
    AMIGO_STATE_DIR: join(root, 'original'),
    AMIGO_WORKSPACE_ID: randomUUID(),
    AMIGO_AGENT_ID: randomUUID(),
  }
  try {
    await fn(root, env)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('portable Amigo preserves its identity, browser, channel and memory state after moving its directory', async () => {
  await fixture(async (root, env) => {
    const first = await openState(env, true)
    const config = JSON.parse(await readFile(join(first.root, 'config/config.json'), 'utf8'))
    assert.equal(config.whatsapp.enabled, false)
    assert.equal(config.telegram.enabled, false)
    const access = JSON.parse(await readFile(join(first.root, 'config/access.json'), 'utf8'))
    assert.deepEqual(access.users, {})
    assert.deepEqual(access.groups, [])
    const privateFiles = [
      'storage/auth/synthetic-session.json',
      'storage/memory/private.md',
      'home/.config/google-chrome-novnc/synthetic-cookie.json',
      'home/.config/synthetic-provider-token',
    ]
    for (const name of privateFiles) await writeFile(join(first.root, name), env.AMIGO_AGENT_ID)
    const moved = join(root, 'replacement-machine-volume')
    await rename(first.root, moved)
    const second = await checkState({ ...env, AMIGO_STATE_DIR: moved })
    assert.deepEqual(second.identity, first.identity)
    for (const name of privateFiles)
      assert.equal(await readFile(join(second.root, name), 'utf8'), env.AMIGO_AGENT_ID)
    await openState({ ...env, AMIGO_STATE_DIR: moved }, true)
    for (const name of privateFiles)
      assert.equal(await readFile(join(second.root, name), 'utf8'), env.AMIGO_AGENT_ID)
  })
})

test('portable state refuses another Amigo, company, unsupported version, and a foreign non-empty directory', async () => {
  await fixture(async (root, env) => {
    await openState(env, true)
    await assert.rejects(checkState({ ...env, AMIGO_AGENT_ID: randomUUID() }), /different Amigo/)
    await assert.rejects(checkState({ ...env, AMIGO_WORKSPACE_ID: randomUUID() }), /different Amigo/)
    const foreign = join(root, 'foreign')
    await mkdir(foreign, { mode: 0o700 })
    await writeFile(join(foreign, 'private.txt'), 'do not adopt')
    await assert.rejects(openState({ ...env, AMIGO_STATE_DIR: foreign }, true), /non-empty/)
    const manifest = join(env.AMIGO_STATE_DIR!, 'amigo.json')
    const identity = JSON.parse(await readFile(manifest, 'utf8'))
    await writeFile(manifest, JSON.stringify({ ...identity, version: 2 }))
    await assert.rejects(checkState(env), /unsupported/)
  })
})

test('portable state rejects machine-specific paths, traversal, config overlays, and symlinks', async () => {
  await fixture(async (root, env) => {
    await openState(env, true)
    const file = join(env.AMIGO_STATE_DIR!, 'config/config.json')
    const config = JSON.parse(await readFile(file, 'utf8'))
    for (const path of ['/Users/someone/auth', '../other/auth', '..\\other\\auth']) {
      await writeFile(file, JSON.stringify({ ...config, whatsapp: { ...config.whatsapp, authDir: path } }))
      await assert.rejects(checkState(env), /relative|escapes/)
    }
    await writeFile(file, JSON.stringify(config))
    const overlay = join(env.AMIGO_STATE_DIR!, 'config/config.local.json')
    await writeFile(overlay, '{}')
    await assert.rejects(checkState(env), /overrides/)
    await rm(overlay)
    await symlink(root, join(env.AMIGO_STATE_DIR!, 'storage/escape'))
    await writeFile(
      file,
      JSON.stringify({ ...config, whatsapp: { ...config.whatsapp, authDir: 'storage/escape/auth' } }),
    )
    await assert.rejects(checkState(env), /symbolic/)
    await assert.rejects(
      openState({ ...env, AMIGO_STATE_DIR: join(env.AMIGO_STATE_DIR!, 'storage/escape') }),
      /symbolic/,
    )
  })
})
