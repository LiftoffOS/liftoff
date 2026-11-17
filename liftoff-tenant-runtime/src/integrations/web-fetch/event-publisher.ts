import { publisher } from '../../infrastructure/pubsub';
import { logger } from '../../infrastructure/logging';
import { resolveInternalAgentId } from '../../agent-lifecycle/resolve-runtime-agent-id';
import { NO_AGENT_SENTINEL } from '../../browser-sessions/types';

export interface WebToolSpendEvent {
  tenantId: string;
  agentId?: string;
  workflowId?: string;
  actionId?: string;            // UUID
  invocationId?: string;        // UUID
  threadId?: string | null;
  connector?: string;           // 'perplexity' | 'anchor' | 'firecrawl' | 'webclaw' | 'browserbase' | 'tavily' | 'exa' | 'openai' | 'google'
  eventType: string;            // 'web_fetch' | 'web_extract' | 'web_research' | 'web_people_search' | 'web_finance_search' | 'web_deep_research' | 'web_identity_connect' | 'web_session_save'
  /** Which platform assistant the spend belongs to, when no agent does:
   *  'liftoff' | 'insights' | 'team_plan'. The control plane files it as the
   *  event's `purpose`, which is the dimension that separates the three — they
   *  otherwise share one identity and would report as a single phantom agent. */
  purpose?: string;
  costUsd: number;              // SIGNED — negative for refunds
  occurredAt: string;           // ISO-8601
  idempotencyKey: string;       // pre-charge: deep_research_id; delta: `${deep_research_id}/delta`; otherwise: usage_events.id
  metadata?: Record<string, unknown>;
}

/** `internal_agents.id` for the event's agent, or undefined when there is no
 *  agent, it is unmapped, or the lookup failed. The Platform Backend keys cost
 *  rows by that id; without it, it asks this runtime's agent-service to
 *  translate, which wakes an instance-billed service for every charge. Never
 *  throws: a charge must not be lost to a failed lookup, and the Platform
 *  Backend still translates when the field is absent (INV-TR-010). */
async function internalAgentIdFor(event: WebToolSpendEvent): Promise<string | undefined> {
  if (!event.agentId || event.agentId === NO_AGENT_SENTINEL) return undefined;
  try {
    return (await resolveInternalAgentId(event.tenantId, event.agentId, 'web-tool-spend')) ?? undefined;
  } catch (err) {
    logger.warn({ err: (err as Error).message, tenant_id: event.tenantId }, 'web_tool_event_internal_agent_id_lookup_failed');
    return undefined;
  }
}

export async function publishWebToolEvent(event: WebToolSpendEvent): Promise<boolean> {
  const env = process.env.ENVIRONMENT || 'dev';
  const project = process.env.BILLING_PUBSUB_PROJECT_ID ?? `YOUR_GCP_PROJECT`;
  const topic = `projects/${project}/topics/web-tool-events-${env}`;
  // Awaited only when there is an agent to translate, so an agentless event
  // still publishes in the same tick it did before.
  const internalAgentId = event.agentId ? await internalAgentIdFor(event) : undefined;
  try {
    await publisher.publish(topic, {
      tenantId:       event.tenantId,
      agentId:        event.agentId,
      ...(internalAgentId ? { internalAgentId } : {}),
      workflowId:     event.workflowId,
      actionId:       event.actionId,
      invocationId:   event.invocationId,
      threadId:       event.threadId,
      connector:      event.connector,
      eventType:      event.eventType,
      purpose:        event.purpose,
      costUsd:        event.costUsd,
      occurredAt:     event.occurredAt,
      idempotencyKey: event.idempotencyKey,
      metadata:       event.metadata,
    });
    return true;
  } catch (err) {
    logger.warn({
      err: (err as Error).message,
      tenant_id:       event.tenantId,
      event_type:      event.eventType,
      idempotency_key: event.idempotencyKey,
    }, 'web_tool_event_publish_lost');
    return false;
  }
}
