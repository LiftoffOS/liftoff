// Shared chat admission (plan v6.1 Phase 5a)
//
// The three checks that were previously ONLY in the HTTP stream-router —
// which meant any direct service call bypassed them entirely:
//   1. agent exists and is not deleted (web parity: paused agents remain
//      chattable and the pause is surfaced downstream — deliberate divergence
//      from delegation, which requires status='active')
//   2. durable per-tenant/per-user chat rate limit (agent_chat_rate_limit_events)
//   3. execution guard (subscription/suspension)
//
// Used by both the HTTP stream-router and the MCP chat path. Membership is
// the caller's concern: the HTTP path verifies Firebase → account →
// membership before calling; the MCP path's OAuth grant already binds
// account ↔ tenant.

import { withTenantScope } from '../infrastructure/database';
import { checkAndIncrementChatRateLimit } from '../common/chat-rate-limiter';
import { checkExecutionAllowed } from '../billing/execution-guard';

export type ChatAdmissionResult =
  | { allowed: true }
  | { allowed: false; httpStatus: number; error: string; retryAfter?: number; reason?: string };

export const CHAT_RATE_LIMITS = {
  tenant: { maxPerMinute: 30, maxPerHour: 200, maxPerDay: 1000 },
  user: { maxPerMinute: 10, maxPerHour: 60, maxPerDay: 200 },
} as const;

export async function checkChatAdmission(input: {
  tenantId: string;
  accountId: string;
  agentId: string;
}): Promise<ChatAdmissionResult> {
  // 1. Agent exists in this tenant (non-deleted; paused allowed — web parity).
  const agentResult = await withTenantScope(input.tenantId, (client) => client.query(
    `SELECT id FROM internal_agents
     WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
    [input.agentId, input.tenantId],
  ));
  if (agentResult.rows.length === 0) {
    return { allowed: false, httpStatus: 404, error: 'agent not found' };
  }

  // 2. Durable rate limit — same table and limits as the web chat surface.
  const rateLimitResult = await checkAndIncrementChatRateLimit({
    tableName: 'agent_chat_rate_limit_events',
    tenantId: input.tenantId,
    accountId: input.accountId,
    limits: CHAT_RATE_LIMITS,
  });
  if (!rateLimitResult.allowed) {
    return {
      allowed: false,
      httpStatus: 429,
      error: 'Rate limit exceeded',
      ...(rateLimitResult.retryAfter != null ? { retryAfter: rateLimitResult.retryAfter } : {}),
    };
  }

  // 3. Execution guard — no active subscription / suspended account.
  const guardResult = await checkExecutionAllowed(input.tenantId);
  if (!guardResult.allowed) {
    return { allowed: false, httpStatus: 402, error: 'payment_required', reason: guardResult.reason };
  }

  return { allowed: true };
}

/**
 * The same payment gate, for a platform assistant.
 *
 * Liftoff and the Insights Manager run IN THIS PROCESS — they do not go through
 * the internal LLM relay, so `llm-router`'s guard never saw them and neither
 * did anything else. A workspace with no subscription and no prepaid balance
 * could talk to either of them indefinitely, browsers and data sources
 * included, and the only thing it could not do was build an agent.
 *
 * Two differences from `checkChatAdmission`, both deliberate:
 *
 *   No agent check. The assistants have no `internal_agents` row; that is what
 *   they are.
 *
 *   No rate limit. Each assistant already keeps its own ledger table
 *   (`liftoff_rate_limit_events`, `insights_rate_limit_events`) and its stream
 *   router already checks it. Doing it again here would charge one message
 *   against two counters.
 *
 * The Chief AI Officer needs no call site: it runs in workforce-service over
 * the internal relay, and that gate turns itself on the moment its purposes
 * stop being platform-absorbed (`PLATFORM_ASSISTANT_PURPOSES`).
 *
 * What this does NOT gate is the work that runs when a person merely opens a
 * page — the Insights Manager's intro and observations. Those keep their own
 * ungated path, so a workspace without a plan still has its dashboard; it is
 * asking a question that meets the gate.
 */
export async function checkAssistantAdmission(input: {
  tenantId: string;
}): Promise<ChatAdmissionResult> {
  const guardResult = await checkExecutionAllowed(input.tenantId);
  if (!guardResult.allowed) {
    return { allowed: false, httpStatus: 402, error: 'payment_required', reason: guardResult.reason };
  }
  return { allowed: true };
}
