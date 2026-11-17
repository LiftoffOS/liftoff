// Tool-schema catalog for the ListTools RPC.
//
// Aggregates every connector's function-level JSON schemas from
// connector-functions-registry.ts into the proto shape consumed by
// platform-backend (tool-gateway, agent-execution, Claude tool-use).
//
// Design:
//   - The source of truth is the static registry. No database reads.
//   - Output is deterministic: connectors + tools sorted alphabetically so
//     the hash is stable across process restarts.
//   - `version` is sha1 of the JSON-serialised tool sets, truncated to
//     16 chars. Stable across server redeploys as long as the registry
//     does not change.
//   - Callers send their `cachedVersion`; when it matches, we short-
//     circuit with `unchanged: true` and an empty tool_sets array.
//
// Categorisation:
//   - If the registry function carries `categories`, pass them through.
//   - Otherwise synthesise via function-name prefix heuristics (see
//     deriveCategories). This handles connectors whose registry entries
//     do not include explicit categories.
//   - `isWrite` is derived from the final categories (any of write /
//     destructive / outbound).

import { createHash } from 'node:crypto';
import {
  getConnectorFunctions,
  getRegisteredConnectorTypes,
} from './connector-functions-registry.js';
import { CONNECTOR_DISPLAY_NAMES, type ConnectorFunction } from '../types.js';
import { ClassificationSource } from '@liftoffos/proto-gen/liftoff/connector/v1/connector_service_pb.js';

export interface ToolDefinitionPlain {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  categories: string[];
  isWrite: boolean;
  // Whether `categories` were DECLARED by the registry entry or INFERRED by the
  // name heuristic. Forwarded on the wire so the governance Authorize decision
  // trusts a declared read but falls back to its own name inference for an
  // inferred one (whose read default for an unknown verb is a guess).
  classificationSource: ClassificationSource;
  // W1.4 — registry metadata propagated through the wire under proto-gen
  // v0.7.0. All optional: undefined when the registry entry doesn't carry
  // the field; the proto layer maps undefined → empty string.
  draftVariant?: string;
  entityType?: string;
  workRole?: string;
  pairedAck?: string;
  acknowledges?: string;
  workItemKind?: string;
  // Composio cutover-completion (C4 / proto-gen v0.8.0).
  definitionSource?: string;
  vendorToolName?: string;
  // Record provenance, host-only result fields, staged writes (proto-gen
  // v0.19.0). Optional here and repeated on the wire, so the encoder maps
  // undefined to an empty array rather than a null the proto cannot carry.
  idArgs?: string[];
  returnsIds?: Array<{ entityType: string; path: string }>;
  egressOnly?: string[];
  writeRole?: string;
  pairedApply?: string;
}

export interface ConnectorToolSetPlain {
  connectorType: string;
  displayName: string;
  tools: ToolDefinitionPlain[];
}

export interface ListToolsResult {
  toolSets: ConnectorToolSetPlain[];
  version: string;
  unchanged: boolean;
}

const WRITE_CATEGORIES = new Set(['write', 'destructive', 'outbound']);

// Heuristic write-prefixes — used only when the registry entry does not
// carry an explicit category list. Matches prefix before an underscore
// or camelCase boundary (createUser, create_user, createXYZ, sendEmail…).
const WRITE_PREFIX_RE = /^(create|update|delete|remove|post|send|archive|patch|put|move|upsert|reply|forward|draft|assign|close|cancel|approve|reject|revoke|grant|publish|unpublish|install|uninstall|start|stop|pause|resume|trigger|invite|kick|ban|unban|merge|apply|import|export|sync|rotate|refresh|upload)([_A-Z]|$)/;

function deriveCategories(fn: ConnectorFunction): {
  categories: string[];
  source: ClassificationSource;
} {
  // Registry-supplied categories win when present — a DECLARED classification.
  if (Array.isArray(fn.categories) && fn.categories.length > 0) {
    return {
      categories: Array.from(new Set(fn.categories as string[])).sort(),
      source: ClassificationSource.DECLARED,
    };
  }
  // Heuristic: name-prefix → write, otherwise read. INFERRED — the read default
  // for an unrecognised name is a guess, so consumers must not treat it as
  // authoritative (it must never loosen a fail-closed governance gate).
  if (WRITE_PREFIX_RE.test(fn.name)) {
    return { categories: ['write'], source: ClassificationSource.INFERRED };
  }
  return { categories: ['read'], source: ClassificationSource.INFERRED };
}

function isWriteTool(categories: string[]): boolean {
  return categories.some((c) => WRITE_CATEGORIES.has(c));
}

/**
 * Recursively ensures every `type: 'array'` node in a JSON Schema object has
 * an `items` field.  Some registry entries omit `items`, which causes the
 * Tenant Runtime startup validator to reject the schema and crash agent-service.
 * This normalisation is purely defensive — it does not change any schema that
 * already has `items` set.
 */
function normalizeArraySchemas(node: unknown): void {
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  if (obj['type'] === 'array' && !('items' in obj)) {
    obj['items'] = {};
  }
  for (const val of Object.values(obj)) {
    if (val && typeof val === 'object') {
      normalizeArraySchemas(val);
    }
  }
}

function buildToolDefinition(
  connectorType: string,
  fn: ConnectorFunction,
): ToolDefinitionPlain {
  const { categories, source: classificationSource } = deriveCategories(fn);
  // Copy inputSchema into a plain object; fallback to an empty object
  // schema when missing (rare — registry types require it, but defensive).
  const inputSchema: Record<string, unknown> = fn.inputSchema
    ? (JSON.parse(JSON.stringify(fn.inputSchema)) as Record<string, unknown>)
    : { type: 'object', properties: {} };
  // Defensively normalise any array schemas that are missing `items`.
  // This prevents malformed registry entries from crashing the Tenant Runtime
  // startup validator (which requires items on every type:array node).
  normalizeArraySchemas(inputSchema);
  return {
    // Tool name is the raw function name. NOT prefixed with connectorType —
    // the prefix used to be `${connectorType}.${fn.name}` but the dot violates
    // the LLM tool-name regex ^[a-zA-Z0-9_-]+$ on the downstream prefix path
    // (tenant-runtime builds `${alias}__${fn.name}` for the model, which would
    // produce e.g. `slack__slack.create_channel`). Tenant runtime carries
    // connectorType separately on the ToolDefinition envelope, so the dotted
    // prefix was always redundant and never read by any downstream consumer
    // (grep for tool.name.split('.') is empty). With the dot, every invocation
    // of an agent bound to such a tool fails with
    // `400 Invalid 'tools[N].function.name': string does not match pattern`.
    name: fn.name,
    description: fn.description,
    inputSchema,
    categories,
    isWrite: isWriteTool(categories),
    classificationSource,
    // W1.4 — pass-through registry metadata that now reaches the wire under
    // proto-gen v0.7.0. Downstream consumers (tenant-runtime tool-schema-cache,
    // platform-backend distill) read these to drive the draft-first
    // tool-interceptor rewrite and the work_inbox/ack contract injection.
    draftVariant: fn.draftVariant,
    entityType: fn.entityType,
    workRole: fn.workRole,
    pairedAck: fn.paired_ack,
    acknowledges: fn.acknowledges,
    workItemKind: fn.workItemKind,
    // Composio cutover-completion (proto-gen v0.8.0) — pass through the
    // dispatch-source marker + vendor tool name so tenant-runtime's
    // stable-name router picks the right dispatch path.
    definitionSource: fn.definitionSource,
    vendorToolName: fn.vendorToolName,
    // Record provenance, host-only result fields, staged writes (proto-gen
    // v0.19.0). Projected here AND in rpc/router.ts, which are the two halves
    // of the same journey: this shapes the plain object, that encodes it. A
    // field added to one and not the other is declared in the registry and
    // absent from the wire, which reads as "the tool declares nothing".
    idArgs: fn.idArgs,
    returnsIds: fn.returnsIds,
    egressOnly: fn.egressOnly,
    writeRole: fn.writeRole,
    pairedApply: fn.paired_apply,
  };
}

function buildConnectorToolSet(connectorType: string): ConnectorToolSetPlain {
  const fns = getConnectorFunctions(connectorType);
  // Sort by fn.name for deterministic hash.
  const sorted = [...fns].sort((a, b) => a.name.localeCompare(b.name));
  return {
    connectorType,
    displayName:
      (CONNECTOR_DISPLAY_NAMES as Record<string, string>)[connectorType] ??
      connectorType,
    tools: sorted.map((fn) => buildToolDefinition(connectorType, fn)),
  };
}

// ────────────────────────────────────────────────────────────────────
// Version hash: sha1(JSON.stringify(allToolSets)) truncated to 16 chars.
// Cached on first build — the registry is a module-level constant, so
// the hash is stable for the life of the process. Re-exported for tests.
// ────────────────────────────────────────────────────────────────────

let cachedAllToolSets: ConnectorToolSetPlain[] | null = null;
let cachedVersion: string | null = null;

function buildAllToolSets(): ConnectorToolSetPlain[] {
  // Use every connector type that has registered functions. We do NOT
  // filter to "functional" here — ListTools is a pure schema surface;
  // availability is governed elsewhere (GetFunctionalTypes).
  const types = [...new Set(getRegisteredConnectorTypes())].sort();
  return types
    .map((t) => buildConnectorToolSet(t))
    .filter((set) => set.tools.length > 0);
}

function ensureCache(): {
  all: ConnectorToolSetPlain[];
  version: string;
} {
  if (cachedAllToolSets && cachedVersion) {
    return { all: cachedAllToolSets, version: cachedVersion };
  }
  const all = buildAllToolSets();
  const hash = createHash('sha1');
  hash.update(JSON.stringify(all));
  const version = hash.digest('hex').slice(0, 16);
  cachedAllToolSets = all;
  cachedVersion = version;
  return { all, version };
}

/** Test-only: forget the cached registry hash. */
export function __resetToolSchemaCache(): void {
  cachedAllToolSets = null;
  cachedVersion = null;
}

/**
 * Build the ListTools response. Honours `cachedVersion` for short-circuit.
 *
 * - `connectorTypes` empty → every registered type.
 * - Unknown connectorTypes are silently dropped (no error) so callers can
 *   probe without tight coupling to the server catalogue.
 */
export function listTools(args: {
  connectorTypes?: string[];
  cachedVersion?: string;
}): ListToolsResult {
  const { all, version } = ensureCache();

  if (args.cachedVersion && args.cachedVersion === version) {
    return { toolSets: [], version, unchanged: true };
  }

  if (!args.connectorTypes || args.connectorTypes.length === 0) {
    return { toolSets: all, version, unchanged: false };
  }

  const filter = new Set(args.connectorTypes);
  const filtered = all.filter((set) => filter.has(set.connectorType));
  return { toolSets: filtered, version, unchanged: false };
}

/** Stable version hash for the current registry. Useful for diagnostics. */
export function getRegistryVersion(): string {
  return ensureCache().version;
}
