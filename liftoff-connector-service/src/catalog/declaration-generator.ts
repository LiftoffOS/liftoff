// Provenance declarations, GENERATED from each function's own schema.
//
// Hand-writing them is rejected doctrine. Three connectors were declared by
// hand in a full session against ~147, every one of them a chance to write
// `pull_number` where the argument is `pullNumber` — a typo that is invisible
// in every direction, because the runtime looks the key up, finds nothing, and
// reads the write as undeclared, which is exactly what an uncovered tool looks
// like.
//
// The schema already knows the answer. A function that takes `task_gid` and is
// categorised `write` is a function whose `task_gid` names the record it
// changes; nobody needs to be asked. So this derives `idArgs` from the
// inputSchema and leaves `returnsIds` to the layer that can actually observe a
// response shape.
//
// WHAT THIS DELIBERATELY DOES NOT DO. It does not generate `returnsIds`. A
// response shape is not in the input schema, and guessing one produces a path
// that matches nothing at runtime — which is worse than no declaration, because
// the connector then LOOKS covered while every write it judges has nothing able
// to provenance it. returnsIds comes from canonical shapes where they exist
// (the Google trio) or from observed traffic, never from a guess.
//
// Output is a PROPOSAL, not a commitment. It is written to a file a person
// reviews, because a generator that edits the registry directly is a generator
// whose mistakes arrive in production without anybody reading them.

import type { ConnectorFunction } from '../types.js';

/** Argument names that identify an existing record.
 *
 *  Anchored on the END of the name so `id` matches `task_id`, `taskId` and
 *  `gid` while `idempotency_key` and `video_id_format` do not. A looser rule
 *  would declare half a schema and produce writes judged against arguments
 *  that are not identities. */
const ID_ARG = /(^|_)(id|ids|iid|gid|uid|uuid|key|number|sha|slug|ref)$|(Id|Ids|Gid|Uid|Uuid|Key|Number|Sha|Slug|Ref)$/;

/** Arguments that look like identifiers but are not the record's identity.
 *
 *  `idempotency_key` identifies the REQUEST; `parent_id` and `project_id` scope
 *  a create rather than naming the thing being changed. Declaring a scope as
 *  the record's identity would flag every create in the connector. */
const NOT_AN_IDENTITY = new Set([
  'idempotency_key', 'idempotencyKey', 'request_id', 'requestId',
  'workspace_gid', 'workspaceGid', 'team_gid', 'teamGid',
  'parent_id', 'parentId', 'project_gid',
]);

/** Split `updateTaskComment`, `update_task_comment` and `Update_Task` alike
 *  into lower-case tokens. */
function tokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** `tasks` → `task`, `entries` → `entry`; a plural in the function name and
 *  a singular in the argument name are the same noun. */
function singular(token: string): string {
  if (token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

/** The noun an identity-shaped argument is about: `task_gid` → `task`,
 *  `mergeRequestIid` → `merge request`, `id` → nothing. */
function stemTokens(arg: string): string[] {
  const stripped = arg.replace(ID_ARG, '').replace(/_+$/, '');
  return tokens(stripped).map(singular);
}

/** Verbs after which the function's LAST noun is the record being brought into
 *  existence — so an argument about that noun is a chosen name or number for
 *  it, not the identity of a record the run could have read. */
const CREATES = new Set(['create', 'new']);

/**
 * Whether an identity-shaped argument names the record this function ACTS ON,
 * as opposed to a record it merely refers to.
 *
 * The suffix alone said yes to `organization_id` on every Zoho write,
 * `currency_id` and `tax_id` on an invoice, `assignee_id` on a task update,
 * `to_mail_ids` on a send — references and scopes, not the target. A write
 * judged on those is a write the run can fail for having never read the
 * currency table. So an argument counts only when it is the bare `id`, or its
 * noun is one of the function's own: `update_task` acts on `task_id` and not
 * on `assignee_id`; `add_tag_to_task` acts on both `tag_id` and `task_id`;
 * `create_task_comment` acts on `task_id`, the parent, and not on a
 * `comment_number` the caller is choosing.
 */
function namesTheTarget(arg: string, functionName: string): boolean {
  const fnTokens = tokens(functionName);
  const nouns = new Set(fnTokens.map(singular));
  const stem = stemTokens(arg);
  const creates = CREATES.has(fnTokens[0]);
  if (stem.length === 0) {
    // Bare `id` (or `ids`): the record itself — except on a create, where
    // there is no record yet and an `id` is one the caller is choosing.
    return !creates;
  }
  if (!stem.every((t) => nouns.has(t))) return false;
  if (creates) {
    // `create_invoice` takes an `invoice_number` the caller is choosing;
    // `create_customer_payment` takes the `customer_id` it is filed under.
    const created = singular(fnTokens[fnTokens.length - 1]);
    if (stem.includes(created)) return false;
  }
  return true;
}

/** `invoice_number` beside `invoice_id` is an attribute the write may be
 *  setting, not a second identity; the id is the identity. */
function shadowedByAnId(arg: string, siblings: readonly string[]): boolean {
  if (!/(_?number|Number)$/.test(arg)) return false;
  const stem = stemTokens(arg).join('_');
  return siblings.some((s) => s !== arg && /(_?id|Id)$/.test(s) && stemTokens(s).join('_') === stem);
}

export interface GeneratedDeclaration {
  connectorType: string;
  functionName: string;
  idArgs: string[];
  /** Why this was proposed, so a reviewer can judge it without re-deriving. */
  basis: string;
}

/**
 * Propose `idArgs` for every write in a connector.
 *
 * Reads only what the registry already states: the categories say whether a
 * function changes something, and the inputSchema says what it takes. Both are
 * boot-validated, so a proposal cannot be built on a function that lies about
 * being a write.
 */
export function generateIdArgDeclarations(
  connectorType: string,
  fns: readonly ConnectorFunction[],
): GeneratedDeclaration[] {
  const out: GeneratedDeclaration[] = [];

  for (const fn of fns) {
    const cats = (fn.categories ?? []).map((c) => String(c).toLowerCase());
    const isWrite = cats.includes('write') || cats.includes('destructive') || cats.includes('outbound');
    if (!isWrite) continue;
    // Already declared by hand or by a previous run: a generator that
    // overwrote existing declarations would undo a human's correction on every
    // regeneration, which is the one thing that would stop anybody correcting.
    if ((fn.idArgs ?? []).length > 0) continue;

    const props = Object.keys(fn.inputSchema?.properties ?? {});
    const idArgs = props.filter((p) =>
      ID_ARG.test(p)
      && !NOT_AN_IDENTITY.has(p)
      && namesTheTarget(p, fn.name)
      && !shadowedByAnId(p, props));
    if (idArgs.length === 0) continue;

    out.push({
      connectorType,
      functionName: fn.name,
      idArgs,
      basis: `write-categorised; inputSchema declares ${idArgs.join(', ')}, each about a noun in the function's own name`,
    });
  }
  return out;
}

/**
 * Whether a generated declaration would be INERT against its own schema.
 *
 * The check that makes generation safe to trust: a proposed argument that the
 * function does not accept is a declaration naming nothing. It cannot happen
 * when the names are read FROM the schema, which is the point — and asserting
 * it means a future generator that stops reading the schema is caught rather
 * than shipped.
 */
export function declarationIsSatisfiable(
  decl: GeneratedDeclaration,
  fn: ConnectorFunction,
): boolean {
  const props = new Set(Object.keys(fn.inputSchema?.properties ?? {}));
  return decl.idArgs.every((a) => props.has(a));
}
