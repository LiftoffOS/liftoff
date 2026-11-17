// Generic templated-request dispatch for codegen'd first-class endpoints.
//
// The codegen (scripts/gen-connector-tools.ts) emits ONE ConnectorFunction per
// vendor endpoint whose `entityType` is the operation template, e.g.
//   "GET /companies/{company_id}/locations"
//   "PATCH /workers/{id}"
// so every documented endpoint becomes a first-class tool (proper name, input
// schema, HITL category) WITHOUT a hand-written case per endpoint in each client.
//
// Each client passes its own low-level request fn `(method, path, body?, query?)`
// to runTemplatedRequest(); this helper fills the {path params} from the input,
// splits the remaining input into query (safe verbs) or body (writes), and calls
// it. Path params consumed from the input are not re-sent as query/body.

import type { ExternalRecord, CreateResult, UpdateResult, DeleteResult } from './types.js';

export type LowLevelRequest = (
  method: string,
  path: string,
  body?: Record<string, unknown>,
  query?: Record<string, string>,
) => Promise<unknown>;

/**
 * The same thing, for a client that can put a LIST on the wire.
 *
 * OpenAPI's default for a query array is the parameter repeated, which a
 * single string cannot express. Opt-in rather than a widening of
 * `LowLevelRequest`: every vendored client builds its own URL, and changing
 * the type under them would either not compile or quietly change what a live
 * connector sends. A client that has not opted in receives exactly what it
 * received before.
 */
/** What a query parameter may hold on the way to a request builder that knows
 *  how to write it: a value, a list, or — for a `deepObject` parameter — a
 *  structure to be bracketed. */
export type QueryValue = string | string[] | Record<string, unknown>;

export type ListAwareLowLevelRequest = (
  method: string,
  path: string,
  body?: Record<string, unknown>,
  query?: Record<string, QueryValue>,
) => Promise<unknown>;

const TEMPLATE_RE = /^(GET|POST|PUT|PATCH|MERGE|DELETE|HEAD)\s+(\/\S*)$/i;

/** True when an entityType is an operation template like "GET /workers/{id}". */
export function isTemplatedEntity(entityType: string): boolean {
  return TEMPLATE_RE.test(entityType);
}

/** Parse "METHOD /path" → { method, pathTemplate }. */
export function parseTemplate(entityType: string): { method: string; pathTemplate: string } | undefined {
  const m = TEMPLATE_RE.exec(entityType);
  if (!m) return undefined;
  return { method: m[1].toUpperCase(), pathTemplate: m[2] };
}

/**
 * Execute a templated operation. `input` supplies {path params} + any query/body
 * fields. Reserved keys (id, entityType, method, path, query, body) are ignored
 * as loose params; a caller may also pass an explicit `query`/`body` object.
 */
export async function runTemplatedRequest(
  exec: LowLevelRequest | ListAwareLowLevelRequest,
  entityType: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const parsed = parseTemplate(entityType);
  if (!parsed) throw new Error(`templated-dispatch: "${entityType}" is not an operation template`);
  const { method, pathTemplate } = parsed;

  const consumed = new Set<string>();
  const path = pathTemplate.replace(/\{([^}]+)\}/g, (_full, name: string) => {
    const v = input[name];
    if (v == null) throw new Error(`templated-dispatch: missing path parameter "${name}" for ${entityType}`);
    consumed.add(name);
    // A path array is OpenAPI's `simple` style: the elements joined by commas,
    // each encoded on its own. `encodeURIComponent(String(list))` encodes the
    // separators too and sends one value with `%2C` in it, which is a
    // different request from the one the specification describes.
    if (Array.isArray(v)) return v.map((item) => encodeURIComponent(String(item))).join(',');
    return encodeURIComponent(String(v));
  });

  const explicitBody = input.body as Record<string, unknown> | undefined;
  const explicitQuery = input.query as Record<string, unknown> | undefined;
  const reserved = new Set(['id', 'entityType', 'method', 'path', 'query', 'body']);
  const loose: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (consumed.has(k) || reserved.has(k) || v == null) continue;
    loose[k] = v;
  }

  const isSafe = method === 'GET' || method === 'HEAD';
  const query: Record<string, QueryValue> = {};
  const source = explicitQuery ?? (isSafe ? loose : undefined);
  if (source) {
    for (const [k, v] of Object.entries(source)) {
      // A list stays a list all the way to the request builder, which knows
      // how the provider wants it written. `String(['a','b'])` is "a,b", which
      // is a DIFFERENT wire form from the repeated parameter OpenAPI defaults
      // to, and it was silently the only one on offer.
      // A structure survives too: a `deepObject` parameter is written
      // bracketed by the builder, and `String(object)` is "[object Object]",
      // which is a provider being sent the words for a value.
      if (Array.isArray(v)) query[k] = v.map((item) => String(item));
      else if (v !== null && typeof v === 'object') query[k] = v as Record<string, unknown>;
      else query[k] = String(v);
    }
  }

  const body = explicitBody ?? (isSafe ? undefined : Object.keys(loose).length ? loose : undefined);

  // The cast is the opt-in above: a list only ever reaches a client that
  // declared it takes one. One that did not sees the strings it always saw.
  return (exec as ListAwareLowLevelRequest)(method, path, body, query);
}

// ── CRUD-shaped wrappers ─────────────────────────────────────────────────────
// Let a client's read/create/update/delete handle any generated (templated)
// entityType with a single guard line:
//   if (isTemplatedEntity(entityType)) return templatedRead(this.exec(), this.ctx(), entityType, entityId, payload);
// `ctx` supplies auto-derived path params (e.g. Gusto company_id from instanceUrl).

export async function templatedRead(exec: LowLevelRequest, ctx: Record<string, unknown>, entityType: string, entityId: string | undefined, payload?: Record<string, unknown>): Promise<ExternalRecord> {
  const data = await runTemplatedRequest(exec, entityType, { ...ctx, ...(payload ?? {}), ...(entityId != null ? { id: entityId } : {}) });
  return { id: entityId ?? 'generated', data: (data ?? {}) as Record<string, unknown> };
}

export async function templatedCreate(exec: LowLevelRequest, ctx: Record<string, unknown>, entityType: string, data: Record<string, unknown>): Promise<CreateResult> {
  try {
    const res = (await runTemplatedRequest(exec, entityType, { ...ctx, ...data }) ?? {}) as Record<string, unknown>;
    return { success: true, id: String(res.id ?? res.uuid ?? 'generated'), data: res };
  } catch (e) { return { success: false, id: '', error: (e as Error).message }; }
}

export async function templatedUpdate(exec: LowLevelRequest, ctx: Record<string, unknown>, entityType: string, entityId: string | undefined, data: Record<string, unknown>): Promise<UpdateResult> {
  try {
    const res = (await runTemplatedRequest(exec, entityType, { ...ctx, ...data, ...(entityId != null ? { id: entityId } : {}) }) ?? {}) as Record<string, unknown>;
    return { success: true, data: res };
  } catch (e) { return { success: false, error: (e as Error).message }; }
}

export async function templatedDelete(exec: LowLevelRequest, ctx: Record<string, unknown>, entityType: string, entityId: string | undefined, payload?: Record<string, unknown>): Promise<DeleteResult> {
  try {
    await runTemplatedRequest(exec, entityType, { ...ctx, ...(payload ?? {}), ...(entityId != null ? { id: entityId } : {}) });
    return { success: true };
  } catch (e) { return { success: false, error: (e as Error).message }; }
}
