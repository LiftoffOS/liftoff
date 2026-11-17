// Oversight settings subscriber.
//
// Platform-backend publishes `tenant.oversight.updated` onto the shared
// `control-plane-events-{ENVIRONMENT}` Pub/Sub topic whenever a tenant
// changes their autonomy/escalation/sensitiveWork/communication settings
// from the /oversight page.  This subscriber materialises that payload into
// the local `tenant_oversight_cache` table so the HITL enforcement service
// can resolve the correct HITL level without RPC'ing the control plane on
// every Preflight/Authorize call.
//
// The subscriber is idempotent: it UPSERTs by tenant_id and respects an
// `entity_version` monotonic counter so out-of-order deliveries don't
// overwrite newer state with older state (same GREATEST() pattern as the
// entitlements subscriber).

import { PubSub, Message, Subscription } from '@google-cloud/pubsub';
import { withTenantScope } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';

const OVERSIGHT_EVENT_TYPE = 'tenant.oversight.updated';

export interface OversightEventPayload {
  autonomy?: string;
  escalation?: string;
  sensitiveWork?: {
    customerCommunication?: boolean;
    financialActions?: boolean;
    dataChanges?: boolean;
    externalPublishing?: boolean;
    hiringDecisions?: boolean;
    [key: string]: boolean | undefined;
  };
  communication?: string;
  [key: string]: unknown;
}

export interface ControlPlaneOversightEnvelope {
  event_id?: string;
  event_type: string;
  entity_type?: string;
  entity_id?: string;
  entity_version?: number;
  tenant_id?: string;
  payload?: OversightEventPayload;
}

// Exported for direct unit testing — the message handler in isolation
// from the Pub/Sub client.
export async function handleOversightMessage(
  message: Pick<Message, 'data' | 'ack' | 'nack'>,
): Promise<void> {
  let raw: ControlPlaneOversightEnvelope;
  try {
    raw = JSON.parse(message.data.toString()) as ControlPlaneOversightEnvelope;
  } catch (err) {
    logger.error(
      { err: (err as Error).message },
      'oversight-subscriber: invalid JSON, acking to drop',
    );
    message.ack();
    return;
  }

  if (raw.event_type !== OVERSIGHT_EVENT_TYPE) {
    // Other event types on the same topic — not for us. Ack to keep
    // the subscription flowing.
    message.ack();
    return;
  }

  const tenantId = raw.tenant_id;
  if (!tenantId) {
    logger.warn(
      { event_type: raw.event_type, event_id: raw.event_id },
      'oversight-subscriber: event missing tenant_id — acking to drop',
    );
    message.ack();
    return;
  }

  const payload = raw.payload ?? {};
  try {
    await upsertOversightCache(tenantId, payload, raw.entity_version);
    logger.info(
      {
        tenant_id: tenantId,
        event_id: raw.event_id,
        entity_version: raw.entity_version,
        autonomy: payload.autonomy,
      },
      'oversight-subscriber: tenant_oversight_cache upserted',
    );
    message.ack();
  } catch (err) {
    logger.error(
      {
        err: (err as Error).message,
        tenant_id: tenantId,
        event_id: raw.event_id,
      },
      'oversight-subscriber: upsert failed — nacking for redelivery',
    );
    message.nack();
  }
}

async function upsertOversightCache(
  tenantId: string,
  payload: OversightEventPayload,
  entityVersion: number | undefined,
): Promise<void> {
  await withTenantScope(tenantId, async (client) => {
    const autonomy = payload.autonomy ?? 'balanced';
    const escalation = payload.escalation ?? 'sensitive';
    const sensitiveWork = payload.sensitiveWork ?? {};
    const communication = payload.communication ?? 'review';

    await client.query(
      `INSERT INTO tenant_oversight_cache (
          tenant_id, entity_version, autonomy, escalation, sensitive_work, communication, synced_at
        )
        VALUES ($1, $2, $3, $4, $5::jsonb, $6, NOW())
        ON CONFLICT (tenant_id) DO UPDATE SET
          entity_version = GREATEST(
            tenant_oversight_cache.entity_version,
            EXCLUDED.entity_version
          ),
          autonomy       = EXCLUDED.autonomy,
          escalation     = EXCLUDED.escalation,
          sensitive_work = EXCLUDED.sensitive_work,
          communication  = EXCLUDED.communication,
          synced_at      = NOW()
        WHERE EXCLUDED.entity_version >= tenant_oversight_cache.entity_version`,
      [
        tenantId,
        entityVersion ?? 1,
        autonomy,
        escalation,
        JSON.stringify(sensitiveWork),
        communication,
      ],
    );
  });
}

// Module-scoped subscription handle so startup can be idempotent — calling
// start twice returns the same handle rather than spawning a duplicate.
let cachedSubscription: Subscription | null = null;

export function startOversightSubscriber(opts?: {
  projectId?: string;
  subscriptionName?: string;
}): Subscription | null {
  if (cachedSubscription) return cachedSubscription;

  const environment = process.env.ENVIRONMENT || 'dev';
  const subscriptionName =
    opts?.subscriptionName ??
    process.env.OVERSIGHT_SUBSCRIPTION_NAME ??
    `governance-oversight-${environment}-sub`;

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
      'oversight-subscriber: failed to construct PubSub client — subscriber disabled',
    );
    return null;
  }

  const subscription = pubsub.subscription(subscriptionName, {
    flowControl: { maxMessages: 4, allowExcessMessages: false },
  });

  subscription.on('message', (message: Message) => {
    void handleOversightMessage(message).catch((err) => {
      logger.error(
        { err: (err as Error).message },
        'oversight-subscriber: handler crashed — nacking',
      );
      message.nack();
    });
  });

  subscription.on('error', (err) => {
    logger.error(
      { err: (err as Error).message },
      'oversight-subscriber: subscription error',
    );
  });

  logger.info({ subscriptionName }, 'oversight-subscriber started');
  cachedSubscription = subscription;
  return subscription;
}

// Test-only reset.
export function __resetSubscriberForTests(): void {
  cachedSubscription = null;
}
