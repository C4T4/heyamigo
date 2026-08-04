import { existsSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

export type BrowserTaskMcpSpec = {
  command: string
  args: string[]
}

export function browserTaskMcpSpec(input: {
  cdpEndpoint: string
  taskId: string
  databasePath: string
}): BrowserTaskMcpSpec {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  const javascriptEntry = resolve(moduleDir, 'task-mcp.js')
  const typescriptEntry = resolve(moduleDir, 'task-mcp.ts')
  const commonArgs = [
    '--cdp-endpoint', input.cdpEndpoint,
    '--task-id', input.taskId,
    '--db-path', input.databasePath,
  ]

  if (existsSync(javascriptEntry)) {
    return {
      command: process.execPath,
      args: [javascriptEntry, ...commonArgs],
    }
  }

  // `npm run dev` executes src through tsx, so the sibling source entrypoint
  // is the packaged server for that mode. Production always takes the built
  // JavaScript branch above.
  if (existsSync(typescriptEntry)) {
    const tsx = resolve(process.cwd(), 'node_modules', '.bin', 'tsx')
    if (!existsSync(tsx)) {
      throw new Error(`Task browser MCP requires tsx in development: ${tsx}`)
    }
    return {
      command: tsx,
      args: [typescriptEntry, ...commonArgs],
    }
  }

  throw new Error(`Task browser MCP entrypoint not found beside ${moduleDir}`)
}
