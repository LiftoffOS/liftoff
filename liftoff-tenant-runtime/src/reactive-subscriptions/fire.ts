// Agent fire path for reactive subscription matches.
//
// Re-checks agent lifecycle before invoking, creates a thread, builds an
// objective that combines the subscription's text with structured match
// context, and runs executeTask. Uses the CHECK-constraint-compliant
// triggeredBy ('event' or 'cron') plus a granular triggered_by_label.

import { invocationsService } from '../invocations/service';
import { agentExecutionService } from '../agent-execution/service';
import { getPool } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import type { SubscriptionRow } from './repository';
import type { AgentTrigger } from '../agent-lifecycle/types';
import { wakeEventDeliveryRepo } from './wake-event-delivery-repo';
import { connectorEventTrigger } from '../agent-lifecycle/types';

// Connector types whose records are authored by an external, untrusted party.
// A reactive fire off one of these carries untrusted_inbound content trust so
// the injection screen + SSRF gate engage. First-party connectors are absent
// here and stay trusted.
export async function fireAgentForSubscription(
  sub: SubscriptionRow,
  event: { data: Record<string, unknown>; changes?: Record<string, { old: unknown; new: unknown }> },
  recordKey: string,
): Promise<void> {
  const lifecycleOk = await isAgentActive(sub.tenantId, sub.agentId);
  if (!lifecycleOk) return;

  // Self-wake one-shot: STAGE a durable delivery instead of starting a fresh run. The
  // drain worker enqueues the resume Cloud Task and consumes the subscription — this closes the
  // claim->enqueue crash window and spreads the herd. Payload is a BOUNDED snapshot.
  if (sub.oneShot && sub.boundScheduledInvocationId) {
    const evtHash = createHash('sha256').update(JSON.stringify(event.changes ?? event.data ?? {})).digest('hex').slice(0, 12);
    const sourceEventId = `${recordKey}:${evtHash}`;
    const connectorRef = sub.source.kind === 'connector_event' ? (sub.source as { connectorRef: string }).connectorRef : undefined;
    const staged = await wakeEventDeliveryRepo.stage({
      tenantId: sub.tenantId,
      wakeScheduledInvocationId: sub.boundScheduledInvocationId,
      sourceEventId,
      payloadRef: {
        // Minimized, bounded snapshot — the changed fields + record key, not the whole entity.
        changes: event.changes ?? {},
        recordKey,
        ...(connectorRef ? { connectorRef } : {}),
        subscriptionId: sub.id,
      },
    });
    logger.info('Self-wake event staged for delivery', {
      tenant_id: sub.tenantId, wake_scheduled_invocation_id: sub.boundScheduledInvocationId,
      source_event_id: sourceEventId, deduped: !staged,
    });
    return;
  }

  const thread = await invocationsService.createThread({
    tenantId: sub.tenantId,
    agentId: sub.agentId,
    initiatedByType: 'scheduler',
    title: `Reactive subscription matched: ${sub.label} (${recordKey})`,
  });

  const sourceDesc = sub.source.kind === 'system_event'
    ? `${sub.source.kind} (${sub.source.topic})`
    : `${sub.source.kind} (${(sub.source as { connectorRef: string }).connectorRef})`;

  const changeText = event.changes && Object.keys(event.changes).length
    ? `Field changes: ${JSON.stringify(redactForLogs(event.changes))}`
    : '';

  const objective = `[subscription.matched] ${sub.objective}\n\n` +
    `Subscription: ${sub.label}\n` +
    `Source: ${sourceDesc}\n` +
    `Matched record: ${recordKey}\n` +
    changeText;

  const mappedTriggeredBy: 'event' | 'cron' =
    sub.source.kind === 'computed_metric' ? 'cron' : 'event';
  const triggeredByLabel =
    sub.source.kind === 'computed_metric'
      ? `computed_metric:${sub.label}`
      : `reactive:${sub.label}`;

  const isReactiveEvent = mappedTriggeredBy === 'event';   // exclude computed_metric (cron)
  const evtHash = createHash('sha256').update(JSON.stringify(event.changes ?? event.data ?? {})).digest('hex').slice(0, 12);

  // A connector_event subscription off an external-authored source enters the
  // executor as untrusted_inbound (via trustLevelFor), so the injection screen
  // and SSRF gate key off the level. All other reactive sources stay trusted.
  const trigger: AgentTrigger | undefined =
    sub.source.kind === 'connector_event'
      ? connectorEventTrigger(sub.source.connectorRef, sub.source.entityType ?? '')
      : undefined;

  await agentExecutionService.executeTask({
    tenantId: sub.tenantId,
    agentId: sub.agentId,
    // Pure UUIDs — workflows.id is a UUID column and the escalation-helper
    // INSERT fails with `invalid input syntax for type uuid` on any prefix.
    workflowId: uuidv4(),
    taskId: uuidv4(),
    objective,
    threadId: thread.id,
    triggeredBy: mappedTriggeredBy,
    triggeredByLabel,
    trigger,
    inputData: { subscriptionId: sub.id, event },
    ...(isReactiveEvent ? {
      triggerKey: `reactive:${sub.id}:${recordKey}:${sub.agentId}:${evtHash}`,
      onConflict: 'defer' as const,
    } : {}),
  });

  logger.info('Reactive subscription fired', {
    tenant_id: sub.tenantId,
    agent_id: sub.agentId,
    subscription_id: sub.id,
    subscription_label: sub.label,
    record_key: recordKey,
  });
}

function redactForLogs(
  changes: Record<string, { old: unknown; new: unknown }>,
): Record<string, { old: unknown; new: unknown }> {
  const PII_KEY_RE = /(email|phone|ssn|tax_id|dob|birth|address|account_number|card|password|token|secret)/i;
  const redacted: Record<string, { old: unknown; new: unknown }> = {};
  for (const [path, change] of Object.entries(changes)) {
    if (PII_KEY_RE.test(path)) {
      redacted[path] = { old: '[redacted]', new: '[redacted]' };
    } else {
      redacted[path] = change;
    }
  }
  return redacted;
}

async function isAgentActive(tenantId: string, agentId: string): Promise<boolean> {
  const pool = getPool();
  const { rows } = await pool.query<{ lifecycle: string }>(
    `SELECT lifecycle FROM agents WHERE id=$1 AND tenant_id=$2 LIMIT 1`,
    [agentId, tenantId]
  );
  return rows[0]?.lifecycle === 'ACTIVE';
}
