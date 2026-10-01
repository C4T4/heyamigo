import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { test } from 'node:test'
import { loadSharedHttpMcps } from '../src/mcp/registry.js'
import { loadPack } from '../src/pack/loader.js'

function withEnv(name: string, value: string, fn: () => void): void {
  const prev = process.env[name]
  process.env[name] = value
  try {
    fn()
  } finally {
    if (prev === undefined) delete process.env[name]
    else process.env[name] = prev
  }
}

test('shared HTTP registry drops Playwright and keeps url servers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heyamigo-mcp-'))
  const path = join(dir, 'mcp.json')
  writeFileSync(
    path,
    JSON.stringify({
      servers: {
        playwright: { url: 'http://127.0.0.1:9/mcp' },
        example: {
          url: ' https://example.com/mcp ',
          headers: { Authorization: 'Bearer secret', extra: 1 },
        },
        empty: { url: '   ' },
      },
    }),
  )
  withEnv('HEYAMIGO_MCP_REGISTRY', path, () => {
    assert.deepEqual(loadSharedHttpMcps(), {
      example: {
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer secret' },
      },
    })
  })
})

test('shared HTTP registry throws on invalid JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heyamigo-mcp-'))
  const path = join(dir, 'mcp.json')
  writeFileSync(path, '{')
  withEnv('HEYAMIGO_MCP_REGISTRY', path, () => {
    assert.throws(() => loadSharedHttpMcps(), /not valid JSON/)
  })
})

test('pack rejects the mandatory skill', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heyamigo-pack-'))
  const path = join(dir, 'pack.json')
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      skills: [{ id: 'i-have-adhd', file: './config/mandatory/i-have-adhd.md', mode: 'always' }],
      mcps: ['example'],
    }),
  )
  withEnv('HEYAMIGO_PACK', path, () => {
    assert.throws(() => loadPack(), /is mandatory/)
  })
})

test('pack loads portable skills', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heyamigo-pack-'))
  const path = join(dir, 'pack.json')
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      skills: [
        {
          id: 'example-skill',
          file: './config/skills/example-skill.md',
          mode: 'demand',
          description: 'Example',
        },
      ],
      mcps: [' example '],
    }),
  )
  withEnv('HEYAMIGO_PACK', path, () => {
    const pack = loadPack()
    assert.equal(pack.skills.length, 1)
    assert.equal(pack.skills[0].id, 'example-skill')
    assert.equal(pack.skills[0].mode, 'demand')
    assert.deepEqual(pack.mcps, ['example'])
  })
})
