// Presenting a pending tool call to an approver.
//
// The runtime stores two things on a HITL approval: prose written at the gate
// (`actionSummary` / `whySummary`), and a `detail` line assembled mechanically
// by hitl-card-content.ts. That line is the approver's trust anchor, but it is
// built to fit a Slack Block-Kit field: at most two arguments, values run
// through JSON.stringify and cut at 80 characters. Rendered into a web panel it
// put `category {"type":"general","urgency":"Low","sensitive":false,…` in front
// of a person and called it a summary.
//
// The page holds the structured calls (`pendingToolCalls`), so it builds the
// anchor itself: every argument, labelled, with the value written out. Nothing
// here is a second opinion about WHAT is being asked. It is the same tool name
// and the same input the runtime flattened, presented rather than stringified.

// Arg keys whose value must never be shown. Mirrors the runtime's own redaction
// (hitl-card-content.ts), which only ever applied to the flattened line: the
// structured calls this file renders from carry the raw input.
const SECRET_KEY =
  /(pass(word)?|secret|token|api[_-]?key|access[_-]?key|authorization|bearer|credential|private[_-]?key|client[_-]?secret)/i

// Words that stay uppercase when a key or tool name is turned into a label.
const ACRONYMS = new Set([
  'id', 'ids', 'url', 'urls', 'uri', 'api', 'sms', 'cc', 'bcc', 'ip', 'sql',
  'csv', 'json', 'html', 'pdf', 'utc', 'crm', 'sla', 'kpi', 'ssn', 'ein',
  'vat', 'iso', 'ttl', 'mcp', 'ai', 'hr', 'pr', 'qa', 'ui',
])

// Connectors whose own spelling is not what title-casing produces.
const BRAND_NAMES: Record<string, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  hubspot: 'HubSpot',
  quickbooks: 'QuickBooks',
  openai: 'OpenAI',
  sendgrid: 'SendGrid',
  pagerduty: 'PagerDuty',
  servicenow: 'ServiceNow',
  clickup: 'ClickUp',
  bigquery: 'BigQuery',
  postgresql: 'PostgreSQL',
  mysql: 'MySQL',
  dynamodb: 'DynamoDB',
  aws: 'AWS',
  gcp: 'GCP',
  // The platform's own in-process MCP server, registered per tenant as
  // `tools-<tenantId>`. Its tools are the product's, not a vendor's.
  liftofftools: 'Liftoff',
}

/** Split a snake_case / kebab-case / camelCase identifier into lowercase words. */
function toWords(raw: string): string[] {
  return raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase())
}

/** Sentence case, with acronyms left uppercase: `record_step_output` becomes
 *  "Record step output", `spreadsheetId` becomes "Spreadsheet ID". */
function sentenceCase(raw: string): string {
  const words = toWords(raw)
  if (words.length === 0) return raw
  return words
    .map((word, index) => {
      if (ACRONYMS.has(word)) return word.toUpperCase()
      if (index === 0) return word.charAt(0).toUpperCase() + word.slice(1)
      return word
    })
    .join(' ')
}

/** Title case for a connector alias, honouring how the vendor spells itself. */
function connectorDisplayName(alias: string): string {
  const compact = alias.replace(/[^a-z0-9]/gi, '').toLowerCase()
  if (BRAND_NAMES[compact]) return BRAND_NAMES[compact]
  return toWords(alias)
    .map((word) =>
      ACRONYMS.has(word) ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(' ')
}

export interface ToolCallHeading {
  /** The connector the call goes through, or null for a platform operation. */
  connector: string | null
  /** What the call does, in words. */
  action: string
}

/**
 * Drop the instance id an alias carries.
 *
 * A binding is registered as `<vendor>-<hex>` and the platform's own server as
 * `tools-<tenantId>`, so the id can be one hex run or a whole hyphenated
 * UUID. Everything from the first id-shaped segment on is dropped, which keeps
 * the vendor words: `google-mail-eaec0c30` is Google Mail, not Google.
 */
function stripInstanceId(alias: string): string {
  const kept: string[] = []
  for (const segment of alias.split('-')) {
    if (/^[0-9a-f]{4,}$/i.test(segment) && /\d/.test(segment)) break
    kept.push(segment)
  }
  return kept.length > 0 ? kept.join('-') : alias
}

/**
 * Split a dispatch-surface tool name into a connector and an action.
 *
 * Connector tools arrive as `mcp__<alias>-<instance>__<tool>`; the platform's
 * own always-gated operations arrive bare.
 */
export function describeToolCall(name: string): ToolCallHeading {
  const parts = name.split('__').filter(Boolean)
  const action = sentenceCase(parts[parts.length - 1] ?? name)
  if (parts.length < 2) return { connector: null, action }

  const segments = parts[0] === 'mcp' ? parts.slice(1) : parts
  const alias = stripInstanceId(segments[0] ?? '')
  return { connector: alias ? connectorDisplayName(alias) : null, action }
}

/** One row of the argument list. */
export interface DetailField {
  /** Unique within the call, so React has a key. */
  path: string
  /** The argument name in words. */
  label: string
  /** How deep the argument sits: 0 for a top-level one. */
  depth: number
  /** The value written out, or null when the row only heads its children. */
  value: string | null
}

// Nesting past this renders as compact JSON rather than more rows: three levels
// is already deeper than any connector argument the queue has shown, and the
// raw view is one click away for anything stranger.
const MAX_DEPTH = 2
const VALUE_MAX = 280
const MAX_FIELDS = 40

type Primitive = string | number | boolean | bigint

function isPrimitive(value: unknown): value is Primitive {
  const type = typeof value
  return type === 'string' || type === 'number' || type === 'boolean' || type === 'bigint'
}

function primitiveText(value: Primitive): string {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  return String(value)
}

function clamp(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > VALUE_MAX ? `${flat.slice(0, VALUE_MAX)}…` : flat
}

function compactJson(value: unknown): string {
  try {
    return clamp(JSON.stringify(value) ?? '')
  } catch {
    return 'Not displayable'
  }
}

/**
 * Flatten a tool call's input into labelled rows.
 *
 * Objects and arrays of objects become a heading row followed by their
 * children, indented. Arrays of plain values stay on one line, because a list
 * of three strings is a value, not a structure.
 */
export function toDetailFields(input: Record<string, unknown> | null | undefined): DetailField[] {
  const fields: DetailField[] = []
  if (!input) return fields

  const push = (path: string, label: string, depth: number, value: string | null) => {
    if (fields.length >= MAX_FIELDS) return
    fields.push({ path, label, depth, value })
  }

  const walk = (value: unknown, key: string, path: string, depth: number) => {
    if (fields.length >= MAX_FIELDS) return
    const label = /^\d+$/.test(key) ? `Item ${key}` : sentenceCase(key)

    if (SECRET_KEY.test(key)) {
      push(path, label, depth, 'Hidden')
      return
    }
    if (value === null || value === undefined || value === '') {
      push(path, label, depth, 'None')
      return
    }
    if (isPrimitive(value)) {
      push(path, label, depth, clamp(primitiveText(value)))
      return
    }
    if (Array.isArray(value)) {
      if (value.length === 0) {
        push(path, label, depth, 'None')
        return
      }
      if (value.every(isPrimitive)) {
        push(path, label, depth, clamp(value.map(primitiveText).join(', ')))
        return
      }
      if (depth >= MAX_DEPTH) {
        push(path, label, depth, compactJson(value))
        return
      }
      push(path, label, depth, null)
      value.forEach((item, index) => walk(item, String(index + 1), `${path}.${index}`, depth + 1))
      return
    }

    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) {
      push(path, label, depth, 'None')
      return
    }
    if (depth >= MAX_DEPTH) {
      push(path, label, depth, compactJson(value))
      return
    }
    push(path, label, depth, null)
    for (const [childKey, childValue] of entries) {
      walk(childValue, childKey, `${path}.${childKey}`, depth + 1)
    }
  }

  for (const [key, value] of Object.entries(input)) {
    walk(value, key, key, 0)
  }
  return fields
}

/**
 * A copy of the input with every secret-bearing value replaced.
 *
 * The runtime redacts on its way into the flattened line, so the structured
 * calls the queue serves still carry whatever the model passed. Anything this
 * page shows verbatim, including the raw view, goes through here first.
 */
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY.test(key) ? 'Hidden' : redactSecrets(child, depth + 1)
  }
  return out
}

/** The head of the runtime's flattened line for one call, exactly as
 *  hitl-card-content.ts writes it (alias cut at the first hyphen, action raw).
 *  Mirrored rather than reused because it is the thing being recognised. */
function flattenedHead(name: string): string {
  const parts = name.split('__').filter(Boolean)
  const action = parts[parts.length - 1] ?? name
  if (parts.length < 2) return action
  const segments = parts[0] === 'mcp' ? parts.slice(1) : parts
  const alias = (segments[0] ?? '').split('-')[0]
  return alias ? `${alias.toLowerCase()} · ${action}` : action
}

// The separator the runtime puts between a call's head and its arguments, and
// again before anything it measured. Not copy: it is what we are parsing.
const FLATTENED_SEPARATOR = ' — '

/**
 * What the stored `detail` line says that the argument rows do not.
 *
 * Two shapes reach this field. Most rows carry the mechanical
 * `connector · action — key value` line, which the rendered arguments already
 * say in full and better, except for the measurement the blast-radius gate
 * appends to it ("This run would have affected 120 items in total."). Older
 * rows carry free prose, which is worth showing whole.
 *
 * A measurement is recognised by its shape: full sentences appended last. An
 * argument value that happens to look like one would be shown here instead of
 * dropped, which is the harmless direction to be wrong in.
 */
export function detailNote(
  detail: string | null | undefined,
  calls: Array<{ name: string }>,
): string | null {
  const text = (detail ?? '').trim()
  if (!text) return null

  const head = calls[0] ? flattenedHead(calls[0].name) : null
  if (!head || !text.startsWith(head)) return text

  const cut = text.lastIndexOf(FLATTENED_SEPARATOR)
  if (cut === -1) return null
  const tail = text.slice(cut + FLATTENED_SEPARATOR.length).trim()
  return /^[A-Z][\s\S]*[.…]$/.test(tail) ? tail : null
}
