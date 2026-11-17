// Invariant escalation sink.
//
// The dual of fire.ts. Where an OPPORTUNITY subscription edge-fires an agent
// (fireAgentForSubscription), an INVARIANT subscription asserts a predicate
// that should ALWAYS hold. When the computed-metric poller detects the
// satisfied→violated edge it routes here instead: no agent runs, a HITL review
// item is raised on the platform's human-review surface via the shared
// escalation helper, and the operator is notified. We deliberately do NOT
// auto-fix — a broken invariant is a human decision.

import { createEscalation } from '../agent-execution/engine/escalation-helper';
import { logger } from '../infrastructure/logging';
import { v4 as uuidv4 } from 'uuid';
import type { ExecutionContext } from '../agent-execution/types';
import type { SubscriptionRow } from './repository';

/**
 * Raise a HITL escalation for a violated invariant. Reuses the canonical
 * `createEscalation` helper (workflow_escalations table, kind='escalation' →
 * user-facing /reviews surface + durable operator notification). Returns the
 * escalation id so the poller can stamp it onto the goal_ledger row.
 */
export async function escalateInvariantViolation(
  sub: SubscriptionRow,
  value: number,
  detectedAt: Date = new Date(),
): Promise<string> {
  const source = sub.source as { connectorRef?: string; fn?: string };
  const valueText = Number.isFinite(value) ? String(value) : 'unavailable';
  const reason =
    `Invariant "${sub.label}" violated. ` +
    `The asserted condition no longer holds (observed metric value: ${valueText}` +
    `${source.connectorRef ? `, source: ${source.connectorRef}/${source.fn}` : ''}). ` +
    `Objective: ${sub.objective}. ` +
    `Detected at ${detectedAt.toISOString()}.`;

  // Minimal ExecutionContext — the escalation helper only reads tenantId,
  // agentId, workflowId, taskId (for the parent workflow/task rows), and the
  // optional threadId/invocationId. Mirrors the hybrid-loop sweeper's
  // synthetic context construction. Pure UUIDs: workflow_escalations FKs
  // workflow_id/task_id to UUID columns.
  const ctx = {
    tenantId: sub.tenantId,
    agentId: sub.agentId,
    workflowId: uuidv4(),
    taskId: uuidv4(),
    instructionVersion: 0,
    instruction: {
      allowedConnectors: [],
      systemPrompt: '',
      userInstructions: '',
    } as unknown as ExecutionContext['instruction'],
    traceId: `invariant-${sub.id}`,
    agentType: 'agent' as const,
    hitlLevel: 3,
    modelConfig: {},
    execConfig: {},
    memoryScope: {},
  } as ExecutionContext;

  const escalationId = await createEscalation(ctx, reason, { kind: 'escalation' });

  logger.info(
    {
      tenant_id: sub.tenantId,
      agent_id: sub.agentId,
      subscription_id: sub.id,
      subscription_label: sub.label,
      escalation_id: escalationId,
      value,
    },
    'Invariant violated — HITL escalation raised',
  );

  return escalationId;
}
