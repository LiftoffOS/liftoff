// Provenance declarations for tools nobody authored a catalog entry for.
//
// The write gate needs two facts per tool: which ARGUMENTS of a write name a
// record (`idArgs`), and where ids appear in a read's RESULT (`returnsIds`).
// For a connector whose catalog we author, both sit beside the tool. For a
// vendor-hosted MCP server — GitHub is the one that matters, since it is the
// code-reviewer pilot's own connector — the tool list is discovered at runtime
// from the vendor, and discovery carries neither.
//
// Discovery is not declaration. It tells us a tool exists and what arguments it
// takes; it does not say which argument is the record being acted on, and it
// says nothing at all about results. So an uncovered vendor tool falls through
// to the heuristic floor, which guesses — and a floor bug is total when the
// floor is the only cover.
//
// The two halves are not symmetric, which is why only one is derived here:
//
//   idArgs      IS derivable. An argument that names a record looks like one,
//               and the same reasoning already generates these from Composio
//               input schemas in connector-service. An input schema is an input
//               schema whatever discovered it.
//
//   returnsIds  is NOT derivable from an input schema — nothing about a tool's
//               arguments says what its response contains. Those are learned
//               from real traffic by the shape observer. Guessing them here
//               would produce a declaration that matches nothing, which reads
//               exactly like a tool nobody covered while looking covered.
//
// So this fills the half that can be filled honestly, and leaves the other half
// to the mechanism built for it.
//
// WHAT A DERIVED DECLARATION IS ALLOWED TO DO. It is judged AND held on, like a
// hand-written one. It used to be "provisional" — judged and reported, never
// held — on the reasoning that a name-shaped guess is not a person's word. The
// review of the generated declarations across the whole catalog (2,805 suffix
// matches read by hand, 766 kept) turned that word into a RULE: an argument is
// the record a write acts on only when it is the bare `id` or names a noun in
// the function's own name, and on a create the created noun has no identity
// yet. `namesTheTarget` below is that rule, and a rule reviewed on the whole
// estate is the vouching. What it cannot see — an id the agent carries from
// memory or an earlier run — costs one read: the hold names the read to run.

/** An id-shaped argument name, in the spellings vendors actually use. */
const ID_ARG = /^(?:[a-z][a-z0-9]*_)?(?:id|ids)$|^(?:[a-z]+)?Id$|_id$|^id$/;

/** Arguments that identify a REQUEST rather than a record acted on. */
const NOT_A_RECORD = new Set([
  'request_id',
  'requestId',
  'idempotency_key',
  'idempotencyKey',
  'client_id',
  'clientId',
  'trace_id',
  'traceId',
  'correlation_id',
  'correlationId',
]);

interface SchemaLike {
  properties?: Record<string, unknown>;
  required?: string[];
}

/** The suffix that makes a name identity-shaped, stripped to leave its noun. */
const ID_SUFFIX = /(_?(id|ids|iid|gid|uid|uuid|key|number|sha|slug|ref)|(Id|Ids|Iid|Gid|Uid|Uuid|Key|Number|Sha|Slug|Ref))$/;

/** `updateTaskComment`, `update_task_comment` and `Update_Task` alike, as
 *  lower-case tokens. */
function tokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** `tasks` → `task`, `entries` → `entry`: one noun, both spellings. */
function singular(token: string): string {
  if (token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

/** The noun an identity-shaped argument is about: `task_gid` → [task],
 *  `mergeRequestIid` → [merge, request], `id` → []. */
function stemTokens(arg: string): string[] {
  return tokens(arg.replace(ID_SUFFIX, '').replace(/_+$/, '')).map(singular);
}

/** Verbs after which the function's last noun is being brought into
 *  existence, so an argument about that noun is a chosen name or number for
 *  it and not the identity of a record the run could have read. */
const CREATES = new Set(['create', 'new']);

/**
 * Whether an identity-shaped argument names the record this function ACTS ON,
 * as opposed to one it refers to.
 *
 * The same judgement the connector-service generator applies to the catalog,
 * stated once more here because the tools this covers are discovered at
 * runtime and never pass through that generator. `update_task` acts on
 * `task_id` and not on `assignee_id`; `add_tag_to_task` acts on both;
 * `create_task_comment` acts on `task_id`, the parent, and not on a
 * `comment_number` the caller is choosing.
 */
function namesTheTarget(arg: string, functionName: string): boolean {
  const fnTokens = tokens(functionName);
  const nouns = new Set(fnTokens.map(singular));
  const stem = stemTokens(arg);
  const creates = CREATES.has(fnTokens[0]);
  if (stem.length === 0) return !creates;
  if (!stem.every((t) => nouns.has(t))) return false;
  if (creates && stem.includes(singular(fnTokens[fnTokens.length - 1]))) return false;
  return true;
}

/** `invoice_number` beside `invoice_id` is an attribute the write may be
 *  setting; the id is the identity. */
function shadowedByAnId(arg: string, siblings: readonly string[]): boolean {
  if (!/(_?number|Number)$/.test(arg)) return false;
  const stem = stemTokens(arg).join('_');
  return siblings.some((s) => s !== arg && /(_?id|Id)$/.test(s) && stemTokens(s).join('_') === stem);
}

/** The tool's own name, whatever prefix the caller addressed it by:
 *  `mcp__github-dd4c4689__pull_request_review_write` → the last segment. */
function bareName(toolName: string): string {
  const i = toolName.lastIndexOf('__');
  return i >= 0 ? toolName.slice(i + 2) : toolName;
}

/**
 * The arguments of this tool that name the record it acts on, or undefined
 * for none.
 *
 * REQUIRED arguments only. An optional id is a filter far more often than a
 * target — `assignee_id` on a search narrows a query and acts on nothing — and
 * a declaration that treats a filter as a record makes every search look like
 * an unprovenanced write.
 *
 * With the tool's name, the reviewed rule as well: only an argument about the
 * noun the function acts on. Without it (a caller that has only a schema),
 * the shape test alone, as before.
 */
export function deriveIdArgs(inputSchema: unknown, toolName?: string): string[] | undefined {
  const schema = inputSchema as SchemaLike | null | undefined;
  const props = schema?.properties;
  const required = schema?.required;
  if (!props || !Array.isArray(required) || required.length === 0) return undefined;

  const names = Object.keys(props);
  const fn = toolName ? bareName(toolName) : undefined;
  const found = required
    .filter((name) => typeof name === 'string')
    .filter((name) => Object.prototype.hasOwnProperty.call(props, name))
    .filter((name) => !NOT_A_RECORD.has(name))
    .filter((name) => ID_ARG.test(name))
    .filter((name) => !fn || (namesTheTarget(name, fn) && !shadowedByAnId(name, names)));

  return found.length > 0 ? found : undefined;
}

/**
 * Fill the derivable half of a discovered tool's declarations.
 *
 * Never overwrites: a tool that arrived WITH declarations was authored or
 * accepted by someone, and a derivation that could silently replace a human's
 * correction is one that stops anybody correcting.
 */
export function withDerivedDeclarations<T extends {
  name?: string;
  inputSchema?: unknown;
  idArgs?: string[];
  returnsIds?: Array<{ entityType: string; path: string }>;
}>(fn: T): T {
  if (fn.idArgs && fn.idArgs.length > 0) return fn;
  const derived = deriveIdArgs(fn.inputSchema, fn.name);
  if (!derived) return fn;
  return { ...fn, idArgs: derived };
}
