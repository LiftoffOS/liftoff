// Per-tenant preflight cache for the governance-engine hot path.
//
// Rationale (see governance_service.proto docs):
//   Preflight is called once per invocation — it returns admission status,
//   HITL level, kill-switch snapshot, allowlists, and a signed preflight
//   token. That token is echoed on every Authorize/Record call.
//
// The plan's 30s TTL is a soft bound; stronger invalidation comes from the
// governance events Pub/Sub subscriber (src/governance/governance-events-subscriber.ts)
// which evicts per-tenant entries on push when
// `governance.kill_switch_changed` arrives.

import { create } from '@bufbuild/protobuf';
import { PreflightRequestSchema } from '@liftoffos/proto-gen/dist/liftoff/governance/v1/governance_service_pb.js';
import { getGovernanceServiceClient, type PreflightResponse } from './governance-service-client';

const TTL_MS = 30_000;

interface CacheEntry {
  key: string;
  response: PreflightResponse;
  expiresAt: number;
}

// Key on (tenantId, agentId, connector list hash, capabilityTier, execEnv).
// A cache entry that was fetched with a different connector set is not
// reusable; governance-engine's allowlists depend on the connectorTypes
// passed in Preflight.
function buildKey(
  tenantId: string,
  agentId: string,
  connectorTypes: string[],
  capabilityTier: string,
  executionEnvironment: string,
): string {
  const connectors = [...connectorTypes].sort().join(',');
  return `${tenantId}|${agentId}|${connectors}|${capabilityTier}|${executionEnvironment}`;
}

// Per-tenant cache map so invalidate(tenantId) can evict all entries for
// a tenant regardless of agent/connector mix.
const cache: Map<string, Map<string, CacheEntry>> = new Map();

export async function getPreflight(
  tenantId: string,
  agentId: string,
  connectorTypes: string[],
  capabilityTier: string,
  executionEnvironment: string,
): Promise<PreflightResponse> {
  const key = buildKey(tenantId, agentId, connectorTypes, capabilityTier, executionEnvironment);
  const perTenant = cache.get(tenantId);
  const entry = perTenant?.get(key);
  const now = Date.now();

  if (entry && entry.expiresAt > now) {
    return entry.response;
  }

  const client = getGovernanceServiceClient();
  const req = create(PreflightRequestSchema, {
    tenantContext: { tenantId },
    agentId,
    connectorTypes,
    capabilityTier,
    executionEnvironment,
  });
  const response = await client.preflight(req);

  const next: CacheEntry = { key, response, expiresAt: now + TTL_MS };
  if (!perTenant) {
    cache.set(tenantId, new Map([[key, next]]));
  } else {
    perTenant.set(key, next);
  }
  return response;
}

export function invalidatePreflight(tenantId: string): void {
  cache.delete(tenantId);
}

export function resetPreflightCache(): void {
  cache.clear();
}
