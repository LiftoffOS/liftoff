import { resolveRef } from './json-pointer.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
import { DOMParser } from '@xmldom/xmldom';
// Pure spec → tool-set codegen for native HRIS connectors. Turns a vendor API
// spec (OpenAPI JSON/YAML or OData EDMX $metadata) into ONE ConnectorFunction per
// documented operation. No filesystem/CLI here — that lives in
// scripts/gen-connector-tools.ts, which imports these functions. Keeping the logic
// under src/ makes it typechecked and unit-testable (see
// src/catalog/__tests__/odata-codegen.test.ts).
//
// Category (HITL) inference:
//   GET/HEAD              → ['read']
//   DELETE               → ['destructive']
//   POST/PUT/PATCH/MERGE → ['write']
// Classification hints (financial/customer-comm) ride along as a companion
// <connector>-classification.json for the platform-backend migration step.

type Json = Record<string, any>;

export interface GenOp {
  name: string;
  description: string;
  entityType: string; // "METHOD /path" (OpenAPI) or a bare OData entity-set name
  method: string;
  path: string;
  inputSchema: Json;
  categories: string[];
  classification: string[]; // dataChanges | financialActions | customerCommunication | ...
  responseSchema?: Json;    // success (2xx) response body schema — powers runtime drift detection
  /** Input properties that are HEADERS rather than query or body fields.
   *  Without this a dispatcher cannot tell them apart: every non-path input on
   *  a read becomes a query parameter and on a write becomes a body field, and
   *  a declared header would silently become either. Only emitted when the
   *  caller asked for headers at all. */
  headerParams?: string[];
  /** The media type the body schema was read from. Absent means JSON, which
   *  is what a dispatcher that has never heard of this writes anyway. */
  bodyMediaType?: string;
  /** Query parameters the specification declared `deepObject`: written
   *  bracketed rather than repeated, because the provider said so. */
  deepObjectParams?: string[];
  /** Query arrays the specification declared `explode: false`: written as one
   *  value with the elements joined by commas, rather than repeated. */
  joinedArrayParams?: string[];
  /** Body properties that carry a FILE. A model names one — the id of a file
   *  already in the workspace — and the bytes are fetched at dispatch, because
   *  a model cannot hold bytes and must never be asked to relay them. */
  fileParams?: string[];
}

const FINANCIAL_RE = /pay|payroll|compensation|salary|bank|tax|garnish|fund|deduction|invoice|reimbursement/i;
const COMMS_RE = /message|email|notify|invite|notification/i;

function slug(method: string, path: string, operationId?: string): string {
  // Ignore non-descriptive hash/checksum operationIds (e.g. BambooHR emits 32-char
  // hex ids) — they yield useless tool names. Fall back to verb + path segments,
  // which is descriptive and stable. Real operationIds always carry non-hex letters,
  // so no vendor with meaningful ids is affected.
  const usableOpId = operationId && !/^[0-9a-f]{16,}$/i.test(operationId) ? operationId : undefined;
  if (usableOpId) return usableOpId.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
  const verb = { GET: 'get', POST: 'create', PUT: 'update', PATCH: 'update', DELETE: 'delete', HEAD: 'head' }[method] ?? method.toLowerCase();
  // Drop a leading /api/v<version>/ segment when naming so tool names aren't polluted by the
  // API version (BambooHR spreads endpoints across /api/v1, /api/v1_2, /api/v2). The entityType
  // still carries the full versioned path; only the derived name ignores the version prefix.
  const namePath = path.replace(/^\/api\/v[0-9._]+(?=\/)/i, '');
  const parts = namePath.split('/').filter((p) => p && !p.startsWith('{'));
  return `${verb}_${parts.join('_')}`.replace(/[^a-zA-Z0-9_]+/g, '_').slice(0, 60);
}

function categoriesFor(method: string): string[] {
  if (method === 'GET' || method === 'HEAD') return ['read'];
  if (method === 'DELETE') return ['destructive'];
  return ['write'];
}

function classificationFor(method: string, path: string): string[] {
  if (method === 'GET' || method === 'HEAD') return [];
  const out = ['dataChanges'];
  if (FINANCIAL_RE.test(path)) out.push('financialActions');
  if (COMMS_RE.test(path)) out.push('customerCommunication');
  return out;
}

const OAS_MAX_DEPTH = 12;

function mapJsonType(t: unknown): string {
  const s = Array.isArray(t) ? t.find((x) => x && x !== 'null') : t;
  if (s === 'integer') return 'integer';
  if (s === 'number') return 'number';
  if (s === 'boolean') return 'boolean';
  if (s === 'array') return 'array';
  if (s === 'object') return 'object';
  return 'string';
}

// Expand an OpenAPI schema into the platform's JsonSchemaProperty vocabulary,
// resolving $ref against components.schemas and merging allOf. Cycle-safe (a type
// already on the path emits a compact note) with OAS_MAX_DEPTH as a backstop.
// oneOf/anyOf collapse to the property superset (all branches optional).
function expandOas(schema: Json, defs: Record<string, Json>, stack: Set<string>, depth: number): Json {
  if (!schema || typeof schema !== 'object') return { type: 'string' };
  if (schema.$ref) {
    const name = String(schema.$ref).split('/').pop() ?? '';
    if (stack.has(name)) return { type: 'object', description: `Recursive reference to ${name}.` };
    if (depth > OAS_MAX_DEPTH || !defs[name]) return { type: 'object', ...(defs[name] ? { description: `${name} (nested; truncated at depth ${OAS_MAX_DEPTH}).` } : {}) };
    return expandOas(defs[name], defs, new Set(stack).add(name), depth + 1);
  }
  if (Array.isArray(schema.allOf)) {
    const properties: Json = {};
    const requiredFields: string[] = [];
    const absorb = (e: Json) => { if (e.properties) Object.assign(properties, e.properties); if (Array.isArray(e.requiredFields)) requiredFields.push(...e.requiredFields); };
    for (const sub of schema.allOf) absorb(expandOas(sub, defs, stack, depth + 1));
    if (schema.properties) for (const [k, v] of Object.entries<Json>(schema.properties)) properties[k] = expandOas(v, defs, stack, depth + 1);
    if (Array.isArray(schema.required)) requiredFields.push(...schema.required);
    return { type: 'object', properties, ...(requiredFields.length ? { requiredFields: [...new Set(requiredFields)] } : {}) };
  }
  const union = schema.oneOf ?? schema.anyOf;
  if (Array.isArray(union)) {
    const properties: Json = {};
    for (const sub of union) { const e = expandOas(sub, defs, stack, depth + 1); if (e.properties) Object.assign(properties, e.properties); }
    return Object.keys(properties).length ? { type: 'object', properties } : { type: 'string' };
  }
  if (schema.type === 'array' || schema.items) {
    return { type: 'array', items: expandOas(schema.items ?? {}, defs, stack, depth + 1) };
  }
  if (schema.type === 'object' || schema.properties) {
    const properties: Json = {};
    for (const [k, v] of Object.entries<Json>(schema.properties ?? {})) properties[k] = expandOas(v, defs, stack, depth + 1);
    const out: Json = { type: 'object', properties };
    if (Array.isArray(schema.required) && schema.required.length) out.requiredFields = schema.required;
    return out;
  }
  const out: Json = { type: mapJsonType(schema.type) };
  if (Array.isArray(schema.enum)) { const e = schema.enum.filter((x: unknown) => x !== null); if (e.length) out.enum = e; }
  return out;
}

// Resolve a `$ref` to ANY node in the document (requestBodies, parameters, and
// the ones that point into `paths` at another operation's parameter, which is
// how DigitalOcean writes every shared one). Resolving only
// `#/components/<section>/<name>` handed the ref object back, and an operation
// then silently lost the parameter it names. Schema $refs are resolved inside
// expandOas instead.
function deref(obj: Json | undefined, document: Json): Json | undefined {
  return resolveRef(obj, document) ?? obj;
}

// The request body property for an operation — fully expanded from the spec.
// requestBody itself may be a $ref into components.requestBodies (Oracle Fusion).
/** Is this schema a file — bytes rather than a value? */
function isBinarySchema(schema: Json | undefined): boolean {
  if (!schema) return false;
  return schema.format === 'binary' || schema.format === 'byte';
}

function bodyProp(op: Json, defs: Record<string, Json>, document: Json, chosen?: { mediaType?: string }, fileParams?: string[], offerFilesById = false): Json | undefined {
  const rb = deref(op.requestBody, document);
  if (rb == null) return undefined;
  const content = (rb.content ?? {}) as Record<string, Json>;
  const key = content['application/json'] ? 'application/json'
    : content['application/xml'] ? 'application/xml'
      : Object.keys(content)[0];
  const media = key ? content[key] : undefined;
  if (chosen && key) chosen.mediaType = key;
  if (!media?.schema) return { type: 'object', description: 'Request body.' };

  const expanded = expandOas(media.schema, defs, new Set(), 0) as Json;
  // Only where a caller asked. The vendored catalogs are committed and checked
  // byte-for-byte, and their schemas are what live connectors already serve to
  // models; a custom API is generated fresh on every connection and has no
  // such history.
  if (!offerFilesById) return expanded;
  // A body that IS a file — a raw PDF, an image posted as the whole payload —
  // is offered as one named property rather than as the bytes it is, because
  // what a model can supply is the id of a file already in the workspace.
  if (isBinarySchema(media.schema as Json)) {
    if (fileParams && !fileParams.includes(FILE_PROPERTY)) fileParams.push(FILE_PROPERTY);
    return {
      type: 'object',
      properties: { [FILE_PROPERTY]: fileProperty() },
      required: [FILE_PROPERTY],
    };
  }
  // A multipart form usually mixes a file with ordinary fields. Each file
  // field becomes an id the same way; the rest are left exactly as they were.
  const props = (expanded.properties ?? {}) as Record<string, Json>;
  const sourceProps = ((media.schema as Json).properties ?? {}) as Record<string, Json>;
  for (const [name, raw] of Object.entries(sourceProps)) {
    const resolved = (deref(raw, document) ?? raw) as Json;
    if (!isBinarySchema(resolved)) continue;
    props[name] = fileProperty();
    if (fileParams && !fileParams.includes(name)) fileParams.push(name);
  }
  return expanded;
}

/** The one name a whole-body file is offered under. */
const FILE_PROPERTY = 'file';

/** What a model is asked for in place of bytes. */
function fileProperty(): Json {
  return {
    type: 'string',
    description:
      'The id of a file in this workspace — one an AI team produced, or one attached in the '
      + 'conversation. Its contents are read and sent; do not paste the contents here.',
  };
}

function schemaForOperation(op: Json, pathParams: string[], lean = false, defs: Record<string, Json> = {}, document: Json = {}, options: FromOpenApiOptions = {}, headerParams?: string[], chosenBody?: { mediaType?: string }, deepObjectParams?: string[], joinedArrayParams?: string[], fileParams?: string[]): Json {
  const properties: Json = {};
  const required: string[] = [];
  for (const p of pathParams) {
    properties[p] = { type: 'string', description: `Path parameter ${p}.` };
    required.push(p);
  }
  const body = bodyProp(op, defs, document, chosenBody, fileParams, options.describeBodyEncoding === true);
  if (lean) {
    // Lean mode (very large specs, e.g. Oracle Fusion HCM ~8k ops): skip enumerating
    // the dozens of standard query params per GET (fields/expand/limit/…) — the
    // dispatcher routes a generic `query` object — but STILL expand the write body
    // fully, so writes carry their real field structure.
    const method = (op.__method as string) ?? '';
    if (method === 'GET' || method === 'HEAD') {
      properties.query = { type: 'object', description: 'Query parameters (fields, expand, limit, offset, q, orderBy, finder, …).' };
    }
    if (body) properties.body = body;
    return { type: 'object', properties, ...(required.length ? { required } : {}) };
  }
  for (const rawParam of op.parameters ?? []) {
    const param = deref(rawParam, document) ?? rawParam;
    const isHeader = param.in === 'header' && options.includeHeaderParams === true;
    if (param.in === 'query' || param.in === 'path' || isHeader) {
      const ps = (param.schema ?? {}) as Json;
      const prop: Json = { type: mapJsonType(ps.type), description: param.description ?? param.name };
      // An array parameter says what it holds. Without `items` a model is told
      // "array" and nothing about what goes in one, and the dispatcher is left
      // guessing how to put it on the wire.
      if (prop.type === 'array' && options.describeArrayItems) {
        const items = (deref(ps.items as Json, document) ?? {}) as Json;
        prop.items = { type: mapJsonType(items.type) };
        if (Array.isArray(items.enum)) {
          const e = items.enum.filter((x: unknown) => x !== null);
          if (e.length) (prop.items as Json).enum = e;
        }
      }
      if (Array.isArray(ps.enum)) { const e = ps.enum.filter((x: unknown) => x !== null); if (e.length) prop.enum = e; }
      properties[param.name] = prop;
      if (isHeader && headerParams && !headerParams.includes(param.name)) headerParams.push(param.name);
      if (param.in === 'query' && param.style === 'deepObject' && deepObjectParams
        && !deepObjectParams.includes(param.name)) deepObjectParams.push(param.name);
      if (param.in === 'query' && param.explode === false && param.style !== 'deepObject'
        && joinedArrayParams && !joinedArrayParams.includes(param.name)) joinedArrayParams.push(param.name);
      if (param.required && !required.includes(param.name)) required.push(param.name);
    }
  }
  if (body) properties.body = body;
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}

// The success (2xx) response body schema for an operation — expanded via the same expandOas
// vocabulary as inputSchema. Powers runtime spec-vs-reality drift detection
// (src/observability/response-conformance.ts). Undefined when the op documents no JSON body.
function successResponseSchema(op: Json, defs: Record<string, Json>, document: Json): Json | undefined {
  const responses = (op.responses ?? {}) as Record<string, Json>;
  const keys = Object.keys(responses);
  // Prefer 200, then any documented 2xx success (201/202/203…, or the '2XX'/'2xx' range key),
  // then 'default'. (204/205 have no body → media below is undefined → undefined responseSchema.)
  const key = keys.find((k) => k === '200')
    ?? keys.find((k) => /^2(\d\d|xx)$/i.test(k))
    ?? (responses.default ? 'default' : undefined);
  if (!key) return undefined;
  const resp = deref(responses[key], document) ?? responses[key];
  const content = (resp.content ?? {}) as Record<string, Json>;
  const media = content['application/json'] ?? Object.values(content)[0];
  return media?.schema ? expandOas(media.schema, defs, new Set(), 0) : undefined;
}

/** Extras a caller may ask for that change the GENERATED OUTPUT.
 *
 *  Off by default on purpose: the vendored catalogs are committed and checked
 *  byte-for-byte (`codegen-conformance.test.ts`), and their tool schemas are
 *  what live connectors already serve to models. A custom API is generated
 *  fresh on every connection and has no such history, so it can have the
 *  better schema immediately. */
export interface FromOpenApiOptions {
  /** Say what an array parameter HOLDS. Without it a model is told "array"
   *  and nothing else, and has to guess what goes in one. */
  describeArrayItems?: boolean;
  /** Offer the operation's declared header parameters, and name them on the
   *  operation so a dispatcher can tell them from query and body fields. */
  includeHeaderParams?: boolean;
  /** Record which media type the body was read from, so a dispatcher writes
   *  the payload the way the provider asked for it rather than assuming. */
  describeBodyEncoding?: boolean;
}

export function fromOpenApi(spec: Json, stripPrefix?: string, pathPrefix?: string, lean = false, options: FromOpenApiOptions = {}): GenOp[] {
  const ops: GenOp[] = [];
  const components = (spec.components ?? {}) as Json;
  const defs = (components.schemas ?? spec.definitions ?? {}) as Record<string, Json>;
  for (const [rawPath, item] of Object.entries<Json>(spec.paths ?? {})) {
    // Strip a base prefix already carried by the client (e.g. Gusto '/v1'); then
    // optionally prepend a module base (e.g. Workday '/ccx/api/staffing/v1/{tenant}',
    // where {tenant} is filled from the connection at dispatch time).
    const stripped = stripPrefix && rawPath.startsWith(stripPrefix)
      ? (rawPath.slice(stripPrefix.length) || '/')
      : rawPath;
    const path = (pathPrefix ?? '') + stripped;
    for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head']) {
      const op = (item as Json)[method];
      if (!op) continue;
      const M = method.toUpperCase();
      const pathParams = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
      op.__method = M;
      // Filled by schemaForOperation as it walks the parameters, so the names
      // come from the same pass that decided to offer them.
      const headerParams: string[] = [];
      const chosenBody: { mediaType?: string } = {};
      const deepObjectParams: string[] = [];
      const joinedArrayParams: string[] = [];
      const fileParams: string[] = [];
      ops.push({
        name: slug(M, path, op.operationId),
        description: op.summary ?? op.description ?? `${M} ${path}`,
        entityType: `${M} ${path}`,
        method: M,
        path,
        inputSchema: schemaForOperation(op, pathParams, lean, defs, spec, options, headerParams, chosenBody, deepObjectParams, joinedArrayParams, fileParams),
        categories: categoriesFor(M),
        classification: classificationFor(M, path),
        responseSchema: lean ? undefined : successResponseSchema(op, defs, spec),
        ...(headerParams.length ? { headerParams } : {}),
        ...(options.describeBodyEncoding && chosenBody.mediaType && chosenBody.mediaType !== 'application/json'
          ? { bodyMediaType: chosenBody.mediaType }
          : {}),
        ...(options.describeBodyEncoding && deepObjectParams.length ? { deepObjectParams } : {}),
        ...(options.describeBodyEncoding && joinedArrayParams.length ? { joinedArrayParams } : {}),
        ...(options.describeBodyEncoding && fileParams.length ? { fileParams } : {}),
      });
    }
  }
  return ops;
}

// EDMX EntityType → expanded field schema (SAP SuccessFactors create/update bodies).
const ODATA_MAX_DEPTH = 3; // navigation nesting depth (SF entities are wide; keep shallow)

function edmToJson(t?: string | null): string {
  const b = ln(t).toLowerCase(); // Edm.String → string
  if (b === 'boolean') return 'boolean';
  if (['int16', 'int32', 'int64', 'byte', 'sbyte'].includes(b)) return 'integer';
  if (['decimal', 'double', 'single'].includes(b)) return 'number';
  return 'string'; // string/dateTime/dateTimeOffset/time/guid/binary
}

interface EdmIndex { types: Map<string, El>; assocs: Map<string, El>; }

function buildEdmIndex(xml: string): EdmIndex {
  const idx: EdmIndex = { types: new Map(), assocs: new Map() };
  let doc: El;
  try { doc = new DOMParser({ onError: () => {} }).parseFromString(xml, 'text/xml') as El; } catch { return idx; }
  const all = doc.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    const n = all.item(i); const t = ln(n.nodeName); const nm = n.getAttribute && n.getAttribute('Name');
    if (!nm) continue;
    if (t === 'EntityType') idx.types.set(nm, n);
    else if (t === 'Association') idx.assocs.set(nm, n);
  }
  return idx;
}

// Expand an EntityType into { properties, required(keys) } — Properties become typed
// fields; NavigationProperties resolve their target EntityType (via the Association's
// ToRole) and nest it (cycle-safe, depth-capped; Multiplicity "*" → array).
function expandODataEntity(typeName: string, idx: EdmIndex, stack: Set<string>, depth: number): { properties: Json; required: string[] } {
  const et = idx.types.get(typeName);
  if (!et || stack.has(typeName) || depth > ODATA_MAX_DEPTH) return { properties: {}, required: [] };
  const ns = new Set(stack); ns.add(typeName);
  const properties: Json = {};
  const keys: string[] = [];
  for (const kr of descByLocal(et, 'PropertyRef')) { const n = kr.getAttribute('Name'); if (n) keys.push(n); }
  for (const p of directChildren(et, 'Property')) {
    const n = p.getAttribute('Name'); if (!n) continue;
    const prop: Json = { type: edmToJson(p.getAttribute('Type')) };
    const label = p.getAttribute('sap:label'); if (label) prop.description = label;
    properties[n] = prop;
  }
  for (const nav of directChildren(et, 'NavigationProperty')) {
    const n = nav.getAttribute('Name'); if (!n) continue;
    const rel = ln(nav.getAttribute('Relationship')); const toRole = nav.getAttribute('ToRole');
    const assoc = idx.assocs.get(rel);
    let target = ''; let coll = false;
    if (assoc) for (const end of directChildren(assoc, 'End')) if (end.getAttribute('Role') === toRole) { target = ln(end.getAttribute('Type')); coll = end.getAttribute('Multiplicity') === '*'; }
    if (target && idx.types.has(target) && !ns.has(target) && depth < ODATA_MAX_DEPTH) {
      const sub = expandODataEntity(target, idx, ns, depth + 1);
      const obj: Json = { type: 'object', properties: sub.properties, ...(sub.required.length ? { requiredFields: sub.required } : {}) };
      properties[n] = coll ? { type: 'array', items: obj } : obj;
    } else {
      properties[n] = coll ? { type: 'array', items: { type: 'object', description: `Navigation to ${target || 'related entity'}.` } } : { type: 'object', description: `Navigation to ${target || 'related entity'}.` };
    }
  }
  return { properties, required: keys };
}

// OData EDMX ($metadata) → CRUD ops per EntitySet (SAP SuccessFactors, etc.).
//
// Emits the SAME shape as the curated SAP tools: entityType is the BARE OData
// entity-set name (e.g. "EmpCompensation") and CRUD is driven by categories +
// the name prefix (query_/get_/create_/update_/delete_). This reuses the SAP
// client's proven OData handling — create → POST /upsert with __metadata.uri,
// update → MERGE by key, delete/get → keyed URL — instead of a generic
// templated dispatch that would omit the required upsert envelope.
//
// EntitySet-level sap:creatable / sap:updatable / sap:deletable annotations gate
// which write tools are emitted (allowed unless the annotation is "false").
// FunctionImports (OData actions) become templated `${HttpMethod} /${Name}` tools
// dispatched through the client's low-level odata() executor.
export function fromODataMetadata(xml: string): GenOp[] {
  const ops: GenOp[] = [];
  const edm = buildEdmIndex(xml);
  const attr = (tag: string, name: string): string | undefined => {
    const m = tag.match(new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}="([^"]*)"`));
    return m ? m[1] : undefined;
  };
  const allowed = (tag: string, name: string): boolean => attr(tag, `sap:${name}`) !== 'false';

  // EntitySets → CRUD tools (open the tag greedily to the first '>').
  for (const m of xml.matchAll(/<EntitySet\s+([^>]+?)\/?>/g)) {
    const tag = m[1];
    const set = attr(tag, 'Name');
    if (!set) continue;
    const lc = set.toLowerCase();
    const queryProps = { $filter: { type: 'string' }, $select: { type: 'string' }, $expand: { type: 'string' }, $top: { type: 'string' }, $skip: { type: 'string' }, $orderby: { type: 'string' } };
    const idProps = { id: { type: 'string', description: `Key for ${set}: a single key value, or a full OData key predicate for composite keys (e.g. userId='X',startDate=datetime'…').` } };
    // Expand the backing EntityType into the write body's real field set.
    const ent = expandODataEntity(ln(attr(tag, 'EntityType') ?? ''), edm, new Set(), 0);
    // SAP OData wraps in { d: … } on the wire, but the SAP client STRIPS the `d` envelope before
    // returning: list() → { results: [...] }, get() → the entity itself (see sap-successfactors.ts
    // read/list). The responseSchema must match the client's post-unwrap shape, not the raw wire.
    const collResponse = { type: 'object', properties: { results: { type: 'array', items: { type: 'object', properties: ent.properties } } } };
    const oneResponse = { type: 'object', properties: ent.properties };
    ops.push({ name: `query_${lc}`, description: `Query ${set} entities (OData $filter/$select/$expand/$top/$skip).`, entityType: set, method: 'GET', path: set, inputSchema: { type: 'object', properties: queryProps }, categories: ['read'], classification: [], responseSchema: collResponse });
    ops.push({ name: `get_${lc}`, description: `Get a single ${set} by key.`, entityType: set, method: 'GET', path: set, inputSchema: { type: 'object', properties: idProps, required: ['id'] }, categories: ['read'], classification: [], responseSchema: oneResponse });
    if (allowed(tag, 'creatable')) {
      ops.push({ name: `create_${lc}`, description: `Create/upsert a ${set} (OData upsert).`, entityType: set, method: 'POST', path: set, inputSchema: { type: 'object', properties: ent.properties, ...(ent.required.length ? { required: ent.required } : {}) }, categories: ['write'], classification: classificationFor('POST', set) });
    }
    if (allowed(tag, 'updatable')) {
      ops.push({ name: `update_${lc}`, description: `Update a ${set} (OData MERGE by key).`, entityType: set, method: 'MERGE', path: set, inputSchema: { type: 'object', properties: { ...idProps, ...ent.properties }, required: ['id'] }, categories: ['write'], classification: classificationFor('POST', set) });
    }
    if (attr(tag, 'sap:deletable') === 'true') {
      // Only emit delete when explicitly deletable — most SF sets are not.
      ops.push({ name: `delete_${lc}`, description: `Delete a ${set} by key.`, entityType: set, method: 'DELETE', path: set, inputSchema: { type: 'object', properties: idProps, required: ['id'] }, categories: ['destructive'], classification: ['dataChanges'] });
    }
  }

  // FunctionImports (OData actions) → templated tools through the client's odata().
  for (const m of xml.matchAll(/<FunctionImport\s+([^>]+?)\/?>/g)) {
    const tag = m[1];
    const name = attr(tag, 'Name');
    if (!name) continue;
    const method = (attr(tag, 'm:HttpMethod') ?? 'GET').toUpperCase();
    const isRead = method === 'GET';
    ops.push({
      name: `call_${name.toLowerCase()}`,
      description: `Invoke the ${name} OData function import.`,
      entityType: `${method} /${name}`,
      method,
      path: `/${name}`,
      inputSchema: isRead
        ? { type: 'object', properties: { query: { type: 'object', description: 'Function import parameters.' } } }
        : { type: 'object', properties: { body: { type: 'object', description: 'Function import parameters/body.' } } },
      categories: isRead ? ['read'] : ['write'],
      classification: isRead ? [] : classificationFor('POST', name),
    });
  }
  return ops;
}

// ── XSD ($metadata within a WSDL) → JSON Schema ───────────────────────────────
// A real, cycle-safe XSD compiler that expands each WWS operation's
// {Operation}_RequestType into a comprehensive JSON Schema in the platform's own
// vocabulary (properties / items / enum / requiredFields / description). Workday's
// schema is flat + fully named (no inline anonymous types), so a name-indexed
// resolver expands it completely. Recursion is broken by cycle detection (a type
// already on the expansion path emits a compact "recursive" note); WSDL_MAX_DEPTH
// is a backstop for pathologically deep non-cyclic trees.
const WSDL_MAX_DEPTH = 16;
const WSDL_ENUM_CAP = 200; // drop absurdly large enums (e.g. every ID type) but keep the base type

type El = any;

// Local name: strip the namespace prefix. Handles both XSD/WSDL colon qualifiers
// (xsd:element, wd:WorkerType) and EDM dot qualifiers (SFOData.User) — takes the
// segment after the last '.' or ':'.
function ln(name?: string | null): string {
  if (!name) return '';
  const i = Math.max(name.lastIndexOf(':'), name.lastIndexOf('.'));
  return i >= 0 ? name.slice(i + 1) : name;
}

function xsdBase(base?: string | null): string {
  const b = ln(base).toLowerCase();
  if (b === 'boolean') return 'boolean';
  if (['decimal', 'float', 'double'].includes(b)) return 'number';
  if (['int', 'integer', 'long', 'short', 'byte', 'unsignedint', 'unsignedlong', 'unsignedshort', 'positiveinteger', 'nonnegativeinteger'].includes(b)) return 'integer';
  return 'string'; // string/date/dateTime/time/base64Binary/anyURI/token/…
}

interface XsdIndex { elements: Map<string, El>; types: Map<string, El>; attrs: Map<string, El>; }

function directChildren(el: El, local: string): El[] {
  const out: El[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1 && ln(n.nodeName) === local) out.push(n);
  return out;
}
function descByLocal(el: El, local: string): El[] {
  const out: El[] = []; const all = el.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) { const n = all.item(i); if (ln(n.nodeName) === local) out.push(n); }
  return out;
}
function firstDesc(el: El, local: string): El | undefined {
  const all = el.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) { const n = all.item(i); if (ln(n.nodeName) === local) return n; }
  return undefined;
}

function buildXsdIndex(doc: El): XsdIndex {
  const idx: XsdIndex = { elements: new Map(), types: new Map(), attrs: new Map() };
  const schemas = doc.getElementsByTagName('*');
  for (let i = 0; i < schemas.length; i++) {
    const s = schemas.item(i);
    if (ln(s.nodeName) !== 'schema') continue;
    for (let n = s.firstChild; n; n = n.nextSibling) {
      if (n.nodeType !== 1) continue;
      const t = ln(n.nodeName); const nm = n.getAttribute && n.getAttribute('name');
      if (!nm) continue;
      if (t === 'element') idx.elements.set(nm, n);
      else if (t === 'complexType' || t === 'simpleType') idx.types.set(nm, n);
      else if (t === 'attribute') idx.attrs.set(nm, n);
    }
  }
  return idx;
}

function expandSimple(el: El): Json {
  const restr = firstDesc(el, 'restriction');
  const t = xsdBase(restr?.getAttribute('base') ?? 'xsd:string');
  const enums: string[] = [];
  if (restr) for (const e of descByLocal(restr, 'enumeration')) { const v = e.getAttribute('value'); if (v != null) enums.push(v); }
  return enums.length && enums.length <= WSDL_ENUM_CAP ? { type: t, enum: enums } : { type: t };
}

function typeToSchema(typeName: string, idx: XsdIndex, stack: Set<string>, depth: number): Json {
  if (stack.has(typeName)) return { type: 'object', description: `Recursive reference to ${typeName} — same shape, expand as needed.` };
  if (depth > WSDL_MAX_DEPTH) return { type: 'object', description: `${typeName} (nested; truncated at depth ${WSDL_MAX_DEPTH}).` };
  const el = idx.types.get(typeName);
  if (!el) return { type: 'string' };
  if (ln(el.nodeName) === 'simpleType') return expandSimple(el);
  const ns = new Set(stack); ns.add(typeName);
  return expandComplex(el, idx, ns, depth);
}

function elemToProp(el: El, idx: XsdIndex, stack: Set<string>, depth: number): { name: string; prop: Json; required: boolean } | null {
  let name = el.getAttribute('name');
  let typeAttr = el.getAttribute('type');
  const ref = el.getAttribute('ref');
  if (!name && ref) { name = ln(ref); const g = idx.elements.get(name); if (g && !typeAttr) typeAttr = g.getAttribute('type'); }
  if (!name) return null;
  const minO = el.getAttribute('minOccurs');
  const maxO = el.getAttribute('maxOccurs');
  const required = minO == null ? true : minO !== '0';
  const isArray = maxO === 'unbounded' || (maxO != null && Number(maxO) > 1);
  const inlineC = directChildren(el, 'complexType')[0];
  const inlineS = directChildren(el, 'simpleType')[0];
  let base: Json;
  if (inlineC) base = expandComplex(inlineC, idx, stack, depth + 1);
  else if (inlineS) base = expandSimple(inlineS);
  else if (typeAttr) base = typeAttr.split(':')[0] === 'xsd' ? { type: xsdBase(typeAttr) } : typeToSchema(ln(typeAttr), idx, stack, depth + 1);
  else base = { type: 'string' };
  return { name, prop: isArray ? { type: 'array', items: base } : base, required };
}

function attrToProp(el: El, idx: XsdIndex, stack: Set<string>, depth: number): { name: string; prop: Json } | null {
  let name = el.getAttribute('name');
  let typeAttr = el.getAttribute('type');
  const ref = el.getAttribute('ref');
  if (!name && ref) { name = ln(ref); const g = idx.attrs.get(name); if (g) { if (!typeAttr) typeAttr = g.getAttribute('type'); const gs = directChildren(g, 'simpleType')[0]; if (gs && !typeAttr) return { name, prop: expandSimple(gs) }; } }
  if (!name) return null;
  const inlineS = directChildren(el, 'simpleType')[0];
  let prop: Json;
  if (inlineS) prop = expandSimple(inlineS);
  else if (typeAttr) prop = typeAttr.split(':')[0] === 'xsd' ? { type: xsdBase(typeAttr) } : typeToSchema(ln(typeAttr), idx, stack, depth + 1);
  else prop = { type: 'string' };
  return { name, prop };
}

function expandComplex(ct: El, idx: XsdIndex, stack: Set<string>, depth: number): Json {
  const properties: Record<string, Json> = {};
  const requiredFields: string[] = [];
  const ext = firstDesc(ct, 'extension');
  if (ext) {
    const base = ext.getAttribute('base');
    if (base) {
      if (base.split(':')[0] === 'xsd') properties['#text'] = { type: xsdBase(base) }; // simpleContent
      else {
        const bs = typeToSchema(ln(base), idx, stack, depth + 1);
        if (bs.properties) { Object.assign(properties, bs.properties); if (bs.requiredFields) requiredFields.push(...bs.requiredFields); }
        else properties['#text'] = { type: (bs.type as string) ?? 'string', ...(bs.enum ? { enum: bs.enum } : {}) };
      }
    }
  }
  for (const chEl of descByLocal(ct, 'element')) {
    const r = elemToProp(chEl, idx, stack, depth);
    if (r && !(r.name in properties)) { properties[r.name] = r.prop; if (r.required) requiredFields.push(r.name); }
  }
  for (const at of descByLocal(ct, 'attribute')) {
    const r = attrToProp(at, idx, stack, depth);
    if (r) properties['@' + r.name] = r.prop;
  }
  return { type: 'object', properties, ...(requiredFields.length ? { requiredFields } : {}) };
}

// Workday WWS WSDL → one tool per SOAP operation, each carrying the FULL expanded
// request schema. entityType is `SOAP {Service} {Operation}`, executed by
// WorkdayClient.soapOperation() which serializes the request object into the
// operation's `<wd:{Operation}_Request>` envelope.
//
// Read detection is FAIL-SECURE: only Get_/Find_/Retrieve_ (pure retrieval) are
// reads. Everything else is a write — critically including Request_* (these SUBMIT
// business processes: Request_Compensation_Change, Request_Bonus_Payment, …) and
// Report_* (Report_Safety_Incident is an event), so they stay HITL-gated.
export function fromWsdl(xml: string, service: string): GenOp[] {
  const svcLc = service.toLowerCase();
  const names = [...new Set([...xml.matchAll(/<wsdl:operation\s+name="([^"]+)"/g)].map((m) => m[1]))];
  let idx: XsdIndex | null = null;
  try { idx = buildXsdIndex(new DOMParser({ onError: () => {} }).parseFromString(xml, 'text/xml') as El); } catch { idx = null; }
  return names.map((op) => {
    const isRead = /^(Get|Find|Retrieve)_/.test(op);
    let inputSchema: Json = {
      type: 'object',
      properties: { request: { type: 'object', description: `Structured ${op}_Request body — serialized to Workday SOAP wd: XML (nested objects → child elements, "@attr" → attribute, "#text" → text, arrays repeat).` } },
    };
    if (idx) {
      const reqEl = idx.elements.get(`${op}_Request`);
      const typeName = reqEl ? ln(reqEl.getAttribute('type')) : '';
      if (typeName) {
        const ex = expandComplex(idx.types.get(typeName) ?? reqEl, idx, new Set([typeName]), 0);
        inputSchema = { type: 'object', properties: ex.properties ?? {}, ...(ex.requiredFields?.length ? { required: ex.requiredFields } : {}) };
      }
    }
    // No responseSchema for WWS ops: WorkdayClient returns raw SOAP XML wrapped as
    // { response: <xml string> } (it does not parse the body), so a structured {op}_Response
    // schema would false-drift on every call. Drift is not applicable at the raw-XML layer.
    return {
      name: `${svcLc}_${op.toLowerCase()}`,
      description: `Workday ${service.replace(/_/g, ' ')} WWS operation: ${op.replace(/_/g, ' ')}.`,
      entityType: `SOAP ${service} ${op}`,
      method: 'SOAP',
      path: op,
      inputSchema,
      categories: isRead ? ['read'] : ['write'],
      classification: isRead ? [] : classificationFor('POST', op),
    };
  });
}

const VALID_CATEGORIES = new Set(['read', 'write', 'destructive', 'outbound', 'sensitive']);

// Codegen-time validation of the ConnectorFunction shape. The generated tool sets
// ship as JSON DATA (not tsc-checked TS source — 8037 Oracle tools as a typed literal
// pushed tsc to 2.66GB and OOM'd CI). This check moves the per-tool verification tsc
// used to do to generation time, where a malformed tool fails loudly with a clear
// message instead of at runtime.
export function validateOps(ops: GenOp[]): void {
  const seen = new Set<string>();
  for (const o of ops) {
    const id = o.name || JSON.stringify(o).slice(0, 100);
    if (typeof o.name !== 'string' || !o.name) throw new Error(`invalid tool (missing name): ${id}`);
    if (seen.has(o.name)) throw new Error(`duplicate tool name: ${o.name}`);
    seen.add(o.name);
    if (typeof o.description !== 'string') throw new Error(`invalid tool ${o.name}: description must be a string`);
    if (!o.inputSchema || typeof o.inputSchema !== 'object') throw new Error(`invalid tool ${o.name}: inputSchema must be an object`);
    if (!Array.isArray(o.categories) || o.categories.length === 0 || o.categories.some((c) => !VALID_CATEGORIES.has(c))) {
      throw new Error(`invalid tool ${o.name}: bad categories ${JSON.stringify(o.categories)}`);
    }
    if (typeof o.entityType !== 'string' || !o.entityType) throw new Error(`invalid tool ${o.name}: missing entityType`);
  }
}

// Emit the tool set as a JSON DATA file — one tool object per line for reviewable
// diffs. Loaded at runtime by native-hris-functions.ts via readFileSync (never
// imported), so tsc/eslint/jest/haste never process the multi-MB output. No chunking
// needed (JSON has no TS2590 union-type limit).
export function emitJson(ops: GenOp[]): string {
  validateOps(ops);
  const objs = ops.map((o) => ({
    name: o.name,
    description: o.description,
    inputSchema: o.inputSchema,
    categories: o.categories,
    entityType: o.entityType,
    ...(o.responseSchema ? { responseSchema: o.responseSchema } : {}),
  }));
  return `[\n${objs.map((o) => JSON.stringify(o)).join(',\n')}\n]\n`;
}

// Guarantee unique tool names. Vendors reuse operationId across resources (Workday
// gives ~33 distinct staffing endpoints the operationId `promptValues_getInstances`),
// so the slug collides even though every entityType (METHOD /path) is distinct.
// Names are the registry key, so a collision silently DROPS endpoints at merge time.
// On collision we disambiguate with distinguishing (non-param) path segments — kept
// descriptive — then a counter as a last resort. First occurrence keeps the clean name.
export function dedupeNames(ops: GenOp[]): GenOp[] {
  const seen = new Set<string>();
  for (const o of ops) {
    if (!seen.has(o.name)) { seen.add(o.name); continue; }
    const segs = o.path.split('/').filter((p) => p && !p.startsWith('{') && !p.startsWith('$'));
    let base = o.name;
    for (let take = 1; take <= segs.length; take++) {
      base = `${o.name}_${segs.slice(-take).join('_').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase()}`;
      if (!seen.has(base)) break;
    }
    let name = base;
    for (let i = 2; seen.has(name); i++) name = `${base}_${i}`;
    o.name = name;
    seen.add(name);
  }
  return ops;
}

// Rows for the platform-backend HITL classification migration.
export function classificationRows(ops: GenOp[]): Array<{ tool: string; categories: string[] }> {
  return ops.filter((o) => o.classification.length).map((o) => ({ tool: o.name, categories: o.classification }));
}
