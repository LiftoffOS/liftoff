// Tenant Runtime feed client — cost attribution ingestion only.
// Exposes the two cursor-based feed endpoints used by the attribution
// ingesters (invocation feed, sandbox feed). No HITL, insights, or
// chat-turn logic — those live in connectors/tenant-runtime-client.ts.
//
// Self-contained within src/cost-attribution/ so this module can be
// extracted to a standalone service without pulling in unrelated platform
// logic.

import { resolveRuntimeBaseUrl, buildRuntimeHeaders } from '../../connectors/tenant-runtime-url';
import { tenantRuntimeBreaker } from '../../connectors/tenant-runtime-circuit-breaker';

export interface InvocationFeedRow {
  id: string;
  /** Tenant Runtime's local `agents.id` (runtime id space). */
  agentId: string;
  /**
   * Control-plane `internal_agents.id`, translated by the runtime through
   * `internal_agent_runtime_mapping`. Preferred for attribution so the
   * `cost_attribution_events.agent_id` column stays in one id space.
   * Optional/null: a runtime that predates this field omits it, and an unmapped
   * agent yields null — both cases fall back to `agentId`.
   */
  internalAgentId?: string | null;
  threadId: string | null;
  triggeredBy: string;
  triggerRef: string | null;
  provider: string;
  modelId: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  inputPricePerMillion: number | null;
  outputPricePerMillion: number | null;
  cachedInputPricePerMillion: number | null;
  costUsd: number | null;
  outcome: string | null;
  startedAt: string; // ISO string
}

export interface SandboxFeedRow {
  id: string;
  /** Tenant Runtime's local `agents.id` (runtime id space). */
  agentId: string | null;
  /** Control-plane `internal_agents.id`; see InvocationFeedRow.internalAgentId. */
  internalAgentId?: string | null;
  invocationId: string | null;
  sandboxId: string;
  phase: string | null;
  wallClockMs: number;
  creditsConsumed: number;
  timestamp: string; // ISO string
}

/**
 * Cursor-based feed of completed invocations for cost attribution ingestion.
 * Returns null on error (caller treats as empty feed and retries next cycle).
 */
export async function getInvocationFeed(
  tenantId: string,
  since: Date,
  limit = 500,
): Promise<{ rows: InvocationFeedRow[]; hasMore: boolean; nextSince: string } | null> {
  const params = new URLSearchParams({
    since: since.toISOString(),
    limit: String(limit),
  });
  const url = `${await resolveRuntimeBaseUrl(tenantId)}/api/invocations/ingestion-feed?${params}`;

  return tenantRuntimeBreaker.executeOrFallback(
    { tenantId, method: 'getInvocationFeed' },
    async () => {
      const response = await fetch(url, {
        method: 'GET',
        headers: await buildRuntimeHeaders(tenantId),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} from tenant runtime ingestion-feed`);
      }

      return await response.json() as { rows: InvocationFeedRow[]; hasMore: boolean; nextSince: string };
    },
    null,
  );
}

/**
 * Cursor-based feed of sandbox usage events for cost attribution ingestion.
 * Returns null on error (caller treats as empty feed and retries next cycle).
 */
export async function getSandboxFeed(
  tenantId: string,
  since: Date,
  limit = 500,
): Promise<{ rows: SandboxFeedRow[]; hasMore: boolean; nextSince: string } | null> {
  const params = new URLSearchParams({
    since: since.toISOString(),
    limit: String(limit),
  });
  const url = `${await resolveRuntimeBaseUrl(tenantId)}/api/invocations/sandbox-feed?${params}`;

  return tenantRuntimeBreaker.executeOrFallback(
    { tenantId, method: 'getSandboxFeed' },
    async () => {
      const response = await fetch(url, {
        method: 'GET',
        headers: await buildRuntimeHeaders(tenantId),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} from tenant runtime sandbox-feed`);
      }

      return await response.json() as { rows: SandboxFeedRow[]; hasMore: boolean; nextSince: string };
    },
    null,
  );
}
