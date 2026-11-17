// Stripe Connect webhooks — the only way an UPDATE to a Stripe object reaches
// an agent.
//
// WHY A WEBHOOK AND NOT A POLL. Stripe has no modified-since filter on any list
// endpoint: `GetInvoices` and `GetInvoicesSearch` filter on `created`, `status`
// and `customer`, never on update time, and the hosted MCP does not expose the
// events feed either (`GetEvents` answers "not available", and the OpenAPI spec
// it serves contains no events operations). So the poll in stripe-mcp.ts carries
// CREATIONS ONLY, by construction rather than by oversight — an invoice created
// before the watermark and later moved draft -> open -> paid is never returned
// by any list we can make. Webhooks are Stripe's answer to exactly this, which
// is why `invoice.updated` and `subscription.updated` were removed from the poll
// (0df6fa2) rather than patched.
//
// ONE ENDPOINT PER CONNECTOR, NOT ONE PER PLATFORM. Stripe authenticates here
// by DCR against access.stripe.com/mcp, so a tenant authorizes our client
// against THEIR OWN Stripe account rather than becoming a connected account on
// a platform. There is therefore no `connect: true` endpoint that could see
// everyone's events and no `account` field to key on: registration happens per
// connection, using that tenant's token, against a URL carrying their connector
// id — and each registration returns its own signing secret, stored with that
// connector's credential.
//
// AUTHENTICATED BY HMAC, NOT BY SERVICE TOKEN. Stripe's servers call this, so it
// mounts BEFORE `verifyServiceAuth` alongside the Meta, Slack and GitHub webhook
// mounts, and uses `express.raw` because Stripe signs the exact bytes sent — a
// re-serialized body produces a different digest.
//
// Delivery continues down the route:
//   publishConnectorWebhookEvent -> control-plane-events -> coordinator
//   -> tenant connector-events -> agent-service event trigger.

import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import { logger } from '../infra/logging.js';
import { publishConnectorWebhookEvent } from './connector-webhook-event.js';
import { findStripeConnectorById } from './stripe-account-lookup.js';
import { getConnectorCredential } from '../secrets/client.js';

export const stripeWebhookRouter = Router();

/** Stripe rejects deliveries older than this; so do we, to bound replay. */
const SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * Verify a `Stripe-Signature` header.
 *
 * The scheme is not GitHub's. The header is a comma-separated list —
 * `t=<unix>,v1=<hex>[,v1=<hex>]` — and the signed payload is `${t}.${rawBody}`,
 * NOT the body alone. Multiple v1 entries appear while a secret is being
 * rotated, so any match counts.
 */
export function verifyStripeSignature(
  rawBody: Buffer,
  signatureHeader: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): { ok: true } | { ok: false; reason: string } {
  const parts = (signatureHeader ?? '').split(',').map((p) => p.trim());
  const timestamp = parts.find((p) => p.startsWith('t='))?.slice(2);
  const signatures = parts.filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  if (!timestamp || signatures.length === 0) return { ok: false, reason: 'malformed_signature_header' };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'malformed_timestamp' };
  if (Math.abs(nowSeconds - ts) > SIGNATURE_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'timestamp_outside_tolerance' };
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody.toString('utf8')}`)
    .digest('hex');
  const a = Buffer.from(expected);

  // timingSafeEqual throws on a length mismatch rather than returning false.
  const matched = signatures.some((sig) => {
    const b = Buffer.from(sig);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
  return matched ? { ok: true } : { ok: false, reason: 'signature_mismatch' };
}

/**
 * Stripe event type -> the shared entity vocabulary the runtime routes on.
 *
 * Deliberately a prefix match on the object family, not the full event name:
 * the runtime routes on `entityType`, and the vendor's own event name travels
 * separately as `subtype` for filters that want it.
 */
export function entityTypeForStripeEvent(eventType: string): string | null {
  if (eventType.startsWith('invoice.')) return 'Invoice';
  if (eventType.startsWith('customer.subscription.')) return 'Subscription';
  if (eventType.startsWith('payment_intent.')) return 'PaymentIntent';
  return null;
}

stripeWebhookRouter.post('/webhook/:connectorId', async (req: Request, res: Response) => {
  const target = await findStripeConnectorById(req.params.connectorId).catch((err) => {
    logger.error({ err: (err as Error).message }, 'stripe_webhook_connector_lookup_failed');
    return null;
  });
  if (!target) {
    // A disconnected connector's endpoint keeps delivering until someone
    // deletes it at Stripe. 404 rather than 401: nothing was wrong with the
    // signature, there is simply nobody to deliver to.
    logger.info({ connector_id: req.params.connectorId }, 'stripe_webhook_unknown_connector');
    return res.status(404).json({ error: 'unknown connector' });
  }

  const credential = await getConnectorCredential(target.tenantId, target.connectorId).catch(() => null);
  const secret = (credential?.metadata as { webhookSigningSecret?: string } | undefined)?.webhookSigningSecret;
  if (!secret) {
    // Unconfigured is not the same as unauthorized. Accepting an unverifiable
    // delivery would mean acting on anything the internet posts here, so this
    // refuses — but says why, because a silent 401 during rollout looks
    // identical to a wrong secret.
    logger.error(
      { tenant_id: target.tenantId, connector_id: target.connectorId },
      'stripe_webhook_secret_not_stored',
    );
    return res.status(503).json({ error: 'stripe webhook not configured' });
  }

  const header = req.header('stripe-signature') ?? '';
  const rawBody = req.body as Buffer;
  if (!Buffer.isBuffer(rawBody)) {
    logger.error({}, 'stripe_webhook_body_not_raw');
    return res.status(500).json({ error: 'raw body required' });
  }

  const verdict = verifyStripeSignature(rawBody, header, secret);
  if (!verdict.ok) {
    logger.warn({ reason: verdict.reason }, 'stripe_webhook_signature_rejected');
    return res.status(401).json({ error: 'invalid signature' });
  }

  let event: {
    id?: string; type?: string; account?: string; created?: number;
    data?: { object?: Record<string, unknown> };
  };
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    logger.warn({}, 'stripe_webhook_body_not_json');
    return res.status(400).json({ error: 'invalid json' });
  }

  // ACK FIRST. Stripe retries on a non-2xx, and every failure below is ours to
  // fix rather than something a redelivery would resolve — an unmapped event
  // type stays unmapped, and an account we do not know stays unknown. Retrying
  // those would just repeat the same outcome on a schedule.
  res.status(200).json({ received: true });

  const eventType = event.type ?? '';
  const entityType = entityTypeForStripeEvent(eventType);
  if (!entityType) return; // A family we do not route. Not an error.

  const object = event.data?.object ?? {};
  const entityId = typeof object.id === 'string' ? object.id : (event.id ?? '');

  try {
    await publishConnectorWebhookEvent({
      source: 'stripe',
      subtype: eventType,
      entityType,
      entityId,
      tenantId: target.tenantId,
      connectorId: target.connectorId,
      // Stripe's own event id. It is the dedupe key, and Stripe redelivers the
      // same id on retry, so a redelivery must not re-run the agent.
      eventId: event.id ?? `${target.connectorId}:${entityId}:${eventType}`,
      data: object,
      occurredAt: event.created ? new Date(event.created * 1000).toISOString() : undefined,
    });
  } catch (err) {
    // Already ACKed, so this cannot be retried by Stripe. Log loudly rather
    // than fail silently — this is the hop that wakes the agent.
    logger.error(
      {
        err: (err as Error).message,
        tenant_id: target.tenantId,
        connector_id: target.connectorId,
        event_type: eventType,
      },
      'stripe_webhook_publish_failed',
    );
  }
});
