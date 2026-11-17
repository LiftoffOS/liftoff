// Runtime -> control-plane agent id translation for the control plane.
//
// The mapping between the Tenant Runtime's `agents.id` and this service's
// `internal_agents.id` lives ONLY in the runtime's database
// (`internal_agent_runtime_mapping`). The control plane has no local copy, so
// anything here that receives a runtime-space id must ask the runtime to
// translate it. See INV-PB-009.
//
// Preferred fix is always to have the producer emit the internal id (the three
// cost seams now do). This module exists for producers we do not control — the
// governance engine records whichever id the tool-gateway handed it, which is
// the internal id on the governed path but falls back to the runtime id for
// agents that were unmapped at call time.
//
// Translation here is **identity-preserving**: an id that is not a known
// runtime id passes through untouched. That makes it safe to apply to a mixed
// feed and idempotent to re-apply.

import { fetchWithOidc } from '../infrastructure/oidc-fetch';
import { resolveRuntimeBaseUrl } from '../connectors/tenant-runtime-url';
import { log } from '../infrastructure/logging';

export interface AgentIdMapping {
  internalAgentId: string;
  runtimeAgentId: string;
  name?: string | null;
  role?: string | null;
  lifecycle?: string | null;
}

/** runtimeAgentId -> internalAgentId */
export type RuntimeToInternalMap = ReadonlyMap<string, string>;

const EMPTY: RuntimeToInternalMap = new Map();

interface CacheEntry {
  map: RuntimeToInternalMap;
  expiresAt: number;
}

// Mappings are minted once at provisioning and never change, so a short TTL is
// only about picking up newly-provisioned agents, not about invalidation.
const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

/**
 * Raw mapping list for a tenant, straight from the runtime. Returns null when
 * the runtime cannot be reached — callers must treat null as "unknown", never
 * as "no mappings", or they will conclude every id is untranslatable.
 */
export async function fetchAgentIdMappings(
  tenantId: string,
  runtimeUrl: string,
): Promise<AgentIdMapping[] | null> {
  try {
    const r = await fetchWithOidc(
      `${runtimeUrl}/internal/agents/list-mappings?tenantId=${encodeURIComponent(tenantId)}`,
      { timeoutMs: 30_000 },
    );
    if (!r.ok) {
      log.warn({ tenantId, status: r.status }, 'agent-id-map: list-mappings returned non-2xx');
      return null;
    }
    return (await r.json()) as AgentIdMapping[];
  } catch (err) {
    log.warn({ tenantId, err: (err as Error).message }, 'agent-id-map: list-mappings call failed');
    return null;
  }
}

/**
 * Cached runtime -> internal lookup for a tenant. On failure returns an empty
 * map, which makes {@link toInternalAgentId} a pass-through — degrading to
 * today's behaviour rather than dropping or mis-keying data.
 *
 * Resolves the runtime URL itself via `resolveRuntimeBaseUrl`, which falls back
 * to the TENANT_RUNTIME_URL env when `tenants.runtime_url` is null — that column
 * can be NULL for every tenant in an environment, so a caller passing it
 * directly would get an empty map and silently translate nothing.
 */
export async function getRuntimeToInternalMap(
  tenantId: string,
): Promise<RuntimeToInternalMap> {
  let runtimeUrl: string;
  try {
    runtimeUrl = await resolveRuntimeBaseUrl(tenantId);
  } catch (err) {
    log.warn({ tenantId, err: (err as Error).message }, 'agent-id-map: could not resolve runtime URL');
    return cache.get(tenantId)?.map ?? EMPTY;
  }

  const now = Date.now();
  const hit = cache.get(tenantId);
  if (hit && hit.expiresAt > now) return hit.map;

  const rows = await fetchAgentIdMappings(tenantId, runtimeUrl);
  if (!rows) {
    // Serve a stale entry rather than losing translation during a blip.
    return hit?.map ?? EMPTY;
  }

  const map = new Map<string, string>();
  for (const row of rows) {
    if (row.runtimeAgentId && row.internalAgentId) {
      map.set(row.runtimeAgentId, row.internalAgentId);
    }
  }
  cache.set(tenantId, { map, expiresAt: now + TTL_MS });
  return map;
}

/**
 * Translate a possibly-runtime-space id into the control-plane space.
 * Identity for ids that are already internal (or unknown), so this is safe on a
 * mixed feed and idempotent.
 */
/**
 * How the tenant runtime spells "no agent".
 *
 * Its `agents` column is NOT NULL, so a platform assistant's session — which
 * genuinely has no agent behind it — travels as the nil UUID. Mirrors
 * NO_AGENT_SENTINEL in the tenant runtime's browser-sessions/types.ts.
 */
export const NO_AGENT_SENTINEL = '00000000-0000-0000-0000-000000000000';

export function toInternalAgentId(
  map: RuntimeToInternalMap,
  agentId: string | null | undefined,
): string | null {
  if (!agentId) return null;
  // The sentinel is NOT an agent id, so it must never reach a column that
  // means "which agent did this". Handled HERE rather than at each call
  // site, because it was handled at one of them: the web-tool spend
  // subscriber converted it and the backstop ingester
  // (cost-attribution/ingestion/usage-ledger-ingester.ts) did not, so the
  // same browser session booked a real agent id down the fast path and the
  // nil UUID down the replay path. It reaches the cost report as an agent
  // the workspace does not have, holding the assistants' spend — which is
  // exactly what the subscriber's own comment says it is there to prevent.
  // One translator, one rule, and a second call site cannot miss it.
  if (agentId === NO_AGENT_SENTINEL) return null;
  return map.get(agentId) ?? agentId;
}

/** Test seam — clears the per-tenant TTL cache. */
export function __resetAgentIdMapCache(): void {
  cache.clear();
}
