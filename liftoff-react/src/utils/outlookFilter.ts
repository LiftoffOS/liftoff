// Outlook filter: translate between user-facing AQS (Advanced Query Syntax,
// what Outlook's search bar accepts — e.g. `from:amy@acme.com`) and the
// Microsoft Graph OData `$filter` shape our routing-time predicate sends
// to the API (e.g. `from/emailAddress/address eq 'amy@acme.com'`).
//
// The UI shows AQS to users; the persisted `config.outlookFilter` stays in
// the canonical OData wire format. Translation only happens at the input
// boundary in IntegrationsSelector.
//
// Supported AQS tokens (mirrors the OData subset the backend accepts):
//   from:<email>      → from/emailAddress/address eq '<email>'
//   to:<email>        → toRecipients/any(r: r/emailAddress/address eq '<email>')
//   category:<name>   → categories/any(c: c eq '<name>')
//
// Tokens are space-separated and combined with logical AND. Values cannot
// contain single quotes (they break OData literals).

export type AqsToken =
  | { kind: 'from'; value: string }
  | { kind: 'to'; value: string }
  | { kind: 'category'; value: string }

interface ParseResult {
  ok: boolean
  tokens?: AqsToken[]
  /** Set when ok=false. Identifies the first bad token. */
  badToken?: string
}

const AQS_TOKEN_RE = /^(from|to|category):(.+)$/i

/**
 * Parse a user-typed AQS string into tokens. Returns `ok: false` if any
 * whitespace-separated token doesn't match `<kind>:<value>` or contains a
 * single quote.
 */
export function parseOutlookAqs(input: string): ParseResult {
  const trimmed = input.trim()
  if (!trimmed) return { ok: true, tokens: [] }

  const raw = trimmed.split(/\s+/)
  const tokens: AqsToken[] = []
  for (const t of raw) {
    const m = t.match(AQS_TOKEN_RE)
    if (!m) return { ok: false, badToken: t }
    const value = m[2]
    if (value.includes("'")) return { ok: false, badToken: t }
    tokens.push({ kind: m[1].toLowerCase() as AqsToken['kind'], value })
  }
  return { ok: true, tokens }
}

/**
 * Encode parsed AQS tokens as a Microsoft Graph `$filter` string. Returns
 * the empty string for an empty token list.
 */
export function aqsToOData(tokens: AqsToken[]): string {
  return tokens
    .map((t) => {
      switch (t.kind) {
        case 'from':
          return `from/emailAddress/address eq '${t.value}'`
        case 'to':
          return `toRecipients/any(r: r/emailAddress/address eq '${t.value}')`
        case 'category':
          return `categories/any(c: c eq '${t.value}')`
      }
    })
    .join(' and ')
}

// Reverse-translation regexes mirror validateBindingFilter's supported set.
// The `any(...)` clauses tolerate any single-letter lambda variable.
const ODATA_FROM = /^from\/emailAddress\/address\s+eq\s+'([^']+)'$/
const ODATA_TO = /^toRecipients\/any\([a-z]+:\s*[a-z]+\/emailAddress\/address\s+eq\s+'([^']+)'\)$/
const ODATA_CATEGORY = /^categories\/any\([a-z]+:\s*[a-z]+\s+eq\s+'([^']+)'\)$/

/**
 * Translate a stored OData `$filter` string back to AQS. Returns `null` if
 * any clause falls outside the supported subset — callers should fall back
 * to showing the raw OData with an advisory in that case.
 */
export function odataToAqs(odata: string): string | null {
  const trimmed = odata.trim()
  if (!trimmed) return ''

  const clauses = trimmed.split(/\s+and\s+/i)
  const tokens: string[] = []
  for (const c of clauses) {
    const clause = c.trim()
    let m: RegExpMatchArray | null

    if ((m = clause.match(ODATA_FROM))) {
      tokens.push(`from:${m[1]}`)
    } else if ((m = clause.match(ODATA_TO))) {
      tokens.push(`to:${m[1]}`)
    } else if ((m = clause.match(ODATA_CATEGORY))) {
      tokens.push(`category:${m[1]}`)
    } else {
      return null
    }
  }
  return tokens.join(' ')
}
