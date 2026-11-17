// Agent Templates Service
// Fetches pre-built agent templates from the Platform Backend

import { api } from './api'

export type DepartmentCategory =
  | 'customer_support'
  | 'sales'
  | 'marketing'
  | 'finance'
  | 'hr'
  | 'legal'
  | 'operations'
  | 'engineering'
  | 'other'

export const DEPARTMENT_LABELS: Record<DepartmentCategory, string> = {
  customer_support: 'Customer Support',
  sales: 'Sales',
  marketing: 'Marketing',
  finance: 'Finance',
  hr: 'HR',
  legal: 'Legal',
  operations: 'Operations',
  engineering: 'Engineering',
  other: 'Other',
}

/** Which enumerator browses the customer's workspace for candidates. Adding a
 *  kind is a registry entry in objectPickers.tsx, not a new flow. */
/** `destination` is where a team's work goes, and it takes EITHER a file or a
 *  folder. It replaces the folder/file PAIR a documents requirement used to
 *  declare: a tree routes a row by what it is, so a pair let the answer choose
 *  the question — naming a document as a save location was recorded against
 *  the read pick instead. One question cannot be answered wrongly. */
export type RequirementObjectKind = 'destination' | 'folder' | 'file' | 'channel' | 'table'

/** A concrete thing in the customer's own workspace that a requirement needs
 *  named: which channel to post to, which folder to write into.
 *
 *  Connecting Slack does not tell us which channel to post in. Without this the
 *  template's "post the alert to the finance channel" compiles into an agent
 *  with no channel, and nobody is ever asked. Mirrors ConnectorRequirement in
 *  the backend's @liftoffos/shared-types. */
export interface RequirementObject {
  id: string
  kind: RequirementObjectKind
  /** `write` is a destination the team produces into, `read` an input it
   *  consumes. The two read differently to a person, so the UI distinguishes. */
  direction: 'read' | 'write'
  label: string
  /** An unresolved required object blocks the hire exactly as a missing
   *  required connection does. */
  required: boolean
  /** What the sentence reads as before anyone has picked: "your team channel".
   *
   *  The template's prose carries `{{pick:<id>}}` where the destination goes,
   *  and on this page nobody has picked anything yet, so the placeholder is
   *  rendered as this phrase. The backend substitutes the same phrase when an
   *  optional pick is left unanswered, so the page and the hired team read the
   *  same sentence. */
  fallback?: string
}

export interface ConnectorRequirement {
  id: string
  connectorType?: string   // specific connector type — exactly one of connectorType, capability or capabilities is set
  capability?: string      // functional capability group (e.g. 'email_marketing', 'hris')
  /** Several capability groups, ANY ONE of which satisfies the requirement.
   *
   *  The same work can arrive by two routes: a contract reaches a workspace as
   *  a file in cloud storage or as a page in a documents app, and the team that
   *  reads it does not care which. Requirements are ANDed together, so the same
   *  thing written as two requirements would demand both. */
  capabilities?: string[]
  role: 'data_source' | 'tool'
  requiredScopes: string[]
  description: string
  /** Absent for most requirements: a pure data_source read through the
   *  connector has nothing in the workspace to name. */
  objects?: RequirementObject[]
  /** The two ways a clause reads, on an OPTIONAL connector, chosen at hire by
   *  whether it was actually bound. Referenced in prose as
   *  `{{connector:<requirement id>}}`. See the backend's ConnectorRequirement. */
  prose?: { whenBound: string; whenUnbound: string }
}

/** The capability groups a requirement accepts, however it was written. Empty
 *  for a requirement that names one specific connector type instead. */
export function capabilitiesOf(req: Pick<ConnectorRequirement, 'capability' | 'capabilities'>): string[] {
  if (req.capabilities?.length) return req.capabilities
  return req.capability ? [req.capability] : []
}

/** Every connector type that satisfies a requirement, given the catalog's
 *  capability → types map.
 *
 *  The single place that answers "what connects this?", so a requirement naming
 *  two capabilities is answered by the union. Reading `req.capability` directly
 *  is the bug this replaces: the field is absent on a list requirement, so the
 *  lookup returned nothing and the row rendered as satisfiable by no app. */
export function typesForRequirement(
  req: Pick<ConnectorRequirement, 'connectorType' | 'capability' | 'capabilities'>,
  capabilityMap: Record<string, string[]>,
): string[] {
  if (req.connectorType) return [req.connectorType]
  const seen = new Set<string>()
  for (const cap of capabilitiesOf(req)) {
    for (const t of capabilityMap[cap] ?? []) seen.add(t)
  }
  return [...seen]
}

/** One requirement per connector family, keeping the first of each.
 *
 *  A template asks a separate question per thing it needs named, so two
 *  requirements can name the same family: the comparison writer needs a
 *  documents app twice, once for where it saves and once for what it reads.
 *  On a card or a chip row that is one app to connect, and "Documents,
 *  Documents" reads as an error. The hire flow still sees both. */
export function uniqueByFamily<T extends Pick<ConnectorRequirement, 'connectorType' | 'capability' | 'capabilities'>>(
  reqs: T[],
): T[] {
  const seen = new Set<string>()
  return reqs.filter(req => {
    const key = req.connectorType ?? [...capabilitiesOf(req)].sort().join('|')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Template prose as a person reads it before hiring anything.
 *
 *  The catalog writes a destination as `{{pick:<object-id>}}`, which the
 *  backend replaces at hire time with what was chosen: `"#eng-alerts" (id
 *  C01234)`. On this page nobody has chosen anything, and raw braces are not
 *  something to show a reader, so each placeholder renders as the phrase its
 *  own object carries: "Post the summary to your team channel".
 *
 *  The same phrase is what the backend substitutes when an optional pick is
 *  left unanswered, so the sentence a person reads here is the sentence the
 *  team gets.
 *
 *  A DECLARED INPUT resolves here too, and for the same reason. `{{company_website}}`
 *  is a different namespace with a different answer — the person types it —
 *  but it is still a brace a reader should never see, and six templates put
 *  one in their prose. `values` carries what they have typed so far; with
 *  nothing typed the input's own `fallback` phrase stands in, which is exactly
 *  what the backend's `applyTemplateInputs` substitutes when the field is left
 *  blank. An input the template does not DECLARE is left alone: `{{a_thing}}`
 *  nobody asked for is somebody's literal text, and swallowing it would be
 *  worse than showing it.
 */
export function proseForDisplay(
  text: string,
  template: AgentTemplate,
  values?: Record<string, string>,
): string {
  if (!text) return text
  const resolve = buildTokenResolver(template, values)
  const declared = new Set((template.inputs ?? []).map(i => i.id))
  return text
    .replace(/\{\{\s*(connector:[a-z][a-z0-9-]*)\s*\}\}/g, (_m, token: string) => resolve(token))
    .replace(/\{\{\s*(pick:[a-z][a-z0-9-]*)\s*\}\}/g, (_m, token: string) => resolve(token))
    .replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g, (whole, id: string) =>
      declared.has(id) ? resolve(id) : whole)
}

/** Resolves one `connector:<id>` or `pick:<id>` token to the phrase a reader
 *  sees in its place.
 *
 *  Split out of `proseForDisplay` because the detail step now renders tokens as
 *  individual chips rather than substituting them into a string, and the two
 *  must never disagree about what a token means: a chip reading one thing while
 *  the distilled prose says another is the failure worth designing out.
 *
 *  A connector's `whenBound` clause can itself contain a `{{pick:...}}`
 *  ("post to {{pick:alert-channel}}"), so one stored token can expand two
 *  levels. That is why the connector pass runs first above, and why this
 *  resolves the inner pick before returning.
 */
export function buildTokenResolver(
  template: AgentTemplate,
  /** What the person has typed into the template's input fields so far, if
   *  anything. An answered input reads back as their own words; an unanswered
   *  one reads as its declared `fallback`, which is the phrase the backend
   *  substitutes for a blank at hire. */
  inputValues?: Record<string, string>,
): (token: string) => string {
  const phrases = new Map<string, string>()
  const inputs = new Map((template.inputs ?? []).map(i => [i.id, i]))
  for (const req of [...(template.requiredConnectors ?? []), ...(template.optionalConnectors ?? [])]) {
    for (const obj of req.objects ?? []) {
      if (obj.fallback) phrases.set(obj.id, obj.fallback)
    }
  }
  const variants = new Map(
    (template.optionalConnectors ?? [])
      .filter(r => r.prose)
      .map(r => [r.id, r.prose!.whenBound] as const),
  )

  // A template edited past the catalog validator could name an object that
  // does not exist. Showing braces would be worse than a vague noun.
  const resolvePick = (id: string) => phrases.get(id) ?? 'the connected workspace'

  return (token: string) => {
    const connector = /^connector:([a-z][a-z0-9-]*)$/.exec(token)
    if (connector) {
      // The gallery shows the CONNECTED version of every clause, deliberately.
      //
      // Nothing is bound yet at this point, so an unbound reading would
      // describe the least capable version of the team to someone deciding
      // whether they want it. A hired team's own text is resolved against what
      // they actually connected, so this page is the fullest form of the job
      // and their agent is the form their workspace supports.
      const clause = variants.get(connector[1]) ?? ''
      return clause.replace(/\{\{\s*pick:([a-z][a-z0-9-]*)\s*\}\}/g, (_m, id: string) =>
        resolvePick(id))
    }
    const pick = /^pick:([a-z][a-z0-9-]*)$/.exec(token)
    if (pick) return resolvePick(pick[1])
    // A bare token is a declared input. `parseInline` only makes one a token
    // when the template declares it, so anything reaching here is known.
    const field = inputs.get(token)
    if (field) {
      const typed = inputValues?.[token]?.trim()
      return typed ? typed : (field.fallback?.trim() ?? '')
    }
    return ''
  }
}

export interface EscalationRule {
  trigger: string
  action: 'hitl' | 'notify' | 'abort'
  description: string
}

/**
 * What the list endpoint returns: enough to render a gallery card, nothing more.
 *
 * The list route used to return whole templates, so opening the Explore page
 * handed the browser the full `responsibilities` and `additionalContext` of
 * every template in the catalog — the prompt text the agents are built from,
 * for all 65, in a paginated sweep this module runs to exhaustion. No card ever
 * rendered a word of it. The body now comes from the per-template detail fetch.
 */
export interface AgentTemplateCard {
  id: string
  version: string
  schemaVersion: number
  displayName: string
  departmentCategory: DepartmentCategory
  description: string
  role: string
  requiredConnectors: ConnectorRequirement[]
  optionalConnectors: ConnectorRequirement[]
  defaultAgentType: 'agent' | 'workflow'
  /** Facts the template needs and the platform must not guess, collected on the
   *  connectors step. A list rather than named fields so declaring a new one
   *  never means touching the screen that renders it. */
  inputs?: TemplateInput[]
}

/** One declared input. Its `id` appears in the template's prose as `{{id}}`. */
export interface TemplateInput {
  id: string
  label: string
  type: 'text' | 'url'
  required: boolean
  placeholder?: string
  hint?: string
  /** The phrase that stands in the sentence when this input is left blank.
   *  The backend's `applyTemplateInputs` substitutes it at hire; `proseForDisplay`
   *  uses the same one so the sentence read before hiring is the sentence the
   *  team gets. An input with no fallback is REMOVED from the sentence rather
   *  than left as braces. */
  fallback?: string
}

/** A single template, fetched when one is opened. Superset of the card. */
export interface AgentTemplate extends AgentTemplateCard {
  roleSummary: string
  responsibilities: string
  additionalContext: string
  defaultMemoryScope: {
    readableLayers?: ('role' | 'global' | 'individual')[]
    writableLayers?: ('role' | 'global' | 'individual')[]
  }
  defaultTriggerConfig: {
    type: 'cron' | 'event' | 'manual'
    cronExpr?: string
    eventTopic?: string
    timezone?: string
  }
  escalationPatterns: EscalationRule[]
}

export interface ListTemplatesResponse {
  templates: AgentTemplateCard[]
  nextCursor?: string
  total: number
}

export async function listAgentTemplates(
  departmentCategory?: DepartmentCategory,
  cursor?: string,
  limit = 50,
): Promise<ListTemplatesResponse> {
  const params = new URLSearchParams()
  if (departmentCategory) params.set('departmentCategory', departmentCategory)
  if (cursor) params.set('cursor', cursor)
  params.set('limit', String(limit))
  const qs = params.toString()
  return api.get<ListTemplatesResponse>(`/api/agent-templates${qs ? `?${qs}` : ''}`)
}

/**
 * Fetches the full template catalog by following cursor pagination to exhaustion.
 *
 * The list endpoint pages results (default 20, max 100 per page, sorted by id).
 * A single call therefore returns only the first page, silently dropping any
 * template past the page boundary — which is how the catalog grew past 50 and
 * five engineering templates (security-engineer, software-engineer, …) stopped
 * appearing. Callers that need the whole catalog (e.g. grouping by department)
 * must page through, not read one page.
 */
export async function listAllAgentTemplates(
  departmentCategory?: DepartmentCategory,
): Promise<AgentTemplateCard[]> {
  const all: AgentTemplateCard[] = []
  let cursor: string | undefined
  do {
    const page = await listAgentTemplates(departmentCategory, cursor, 100)
    all.push(...page.templates)
    cursor = page.nextCursor
  } while (cursor)
  return all
}

export async function getAgentTemplate(templateId: string): Promise<AgentTemplate> {
  return api.get<AgentTemplate>(`/api/agent-templates/${templateId}`)
}

/** One sentence describing a team whose prose has been rewritten.
 *
 *  The line under the role name is the template's own `description`, written by
 *  whoever authored the catalog entry. The moment somebody rewrites a
 *  responsibility it stops being true of the team they are about to hire, and a
 *  stale one-liner is worse than none: it is the shortest thing on the page and
 *  the most likely to be read as the summary of what was just changed.
 *
 *  Deliberately NOT the distiller. That runs on the large tier against the
 *  whole connector catalog and produces two to three sentences capped at 1500
 *  characters; this is one sentence off `small` (Haiku), costing roughly a
 *  fifth of a cent, and it is never persisted — the authoritative `summary` is
 *  still the one the distillation produces on Continue.
 *
 *  REQUIRES the matching platform-backend route. Until it ships this rejects,
 *  and the caller drops the description rather than showing a stale one.
 */
export async function describeEditedTemplate(
  templateId: string,
  tenantId: string,
  body: { role: string; responsibilities: string; additionalContext: string },
  signal?: AbortSignal,
): Promise<{ description: string }> {
  // tenantId on the query string, as the distill and create calls send it. It
  // is the one route on the template catalog that is not the same for everyone
  // — it spends money — so the server proves membership before answering.
  return api.post<{ description: string }>(
    `/api/agent-templates/${templateId}/description?tenantId=${encodeURIComponent(tenantId)}`,
    body,
    { signal },
  )
}

