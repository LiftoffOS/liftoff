// Enumerates a vendor-hosted MCP server's tools into the adapter tool catalog.
//
// The bridge already DISPATCHES remote MCP tools (mcp-client-pool opens a
// StreamableHTTPClientTransport for kind:'remote' servers). What was missing was
// ENUMERATION: vendor-hosted MCP tools (GitHub/Notion/Stripe, custom MCP) only
// landed in catalog.servers, never catalog.tools — so OpenAI registered them on
// the SDK-native MCP path (no recovery, no per-tool HITL gate) and Gemini, which
// only reads catalog.tools, never saw them at all.
//
// This helper runs a live, PAGINATED `tools/list` over @liftoffos/runtime-mcp-transports
// (the same transport stack as binding-probe.ts — NOT the bridge's
// @modelcontextprotocol/sdk pool) and maps each tool into an McpToolDefinition
// for catalog.tools:
//   - `name`           — NAMESPACED `<serverAlias>__<tool>` (composeToolName,
//                        matching the connector/external alias convention) so a
//                        vendor `search` never collides with the in-process one.
//   - `remoteToolName` — the BARE vendor name the server dispatches on; the
//                        bridge sends this on the wire (see dispatchFunctionCall).
//   - `serverId`       — links to the kind:'remote' catalog.servers entry so
//                        dispatchFunctionCall routes through the HTTP transport.
//   - `categories` / destructive marker — from classifyVendorMcpTool so
//                        category-based HITL reaches vendor MCP.
//
// One enumeration path serves BOTH vendor-MCP branches (vendor-hosted OAuth
// Bearer and custom_mcp custom headers) — both reduce upstream to a
// RemoteMcpServerConfig with `headers`, so resolveVendorMcpServers no longer
// needs its own log-only probe (the observability log moved here).
//
// Failure semantics: a probe failure falls back to the last list this server
// answered with (cached_vendor_mcp_tools, migration 377), and only degrades to
// `[]` when it has never answered. Auth failures are logged distinctly (token
// rotation/expiry is resolved upstream by connector-service, not here).
//
// `[]` was the whole story until this list became load-bearing for VALIDATION.
// For the model's catalog it is right — one flaky connector should not kill a
// run. For graph validation it turns "I could not ask" into "those tools do not
// exist", and the run then dies blaming the workflow for naming a real tool on
// a server it is bound to. GitHub's own HTTP 500 and 502 responses do this.
// A vendor's tool surface changes on the order of months; a bad minute lasts a
// minute, so the stored answer is very nearly always the true one.
//
// Caching: the raw vendor tool list is cached by (url, headers-hash) for a short
// TTL (mirrors the SDK's native cacheToolsList) so the per-invocation
// enumeration is not a fresh round-trip every time. Keying on the header hash
// means a token rotation naturally invalidates, and different tenants/tokens
// stay isolated.

import { createHash } from 'crypto';
import { createTransportSync } from '../../tool-gateway/transports';
import { composeToolName } from '../tool-name-sanitizer';
import { logger } from '../../infrastructure/logging';
import type { McpToolDefinition, RemoteMcpServerConfig } from './catalog-types';
import { classifyVendorMcpTool, vendorTypeFromServerId } from './vendor-mcp-classify';
import { storeVendorToolList, loadVendorToolList } from './vendor-mcp-tool-store';
import { classifyVendorToolEffect, effectFromMcpAnnotations, nameHasMutatingVerb, type McpToolAnnotations } from '../../tool-gateway/tool-effect';
import { fetchToolClassifications } from '../../clients/platform-backend-client';

/** Shape of a single entry in an MCP `tools/list` response. */
export interface VendorMcpToolListEntry {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  /** What the SERVER says the tool does. Standard since MCP 2025-03-26 and
   *  modelled by the SDK. This was absent from the type, so the field arrived
   *  over the wire on every tools/list response and nothing ever read it —
   *  while the code below guessed at what it already stated. */
  annotations?: McpToolAnnotations;
}

const ENUMERATE_TIMEOUT_MS = 10_000;
const TOOL_LIST_CACHE_TTL_MS = 5 * 60_000; // 5 min — mirrors native cacheToolsList
const MAX_TOOL_LIST_PAGES = 50;            // pagination safety stop (50 * page size)

interface ToolListCacheEntry { entries: VendorMcpToolListEntry[]; expiresAt: number; }
const toolListCache = new Map<string, ToolListCacheEntry>();

/** Test seam — drop the cached tool lists. */
export function clearVendorMcpToolListCache(): void {
  toolListCache.clear();
}

// ── A priori classification seeds ────────────────────────────────────────
//
// Composio-managed tools carry categories from the overlay; a vendor-hosted
// server's tools are discovered live and, until now, classified only by the
// server's annotations and the verb heuristics below. The seeds are the global
// rows platform-backend holds per connector type, written from each vendor's
// public tool inventory before the first customer connects, and they are
// consulted BEFORE the heuristic path: a seeded tool takes its categories and
// effect from the seed, and the annotation / name path is skipped for it.
//
// Cached per connector type for ten minutes. A seed lookup never throws (the
// client returns no seeds on any failure), so a platform-backend outage only
// means every tool takes the heuristic path — which is what it always did.

const SEED_CACHE_TTL_MS = 10 * 60_000;

/** Seeds for one connector type, keyed by bare vendor tool name (or
 *  `<tool>:<operation>` on a meta-tool server). */
export interface SeededClassifications {
  byName: Map<string, string[]>;
  operationKey: { tool: string; arg: string } | null;
}

interface SeedCacheEntry { seeds: SeededClassifications; expiresAt: number; }
const seedCache = new Map<string, SeedCacheEntry>();

/** Test seam — drop the cached seeds and the unseeded-tool report set. */
export function _clearSeededClassificationCache(): void {
  seedCache.clear();
  UNSEEDED_REPORTED.clear();
}

export async function getSeededClassifications(connectorType: string): Promise<SeededClassifications> {
  const cached = seedCache.get(connectorType);
  if (cached && cached.expiresAt > Date.now()) return cached.seeds;
  const fetched = await fetchToolClassifications(connectorType);
  const seeds: SeededClassifications = {
    byName: new Map(fetched.tools.map((t) => [t.name, t.categories])),
    operationKey: fetched.operationKey,
  };
  seedCache.set(connectorType, { seeds, expiresAt: Date.now() + SEED_CACHE_TTL_MS });
  return seeds;
}

/** The effect tokens a seed row may carry. A row written from a harvested
 *  inventory carries them; the older vendor seeds (migrations 084 / 305:
 *  github, gitlab, stripe, hubspot) predate them and carry sensitivity
 *  categories only. */
const EFFECT_TOKENS = new Set(['write', 'destructive', 'outbound']);

/** The effect a seed's categories state.
 *
 *  A seed that carries an effect token states it outright. A seed that
 *  carries only sensitivity categories is a write when it has any — the
 *  classifier that wrote those rows returns an empty array for a read and
 *  nothing else — and a read when it has none. */
function effectOfSeed(categories: string[]): 'read' | 'write' {
  if (categories.some((c) => EFFECT_TOKENS.has(c))) return 'write';
  return categories.length > 0 ? 'write' : 'read';
}

/** Unseeded tools already reported by this process, keyed by connector type,
 *  tool and description hash. The line exists so a seed can be completed from
 *  what the vendor actually served; one line per distinct tool says that, and
 *  repeating it on every invocation of every agent bound to the server says
 *  nothing more while burying the rest of the log. A new description hash is
 *  a new line — the tool changed and the seed may need to follow. */
const UNSEEDED_REPORTED = new Set<string>();

/** Whether the seed's vocabulary can state destructiveness at all. A row
 *  with no effect token cannot say "not destructive" — it never had the
 *  word — so for those rows the name heuristic keeps the DESTRUCTIVE marker
 *  it would have set anyway: a seed is never weaker than the heuristic it
 *  replaces, which is the rule the classifier enforces when it writes one. */
function seedStatesEffect(categories: string[]): boolean {
  return categories.some((c) => EFFECT_TOKENS.has(c));
}

function cacheKeyFor(url: string, headers: Record<string, string>): string {
  // Hash the headers (which carry the Bearer/custom auth) so the secret never
  // lands in the key and rotation produces a fresh key (cache miss → re-fetch).
  const headerHash = createHash('sha256')
    .update(JSON.stringify(Object.entries(headers ?? {}).sort()))
    .digest('hex');
  return `${url} ${headerHash}`;
}

function isAuthFailure(message: string): boolean {
  return /\b401\b|\b403\b|unauthor|forbidden|invalid[_ ]?token|token.*expired|expired.*token/i.test(message);
}

/**
 * Fetch a vendor server's FULL tool list via a paginated `tools/list`, cached by
 * (url, headers-hash). Returns the RAW (vendor-neutral) entries — the per-server
 * namespacing + classification happens in the caller, so two integrations
 * pointing at the same URL but with different serverIds reuse the cached list.
 * Throws on transport/auth failure; callers degrade.
 */
export async function fetchVendorToolList(
  url: string,
  headers: Record<string, string>,
  transport: RemoteMcpServerConfig['transport'],
): Promise<VendorMcpToolListEntry[]> {
  const key = cacheKeyFor(url, headers);
  const cached = toolListCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.entries;

  // createTransportSync accepts 'streamable-http' | 'sse'. RemoteMcpServerConfig
  // carries 'http' | 'streamable-http' | 'sse' | 'stdio'; everything non-sse
  // (incl. plain 'http') maps to streamable-http — stdio never reaches a remote
  // vendor entry (resolveVendorMcpServers only emits http/sse).
  const transportType = transport === 'sse' ? 'sse' : 'streamable-http';
  const probe = createTransportSync(transportType, {
    endpointUrl: url,
    authType: 'custom_headers',
    customHeaders: Object.entries(headers ?? {}).map(([k, v]) => ({ key: k, value: v })),
    timeout: ENUMERATE_TIMEOUT_MS,
  });
  try {
    await probe.connect();
    const entries: VendorMcpToolListEntry[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_LIST_PAGES; page++) {
      const result = await probe.request<{ tools?: VendorMcpToolListEntry[]; nextCursor?: string }>(
        'tools/list',
        cursor ? { cursor } : {},
      );
      if (result.tools?.length) entries.push(...result.tools);
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    toolListCache.set(key, { entries, expiresAt: Date.now() + TOOL_LIST_CACHE_TTL_MS });
    return entries;
  } finally {
    probe.close();
  }
}

/**
 * Enumerate one remote vendor MCP server's tools into McpToolDefinitions.
 * Returns `[]` on any failure (degrade, never throw) so the catalog builder can
 * fold the result in unconditionally.
 */
export async function enumerateVendorMcpTools(
  server: RemoteMcpServerConfig,
  opts?: { tenantId?: string },
): Promise<McpToolDefinition[]> {
  // Set when the live probe failed and the entries below came from the store.
  let staleFrom: Date | undefined;
  try {
    const entries = await (async (): Promise<VendorMcpToolListEntry[]> => {
      try {
        const live = await fetchVendorToolList(server.url, server.headers ?? {}, server.transport);
        // Write through on the way past. Cheap, and it is the only moment this
        // process knows something worth remembering.
        if (opts?.tenantId) void storeVendorToolList(opts.tenantId, server.id, live);
        return live;
      } catch (probeErr) {
        // "I could not ask" is not "the tools are not there", and until now the
        // two produced the same answer: an empty list, which graph validation
        // reads as a workflow naming tools that do not exist. A vendor's tool
        // surface changes on the order of months and a bad minute lasts a
        // minute, so last-known-good is very nearly always the true answer.
        const stored = opts?.tenantId
          ? await loadVendorToolList(opts.tenantId, server.id)
          : null;
        if (!stored) throw probeErr;
        staleFrom = stored.fetchedAt;
        logger.warn(
          {
            serverId: server.id,
            tenantId: opts?.tenantId,
            err: (probeErr as Error).message,
            lastAnsweredAt: stored.fetchedAt,
            toolCount: stored.tools.length,
          },
          'vendor_mcp_tool_list_served_stale',
        );
        return stored.tools;
      }
    })();
    const connectorType = vendorTypeFromServerId(server.id);
    const seeds = await getSeededClassifications(connectorType);
    const tools = entries.map((t) => {
      const baseDescription = t.description ?? '';

      // A seeded tool is classified by the seed. The one thing the name
      // heuristic still contributes is the DESTRUCTIVE marker on a row whose
      // vocabulary predates effect tokens (see seedStatesEffect).
      const seed = seeds.byName.get(t.name);
      if (seed) {
        const destructive = seed.includes('destructive')
          || (!seedStatesEffect(seed) && seed.length > 0 && classifyVendorMcpTool(server.id, t.name).destructive);
        return {
          name: composeToolName(server.id, t.name),
          description: destructive ? `⚠️ DESTRUCTIVE: ${baseDescription}` : baseDescription,
          inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
          serverId: server.id,
          remoteToolName: t.name,
          categories: seed,
          effect: effectOfSeed(seed),
        };
      }

      // The meta-tool of a code-mode server: its own name says nothing, the
      // operation argument does. Carry the per-operation seeds so the gate can
      // resolve each call; the tool itself is the write class, fail closed.
      if (seeds.operationKey && t.name === seeds.operationKey.tool) {
        const prefix = `${seeds.operationKey.tool}:`;
        const byOperation: Record<string, string[]> = {};
        for (const [key, categories] of seeds.byName) {
          if (key.startsWith(prefix)) byOperation[key.slice(prefix.length)] = categories;
        }
        return {
          name: composeToolName(server.id, t.name),
          description: baseDescription,
          inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
          serverId: server.id,
          remoteToolName: t.name,
          categories: [],
          effect: 'write' as const,
          operationClassifications: { arg: seeds.operationKey.arg, byOperation },
        };
      }

      // Unseeded: the heuristic path, unchanged. Logged so the seed can be
      // completed from what the vendor actually served (names + a hash of the
      // description, never the description itself).
      const descriptionHash = createHash('sha256').update(baseDescription).digest('hex').slice(0, 12);
      const unseededKey = `${connectorType}:${t.name}:${descriptionHash}`;
      if (!UNSEEDED_REPORTED.has(unseededKey)) {
        UNSEEDED_REPORTED.add(unseededKey);
        logger.info({ connectorType, tool: t.name, descriptionHash }, 'vendor_mcp_tool_unseeded');
      }

      // Classify so category-based HITL (sensitive-work / level-2 destructive)
      // reaches vendor MCP tools the way it reaches in-process connector tools.
      // Destructive tools get the same `⚠️ DESTRUCTIVE` description marker the
      // in-process path uses (mcp-server.ts) so the level-2 gate + isLowRiskTool
      // see it.
      const classification = classifyVendorMcpTool(server.id, t.name);

      // What the SERVER declared, preferred over what its name suggests.
      //
      // Deriving safety from the tool's name means an ordinary read-only tool
      // gates on every call when its author picked a word our verb list does
      // not know: `search_docs` passes, `lookup_article` / `query_docs` /
      // `find_answer` all gate, for identical behaviour. That is a tax on every
      // custom MCP server anyone connects, paid in approval cards a person
      // cannot meaningfully answer.
      //
      // MCP has published this since the 2025-03-26 revision. The field was
      // arriving on every tools/list response and being dropped at the type
      // boundary.
      //
      // effectFromMcpAnnotations is asymmetric on purpose — the spec is explicit
      // that annotations are hints, not a security boundary for an untrusted
      // server. `destructiveHint` is always honoured because it only adds
      // caution; `readOnlyHint` is honoured only when the name shows NO explicit
      // mutating-verb evidence, so a server cannot declare `charge_card` /
      // `publish_post` / `delete_x` read-only and buy its way out of the gate.
      // The evidence is a recognized MUTATING VERB (`nameHasMutatingVerb`), NOT
      // the sensitivity categories: those come from domain NOUNS, so a
      // category-count test both MISSES a recognized write with no sensitivity
      // tag (`approve_request`/`enable_feature`/`upload_file`) and WRONGLY blocks
      // the hint on a read named in a sensitive domain (`lookup_invoice`/
      // `query_candidate`). A read-verb name and a genuinely unknown verb
      // (`query_docs`) carry no mutating verb, so the hint that confirms/rescues a
      // read is still honoured. Silence falls through to today's behaviour.
      const declared = effectFromMcpAnnotations(t.annotations, {
        nameLooksMutating: nameHasMutatingVerb(t.name),
      });
      const destructive = classification.destructive || t.annotations?.destructiveHint === true;
      const categories = destructive
        ? [...new Set([...classification.categories, 'destructive', 'dataChanges'])]
        : classification.categories;

      return {
        name: composeToolName(server.id, t.name),
        description: destructive ? `⚠️ DESTRUCTIVE: ${baseDescription}` : baseDescription,
        inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
        serverId: server.id,
        remoteToolName: t.name,
        categories,
        // Declared beats derived; a missing effect still gates, fail closed.
        effect: declared ?? classifyVendorToolEffect(t.name),
      };
    });
    // Operator observability — the only `tools/list` log for vendor MCP now that
    // resolveVendorMcpServers no longer probes. Operators can search by tenant +
    // server to see the exact tool surface the LLM had at invocation time.
    // Argument names alongside the tool names. The surface an operator needs to
    // reason about is not "which tools existed" but "what did they take" — a
    // workflow step or a host-agnostic adapter is written against the ARGUMENTS,
    // and this is a vendor-defined surface that can change without our
    // involvement. Names alone sent one round of adapter work off a guess.
    //
    // Property names only, never the schema: bounded output, and a vendor
    // description can be long and is not what anyone is searching for.
    const toolArgs: Record<string, string[]> = {};
    for (const t of entries) {
      const schema = (t.inputSchema ?? {}) as { properties?: Record<string, unknown>; required?: string[] };
      const props = Object.keys(schema.properties ?? {});
      if (props.length === 0) continue;
      const required = new Set(schema.required ?? []);
      // Required first and marked, because that is the part an adapter must
      // satisfy; the rest is optional detail.
      const properties = (schema.properties ?? {}) as Record<string, { enum?: unknown[] }>;
      toolArgs[t.name] = props
        .sort((a, b) => Number(required.has(b)) - Number(required.has(a)) || a.localeCompare(b))
        .map((p) => {
          const marked = required.has(p) ? `${p}*` : p;
          // A closed value set is the other half of "what does this take".
          // GitHub's pull_request_read is one tool serving several operations
          // behind a required `method`, so the argument NAME alone says nothing
          // about which operations exist — and anything mapping onto it has to
          // know. Bounded to short enums so a long free-form list cannot bloat
          // the line.
          const values = properties[p]?.enum;
          if (!Array.isArray(values) || values.length === 0 || values.length > 12) return marked;
          return `${marked}=${values.map(String).join('|')}`;
        });
    }
    logger.info(
      {
        serverId: server.id,
        tenantId: opts?.tenantId,
        url: server.url,
        toolCount: tools.length,
        // Present only when the live probe failed and this list came from the
        // store. An operator reading a surprising catalog needs to know it is
        // an answer from the past, not from the server just now.
        ...(staleFrom ? { servedStaleFrom: staleFrom } : {}),
        toolNames: entries.map((t) => t.name),
        toolArgs,
      },
      'vendor_mcp_tools_enumerated',
    );
    return tools;
  } catch (err) {
    const message = (err as Error).message;
    logger.warn(
      { serverId: server.id, tenantId: opts?.tenantId, url: server.url, err: message },
      isAuthFailure(message) ? 'vendor_mcp_enumerate_auth_failed' : 'vendor_mcp_enumerate_failed',
    );
    return [];
  }
}

/**
 * Enumerate every remote server in a catalog and merge the results into the
 * existing in-process tool list with FIRST-WINS dedup on the namespaced name
 * (in-process tools are passed in first, so they win any rare collision). Each
 * collision is logged. Returns the combined tool list; the catalog builder
 * assigns it back to `catalog.tools`.
 */
export async function enumerateAndMergeVendorMcpTools(
  inProcessTools: McpToolDefinition[],
  remoteServers: RemoteMcpServerConfig[],
  opts?: { tenantId?: string },
): Promise<McpToolDefinition[]> {
  const merged = [...inProcessTools];
  const registeredNames = new Set(merged.map((t) => t.name));
  for (const server of remoteServers) {
    const vendorTools = await enumerateVendorMcpTools(server, opts);
    for (const vt of vendorTools) {
      if (registeredNames.has(vt.name)) {
        logger.warn(
          { toolName: vt.name, serverId: server.id },
          'vendor_mcp_tool_name_collision_skipped',
        );
        continue;
      }
      registeredNames.add(vt.name);
      merged.push(vt);
    }
  }
  return merged;
}
