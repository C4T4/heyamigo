import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'

const BLOCKLIST = new Set(['playwright'])
const DEFAULT_PATH = './config/mcp.json'

export type HttpMcpServer = {
  url: string
  headers: Record<string, string>
}

function registryPath(): string {
  return resolve(process.cwd(), process.env.HEYAMIGO_MCP_REGISTRY || DEFAULT_PATH)
}

function stringHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const headers: Record<string, string> = {}
  for (const [key, header] of Object.entries(value)) {
    if (typeof header === 'string') headers[key] = header
  }
  return headers
}

/**
 * Shared HTTP MCP registry for every agent spawn.
 * Playwright is never taken from this file. A missing file is an empty
 * registry. Invalid JSON throws.
 */
export function loadSharedHttpMcps(): Record<string, HttpMcpServer> {
  const path = registryPath()
  if (!existsSync(path)) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    throw new Error(`mcp registry is not valid JSON: ${path}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`mcp registry must be an object: ${path}`)
  }
  const record = parsed as Record<string, unknown>
  const raw = record.servers ?? parsed
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`mcp registry servers must be an object: ${path}`)
  }
  const out: Record<string, HttpMcpServer> = {}
  for (const [name, spec] of Object.entries(raw)) {
    if (BLOCKLIST.has(name)) continue
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) continue
    const url = typeof (spec as { url?: unknown }).url === 'string'
      ? (spec as { url: string }).url.trim()
      : ''
    if (!url) continue
    out[name] = {
      url,
      headers: stringHeaders((spec as { headers?: unknown }).headers),
    }
  }
  return out
}

export function sharedHttpMcpNames(): string[] {
  return Object.keys(loadSharedHttpMcps())
}

export function claudeHttpMcpServers(): Record<
  string,
  { type: 'http'; url: string; headers: Record<string, string> }
> {
  const servers: Record<
    string,
    { type: 'http'; url: string; headers: Record<string, string> }
  > = {}
  for (const [name, spec] of Object.entries(loadSharedHttpMcps())) {
    servers[name] = { type: 'http', url: spec.url, headers: spec.headers }
  }
  return servers
}

export function geminiHttpMcpServers(): Record<
  string,
  { httpUrl: string; headers: Record<string, string>; trust: true }
> {
  const servers: Record<
    string,
    { httpUrl: string; headers: Record<string, string>; trust: true }
  > = {}
  for (const [name, spec] of Object.entries(loadSharedHttpMcps())) {
    servers[name] = { httpUrl: spec.url, headers: spec.headers, trust: true }
  }
  return servers
}

export function claudeHttpToolPatterns(): string[] {
  return sharedHttpMcpNames().map((name) => `mcp__${name}__*`)
}

export function grokHttpMcpServers(): Record<string, HttpMcpServer> {
  return loadSharedHttpMcps()
}

/** Codex `-c` fragments. HTTP MCP; skip if a spawn cannot take URL servers. */
export function codexHttpMcpConfigArgs(): string[] {
  const args: string[] = []
  for (const [name, spec] of Object.entries(loadSharedHttpMcps())) {
    args.push('-c', `mcp_servers.${name}.url=${JSON.stringify(spec.url)}`)
    for (const [header, value] of Object.entries(spec.headers)) {
      args.push(
        '-c',
        `mcp_servers.${name}.http_headers.${header}=${JSON.stringify(value)}`,
      )
    }
  }
  return args
}
