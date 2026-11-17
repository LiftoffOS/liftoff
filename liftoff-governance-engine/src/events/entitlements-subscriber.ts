// Entitlements subscriber.
//
// Phase 3 design: platform-backend owns entitlements and Stripe customer
// identifiers. When those change it publishes `tenant.entitlement.updated`
// (dotted, legacy "tenant.entitlement_updated" also tolerated) onto the
// shared `control-plane-events-{ENVIRONMENT}` Pub/Sub topic. Governance-
// engine subscribes to that topic and materialises the payload into the
// local `cached_entitlements` table so admission + stripe-meter read a
// local cache rather than RPC'ing the control plane on every call.
//
// The subscriber is idempotent: it UPSERTs by tenant_id + respects an
// `entity_version` monotonic counter so out-of-order deliveries don't
// overwrite newer state with older state.

import { PubSub, Message, Subscription } from '@google-cloud/pubsub';
import { withTenantScope } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';

// TTL for the cached entitlements row. Platform-backend emits refresh
// events at most once per day; we give ourselves 24h of headroom so a
// brief subscriber outage doesn't instantly invalidate every tenant.
const ENTITLEMENT_TTL_MS = 24 * 60 * 60 * 1000;

// Event types we care about on the control-plane-events topic.
// Platform-backend emits 'tenant.entitlement.updated' (dotted); older
// code referred to 'tenant.entitlement_updated' — accept both.
const ENTITLEMENT_EVENT_TYPES = new Set<string>([
  'tenant.entitlement.updated',
  'tenant.entitlement_updated',
]);

export interface EntitlementEventPayload {
  customerId?: string;
  stripeCustomerId?: string;
  plan?: string;
  operationalStatus?: string;
  agentExecutionAllowed?: boolean;
  remainingIncludedCredits?: number;
  overageAllowed?: boolean;
  overageCeiling?: number;
  includedMonthlyCredits?: number;
  // Pass-through for future fields.
  [key: string]: unknown;
}

export interface ControlPlaneEventEnvelope {
  event_id?: string;
  event_type: string;
  entity_type?: string;
  entity_id?: string;
  entity_version?: number;
  tenant_id?: string;
  payload?: EntitlementEventPayload;
}

// Exported for direct unit testing — the message handler in isolation
// from the Pub/Sub client.
export async function handleEntitlementMessage(
  message: Pick<Message, 'data' | 'ack' | 'nack'>,
): Promise<void> {
  let raw: ControlPlaneEventEnvelope;
  try {
    raw = JSON.parse(message.data.toString()) as ControlPlaneEventEnvelope;
  } catch (err) {
    logger.error(
      { err: (err as Error).message },
      'entitlements-subscriber: invalid JSON, acking to drop',
    );
    message.ack();
    return;
  }

  const eventType = raw.event_type;
  if (!ENTITLEMENT_EVENT_TYPES.has(eventType)) {
    // Other event types on the same topic — not for us. Ack to keep
    // the subscription flowing; governance-engine only owns the
    // entitlements subset here.
    message.ack();
    return;
  }

  const tenantId = raw.tenant_id;
  if (!tenantId) {
    logger.warn(
      { event_type: eventType, event_id: raw.event_id },
      'entitlements-subscriber: event missing tenant_id — acking to drop',
    );
    message.ack();
    return;
  }

  const payload = raw.payload ?? {};
  try {
    await upsertCachedEntitlement(tenantId, payload, raw.entity_version);
    logger.info(
      {
        tenant_id: tenantId,
        event_id: raw.event_id,
        entity_version: raw.entity_version,
      },
      'entitlements-subscriber: cached_entitlements upserted',
    );
    message.ack();
  } catch (err) {
    logger.error(
      {
        err: (err as Error).message,
        tenant_id: tenantId,
        event_id: raw.event_id,
      },
      'entitlements-subscriber: upsert failed — nacking for redelivery',
    );
    message.nack();
  }
}

async function upsertCachedEntitlement(
  tenantId: string,
  payload: EntitlementEventPayload,
  entityVersion: number | undefined,
): Promise<void> {
  await withTenantScope(tenantId, async (client) => {
    const expiresAt = new Date(Date.now() + ENTITLEMENT_TTL_MS);
    const operationalStatus = payload.operationalStatus ?? 'active';
    // Preserve the entire payload in entitlements_json so future readers
    // can pick out whichever field they need. Subsequent writes replace
    // the blob wholesale (entitlements are fully-resolved snapshots).
    const entitlementsJson = JSON.stringify(payload);

    // Admission columns — default conservatively when absent from payload.
    const agentExecutionAllowed = payload.agentExecutionAllowed ?? true;
    const includedMonthlyCredits = payload.includedMonthlyCredits ?? null;
    const overageCeiling = payload.overageCeiling ?? 0;
    const overageAllowed = payload.overageAllowed ?? false;

    await client.query(
      `INSERT INTO cached_entitlements (
          tenant_id, entitlements_json, entity_version,
          operational_status, agent_execution_allowed,
          included_monthly_credits, overage_ceiling, overage_allowed,
          cached_at, expires_at, updated_at
        )
        VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, $8, NOW(), $9, NOW())
        ON CONFLICT (tenant_id) DO UPDATE SET
          entitlements_json        = EXCLUDED.entitlements_json,
          entity_version           = GREATEST(
            cached_entitlements.entity_version,
            EXCLUDED.entity_version
          ),
          operational_status       = EXCLUDED.operational_status,
          agent_execution_allowed  = EXCLUDED.agent_execution_allowed,
          included_monthly_credits = EXCLUDED.included_monthly_credits,
          overage_ceiling          = EXCLUDED.overage_ceiling,
          overage_allowed          = EXCLUDED.overage_allowed,
          cached_at                = NOW(),
          expires_at               = EXCLUDED.expires_at,
          updated_at               = NOW()
        WHERE EXCLUDED.entity_version >= cached_entitlements.entity_version`,
      [
        tenantId,
        entitlementsJson,
        entityVersion ?? 1,
        operationalStatus,
        agentExecutionAllowed,
        includedMonthlyCredits,
        overageCeiling,
        overageAllowed,
        expiresAt,
      ],
    );
  });
}

// Module-scoped subscription handle so startup can be idempotent — calling
// start twice returns the same handle rather than spawning a duplicate.
let cachedSubscription: Subscription | null = null;

export function startEntitlementsSubscriber(opts?: {
  projectId?: string;
  subscriptionName?: string;
}): Subscription | null {
  if (cachedSubscription) return cachedSubscription;

  const environment = process.env.ENVIRONMENT || 'dev';
  const subscriptionName =
    opts?.subscriptionName ??
    process.env.ENTITLEMENTS_SUBSCRIPTION_NAME ??
    `governance-entitlements-${environment}-sub`;

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
      'entitlements-subscriber: failed to construct PubSub client — subscriber disabled',
    );
    return null;
  }

  const subscription = pubsub.subscription(subscriptionName, {
    flowControl: { maxMessages: 4, allowExcessMessages: false },
  });

  subscription.on('message', (message: Message) => {
    void handleEntitlementMessage(message).catch((err) => {
      logger.error(
        { err: (err as Error).message },
        'entitlements-subscriber: handler crashed — nacking',
      );
      message.nack();
    });
  });

  subscription.on('error', (err) => {
    logger.error(
      { err: (err as Error).message },
      'entitlements-subscriber: subscription error',
    );
  });

  logger.info({ subscriptionName }, 'entitlements-subscriber started');
  cachedSubscription = subscription;
  return subscription;
}

// Test-only reset.
export function __resetSubscriberForTests(): void {
  cachedSubscription = null;
}
