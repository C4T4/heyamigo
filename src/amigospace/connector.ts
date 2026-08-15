import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { config } from '../config.js'

export const AMIGOSPACE_MCP_SERVER_NAME = 'amigospace'
export const AMIGOSPACE_MCP_TOOL_PATTERN = 'mcp__amigospace__*'

export type ToolAccess = string[] | 'all' | undefined

export type McpCommandSpec = {
  command: string
  args: string[]
}

export type AmigospaceConnectorConfiguration = {
  enabled: boolean
  endpoint: string
  clientId: string
  tokenEndpoint: string
  credentialFile: string
  requestTimeoutMs: number
}

export interface KnowledgeConnector {
  readonly name: string
  commandFor(access: ToolAccess): McpCommandSpec | null
}

const AMIGOSPACE_ROUTING_CONTEXT = `[HeyAmigo runtime: Amigospace MCP is connected. For durable user or project documents, notes, files, and knowledge, use the Amigospace tools directly in this turn for save, search, read, browse, organize, connect, resume, or trash. Do not substitute the local filesystem, storage/memory, Notion, or an async task unless the user explicitly asks for that target. Never claim an Amigospace action succeeded without a successful tool result. Local storage/memory remains only operational agent memory.]`

/**
 * Provider sessions can outlive the system prompt that introduced a newly
 * enabled connector. Keep the active knowledge-store contract on every turn
 * so resumed sessions route durable knowledge consistently.
 */
export function withAmigospaceRoutingContext(
  input: string,
  active: boolean,
): string {
  if (!active) return input
  return `${AMIGOSPACE_ROUTING_CONTEXT}\n\n${input}`
}

export function permitsAmigospace(access: ToolAccess): boolean {
  if (access === 'all') return true
  if (!Array.isArray(access)) return false
  return access.some(
    (tool) =>
      tool === AMIGOSPACE_MCP_TOOL_PATTERN ||
      tool.startsWith('mcp__amigospace__'),
  )
}

export class AmigospaceConnector implements KnowledgeConnector {
  readonly name = AMIGOSPACE_MCP_SERVER_NAME

  constructor(
    private readonly configuration: AmigospaceConnectorConfiguration,
    private readonly proxyScript = fileURLToPath(
      new URL('../../scripts/amigospace-mcp.mjs', import.meta.url),
    ),
  ) {}

  commandFor(access: ToolAccess): McpCommandSpec | null {
    if (!this.configuration.enabled || !permitsAmigospace(access)) return null

    return {
      command: process.execPath,
      args: [
        this.proxyScript,
        '--endpoint',
        this.configuration.endpoint,
        '--client-id',
        this.configuration.clientId,
        '--token-endpoint',
        this.configuration.tokenEndpoint,
        '--credential-file',
        resolve(this.configuration.credentialFile),
        '--timeout-ms',
        String(this.configuration.requestTimeoutMs),
      ],
    }
  }
}

const configuredConnector = new AmigospaceConnector(config.amigospace)

export function configuredAmigospaceMcp(
  access: ToolAccess,
): McpCommandSpec | null {
  return configuredConnector.commandFor(access)
}
