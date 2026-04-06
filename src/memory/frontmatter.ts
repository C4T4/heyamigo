export type FrontmatterValue =
  | string
  | string[]
  | number
  | boolean
  | null

export type Frontmatter = Record<string, FrontmatterValue>

export type Parsed = { data: Frontmatter; body: string }

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

export function parseFrontmatter(content: string): Parsed {
  const m = content.match(FM_RE)
  if (!m) return { data: {}, body: content }
  const yaml = m[1] ?? ''
  const body = m[2] ?? ''
  const data: Frontmatter = {}
  for (const rawLine of yaml.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/)
    if (!kv) continue
    const key = kv[1]!
    data[key] = parseValue((kv[2] ?? '').trim())
  }
  return { data, body }
}

function parseValue(raw: string): FrontmatterValue {
  if (raw === '' || raw === 'null' || raw === '~') return null
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim()
    if (!inner) return []
    return splitArgs(inner).map(stripQuotes)
  }
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return stripQuotes(raw)
  }
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw)
  return raw
}

function splitArgs(inner: string): string[] {
  const out: string[] = []
  let current = ''
  let quote: string | null = null
  for (const ch of inner) {
    if (quote) {
      current += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    if (ch === ',') {
      out.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim()) out.push(current.trim())
  return out
}

function stripQuotes(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1)
  }
  return s
}

export function serializeFrontmatter(
  data: Frontmatter,
  body: string,
): string {
  const lines = ['---']
  for (const [k, v] of Object.entries(data)) {
    lines.push(`${k}: ${serializeValue(v)}`)
  }
  lines.push('---')
  lines.push('')
  lines.push(body.trimStart())
  return lines.join('\n')
}

function serializeValue(v: FrontmatterValue): string {
  if (v === null) return 'null'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') return String(v)
  if (Array.isArray(v)) {
    return '[' + v.map((x) => JSON.stringify(x)).join(', ') + ']'
  }
  // simple strings unquoted if safe
  if (/^[A-Za-z0-9 _\-./:@]+$/.test(v)) return v
  return JSON.stringify(v)
}
