// Agent lifecycle subscriber.
//
// Materialises internal agent lifecycle state from platform-backend into
// the local `agents` table so checkAgentLifecycle in admission/service.ts
// can evaluate per-agent execution gating without an RPC back to the control
// plane on every Preflight call.
//
// Subscribes to the shared `control-plane-events-{ENVIRONMENT}` Pub/Sub topic
// and handles three internal-agent event types:
//   tenant.internal_agent.created       — initial lifecycle from status field
//   tenant.internal_agent.status_changed — lifecycle update from newStatus field
//   tenant.internal_agent.deleted       — mark lifecycle DELETED
//
// lifecycle values stored uppercase to match the admission service check
//   (lifecycle !== 'ACTIVE'): ACTIVE | DRAFT | PAUSED | DELETED

import { PubSub, Message, Subscription } from '@google-cloud/pubsub';
import { withTenantScope } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';

const AGENT_LIFECYCLE_EVENT_TYPES = new Set<string>([
  'tenant.internal_agent.created',
  'tenant.internal_agent.status_changed',
  'tenant.internal_agent.deleted',
]);

// Platform-backend internal agent status values (lowercase).
type PlatformAgentStatus = 'draft' | 'active' | 'paused';

function toLifecycle(status: string | undefined): string {
  switch ((status ?? '').toLowerCase()) {
    case 'active': return 'ACTIVE';
    case 'draft':  return 'DRAFT';
    case 'paused': return 'PAUSED';
    default:       return 'DRAFT';
  }
}

export interface AgentLifecycleEventPayload {
  id?: string;
  tenantId?: string;
  status?: PlatformAgentStatus;        // on created
  newStatus?: PlatformAgentStatus;     // on status_changed
  previousStatus?: PlatformAgentStatus;
  changedBy?: string;
  changedAt?: string;
  [key: string]: unknown;
}

interface ControlPlaneEventEnvelope {
  event_id?: string;
  event_type: string;
  entity_type?: string;
  entity_id?: string;
  entity_version?: number;
  tenant_id?: string;
  payload?: AgentLifecycleEventPayload;
}

export async function handleAgentLifecycleMessage(
  message: Pick<Message, 'data' | 'ack' | 'nack'>,
): Promise<void> {
  let raw: ControlPlaneEventEnvelope;
  try {
    raw = JSON.parse(message.data.toString()) as ControlPlaneEventEnvelope;
  } catch (err) {
    logger.error(
      { err: (err as Error).message },
      'agent-lifecycle-subscriber: invalid JSON, acking to drop',
    );
    message.ack();
    return;
  }

  if (!AGENT_LIFECYCLE_EVENT_TYPES.has(raw.event_type)) {
    // Other event types on the shared topic — not for us. Ack to keep flowing.
    message.ack();
    return;
  }

  const tenantId = raw.tenant_id ?? raw.payload?.tenantId;
  const agentId  = raw.entity_id  ?? raw.payload?.id;

  if (!tenantId || !agentId) {
    logger.warn(
      { event_type: raw.event_type, event_id: raw.event_id },
      'agent-lifecycle-subscriber: event missing tenant_id or agent id — acking to drop',
    );
    message.ack();
    return;
  }

  let lifecycle: string;
  if (raw.event_type === 'tenant.internal_agent.deleted') {
    lifecycle = 'DELETED';
  } else if (raw.event_type === 'tenant.internal_agent.status_changed') {
    lifecycle = toLifecycle(raw.payload?.newStatus);
  } else {
    // created — use status field, fall back to ACTIVE if absent
    lifecycle = toLifecycle(raw.payload?.status ?? 'active');
  }

  try {
    await upsertAgentLifecycle(agentId, tenantId, lifecycle, raw.entity_version);
    logger.info(
      {
        agent_id: agentId,
        tenant_id: tenantId,
        lifecycle,
        event_id: raw.event_id,
        entity_version: raw.entity_version,
      },
      'agent-lifecycle-subscriber: agents row upserted',
    );
    message.ack();
  } catch (err) {
    logger.error(
      {
        err: (err as Error).message,
        agent_id: agentId,
        tenant_id: tenantId,
        event_id: raw.event_id,
      },
      'agent-lifecycle-subscriber: upsert failed — nacking for redelivery',
    );
    message.nack();
  }
}

async function upsertAgentLifecycle(
  agentId: string,
  tenantId: string,
  lifecycle: string,
  entityVersion: number | undefined,
): Promise<void> {
  await withTenantScope(tenantId, async (client) => {
    await client.query(
      `INSERT INTO agents (id, tenant_id, lifecycle, entity_version, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (id) DO UPDATE SET
         lifecycle      = EXCLUDED.lifecycle,
         entity_version = GREATEST(agents.entity_version, EXCLUDED.entity_version),
         updated_at     = NOW()
       WHERE EXCLUDED.entity_version >= agents.entity_version`,
      [agentId, tenantId, lifecycle, entityVersion ?? 1],
    );
  });
}

let cachedSubscription: Subscription | null = null;

export function startAgentLifecycleSubscriber(opts?: {
  projectId?: string;
  subscriptionName?: string;
}): Subscription | null {
  if (cachedSubscription) return cachedSubscription;

  const environment = process.env.ENVIRONMENT || 'dev';
  const subscriptionName =
    opts?.subscriptionName ??
    process.env.AGENT_LIFECYCLE_SUBSCRIPTION_NAME ??
    `governance-agent-lifecycle-${environment}-sub`;

  let pubsub: PubSub;
  try {
    pubsub = new PubSub(
      opts?.projectId || process.env.GCP_PROJECT_ID
        ? { projectId: opts?.projectId || process.env.GCP_PROJECT_ID }
        : {},
    );
  } catch (err) {
    logger.error(
      { err: (err as Error).message },
      'agent-lifecycle-subscriber: failed to construct PubSub client — subscriber disabled',
    );
    return null;
  }

  const subscription = pubsub.subscription(subscriptionName, {
    flowControl: { maxMessages: 4, allowExcessMessages: false },
  });

  subscription.on('message', (message: Message) => {
    void handleAgentLifecycleMessage(message).catch((err) => {
      logger.error(
        { err: (err as Error).message },
        'agent-lifecycle-subscriber: handler crashed — nacking',
      );
      message.nack();
    });
  });

  subscription.on('error', (err) => {
    logger.error(
      { err: (err as Error).message },
      'agent-lifecycle-subscriber: subscription error',
    );
  });

  logger.info({ subscriptionName }, 'agent-lifecycle-subscriber started');
  cachedSubscription = subscription;
  return subscription;
}

export function __resetSubscriberForTests(): void {
  cachedSubscription = null;
}
