// The gateway resolves the capability tri-state ITSELF.
//
// It could have been a field on ExecuteInput, and it was — which is exactly why
// it never fired. `ExecuteInput` is built at a dozen separate call sites in
// mcp-server.ts alone (connector tools, agent_slack, agent_teams,
// execution_environment, the batch path, the sandbox bridge), each one an
// explicit field-by-field literal. A guard whose input every one of those has
// to remember is a guard the next one silently opts out of, and the opt-out
// looks like ordinary code.
//
// So the map is read here, from the stored instruction, keyed by the identity
// every ExecuteInput already carries. A dispatch path added tomorrow inherits
// the refusal instead of having to ask for it.
//
// Cached because the alternative is a database read per tool call, and the
// value is immutable for a (tenant, agent, instructionVersion) triple: a new
// instruction version is a new row, so a stale entry cannot outlive the thing
// it describes. The cache is bounded and short-lived anyway, since a runtime
// serves a handful of agents at a time.

import { getPoolForService } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';

export type CapabilityState = 'live' | 'unwired' | 'absent';

interface CacheEntry {
  states: Record<string, CapabilityState>;
  at: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 500;
const cache = new Map<string, CacheEntry>();

function key(tenantId: string, agentId: string, version: number): string {
  return `${tenantId}:${agentId}:${version}`;
}

/**
 * The capability states for a compiled instruction.
 *
 * Returns `{}` on ANY failure — a missing row, a database blip, a version that
 * predates the column. That direction is deliberate and is the only safe one: an
 * empty map refuses nothing, so a lookup that cannot answer lets the call
 * through. Failing closed would turn a transient database error into an agent
 * that suddenly claims its tools do not exist, which is a far worse outcome
 * than a refusal that arrives a few minutes late.
 */
export async function capabilityStatesFor(
  tenantId: string,
  agentId: string,
  instructionVersion: number,
): Promise<Record<string, CapabilityState>> {
  const k = key(tenantId, agentId, instructionVersion);
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.states;

  try {
    const pool = getPoolForService('tool-gateway');
    const res = await pool.query(
      `SELECT capability_states FROM compiled_instructions
        WHERE tenant_id = $1 AND agent_id = $2 AND version = $3
        LIMIT 1`,
      [tenantId, agentId, instructionVersion],
    );
    const raw = res.rows[0]?.capability_states;
    const states = (raw && typeof raw === 'object' ? raw : {}) as Record<string, CapabilityState>;
    if (cache.size >= MAX_ENTRIES) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(k, { states, at: Date.now() });
    return states;
  } catch (err) {
    logger.warn({
      event: 'capability_states_lookup_failed',
      tenantId,
      agentId,
      instructionVersion,
      err: (err as Error).message,
    }, 'could not read capability states; refusing nothing this call');
    return {};
  }
}

/**
 * The repositories a connector binding is scoped to, from the stored
 * instruction's per-binding config.
 *
 * Read HERE for the same reason capability states are: `ExecuteInput` is built
 * at a dozen call sites and a scope each one has to remember is a scope the
 * next one forgets. That is not hypothetical for this field — `githubFilter`
 * was consulted in exactly one place, the event trigger, and every dispatch
 * path silently ignored it.
 *
 * Fails OPEN, returning `[]`, which means "no scope declared" and therefore no
 * refusal. A lookup that cannot answer must not start refusing an agent's own
 * repositories.
 */
export async function repoScopeFor(
  tenantId: string,
  agentId: string,
  instructionVersion: number,
  connectorId: string,
): Promise<string[]> {
  try {
    const pool = getPoolForService('tool-gateway');
    const res = await pool.query(
      `SELECT integrations FROM compiled_instructions
        WHERE tenant_id = $1 AND agent_id = $2 AND version = $3
        LIMIT 1`,
      [tenantId, agentId, instructionVersion],
    );
    const raw = res.rows[0]?.integrations;
    const list = (typeof raw === 'string' ? JSON.parse(raw) : raw) as
      Array<{ id?: string; config?: Record<string, unknown> }> | undefined;
    const binding = (list ?? []).find((i) => i.id === connectorId);
    const cfg = binding?.config as
      { githubFilter?: { repos?: string[] }; gitlabFilter?: { projects?: string[] } } | undefined;
    return cfg?.githubFilter?.repos ?? cfg?.gitlabFilter?.projects ?? [];
  } catch (err) {
    logger.warn({
      event: 'repo_scope_lookup_failed',
      tenantId,
      agentId,
      connectorId,
      err: (err as Error).message,
    }, 'could not read repository scope; refusing nothing this call');
    return [];
  }
}

/** Test seam: the cache is process-global, so a test seeding one would
 *  otherwise leak into the next. */
export function _resetCapabilityStatesCacheForTesting(): void {
  cache.clear();
}
