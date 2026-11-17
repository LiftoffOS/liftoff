// Vendor-tool effect classification for the external-content write gate.
//
// Platform tools carry an explicit `effect` in the catalog. Vendor (MCP) tool
// names are dynamically discovered and carry no effect, so we derive one from
// the name at catalog-build time. The derivation is PRECEDENCE-ORDERED and
// fail-open toward 'write' (an unrecognized verb gates):
//
//   1. any recognized mutating verb token  => 'write'   (mutating wins:
//      `list_and_delete_items`, `get_or_create_issue` are both 'write')
//   2. else any recognized read verb token  => 'read'
//   3. else                                 => 'write'   (unknown verbs gate)
//
// The runtime gate check is `effect !== 'read'`, so a tool that never reaches
// rule 2 is gated — the safe default for external-authored content.

// Whole-token read verbs. A name is 'read' only when it contains one of these
// AND no mutating verb (rule 1 beats rule 2).
const READ_VERBS: ReadonlySet<string> = new Set([
  'get',
  'list',
  'read',
  'search',
  'fetch',
  'describe',
  'view',
  'download',
  'count',
]);

// Whole-token mutating verbs. Kept to unambiguous mutating verbs; exotic or
// domain-specific mutators (expire, sunset, rotate, ...) are intentionally absent
// so they fall through to the rule-3 'write' default rather than needing
// exhaustive enumeration. Tokens that collide with common read-NOUNS (issue, run,
// order, comment, label, post, book, mark, share, copy, ...) are also excluded so
// a read like `get_issue` / `view_run` isn't mis-gated by mutating-wins precedence.
const MUTATING_VERBS: ReadonlySet<string> = new Set([
  'create', 'update', 'delete', 'remove', 'add', 'set', 'write', 'send',
  'merge', 'insert', 'upsert', 'patch', 'put', 'edit', 'modify', 'replace',
  'move', 'rename', 'archive', 'restore', 'publish', 'unpublish', 'deploy',
  'cancel', 'approve', 'reject', 'assign', 'unassign', 'invite', 'revoke',
  'grant', 'enable', 'disable', 'submit', 'execute', 'trigger', 'import',
  'export', 'upload', 'lock', 'unlock', 'subscribe', 'unsubscribe', 'transfer',
  'convert', 'clear', 'reset', 'dismiss', 'refund', 'charge', 'pay', 'apply',
]);

/** Split a tool name into lowercase whole tokens, breaking on non-alphanumeric
 *  separators AND camelCase boundaries so `get_or_create`, `getOrCreate`, and
 *  `github.createIssue` all yield the same token stream. */
function tokenize(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .map((t) => t.toLowerCase())
    .filter(Boolean);
}

/** Derive a vendor tool's side-effect class from its name. Returns 'read' only
 *  when a read verb is present and no mutating verb is; otherwise 'write'. */
export function classifyVendorToolEffect(name: string): 'read' | 'write' {
  const tokens = tokenize(name);
  if (tokens.some((t) => MUTATING_VERBS.has(t))) return 'write';
  if (tokens.some((t) => READ_VERBS.has(t))) return 'read';
  return 'write';
}

/** Does the name carry EXPLICIT mutating-verb evidence — a recognized mutating
 *  verb token, not the rule-3 unknown-name fallback and not a domain noun?
 *
 *  This is the ONLY honest signal for "a readOnlyHint must not rescue this to a
 *  read." `classifyVendorToolEffect` returns 'write' for BOTH a matched mutating
 *  verb AND an unrecognised name, so it cannot tell the two apart; and the
 *  sensitivity categories are derived from domain NOUNS (`invoice`, `candidate`),
 *  so "has a category" both MISSES a recognised write with no sensitivity tag
 *  (`approve_request`, `enable_feature`, `upload_file`) and WRONGLY blocks a read
 *  named in a sensitive domain (`lookup_invoice`, `query_candidate`). A mutating
 *  verb is the recognised-write evidence with neither failure. A recognised READ
 *  verb with no mutating verb is not mutating, so the hint that merely confirms a
 *  read (or rescues a genuinely unknown verb like `query_docs`) is still honoured. */
export function nameHasMutatingVerb(name: string): boolean {
  return tokenize(name).some((t) => MUTATING_VERBS.has(t));
}

/** The gate's read test. A missing/undefined effect gates (fail closed). */
export function effectPassesUngated(effect: 'read' | 'write' | 'spawn' | undefined): boolean {
  return effect === 'read';
}

/** Categories that mean a call CHANGES something — the presence of any one of
 *  them disqualifies a tool from the read fast-path no matter what else it
 *  claims, INCLUDING an `effect: 'read'` annotation. Kept as the denylist rather
 *  than trusting `read` alone, because a tool tagged `['read','write']` is a
 *  write.
 *
 *  These are the SIDE-EFFECT axis only. A category earns a place here solely
 *  when its presence is evidence of a state change or a boundary crossing:
 *    - write / destructive / outbound / spawn / admin — connector-service's own
 *      effect vocabulary (deriveCategories); each is a stated side effect.
 *    - datachanges — the ONE tag from the richer vendor-MCP / oversight
 *      vocabulary that qualifies. classifyVendorMcpTool emits `dataChanges` ONLY
 *      on a WRITE_VERBS / DESTRUCTIVE_VERBS token match, so it is verb-derived
 *      write evidence, not a domain guess. It is what catches a server that lies
 *      `readOnlyHint: true` on a non-destructive write name — `update_cache`
 *      enumerates as `{ effect: 'read', categories: ['dataChanges'] }`, and the
 *      category must beat the read hint.
 *
 *  The other vendor-MCP sensitivity tags — financialActions, customerCommunication,
 *  externalPublishing, hiringDecisions — are the SENSITIVITY axis and are
 *  deliberately NOT here. They describe the DOMAIN a call touches, not whether it
 *  writes, and the classifier derives them from domain NOUNS (FINANCIAL_VERBS
 *  holds `invoice`/`subscription`/`payment`, HIRING_VERBS holds
 *  `candidate`/`employee`, ...) that co-occur with read verbs. So `get_invoice`
 *  is tagged `financialActions` while being a pure read, and gating it here taught
 *  people to click through approvals on a retrieval — the exact cost the read
 *  fast-path exists to avoid. A genuine financial/comms/publishing WRITE is not
 *  lost: its mutating verb (`create`/`refund`/`send`/`publish`, or the rule-3
 *  fail-closed default) already sets `effect: 'write'`, which the gate catches
 *  below. A sensitivity tag is read by oversight (`sensitiveWork`); it is not
 *  evidence of a write, so it does not override a read on the side-effect axis.
 *  (`internalCollaboration` is also excluded: classifyVendorMcpTool never emits
 *  it, so it only ever arrived here as dead weight.)
 *
 *  Lowercased because toolIsReadOnly normalizes case and the vendor-MCP vocabulary
 *  is camelCase where the connector vocabulary is lowercase.
 */
const NON_READ_CATEGORIES: ReadonlySet<string> = new Set([
  'write', 'destructive', 'outbound', 'spawn', 'admin', 'datachanges',
]);

/**
 * Is this tool read-only?
 *
 * A read never requires approval — no connector, no exception. Asking a person
 * to authorise "retrieve email thread X" teaches them to click through
 * approvals without reading them, which costs more safety than the gate on a
 * read could ever buy.
 *
 * WHY THIS EXISTS SEPARATELY FROM `effectPassesUngated`. That helper tests
 * `effect` alone, and `effect` is populated for platform tools and left
 * undefined for every CONNECTOR tool — the connector catalog carries the same
 * fact in `categories` instead. So the gate asked the one field connectors do
 * not set, read undefined, failed closed, and raised an approval for a pure
 * read.
 *
 * So a support agent raises "Approval needed — Retrieve email thread … from
 * Google Mail" on `get_thread`, whose catalog entry is `effect: undefined,
 * categories: ['read']`. The catalog knows; the gate is looking at the wrong
 * field.
 *
 * Both sources are consulted, and a SIDE-EFFECT signal in EITHER wins: the
 * fast-path is only taken when nothing about the tool's side effect suggests it
 * changes anything. A sensitivity tag is not a side-effect signal — see
 * NON_READ_CATEGORIES for why `get_invoice`'s `financialActions` does not gate
 * while `dataChanges` does.
 */
export function toolIsReadOnly(tool: {
  effect?: 'read' | 'write' | 'spawn';
  categories?: string[];
} | undefined): boolean {
  if (!tool) return false;
  const categories = (tool.categories ?? []).map((c) => c.toLowerCase());
  if (categories.some((c) => NON_READ_CATEGORIES.has(c))) return false;
  if (tool.effect === 'read') return true;
  // No effect recorded — the connector-catalog case. Trust `read` only when it
  // is stated, never inferred from absence: a tool with neither signal is
  // unknown, and unknown gates.
  return tool.effect === undefined && categories.includes('read');
}

/**
 * The side-effect class of each standard tool, stated rather than guessed.
 *
 * These 36 tools are OURS. We know exactly what each one does, so deriving the
 * answer from the tool's name — which is what `classifyVendorToolEffect` does —
 * is guessing about something we are not required to guess about. That helper
 * exists for VENDOR tools, whose names arrive from a third party and cannot be
 * changed; its rule 3 sends any unrecognised verb to `write` so an unknown
 * vendor tool gates. Correct there, wrong here.
 *
 * 19 of these 36 hit that default, because the verb list has no entry for
 * `research`, `extract`, `diff`, `landscape`, `retrieve`, `screenshot` or
 * `check`. So a support agent searching for a Help Center article with
 * `web_research` pauses for approval with reason `external_content_write`.
 * It is a SEARCH. It writes
 * nothing, sends nothing and reaches no customer — the name simply contained no
 * verb the classifier knew.
 *
 * Anything that only looks — at a page, a document, memory, the catalogue, a
 * session's status — is a read. Anything that changes state, drives a browser,
 * spends money, or asks the user for something is not, and a browser task is a
 * write regardless of what the model intends to do with it, because the tool
 * cannot bound that.
 */
export const STANDARD_TOOL_EFFECTS: Readonly<Record<string, 'read' | 'write' | 'spawn'>> = {
  // ── Reads: they observe, and change nothing ──────────────────────────────
  corpus_search: 'read',
  // Discovery over the platform's capability surface, and execution of one
  // capability. Both are 'read' for the STATIC effect map because a capability's
  // true class is knowable only from its opaque handle, not the tool name — a
  // write/outbound capability is paused instead by the handle-marker branch in
  // the admission gate (service.ts), and executes only after human approval.
  capability_search: 'read',
  run_capability: 'read',
  // The records a capability parked, read back from platform-backend's own
  // store: a query, an instruction answered over them, the job's list. No
  // vendor is reached and nothing outside the platform changes.
  dataset_query: 'read',
  dataset_extract: 'read',
  dataset_list: 'read',
  // Reads the agent's OWN ledger rows. Reaches no vendor and no person — and
  // its whole purpose is to be consulted BEFORE a write, so gating it would
  // put an approval in front of the check that exists to avoid a duplicate.
  have_i_acted_on: 'read',
  memory_retrieve: 'read',
  note_list: 'read',
  read_skill: 'read',
  data_landscape: 'read',
  tabular_extract: 'read',
  tabular_enumerate: 'read',
  // Writes a message into the workspace's own chat. Not 'read': a person sees
  // it, and an unread badge appears.
  open_chat_thread: 'write',
  // The basic search. A read, like every search here — and the one whose name
  // the guess would get most confidently wrong.
  web_search: 'read',
  web_research: 'read',
  web_deep_research: 'read',
  web_extract: 'read',
  web_diff: 'read',
  web_fetch_advanced: 'read',
  web_people_search: 'read',
  // Reads posts. Writes nothing, sends nothing, reaches no customer — the
  // name's 'search' verb would default it to 'write' and gate a read.
  web_x_search: 'read',
  web_finance_search: 'read',
  web_session_list: 'read',
  read_active_browser_session: 'read',
  get_browser_session_stats: 'read',
  list_browser_downloads: 'read',
  fetch_browser_download: 'read',
  // Showing a file writes a card into the conversation, which a person
  // sees. It creates no file and changes nothing outside this chat.
  show_file: 'write',
  screenshot_browser_session: 'read',
  check_browser_intervention_pending: 'read',
  // The record of the browser beside the conversation, and the controls on
  // the page it shows: both observe. The controls read records itself as a
  // pane work call, which is bookkeeping about a read, not a change to the
  // page.
  read_browser_session_activity: 'read',
  read_browser_session_controls: 'read',

  // ── Writes: state changes, or reaching a person or a third party ─────────
  note_save: 'write',
  note_delete: 'write',
  memory_save: 'write',
  audit_log: 'write',
  notifications_send: 'write',
  cancel_followup: 'write',
  // Registers a consent proposal on the platform and holds the one-open
  // budget until a person answers. Not 'spawn': nothing runs unless the
  // person says yes, and the yes is theirs, not the model's.
  propose_routine: 'write',
  bring_in_colleague: 'write',
  web_session_save: 'write',
  web_session_forget: 'write',
  web_session_close: 'write',
  // Asks the user to go and log in somewhere. Reaches a person.
  web_identity_connect: 'write',
  // An autonomous browser agent. What it does is decided at run time, so the
  // tool cannot promise it only looks.
  web_task: 'write',
  run_browser_task: 'write',
  // Setting another run of this team going. It does whatever the brief says,
  // which is the world the team was hired into.
  work_on_this_in_the_background: 'write',
  // Collecting the result of a task that carried on. It reads what has
  // already happened and touches no page.
  check_browser_task: 'read',
  // Changes what the shared browser is showing — the person is watching it, and
  // a navigation can leave a form half-filled or abandon a checkout. Read-only
  // would be wrong even though it fetches: the SIDE EFFECT is on the session,
  // not the response.
  navigate_browser_session: 'write',
  // One click, entry or choice on a control of the shared browser: the same
  // side effect as a navigation, on the session the person is watching.
  act_in_browser_session: 'write',
  // Asks the person to take the browser over, and holds the mutating browser
  // tools until they do. Reaches a person, so not a read.
  ask_person_to_take_over_browser_session: 'write',
  // Produces an artifact and surfaces it in the chat.
  save_active_browser_page_as_pdf: 'write',
  // `__fail_once__` is deliberately absent: it is test-only and is not part of
  // STANDARD_TOOLS outside those builds, so an entry here would be a stale key
  // pointing at nothing. It falls through to classifyVendorToolEffect, which
  // returns 'write' for it — gating a failure injector is the right outcome.

  // ── Spawns: they create future or parallel work ──────────────────────────
  start_browser_session: 'spawn',
  schedule_followup: 'spawn',
  // Starts the agent's own workflow run inside the current chat invocation.
  // The work the run does is gated call by call as it happens; what this
  // tool itself does is start it.
  run_routine_now: 'spawn',
};

/**
 * The side-effect class of one of OUR tools, as every catalog must state it.
 *
 * Two catalogs hand tools to the HITL gate: the in-process bridge (chat and
 * the single-call adapter path) and `buildToolsSchema` (workflow steps,
 * scheduled and triggered runs). The bridge stamped this on every standard
 * tool; the workflow catalog pushed the raw definitions, which carry no
 * `effect` and no `categories`, so the gate saw "unknown", failed closed and
 * asked a person to approve `have_i_acted_on` — the agent's own read of its
 * own ledger — on every fifteen-minute inbound poll of a support hire: dozens
 * of approval cards a day, every one for a read. ONE
 * function, called from both, so the two catalogs cannot state different
 * things about the same tool.
 */
export function standardToolEffect(name: string): 'read' | 'write' | 'spawn' {
  return STANDARD_TOOL_EFFECTS[name] ?? classifyVendorToolEffect(name);
}

/** The MCP tool annotations a server may publish alongside each tool.
 *  Standard since the 2025-03-26 protocol revision and modelled by the SDK
 *  (@modelcontextprotocol/sdk types: readOnlyHint, destructiveHint,
 *  idempotentHint, openWorldHint). */
export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/**
 * What the SERVER says its tool does, when it says anything.
 *
 * Vendor tool safety was derived from the tool's NAME alone: a recognised read
 * verb meant read, anything unrecognised meant write, and write on an
 * untrusted-inbound run means an approval card. So a perfectly ordinary
 * read-only tool gated on every call for no reason other than its author's
 * choice of word — `lookup_article`, `query_docs` and `find_answer` all gate
 * while `search_docs` does not, for identical behaviour.
 *
 * MCP has had an answer to this since the 2025-03-26 revision: the server
 * publishes annotations on each tool. We were discarding them — `annotations`
 * was not even declared on the tools/list entry type — and then guessing at
 * what they already stated.
 *
 * Deliberately asymmetric, because the spec is explicit that annotations are
 * HINTS and a client should not rely on them for security decisions about an
 * untrusted server:
 *
 *   - `destructiveHint: true` is always honoured. It can only ADD caution, so
 *     believing it costs nothing even from a server that is wrong or hostile.
 *   - `readOnlyHint: true` REMOVES caution, so it is honoured only when the name
 *     shows NO recognized mutation/outbound evidence (`nameLooksMutating`). A
 *     server claiming `delete_everything`, `charge_card` or `publish_post` is
 *     read-only does not get to say so — the name's own action evidence wins,
 *     and the caller falls back to the name classifier (which returns 'write'
 *     for those). The hint's ONLY legitimate job is rescuing a name whose verb
 *     is simply unrecognised — `lookup_article`, `query_docs`, `find_answer` —
 *     which carry no action evidence, so those are still honoured.
 *   - Silence changes nothing: the caller falls back to the name heuristic and
 *     behaviour is exactly what it was.
 *
 * Returns null when the annotations decide nothing, so the caller keeps its
 * existing fallback rather than this inventing an answer.
 */
export function effectFromMcpAnnotations(
  annotations: McpToolAnnotations | undefined,
  opts?: { nameLooksMutating?: boolean },
): 'read' | 'write' | null {
  if (!annotations) return null;
  if (annotations.destructiveHint === true) return 'write';
  if (annotations.readOnlyHint === true) {
    // The one place a hint could weaken a decision — backstopped by the name's
    // own action evidence. A recognized mutating/outbound name is never rescued
    // to 'read' by a server's self-assertion (fall back to the classifier);
    // only a name with no action evidence at all is.
    return opts?.nameLooksMutating ? null : 'read';
  }
  return null;
}
