// Start, pause or draft an agent: the dashboard's PATCH /:id/status body,
// lifted out so every surface applies the same admission (the execution
// guard's own words on a 402), the same role rule (member and above) and the
// same attribution.
//
// The route keeps what is a route concern: the activation rate limiter, the
// idempotency middleware, verifyTenantOwnership, and the status-code mapping
// (404 / 402 / 422 / 409 with the bodies the frontend's openIfPaymentRequired
// reads).

import { pool } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { internalAgentService } from '../internal-agents/service';
import { RequiredConnectorMissingError } from '../internal-agents/required-connector-guard';
import { checkExecutionAllowed } from '../billing/execution-guard';
import { updateAgentQuantity } from '../billing/subscription-items-service';
import type { InternalAgent } from '../internal-agents/types';
import { requirePermission, type Actor } from './actor';
import { writeAudit } from './audit';

export type TeamStatus = 'draft' | 'active' | 'paused';

export type TeamStatusRefusal = {
  refused: 'not_found' | 'payment_required' | 'required_connector_missing' | 'workflow_tampered' | 'rate_limited';
  message: string;
  context?: unknown;
};

export type TeamStatusResult = { agent: InternalAgent } | TeamStatusRefusal;

// Activation is rate limited per workspace on EVERY surface, and this is the
// one definition: the dashboard's route limiter reads it too, so the two
// cannot drift. The ceiling is sized to a LOOP, not to a person: every
// activation is an entitlement read, a runtime activation event and a Stripe
// subscription-quantity write, so a script toggling one team at loop speed
// is a Stripe write per iteration. A person clicking Start on each paused
// team, two admins doing it at once, or an assistant asked to start every
// paused team in one turn all stay far below one a second; a loop does not.
// Only a change TO active counts, so pause → resume churn spends one slot
// per resume. In-memory per instance, the same enforcement level the route
// has; a window slides over the last minute.
export const ACTIVATION_LIMIT = { max: 60, windowMs: 60_000 } as const;
const activationsByTenant = new Map<string, number[]>();

function activationAllowed(tenantId: string, now = Date.now()): boolean {
  const recent = (activationsByTenant.get(tenantId) ?? []).filter((t) => now - t < ACTIVATION_LIMIT.windowMs);
  if (recent.length >= ACTIVATION_LIMIT.max) {
    activationsByTenant.set(tenantId, recent);
    return false;
  }
  recent.push(now);
  activationsByTenant.set(tenantId, recent);
  return true;
}

/** Test seam. */
export function _resetActivationLimiter(): void {
  activationsByTenant.clear();
}

export async function setTeamStatus(
  actor: Actor,
  agentId: string,
  status: TeamStatus,
): Promise<TeamStatusResult> {
  requirePermission(actor, 'teams:status');
  const { tenantId } = actor;

  if (status === 'active' && !activationAllowed(tenantId)) {
    return { refused: 'rate_limited', message: 'Too many activation requests, please try again later' };
  }

  // Get previous status before update (BE-009)
  const currentAgent = await internalAgentService.getById(agentId, tenantId);
  if (!currentAgent) {
    return { refused: 'not_found', message: 'agent not found' };
  }
  const previousStatus = currentAgent.status;
  const newStatus = status;

  // Resolve workspace account_id — used for billing hooks (agent quantity sync).
  const tenantRow = await pool.query<{ account_id: string }>(
    `SELECT account_id FROM tenants WHERE id = $1`,
    [tenantId],
  );
  const workspaceAccountId = tenantRow.rows[0]?.account_id;

  // Block activation when the tenant doesn't have an active subscription or is suspended.
  if (newStatus === 'active') {
    const guardResult = await checkExecutionAllowed(tenantId);
    if (!guardResult.allowed) {
      // The guard's own copy is the message — "outstanding balance of $X" and
      // "needs an active plan" are different things to tell a person.
      const reason = guardResult.reason ?? 'Execution is not allowed for this workspace';
      return { refused: 'payment_required', message: reason, context: { reason } };
    }
  }

  let internalAgent: InternalAgent | null;
  try {
    internalAgent = await internalAgentService.updateStatus(agentId, tenantId, newStatus, actor.accountId);
  } catch (error) {
    // The template names a connector this hire never bound, so it cannot
    // start. Fixable on the tools step, so it is theirs to see.
    if (error instanceof RequiredConnectorMissingError) {
      return { refused: 'required_connector_missing', message: error.message, context: error.context };
    }
    // Phase 4: Structured error for workflow tamper detection
    if ((error as { code?: string }).code === 'WORKFLOW_TAMPERED') {
      return { refused: 'workflow_tampered', message: (error as Error).message };
    }
    throw error;
  }

  if (!internalAgent) {
    return { refused: 'not_found', message: 'agent not found' };
  }

  writeAudit(actor, 'internal_agent.status_changed', {
    internalAgentId: internalAgent.id,
    newStatus: internalAgent.status,
    previousStatus,
    tenantId,
  });

  // Event publish is owned by InternalAgentService.updateStatus (shape-3
  // canonical pattern per plan §5.4). On activation the service enriches
  // the payload with the full agent config via buildInternalAgentEventPayload
  // — identical shape to the create-path payload, so the runtime activation
  // path receives the same data structure.

  // Phase 3: Update Stripe subscription agent quantity when active-agent count changes.
  // Fire-and-forget — Stripe latency must not block the caller.
  if (workspaceAccountId && (newStatus === 'active' || previousStatus === 'active')) {
    updateAgentQuantity(workspaceAccountId).catch((err) =>
      log.warn({ err, workspaceAccountId }, 'billing.phase3: updateAgentQuantity failed (non-fatal)'),
    );
  }

  return { agent: internalAgent };
}
