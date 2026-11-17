// Phase 1c — Stripe webhook handler.
//
// Public HTTPS endpoint at POST /stripe/webhook. This is the ONE
// exception to the --no-allow-unauthenticated rule for
// YOUR_GCP_PROJECT services; authentication is the webhook
// signature itself.
//
// Requirements (plan 1c):
//   - Raw body preserved as Buffer (JSON parsing AFTER signature verify)
//   - stripe.webhooks.constructEvent with 300s tolerance
//   - Constant-time signature compare (delegated to Stripe SDK)
//   - Ack in <200ms by writing to stripe_webhook_events + outbox in
//     a single transaction, then returning 200
//   - Duplicate stripe_event_id = idempotent no-op
//   - Dual-secret window (current OR previous) for rotation

import { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import Stripe from 'stripe';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { enqueueOutboxEvent, type EventEnvelope } from '@liftoffos/outbox';
import { loadConfig } from '../infrastructure/config.js';

export interface StripeWebhookDeps {
  pool: Pool;
  stripe: Stripe;
  /** Current + previous secret for dual-secret rotation window. */
  webhookSecrets: string[];
  toleranceSeconds: number;
  log: { info: (msg: string, meta?: object) => void; warn: (msg: string, meta?: object) => void; error: (msg: string, meta?: object) => void };
}

export function registerStripeWebhook(app: FastifyInstance, deps: StripeWebhookDeps): void {
  // Register a custom contentTypeParser that preserves the raw body
  // as a Buffer. This runs BEFORE the handler so we can sign-verify
  // on raw bytes; JSON parsing happens AFTER verification.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_req, body, done) => {
      done(null, body);
    },
  );

  app.post<{ Body: Buffer }>(
    '/stripe/webhook',
    async (req: FastifyRequest<{ Body: Buffer }>, reply: FastifyReply) => {
      const rawBody = req.body;
      const signature = req.headers['stripe-signature'];
      if (!Buffer.isBuffer(rawBody) || typeof signature !== 'string') {
        return reply.code(400).send({ error: 'bad_request' });
      }

      // Try every configured secret (dual-secret window). Bubbles up
      // only if ALL fail.
      let event: Stripe.Event | null = null;
      let verifyError: string | null = null;
      for (const secret of deps.webhookSecrets) {
        try {
          event = deps.stripe.webhooks.constructEvent(
            rawBody,
            signature,
            secret,
            deps.toleranceSeconds,
          );
          break;
        } catch (err) {
          verifyError = err instanceof Error ? err.message : String(err);
        }
      }
      if (!event) {
        deps.log.warn('stripe.webhook.signature_rejected', { error: verifyError });
        return reply.code(400).send({ error: 'signature_verification_failed' });
      }

      // Durable write + outbox publish in a single transaction → 200 back to Stripe.
      const client = await deps.pool.connect();
      try {
        await client.query('BEGIN');
        const payloadSha256 = createHash('sha256').update(rawBody).digest('hex');
        const sigTimestampMs = extractSignatureTimestamp(signature);

        const insert = await client.query<{ id: string }>( // rls-fence: allow (stripe_webhook_events carries no row-level security)
          `INSERT INTO stripe_webhook_events (
             stripe_event_id, stripe_event_type, livemode, api_version,
             payload_sha256, payload, signature, signature_timestamp_ms
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (stripe_event_id) DO NOTHING
           RETURNING id`,
          [
            event.id,
            event.type,
            event.livemode,
            event.api_version,
            payloadSha256,
            JSON.stringify(event),
            signature,
            sigTimestampMs,
          ],
        );

        if (insert.rows.length === 0) {
          // Duplicate stripe_event_id — idempotent no-op.
          await client.query('ROLLBACK');
          deps.log.info('stripe.webhook.duplicate_event', { eventId: event.id });
          return reply.code(200).send({ received: true, duplicate: true });
        }

        // Emit an outbox event so downstream processors (invoice
        // finalizer, subscription updater, credit-balance adjuster)
        // pick it up asynchronously.
        const tenantId = await resolveEventTenant(client, event); // see note below
        const outboxEnv: EventEnvelope<{ stripeEventId: string; stripeEventType: string }> = {
          eventId: randomUUID(),
          eventType: `billing.stripe.${event.type}`,
          schemaVersion: 1,
          tenantId,
          occurredAt: new Date(event.created * 1000),
          sourceService: 'liftoff-billing',
          traceId: (req.headers['traceparent'] as string | undefined) ?? null,
          payload: { stripeEventId: event.id, stripeEventType: event.type },
        };
        // outbox_events has RLS enabled — must set app.current_tenant_id before INSERT.
        // SET LOCAL doesn't support $1 params; use set_config with is_local=true instead.
        await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant_id', tenantId]);
        await enqueueOutboxEvent(client, outboxEnv);

        await client.query('COMMIT');
        return reply.code(200).send({ received: true });
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* ignore */ }
        deps.log.error('stripe.webhook.durable_write_failed', {
          eventId: event.id,
          error: err instanceof Error ? err.message : String(err),
        });
        // Return 500 — Stripe will retry. The retry is idempotent via
        // stripe_event_id UNIQUE.
        return reply.code(500).send({ error: 'durable_write_failed' });
      } finally {
        client.release();
      }
    },
  );
}

function extractSignatureTimestamp(sig: string): number {
  // Stripe signature header format: `t=<unix-seconds>,v1=<hash>,...`
  const match = sig.match(/(?:^|,)t=(\d+)/);
  return match ? Number(match[1]) * 1000 : 0;
}

/**
 * Stripe events carry the tenant link via `client_reference_id` on
 * checkout sessions or `metadata.tenant_id` on subscriptions /
 * invoices — the latter is the convention liftoff-billing populates
 * at CreateCheckoutSession time. If neither is present (early-ack
 * webhook types like `balance.available`), we fall back to emitting
 * the outbox row with a sentinel tenant_id; downstream processors
 * skip them.
 */
function extractTenantIdFromEvent(event: Stripe.Event): string | null {
  const obj = event.data.object as { metadata?: Record<string, string>; client_reference_id?: string | null };
  return (
    obj?.metadata?.tenant_id ??
    (obj?.client_reference_id as string | null | undefined) ??
    null
  );
}

/**
 * Resolves the tenant ID for a Stripe event. Falls back to a DB lookup
 * for invoice events (which lack metadata.tenant_id) using a SECURITY
 * DEFINER function that bypasses RLS (billing_migrate is the table owner).
 * If unresolvable, returns a random sentinel UUID so downstream consumers
 * can still classify and skip non-tenant events.
 */
async function resolveEventTenant(client: PoolClient, event: Stripe.Event): Promise<string> {
  const fromMeta = extractTenantIdFromEvent(event);
  if (fromMeta) return fromMeta;

  if (event.type.startsWith('invoice.')) {
    const inv = event.data.object as Stripe.Invoice;
    // Attribute by the invoice's subscription first (stable per account life),
    // then customer as a fallback. This only seeds the outbox envelope; the
    // consumer re-resolves authoritatively (and retries if the subscription is
    // not yet synced), so a sentinel here is recoverable.
    const subId = typeof inv.subscription === 'string' ? inv.subscription : null;
    if (subId) {
      try {
        const r = await client.query<{ tenant_id: string | null }>( // rls-fence: allow (cross-tenant resolution via SECURITY DEFINER fn; no direct table access)
          `SELECT tenant_id_for_stripe_subscription($1) AS tenant_id`,
          [subId],
        );
        if (r.rows[0]?.tenant_id) return r.rows[0].tenant_id;
      } catch { /* non-fatal — fall through */ }
    }
    const customerId = typeof inv.customer === 'string'
      ? inv.customer
      : (inv.customer as Stripe.Customer | null)?.id ?? null;
    if (customerId) {
      try {
        const r = await client.query<{ tenant_id: string | null }>( // rls-fence: allow (cross-tenant resolution via SECURITY DEFINER fn; no direct table access)
          `SELECT tenant_id_for_stripe_customer($1) AS tenant_id`,
          [customerId],
        );
        if (r.rows[0]?.tenant_id) return r.rows[0].tenant_id;
      } catch { /* non-fatal — fall through to sentinel */ }
    }
  }

  return randomUUID();
}

// Helper — loaded from config + Secret Manager at bootstrap.
export async function loadWebhookSecrets(): Promise<string[]> {
  const config = loadConfig();
  if (process.env.NODE_ENV === 'test') {
    const base = process.env.STRIPE_WEBHOOK_SECRET ?? 'whsec_test';
    const prev = process.env.STRIPE_WEBHOOK_SECRET_PREVIOUS;
    return prev ? [base, prev] : [base];
  }
  const { SecretManagerServiceClient } = await import('@google-cloud/secret-manager');
  const client = new SecretManagerServiceClient();
  const out: string[] = [];
  for (const name of [config.STRIPE_WEBHOOK_SECRET, config.STRIPE_WEBHOOK_SECRET_PREVIOUS]) {
    try {
      const [v] = await client.accessSecretVersion({
        name: `projects/${config.GCP_PROJECT_ID}/secrets/${name}/versions/latest`,
      });
      const raw = v.payload?.data;
      const payload = raw ? (typeof raw === 'string' ? raw : Buffer.from(raw as Uint8Array).toString('utf-8')) : undefined;
      if (payload) out.push(payload);
    } catch {
      // Previous secret is optional during normal operation.
    }
  }
  if (out.length === 0) {
    throw new Error('no Stripe webhook secrets resolved from Secret Manager');
  }
  return out;
}
