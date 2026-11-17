// Tool Schema Cache — Phase 2c
//
// In-memory cache of tool schemas sourced from the connector-service ListTools
// RPC. This replaces the old hard-coded src/connectors/connector-functions-registry.ts
// (Phase 2b deferral) with a single network-backed cache that every importer
// reads synchronously via getToolSchema()/listAllToolSchemas().
//
// Design
// ──────
// 1. initToolSchemaCache() is called once at process start (src/index.ts). It
//    seeds the cache with the full set of tool schemas from the connector-
//    service. On failure (service unreachable, boot race), it logs a warn and
//    leaves the cache empty — the background refresh will retry.
// 2. A background timer runs every 5 minutes, sends ListTools with the
//    currently-cached version tag, and short-circuits when the server returns
//    { unchanged: true } (the only cost is one RPC with no payload).
// 3. Every consumer (agent-execution, tool-gateway, tool-catalog, registry-
//    validator) reads from this cache synchronously — the cache is process-
//    local and guaranteed to be populated before traffic is served.
//
// Shape returned by ListTools is (connectorType → ToolDefinition[]). We map
// each ToolDefinition back to the ConnectorFunction shape the rest of the
// runtime already knows about so call sites only change their imports, not
// their code.
//
// Phase 2d and beyond: when additional connectors or schema updates are
// rolled out from the connector-service, no redeploy of tenant-runtime is
// needed — the 5-minute refresh picks them up automatically.

import { withDerivedDeclarations } from './derive-declarations';
import type { ConnectorFunction, JsonSchemaProperty, ToolCategory } from '@liftoffos/connector-types';
import { ClassificationSource } from '@liftoffos/proto-gen/dist/liftoff/connector/v1/connector_service_pb';
import {
  getConnectorServiceClient,
} from './connector-service-client';
import { logger } from '../infrastructure/logging';
import { forEachTenant } from '../infrastructure/tenant-registry';
import { getManagedSecret } from '../infrastructure/secret-store';

// ── Types ───────────────────────────────────────────────────────────────

/** A cached connector function plus the provenance of its `categories`:
 *  DECLARED by the connector catalog vs name-INFERRED by connector-service.
 *  Carried on the object so it rides the same atomic cache swap and reaches the
 *  governance Authorize decision through getToolSchemas → the tool-gateway. The
 *  governance gate trusts a declared read but not an inferred one (whose read
 *  default for an unknown verb is a guess). */
export type CachedConnectorFunction = ConnectorFunction & { classificationDeclared?: boolean };

export interface ConnectorToolSet {
  connectorType: string;
  displayName: string;
  functions: CachedConnectorFunction[];
}

// ── Module state ────────────────────────────────────────────────────────

// Keyed by connectorType → ConnectorFunction[].
let schemaByConnectorType: Map<string, ConnectorFunction[]> = new Map();
// Keyed by connectorType → display name.
let displayNameByConnectorType: Map<string, string> = new Map();
// Monotonic version tag from the server — used for short-circuited refresh.
let cachedVersion: string = '';
// Interval handle so tests can stop the refresh loop.
let refreshTimer: NodeJS.Timeout | null = null;
// True once the initial seed (success or failure) has completed.
let seeded = false;

// Custom MCP server tool schemas — sourced from platform-backend's
// /api/internal/custom-mcp-servers endpoints. Keyed by customMcpServerId.
// Each entry carries the row's updated_at as its short-circuit version.
interface CustomMcpServerCacheEntry {
  serverId: string;
  /** Which tenant's server this is. Server ids are globally unique, so the map
   *  needs no tenant in its key — but a refresh that fails for ONE tenant must
   *  carry that tenant's entries forward untouched, and that needs to know
   *  which entries are theirs. */
  tenantId: string;
  name: string;
  functions: CachedConnectorFunction[];
  /** The version string the control plane returned for this entry:
   *  `<updatedAt>|<classifier>` from both endpoints (1b), or the bare
   *  `updatedAt` from an older control plane. Compared, never parsed: a flag
   *  flip or a classification-version bump on the control plane changes it
   *  for every server on the next tick with no row written, and the entry
   *  is refetched. */
  version: string;
}

/** The effect class the control plane's classifier stored for a custom tool
 *  (1b): what one call does, in the category vocabulary. */
export type CustomToolEffectClass = 'read' | 'write' | 'destructive' | 'outbound';
const EFFECT_CLASSES: ReadonlySet<string> = new Set(['read', 'write', 'destructive', 'outbound']);

/**
 * The custom-MCP mapper's 1b rule: the effect class is APPENDED to the
 * function's categories and the function marked DECLARED, only when the
 * payload carries a class for it. Appending, never replacing, so a
 * sensitivity signal already on the function is never dropped — and the
 * read-class rule downstream is unchanged (`toolIsReadOnly` over the
 * categories), so a `read` effect beside a sensitive category is still
 * DECLARED_NON_READ. A payload with no class for the tool, or with the
 * classifier reported off, leaves the function exactly as today.
 */
export function withEffectClass(
  fn: ConnectorFunction,
  effectClass: string | undefined,
  classifierEnabled: boolean,
): CachedConnectorFunction {
  if (!classifierEnabled || !effectClass || !EFFECT_CLASSES.has(effectClass)) return fn;
  const existing = fn.categories ?? [];
  if (existing.includes(effectClass as never)) return { ...fn, classificationDeclared: true };
  return {
    ...fn,
    categories: [...existing, effectClass] as ConnectorFunction['categories'],
    classificationDeclared: true,
  };
}
let customMcpSchemaByServerId: Map<string, CustomMcpServerCacheEntry> = new Map();

/** One workspace's custom API connection, as its OPERATIONS.
 *
 *  Keyed by connector id, never by provider slug: `custom_api_connector` is one
 *  shared catalog type, several tenants share a runtime process, and two
 *  workspaces could both choose the same slug. The connector UUID is unique
 *  across tenants, which is what makes this key safe here. */
interface CustomApiConnectorCacheEntry {
  connectorId: string;
  /** Which tenant's connection this is — the same reason the custom-MCP entry
   *  carries one: a refresh that fails for ONE tenant must carry that tenant's
   *  entries forward untouched. */
  tenantId: string;
  name: string;
  functions: CachedConnectorFunction[];
  /** The version string connector-service returned. Compared, never parsed. */
  version: string;
}

let customApiSchemaByConnectorId: Map<string, CustomApiConnectorCacheEntry> = new Map();

const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ── JSON Schema coercion ───────────────────────────────────────────────
//
// ToolDefinition.inputSchema is a proto Struct (JsonObject). ConnectorFunction
// expects a narrower shape with `type: 'object'` + typed properties. We coerce
// at the boundary; anything the cache emits downstream is guaranteed to match
// the old registry's shape, so call sites don't care.

function coerceInputSchema(raw: unknown): ConnectorFunction['inputSchema'] {
  const fallback: ConnectorFunction['inputSchema'] = {
    type: 'object',
    properties: {},
  };
  if (!raw || typeof raw !== 'object') return fallback;
  const obj = raw as Record<string, unknown>;
  const props = (obj.properties ?? {}) as Record<string, JsonSchemaProperty>;
  const required = Array.isArray(obj.required) ? (obj.required as string[]) : undefined;
  return {
    type: 'object',
    properties: props,
    ...(required ? { required } : {}),
  };
}

function coerceCategories(raw: string[] | undefined): ToolCategory[] {
  const allowed: readonly ToolCategory[] = [
    'read',
    'write',
    'destructive',
    'outbound',
    'sensitive',
    // A message into the workspace's own collaboration surface: the gate
    // reads it as never held, and it must reach the gate to be read.
    'internalCollaboration',
  ];
  if (!Array.isArray(raw)) return [];
  return raw.filter((c): c is ToolCategory =>
    (allowed as readonly string[]).includes(c),
  );
}

// ── RPC wiring ──────────────────────────────────────────────────────────

async function fetchToolSets(cachedVersionParam: string): Promise<{
  toolSets: ConnectorToolSet[];
  version: string;
  unchanged: boolean;
}> {
  const client = getConnectorServiceClient();
  // Deliberately the process-level slug: listTools returns the CONNECTOR-TYPE
  // catalog (what a `gmail` connector can do), which is identical for every
  // tenant, so there is nothing per-tenant to fan out over here. The per-tenant
  // half of this cache is the custom-MCP refresh below, which does fan out.
  const resp = await client.listTools({
    tenantContext: { tenantId: process.env.TENANT_ID ?? '' },
    connectorTypes: [],
    cachedVersion: cachedVersionParam,
  });

  const toolSets: ConnectorToolSet[] = resp.toolSets.map((ts) => ({
    connectorType: ts.connectorType,
    displayName: ts.displayName,
    // Every tool the runtime knows comes through this mapper or the custom-MCP
    // one below, so the derivation sits on both rather than in a catalog
    // migration. That is what makes it cover the connectors we have, the ones
    // added later, and a customer's own MCP server — which cannot be covered
    // any other way, since nobody here has seen its tools.
    functions: ts.tools.map((tool): CachedConnectorFunction => ({
      // Provenance from connector-service (proto-gen 0.21.0): DECLARED
      // categories are authoritative; an INFERRED one is a name guess the
      // governance gate must not trust. Rides the object to Authorize via
      // getToolSchemas → the tool-gateway. Custom-MCP tools (a different mapper)
      // leave it unset ⇒ treated as inferred ⇒ name inference, which is safe.
      classificationDeclared: tool.classificationSource === ClassificationSource.DECLARED,
      ...withDerivedDeclarations({
      name: tool.name,
      description: tool.description,
      inputSchema: coerceInputSchema(tool.inputSchema),
      categories: coerceCategories(tool.categories),
      // Proto-gen v0.7.0 (W1.4) — empty string is the proto-3 default for
      // unset string fields; map to undefined so downstream `if (fn.x)`
      // checks behave like they always have.
      draftVariant: tool.draftVariant || undefined,
      entityType: tool.entityType || undefined,
      workRole: (tool.workRole === 'inbox' || tool.workRole === 'ack') ? tool.workRole : undefined,
      paired_ack: tool.pairedAck || undefined,
      acknowledges: tool.acknowledges || undefined,
      workItemKind: tool.workItemKind || undefined,
      // Proto-gen v0.8.0 (Composio cutover) — dispatch-source marker +
      // vendor tool name. Same proto-3 default handling as above.
      definitionSource:
        tool.definitionSource === 'native' || tool.definitionSource === 'composio'
          ? tool.definitionSource
          : undefined,
      vendorToolName: tool.vendorToolName || undefined,
      // Proto-gen v0.19.0 — record provenance, host-only result fields, staged
      // writes. Mapped here or they stop at the RPC boundary: every consumer
      // reads ConnectorFunction, and a field this mapper drops is a field the
      // catalog declared and the runtime never sees.
      //
      // Optional-chained, not because proto-3 can omit a repeated field — a
      // decoded message always carries `[]` — but because a THROW here empties
      // the entire cache. Every tool schema in the runtime comes through this
      // mapper, so one field read against something that is not a decoded
      // message (an older server behind a proxy, a hand-built fixture) would
      // take out the catalog rather than one declaration.
      idArgs: tool.idArgs?.length ? [...tool.idArgs] : undefined,
      returnsIds: tool.returnsIds?.length
        ? tool.returnsIds.map((r) => ({ entityType: r.entityType, path: r.path }))
        : undefined,
      egressOnly: tool.egressOnly?.length ? [...tool.egressOnly] : undefined,
      writeRole:
        tool.writeRole === 'stage' || tool.writeRole === 'apply' || tool.writeRole === 'direct'
          ? tool.writeRole
          : undefined,
      paired_apply: tool.pairedApply || undefined,
    }) })),
  }));

  return {
    toolSets,
    version: resp.version,
    unchanged: resp.unchanged,
  };
}

function installToolSets(toolSets: ConnectorToolSet[]): void {
  const nextByType = new Map<string, ConnectorFunction[]>();
  const nextDisplay = new Map<string, string>();
  for (const ts of toolSets) {
    nextByType.set(ts.connectorType, ts.functions);
    nextDisplay.set(ts.connectorType, ts.displayName || ts.connectorType);
  }
  schemaByConnectorType = nextByType;
  displayNameByConnectorType = nextDisplay;
}

async function refreshOnce(): Promise<void> {
  try {
    const result = await fetchToolSets(cachedVersion);
    if (result.unchanged) {
      logger.debug('tool_schema_cache_unchanged', { version: cachedVersion });
    } else {
      installToolSets(result.toolSets);
      cachedVersion = result.version;
      logger.info('tool_schema_cache_refreshed', {
        version: cachedVersion,
        connector_types: schemaByConnectorType.size,
      });
    }
  } catch (err) {
    logger.warn('tool_schema_cache_refresh_failed', {
      err: (err as Error).message,
      version: cachedVersion,
    });
  }
  // Refresh custom MCP server schemas in the same loop. Failures are logged
  // but don't block other connector schema refreshes.
  try {
    await refreshCustomMcpServerSchemasOnce();
  } catch (err) {
    logger.warn('custom_mcp_server_schema_cache_refresh_failed', { err: (err as Error).message });
  }
  // Custom API connections, whose operations are PER INSTANCE and therefore
  // cannot travel through ListTools above — that payload is aggregated per
  // connector TYPE from a static registry with no database read, and says so
  // in as many words. Same loop, same isolation of failures.
  try {
    await refreshCustomApiSchemasOnce();
  } catch (err) {
    logger.warn('custom_api_schema_cache_refresh_failed', { err: (err as Error).message });
  }
}

// ── Custom MCP Server schema refresh ─────────────────────────────────────

async function refreshCustomMcpServerSchemasOnce(): Promise<void> {
  const baseUrl = process.env.PLATFORM_BACKEND_URL;
  // PB's custom-mcp internal endpoints use verifyServiceAuth() default
  // (TENANT_RUNTIME_SERVICE_TOKEN). Same fix as custom-mcp-server-handler.ts
  // — the old PLATFORM_BACKEND_SERVICE_TOKEN || CONNECTOR_SERVICE_TOKEN chain
  // sent the connector-service shared secret which PB rejected with 401, so
  // this background cache refresh has been silently failing across every
  // tenant since shipping. Causes `custom_mcp_server_schema_cache_refresh_failed`
  // log line every cycle.
  const serviceToken = getManagedSecret('TENANT_RUNTIME_SERVICE_TOKEN');
  if (!baseUrl || !serviceToken) {
    // Single-tenant runtimes only — silently skip when not configured (e.g. tests).
    return;
  }
  // The servers belong to a TENANT, so the refresh runs once per tenant this
  // runtime serves and merges the results. Refreshing for one tenant leaves
  // every other tenant's custom-MCP tools absent from the cache, and an absent
  // tool is not an error anywhere: the model is simply never offered it.
  //
  // Tenant ids come from the `tenants` table, never process.env.TENANT_ID —
  // that is the tenant SLUG, and PB's `custom_mcp_servers.tenant_id` is
  // UUID-typed, so a slug is a PG 22P02 cast error surfacing as a 500 here and
  // an empty cache forever.
  const trimmed = baseUrl.replace(/\/$/, '');
  const nextById = new Map<string, CustomMcpServerCacheEntry>();

  const fanout = await forEachTenant('custom-mcp-schema-cache', async (tenantId) => {
    const listUrl = new URL(`${trimmed}/api/internal/custom-mcp-servers`);
    listUrl.searchParams.set('tenantId', tenantId);

    const listRes = await fetch(listUrl.toString(), {
      headers: { 'X-Service-Auth': serviceToken, accept: 'application/json' },
    });
    if (!listRes.ok) {
      throw new Error(`list custom MCP servers failed: ${listRes.status}`);
    }
    const { servers } = (await listRes.json()) as {
      servers: Array<{ id: string; name: string; connectorId: string; updatedAt: string; version?: string }>;
    };

    for (const s of servers) {
      const cached = customMcpSchemaByServerId.get(s.id);
      // Short-circuit on the control plane's version string (1b): the list's
      // `version` when it carries one, the bare `updatedAt` from an older
      // control plane. Same string the raw-tools endpoint returns and the
      // entry stores, so an unchanged server keeps its entry and a server
      // whose classifier flag or classification version moved is refetched.
      const listVersion = s.version ?? s.updatedAt;
      if (cached && cached.version === listVersion) {
        nextById.set(s.id, cached);
        continue;
      }
      const toolsUrl = new URL(`${trimmed}/api/internal/custom-mcp-servers/by-id/raw-tools`);
      toolsUrl.searchParams.set('tenantId', tenantId);
      toolsUrl.searchParams.set('id', s.id);
      const toolsRes = await fetch(toolsUrl.toString(), {
        headers: { 'X-Service-Auth': serviceToken, accept: 'application/json' },
      });
      if (!toolsRes.ok) {
        logger.warn('custom_mcp_server_tools_fetch_failed', { serverId: s.id, status: toolsRes.status });
        // Preserve any prior entry so a transient failure doesn't blank the cache.
        if (cached) nextById.set(s.id, cached);
        continue;
      }
      const { tools, version, effectClasses, classifierEnabled } = (await toolsRes.json()) as {
        tools: Array<{ name: string; description?: string; inputSchema: unknown }>;
        version: string;
        /** 1b: the confident effect class per bare tool name. Absent from an
         *  older control plane; empty while its classifier kill is off. */
        effectClasses?: Record<string, string>;
        /** Present from a control plane that states it; absent reads as on. */
        classifierEnabled?: boolean;
      };
      nextById.set(s.id, {
        serverId: s.id,
        tenantId,
        name: s.name,
        // Discovery carries no provenance declarations, so the derivable half
        // is filled here: an argument that names a record looks like one, and
        // an input schema is an input schema whatever discovered it. Without
        // this every vendor-hosted MCP write falls to the heuristic floor —
        // including GitHub's, which is the code-reviewer pilot's own connector.
        // Then the 1b effect class, appended as a DECLARED class when the
        // control plane stored one for the tool.
        functions: tools.map(
          (t): CachedConnectorFunction => withEffectClass(
            withDerivedDeclarations({
              name: t.name,
              description: t.description ?? '',
              inputSchema: coerceInputSchema(t.inputSchema),
              categories: [],
            }),
            effectClasses?.[t.name],
            classifierEnabled !== false,
          ),
        ),
        // Stored as returned — the same string the list carries — and never
        // parsed, so the next tick compares like with like.
        version: version ?? listVersion,
      });
    }
    return { servers: servers.length };
  });

  // A tenant whose list call failed keeps whatever it had. Without this the
  // merged map would drop that tenant's servers entirely, so one tenant's
  // transient 500 would silently strip its tools from every agent it owns.
  const failedTenants = new Set(
    fanout.results.filter((r) => r.error !== undefined).map((r) => r.tenantId),
  );
  if (failedTenants.size > 0) {
    for (const [serverId, entry] of customMcpSchemaByServerId) {
      if (failedTenants.has(entry.tenantId) && !nextById.has(serverId)) {
        nextById.set(serverId, entry);
      }
    }
  }

  customMcpSchemaByServerId = nextById;
  logger.info('custom_mcp_server_schema_cache_refreshed', {
    count: nextById.size,
    tenants: fanout.tenants,
    failedTenants: fanout.failed,
  });
}

// ── Custom API connection schema refresh ─────────────────────────────────
//
// The one piece neither the ordinary connector path nor the custom-MCP path
// gives us for free. `ListTools` is aggregated per connector TYPE with a global
// version hash and reads no database, so a connection whose operations come
// from ONE workspace's OpenAPI document cannot travel through it. This refreshes
// against connector-service's per-instance endpoint instead. Execution is
// unchanged: it still goes through the existing Execute path.

/** The connector type the shared catalog gained. ONE generic type for every
 *  API a workspace connects from a conversation. */
export const CUSTOM_API_CONNECTOR_TYPE = 'custom_api_connector';

async function refreshCustomApiSchemasOnce(): Promise<void> {
  const baseUrl = process.env.CONNECTOR_SERVICE_URL;
  const serviceToken = getManagedSecret('CONNECTOR_SERVICE_TOKEN');
  if (!baseUrl || !serviceToken) {
    // Not configured (tests, a runtime with no connector-service): skip
    // silently, exactly as the custom-MCP refresh does.
    return;
  }
  const trimmed = baseUrl.replace(/\/$/, '');
  const nextById = new Map<string, CustomApiConnectorCacheEntry>();

  const fanout = await forEachTenant('custom-api-schema-cache', async (tenantId) => {
    const listUrl = new URL(`${trimmed}/api/connectors/custom-api`);
    listUrl.searchParams.set('tenantId', tenantId);
    const listRes = await fetch(listUrl.toString(), {
      headers: { 'X-Service-Auth': serviceToken, accept: 'application/json' },
    });
    if (!listRes.ok) throw new Error(`list custom API connections failed: ${listRes.status}`);
    const { connections } = (await listRes.json()) as {
      connections: Array<{ connectorId: string; name: string; version: string; operationCount: number }>;
    };

    for (const c of connections) {
      const cached = customApiSchemaByConnectorId.get(c.connectorId);
      // Short-circuit on the version connector-service returned. Compared,
      // never parsed: a re-registration that replaced the operations changes
      // it and the entry is refetched.
      if (cached && cached.version === c.version) {
        nextById.set(c.connectorId, cached);
        continue;
      }
      const toolsUrl = new URL(`${trimmed}/api/connectors/custom-api/${encodeURIComponent(c.connectorId)}/tools`);
      toolsUrl.searchParams.set('tenantId', tenantId);
      const toolsRes = await fetch(toolsUrl.toString(), {
        headers: { 'X-Service-Auth': serviceToken, accept: 'application/json' },
      });
      if (!toolsRes.ok) {
        logger.warn('custom_api_tools_fetch_failed', { connectorId: c.connectorId, status: toolsRes.status });
        // A transient failure must not blank an entry: an absent tool is not an
        // error anywhere downstream, the model is simply never offered it.
        if (cached) nextById.set(c.connectorId, cached);
        continue;
      }
      const { tools, version } = (await toolsRes.json()) as {
        tools: Array<{ name: string; description?: string; inputSchema: unknown; entityType?: string; categories?: string[] }>;
        version: string;
      };
      nextById.set(c.connectorId, {
        connectorId: c.connectorId,
        tenantId,
        name: c.name,
        functions: tools.map((t): CachedConnectorFunction => ({
          name: t.name,
          description: t.description ?? '',
          inputSchema: coerceInputSchema(t.inputSchema),
          // Carried VERBATIM, and deliberately not through `coerceCategories`.
          // The merged classification holds two vocabularies at once: the
          // effect tokens the HITL gate reads, and the sensitivity names the
          // Sensitive Work settings match LITERALLY out of a tool's categories
          // (`sensitiveWorkMatch`). Filtering to the ToolCategory union would
          // drop the second half, and every one of a connection's operations
          // would match no Sensitive Work category at all — the same blindness
          // a collapsed vendor server had, arriving from a different
          // direction.
          categories: (t.categories ?? []) as ConnectorFunction['categories'],
          entityType: t.entityType || undefined,
          // Connector-service DECLARED these: `spec-codegen`'s seed is the HTTP
          // method's own evidence, merged with the classifier and never made
          // less restrictive. The governance gate trusts a declared read.
          classificationDeclared: true,
        })),
        version,
      });
    }
    return { connections: connections.length };
  });

  const failedTenants = new Set(
    fanout.results.filter((r) => r.error !== undefined).map((r) => r.tenantId),
  );
  if (failedTenants.size > 0) {
    for (const [connectorId, entry] of customApiSchemaByConnectorId) {
      if (failedTenants.has(entry.tenantId) && !nextById.has(connectorId)) {
        nextById.set(connectorId, entry);
      }
    }
  }

  customApiSchemaByConnectorId = nextById;
  logger.info('custom_api_schema_cache_refreshed', {
    count: nextById.size,
    tenants: fanout.tenants,
    failedTenants: fanout.failed,
  });
}

/** The operations one custom API connection serves. Empty for a connection
 *  this runtime has not cached, which reads downstream as "no tools" and never
 *  as an error. */
export function getCustomApiToolSchemas(connectorId: string): ConnectorFunction[] {
  return customApiSchemaByConnectorId.get(connectorId)?.functions ?? [];
}

/**
 * One operation of a custom API connection, addressed the way a DISPATCH
 * addresses it: by the alias the engine sees
 * (`custom-api-connector-<first 8 of the connector uuid, dashes removed>`) and
 * the bare operation name.
 *
 * This is the reader every seam past the model needs, and the reason it cannot
 * be `getToolSchema` is structural: that map is keyed by connector TYPE, and
 * `catalogTypeFor('custom-api-connector-1a2b3c4d')` is `custom_api_connector`,
 * under which nothing is ever stored — a connection's operations come from ONE
 * workspace's OpenAPI document. The lookup would return null, which reads
 * downstream as "this operation declares nothing" rather than "the lookup
 * missed", and the merged classification the whole of Phase 5 exists to
 * produce would reach no gate at all.
 *
 * Scoped to the tenant, exactly as the custom-MCP reader beside it is: the
 * alias carries eight hex characters and two workspaces' connectors can share
 * a prefix, so an unscoped match would judge this call with another
 * workspace's classification.
 */
export function getCustomApiToolSchema(
  tenantId: string,
  alias: string,
  functionName: string,
): CachedConnectorFunction | null {
  return listCustomApiToolSchemasByAlias(tenantId, alias).find((f) => f.name === functionName) ?? null;
}

/**
 * EVERY operation of the connection an alias names, resolved the same way.
 *
 * One resolution rule behind both shapes: a caller with the connector id uses
 * `getCustomApiToolSchemas`, a caller with only the model-facing alias uses
 * this. Two rules would be two chances to disagree about which connection an
 * alias means, and the cross-tenant collision the tenant scope exists for is
 * exactly what a second rule would get wrong.
 */
export function listCustomApiToolSchemasByAlias(
  tenantId: string,
  alias: string,
): CachedConnectorFunction[] {
  const m = /^custom-api-connector-([0-9a-f]{8})$/.exec(alias);
  if (!m) return [];
  const shortId = m[1];
  for (const entry of customApiSchemaByConnectorId.values()) {
    if (entry.tenantId !== tenantId) continue;
    if (!entry.connectorId.replace(/-/g, '').startsWith(shortId)) continue;
    return entry.functions;
  }
  return [];
}

/** Replace the custom API cache for tests. Never called from production. */
export function __setCustomApiSchemaCacheForTests(
  entries: ReadonlyArray<{ connectorId: string; tenantId: string; name: string; functions: CachedConnectorFunction[]; version?: string }>,
): void {
  customApiSchemaByConnectorId = new Map(
    entries.map((e) => [e.connectorId, { ...e, version: e.version ?? 'test' }]),
  );
}

export function getCustomMcpServerToolSchemas(serverId: string): ConnectorFunction[] {
  return customMcpSchemaByServerId.get(serverId)?.functions ?? [];
}

/**
 * The schema for one tool on a customer's own MCP server, addressed the way a
 * dispatch addresses it: by the ALIAS the engine sees (`custom-mcp-<first 8 of
 * the server uuid, dashes removed>`) and the bare tool name.
 *
 * THIS IS THE READER THE CACHE NEVER HAD. Its writer derives `idArgs` for
 * every custom-MCP tool and says, in its own comment, that without this
 * "every vendor-hosted MCP write falls to the heuristic floor — including
 * GitHub's, which is the code-reviewer pilot's own connector". Nothing then
 * read it: the provenance gate looked up declarations by connector TYPE in the
 * catalog map, `catalogTypeFor('custom-mcp-d144a7ea')` is `custom_mcp`, and no
 * catalog entry is keyed that way. So every custom-MCP write fell to the floor
 * anyway, with the declaration that would have judged it sitting one map over.
 *
 * Scoped to the tenant, because the alias is eight hex characters and two
 * tenants' servers can share a prefix; a match on another tenant's server would
 * hand this write someone else's declarations.
 */
export function getCustomMcpToolSchema(
  tenantId: string,
  alias: string,
  functionName: string,
): CachedConnectorFunction | null {
  const m = /^custom-mcp-([0-9a-f]{8})$/.exec(alias);
  if (!m) return null;
  const shortId = m[1];
  for (const entry of customMcpSchemaByServerId.values()) {
    if (entry.tenantId !== tenantId) continue;
    if (!entry.serverId.replace(/-/g, '').startsWith(shortId)) continue;
    return entry.functions.find((f) => f.name === functionName) ?? null;
  }
  return null;
}

/** Test seam: seed the custom-MCP map directly. The refresh path needs a
 *  control plane to talk to; the resolver above needs only the map. */
export function _seedCustomMcpServerSchemasForTesting(
  entries: ReadonlyArray<{ serverId: string; tenantId: string; name: string; functions: CachedConnectorFunction[]; version?: string }>,
): void {
  customMcpSchemaByServerId = new Map(entries.map((e) => [e.serverId, { ...e, version: e.version ?? 'test' }]));
}

/** Test seam: run one custom-MCP refresh tick against a fetch the test
 *  controls, so the version short-circuit and the 1b mapping can be seen
 *  without a control plane. */
export async function _refreshCustomMcpServerSchemasOnceForTesting(): Promise<void> {
  await refreshCustomMcpServerSchemasOnce();
}

export function listCustomMcpServerCacheEntries(): CustomMcpServerCacheEntry[] {
  return Array.from(customMcpSchemaByServerId.values());
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Seed the cache from the connector-service and start the 5-minute refresh
 * loop. Call once from src/index.ts before any agent is scheduled. On
 * failure, logs a warn and leaves the cache empty; subsequent refreshes
 * retry until a successful seed.
 */
export async function initToolSchemaCache(): Promise<void> {
  if (seeded) return;
  seeded = true;
  try {
    const result = await fetchToolSets('');
    installToolSets(result.toolSets);
    cachedVersion = result.version;
    logger.info('tool_schema_cache_seeded', {
      version: cachedVersion,
      connector_types: schemaByConnectorType.size,
    });
  } catch (err) {
    logger.warn('tool_schema_cache_seed_failed', {
      err: (err as Error).message,
    });
  }
  // Always start the refresh loop so a failed seed self-heals.
  if (refreshTimer === null) {
    refreshTimer = setInterval(() => {
      void refreshOnce();
    }, REFRESH_INTERVAL_MS);
    // Don't let the timer keep the process alive.
    if (typeof refreshTimer.unref === 'function') refreshTimer.unref();
  }
}

/**
 * Stop the refresh timer. Test-only — production never calls this.
 */
export function stopToolSchemaCache(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  seeded = false;
}

/**
 * Replace the cache contents for tests. Never call this from production code.
 */
export function __setToolSchemaCacheForTests(
  entries: Array<{ connectorType: string; displayName?: string; functions: ConnectorFunction[] }>,
  version: string = 'test',
): void {
  installToolSets(
    entries.map((e) => ({
      connectorType: e.connectorType,
      displayName: e.displayName ?? e.connectorType,
      functions: e.functions,
    })),
  );
  cachedVersion = version;
  seeded = true;
}

/**
 * Reset the cache back to the empty, unseeded state. Test-only.
 */
export function __clearToolSchemaCacheForTests(): void {
  schemaByConnectorType = new Map();
  displayNameByConnectorType = new Map();
  cachedVersion = '';
  seeded = false;
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

/**
 * Return every connector function for a given connectorType. Returns an
 * empty array for unknown types or before the cache is seeded.
 */
export function getToolSchemas(connectorType: string): ConnectorFunction[] {
  return schemaByConnectorType.get(connectorType) ?? [];
}

/**
 * Look up a single tool definition by connectorType + function name.
 */
/** A connector INSTANCE alias is `<type>-<first 8 of the connector uuid>`. */
const INSTANCE_SUFFIX = /-[0-9a-f]{8}$/;

/**
 * The CATALOG key for a connector reference, whatever form it arrives in.
 *
 * `google_mail-0105297e` and `google_mail` both key `google_mail`. Note what
 * this does NOT do: it does not turn underscores into hyphens.
 *
 * That is the whole reason it exists rather than reusing
 * `connectorTypeFromAlias`. That function normalises into the ACTION LEDGER's
 * namespace, where `target_ref` is hyphen-separated by convention, so it maps
 * `google_mail` to `google-mail` on purpose. This map is keyed on whatever
 * connector-service calls the connector, which is `google_mail` with the
 * underscore. Feeding one namespace's key into the other's map is not an
 * error — `Map.get` returns undefined, the caller reads it as "this tool
 * declares nothing", and every underscore-typed connector silently drops out
 * while `slack` and `github` keep working because they have no underscore.
 *
 * Lives here, beside the Map it has to agree with, so the two cannot drift
 * into different files and different assumptions.
 */
/**
 * The capability a connector type provides, for tri-state refusal.
 *
 * Resolved from the connector TYPE rather than the tool name: a capability is
 * a property of the connector, and every tool it exposes inherits it. Deriving
 * it per tool would invite a tool-name heuristic, which is how a read ends up
 * classified as a write elsewhere in this estate.
 *
 * Returns null for a type nothing maps, which is the honest answer: the gate
 * refuses only what it can positively identify as belonging to an absent
 * capability, never what it merely fails to recognise.
 */
const TYPE_TO_CAPABILITY: Readonly<Record<string, string>> = Object.freeze({
  slack: 'team_chat',
  microsoft_teams: 'team_chat',
  google_mail: 'email_communication',
  microsoft_outlook_mail: 'email_communication',
  github: 'version_control',
  gitlab: 'version_control',
  google_docs: 'documents',
  google_drive: 'cloud_storage',
  microsoft_onedrive: 'cloud_storage',
  dropbox: 'cloud_storage',
  box: 'cloud_storage',
  google_sheets: 'data_table',
  salesforce: 'crm',
  hubspot: 'crm',
  zendesk: 'ticketing',
  linear: 'ticketing',
  atlassian_jira: 'ticketing',
});

export function capabilityForToolName(connectorType: string, _toolName: string): string | null {
  return TYPE_TO_CAPABILITY[connectorType] ?? null;
}

/** What `catalogTypeFor` answers for a customer's own MCP server alias
 *  (`custom-mcp-<8 hex>`): a type no catalog entry is keyed by. The resolver
 *  that receives it looks the tool up in the tenant-scoped custom-MCP cache
 *  instead (getCustomMcpToolSchema). */
export const CUSTOM_MCP_CATALOG_TYPE = 'custom_mcp';

export function catalogTypeFor(connector: string): string {
  const raw = (connector ?? '').trim();
  if (!raw) return '';
  if (raw.startsWith('__builtin:')) return raw;
  // Separator normalised, not just the instance suffix stripped.
  //
  // This cache is keyed on the CANONICAL connector type, and every entry in
  // CONNECTOR_TYPES spells one with underscores — `google_docs`, `google_mail`,
  // `microsoft_teams`, `atlassian_jira`, `cal_com`. A tenant's instance alias
  // spells the same type with hyphens (`google-docs-8fd9fc68`), so stripping
  // `-8fd9fc68` alone yields `google-docs`, which is not a key.
  //
  // The miss is silent by construction: `getToolSchema` returns null, the
  // caller reads that as "this tool declares nothing", and a lookup that could
  // not find its row is indistinguishable from a row that says nothing. Every
  // underscored type in the estate lost its provenance declaration that way
  // whenever the caller had an alias rather than a type, which is most of them.
  //
  // Safe in the other direction because no canonical type contains a hyphen: a
  // name that is already underscored passes through, and an alias nobody
  // registered misses either way.
  return raw.toLowerCase().replace(INSTANCE_SUFFIX, '').replace(/-/g, '_');
}

export function getToolSchema(
  connectorType: string,
  functionName: string,
): ConnectorFunction | null {
  const fns = schemaByConnectorType.get(connectorType);
  if (!fns) return null;
  return fns.find((f) => f.name === functionName) ?? null;
}

/**
 * Return every connector type the cache knows about.
 */
export function listConnectorTypes(): string[] {
  return Array.from(schemaByConnectorType.keys());
}

/**
 * Return every tool set the cache knows about (shape mirrors ListTools).
 */
export function listAllToolSchemas(): ConnectorToolSet[] {
  const out: ConnectorToolSet[] = [];
  for (const [connectorType, functions] of schemaByConnectorType) {
    out.push({
      connectorType,
      displayName: displayNameByConnectorType.get(connectorType) ?? connectorType,
      functions,
    });
  }
  return out;
}

/**
 * Resolve the API-native entity type for a connector function (used by the
 * agent executor when mapping tool calls into ExecuteRequests). Mirrors the
 * old connector-functions-registry.resolveEntityType() algorithm so call
 * sites don't need to change behaviour.
 */
export function resolveEntityType(
  connectorAlias: string,
  functionName: string,
): string {
  const candidates = [
    connectorAlias,
    connectorAlias.replace(/-/g, '_'),
    `google_${connectorAlias}`,
    `microsoft_${connectorAlias.replace(/-/g, '_')}`,
  ];
  for (const key of candidates) {
    const fns = schemaByConnectorType.get(key);
    if (!fns) continue;
    const match = fns.find((f) => f.name === functionName);
    if (match) return match.entityType || functionName;
  }
  return functionName;
}

/**
 * True if the cache has been seeded successfully at least once.
 */
export function isToolSchemaCacheSeeded(): boolean {
  return seeded;
}
