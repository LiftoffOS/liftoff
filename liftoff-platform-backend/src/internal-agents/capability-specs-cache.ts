// Off-hot-path cache of an agent's LLM-derived public-data capability specs.
//
// The distillation prefetch derives the capability specs that drive prior-art
// discovery, but it runs under the summary-wave budget and cannot afford an
// LLM call — so it uses a keyword heuristic (deriveCapabilitySpecs). The LLM
// counterpart (deriveCapabilitySpecsLLM) reads the role text properly, so it
// catches intents the cues miss. We get its quality by running it and caching
// the result on the agent row, keyed by a source hash that an edit to the
// role or responsibilities moves. On a cache miss the prefetch waits a bounded
// time for the derivation — a team built or corrected in the background can
// afford a few seconds, and it is those distills that decide what the team is
// wired to — and falls back to the heuristic only when the derivation does
// not land in time, with the refresh still writing the cache for the next
// distill. Before the wait, every first distill and every distill after an
// edit ran on the heuristic, whose specs name no platform, so prior art for a
// team that pulls posts from a named site was never found at the distill that
// mattered. A failure anywhere leaves the heuristic in place — this is
// strictly an enrichment, never a regression.

import { withTenantScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { capabilitySpecsSourceHash, deriveCapabilitySpecsLLM } from './distill-prior-art-injection';
import type { CapabilitySpec } from '../capability-discovery';

/** Derive with the LLM and cache on the agent row, keyed by the source hash.
 *  Returns the specs it derived, so a prefetch that waited for them can use
 *  them; a failure logs, leaves the cache untouched and returns null (the
 *  prefetch then keeps the heuristic). */
export async function refreshCapabilitySpecsCache(
  agentId: string,
  tenantId: string,
  role: string,
  responsibilities: string,
  integrationTypes: string[],
): Promise<CapabilitySpec[] | null> {
  try {
    const hash = capabilitySpecsSourceHash(role, responsibilities, integrationTypes);
    const specs = await deriveCapabilitySpecsLLM(role, responsibilities, integrationTypes, tenantId);
    await withTenantScope(tenantId, (client) =>
      client.query(
        `UPDATE internal_agents
            SET capability_specs = $1::jsonb, capability_specs_source_hash = $2
          WHERE id = $3 AND tenant_id = $4`,
        [JSON.stringify(specs), hash, agentId, tenantId],
      ),
    );
    return specs;
  } catch (err) {
    log.warn(
      { err: (err as Error).message, agentId, tenantId },
      'refreshCapabilitySpecsCache failed; prefetch keeps the heuristic',
    );
    return null;
  }
}

/** How long a prefetch waits for the LLM-derived specs on a cache miss before
 *  taking the heuristic. Sized for a short model call; the refresh keeps
 *  running past it and writes the cache for the next distill either way. */
export const SPEC_DERIVATION_WAIT_MS = 8_000;

/** The LLM-derived specs within the wait, else null. With an agent id the
 *  derivation is cached on the row and is not cancelled on a timeout: it
 *  finishes in the background and lands in the cache, which is what the next
 *  distill reads. A first distill has no row yet and derives directly. */
export async function deriveCapabilitySpecsWithin(
  waitMs: number,
  agentId: string | null,
  tenantId: string,
  role: string,
  responsibilities: string,
  integrationTypes: string[],
): Promise<CapabilitySpec[] | null> {
  const refresh = agentId
    ? refreshCapabilitySpecsCache(agentId, tenantId, role, responsibilities, integrationTypes)
    : deriveCapabilitySpecsLLM(role, responsibilities, integrationTypes, tenantId).catch(() => null);
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), waitMs); });
  try {
    return await Promise.race([refresh, late]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The cached LLM specs when the source hash still matches the current role +
 *  responsibilities + integrations; null to fall back to the heuristic. An
 *  empty array with a matching hash is a real answer (own-account role) and is
 *  returned as-is, not treated as a miss. */
export async function readCachedCapabilitySpecs(
  agentId: string,
  tenantId: string,
  role: string,
  responsibilities: string,
  integrationTypes: string[],
): Promise<CapabilitySpec[] | null> {
  try {
    const want = capabilitySpecsSourceHash(role, responsibilities, integrationTypes);
    const res = await withTenantScope(tenantId, (client) =>
      client.query<{ capability_specs: unknown; capability_specs_source_hash: string | null }>(
        `SELECT capability_specs, capability_specs_source_hash
           FROM internal_agents WHERE id = $1 AND tenant_id = $2`,
        [agentId, tenantId],
      ),
    );
    const row = res.rows[0];
    if (!row || row.capability_specs_source_hash !== want || !Array.isArray(row.capability_specs)) {
      return null;
    }
    return row.capability_specs as CapabilitySpec[];
  } catch {
    return null;
  }
}
