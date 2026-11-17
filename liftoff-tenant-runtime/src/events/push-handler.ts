// Push-delivery HTTP handler for control-plane Pub/Sub topics.
//
// Phase 5 (push migration): coordinator-service exposes one POST endpoint per
// subscribed topic at /internal/pubsub/<topic>. Pub/Sub HTTPs each message to
// the matching endpoint with an OIDC bearer token whose audience is the
// coordinator service URL and whose `email` claim is the dedicated push SA
// (`tenant-runtime-pubsub-push-{env}@YOUR_GCP_PROJECT.iam`).
//
// Status code contract:
//   - 204 → message acked (success, schema-invalid → DLQ table, unknown event
//           type warn-and-ack).
//   - 400 → malformed Pub/Sub envelope (Pub/Sub stops redelivering after one
//           attempt for permanent envelope errors).
//   - 401 → missing/invalid OIDC bearer token (Pub/Sub redelivers).
//   - 500 → transient handler error (Pub/Sub redelivers with exponential
//           backoff up to max_delivery_attempts; then DLQ).
//
// Reference handler shape: liftoff-platform-backend
// src/billing/spend-subscriber.ts (envelope + OIDC).

import { Router, type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../infrastructure/logging';
import { setTraceContext } from '../infrastructure/safe-trace-context';
import { extractBearerToken, verifyGoogleOidcToken } from '../security/oidc-verifier';
import { DlqRoutedError, EntityBusyError } from './event-processor';
import { SUBSCRIBED_EVENTS, dispatchEvent, subscriberPool, UUID_REGEX } from './subscriber';
import { isKnownTenant } from '../infrastructure/tenant-registry';

/**
 * WS-4.2: extract tenant_id from the parsed Pub/Sub event envelope so DLQ
 * + retry log lines carry real attribution instead of 'unknown'.
 */
function extractTenantIdFromEnvelopeEvent(rawEvent: unknown): string | null {
  if (!rawEvent || typeof rawEvent !== 'object') return null;
  const r = rawEvent as Record<string, unknown>;
  const v = r.tenant_id ?? r.tenantId;
  return typeof v === 'string' ? v : null;
}

// Subscriber-side poison cap. By attempt 8 we accept the event isn't
// recoverable and DLQ proactively — avoids 2 more useless retries before
// Pub/Sub's own maxDeliveryAttempts=10 cap kicks in.
const POISON_DELIVERY_ATTEMPT_CAP = 8;

/** Classify whether an unhandled error from dispatchEvent is transient
 *  (Pub/Sub retry helps) or permanent (redelivery is wasteful + dangerous). */
function classifyError(err: Error): 'transient' | 'permanent' {
  const msg = err.message.toLowerCase();
  const name = err.name;
  if (name === 'EntityBusyError') return 'transient';
  if (msg.includes('econnreset') || msg.includes('etimedout') ||
      msg.includes('connect timeout') || msg.includes('eai_again') ||
      msg.includes('socket hang up')) {
    return 'transient';
  }
  if (msg.includes('foreign key') || msg.includes('check constraint') ||
      msg.includes('invalid input syntax') || msg.includes('null value in column')) {
    return 'permanent';
  }
  // Default: transient. Better to over-retry than under-DLQ a real bug.
  return 'transient';
}

/** Why this handler gave up, as recorded in dlq_messages.error. */
type DlqDisposition = 'over-attempt' | 'permanent';

/** The triage class stored in dlq_messages.failure_class.
 *
 *  Recorded at write time rather than reconstructed later, because
 *  reconstructing it means parsing prose out of the `error` column, which is
 *  exactly the archaeology that let 644 rows sit untriaged for four months.
 *  The two values imply different remediations:
 *
 *    transient  retries ran out on a fault that looked recoverable. Replaying
 *               once the dependency is healthy is the fix.
 *    permanent  a schema or contract defect. Replaying changes nothing; the
 *               code or the producer has to change first. */
const FAILURE_CLASS: Record<DlqDisposition, 'transient' | 'permanent'> = {
  'over-attempt': 'transient',
  permanent: 'permanent',
};

async function writeToDlqMessages(
  raw: unknown,
  error: Error,
  deliveryAttempt: number,
  messageId: string | null,
  topic: string,
  classification: DlqDisposition,
): Promise<void> {
  const rawTenantId = typeof (raw as { tenant_id?: string })?.tenant_id === 'string'
    ? (raw as { tenant_id: string }).tenant_id
    : '';
  const tenantIdForDlq = UUID_REGEX.test(rawTenantId)
    ? rawTenantId
    : '00000000-0000-0000-0000-000000000000';
  await subscriberPool.query(
    `INSERT INTO dlq_messages (id, original_topic, original_message_id, tenant_id, payload, error,
       delivery_attempt, max_delivery_attempts, first_received_at, failed_at, status, failure_class)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 10, NOW(), NOW(), 'pending', $8)
     ON CONFLICT (id) DO NOTHING`,
    [
      uuidv4(),
      topic,
      messageId ?? 'unknown',
      tenantIdForDlq,
      JSON.stringify(raw),
      `[${classification}] ${error.message.substring(0, 1000)}`,
      deliveryAttempt,
      FAILURE_CLASS[classification],
    ],
  );
}

// Pub/Sub push envelope shape (per
// https://cloud.google.com/pubsub/docs/push#receive_push):
//
//   {
//     "message": {
//       "data": "<base64-encoded payload>",
//       "messageId": "...",
//       "publishTime": "...",
//       "attributes": { ... },
//       "deliveryAttempt": 1   // present when subscription has dead_letter_policy
//     },
//     "subscription": "projects/<proj>/subscriptions/<name>"
//   }
interface PubSubPushMessage {
  data?: string;
  messageId?: string;
  publishTime?: string;
  attributes?: Record<string, string>;
  deliveryAttempt?: number;
}

interface PubSubPushEnvelope {
  message?: PubSubPushMessage;
  subscription?: string;
}

function isPushEnvelope(body: unknown): body is PubSubPushEnvelope {
  if (!body || typeof body !== 'object') return false;
  const env = body as Record<string, unknown>;
  if (!env.message || typeof env.message !== 'object') return false;
  return true;
}

/**
 * Build the Express router that mounts POST /internal/pubsub/:topic for every
 * topic in SUBSCRIBED_EVENTS. Unknown topic → 404 (default Express behaviour).
 *
 * OIDC audience and allowed-email are read from process.env at request time:
 *   - COORDINATOR_SERVICE_URL — Cloud Run URL coordinator was deployed at;
 *     Pub/Sub mints push-token `aud` to this exact value (no trailing slash).
 *   - PUBSUB_PUSH_SA_EMAIL    — dedicated push SA in
 *     YOUR_GCP_PROJECT; the OIDC `email` claim must match.
 *
 * Reading at request time (not module-load time) means a Cloud Run revision
 * picked up by the cloudbuild patch step (which sets these env vars after the
 * service is up) doesn't need a router rebuild — first request after the env
 * lands is authenticated correctly. index.ts startup-guards on both being set
 * before the listener binds.
 */
export function buildPushHandlerRouter(): Router {
  const router = Router();

  for (const topic of SUBSCRIBED_EVENTS) {
    router.post(`/${topic}`, (req, res) => handlePush(req, res, topic));
  }

  // Tunnel routes-changed lives outside the control-plane-events schema —
  // payload is just { tenantId }. Verified via the same OIDC pattern, then
  // invalidates the tenant's MCP URL allowlist cache.
  router.post('/mcp-tunnel-routes-changed', (req, res) =>
    handleTunnelRoutesChanged(req, res),
  );

  return router;
}

async function handleTunnelRoutesChanged(req: Request, res: Response): Promise<void> {
  const topic = 'mcp-tunnel-routes-changed';
  const token = extractBearerToken(req.headers.authorization);
  if (!token) {
    res.status(401).json({ error: 'missing_bearer_token' });
    return;
  }
  const audience = process.env.COORDINATOR_SERVICE_URL;
  const pushSaEmail = process.env.PUBSUB_PUSH_SA_EMAIL;
  if (!audience || !pushSaEmail) {
    res.status(500).json({ error: 'push_handler_misconfigured' });
    return;
  }
  const verifyResult = await verifyGoogleOidcToken(token, {
    audience,
    allowedEmails: [pushSaEmail],
  });
  if (verifyResult.ok !== true) {
    res.status(401).json({ error: 'oidc_verification_failed', reason: verifyResult.reason });
    return;
  }
  if (!isPushEnvelope(req.body) || !req.body.message?.data) {
    res.status(400).json({ error: 'malformed_envelope' });
    return;
  }
  let payload: { tenantId?: string };
  try {
    payload = JSON.parse(Buffer.from(req.body.message.data, 'base64').toString('utf-8'));
  } catch {
    res.status(400).json({ error: 'payload_decode_failed' });
    return;
  }
  const tenantId = payload.tenantId;
  if (!tenantId) {
    res.status(400).json({ error: 'missing_tenant_id' });
    return;
  }
  // Ignore events for tenants this runtime does not serve. The topic is shared
  // cross-tenant in platform-control; filtering happens here rather than via a
  // per-tenant subscription filter so we can use Pub/Sub's fan-out without
  // proliferating subscriptions.
  //
  // A membership question, and against the `tenants` TABLE. The check was
  // `tenantId !== process.env.TENANT_ID`, which is wrong twice over: TENANT_ID
  // holds the DEPLOYMENT slug (`liftoffos`) while the payload carries a tenant
  // UUID, so the comparison never matched and every event was dropped; and even
  // with matching id spaces it would serve exactly one tenant on a runtime that
  // serves many. Both failures are silent, because the drop answers 204.
  if (!(await isKnownTenant(tenantId))) {
    res.status(204).end();
    return;
  }
  const { getTenantAllowlistProvider } = await import('../security/tenant-allowlist-provider');
  try {
    getTenantAllowlistProvider().invalidate(tenantId);
    logger.info('mcp_tunnel_routes_changed_invalidated', { topic, tenantId });
    res.status(204).end();
  } catch (err) {
    logger.warn('mcp_tunnel_routes_changed_invalidate_failed', {
      topic,
      tenantId,
      err: (err as Error).message,
    });
    // 204 anyway — the 60s TTL is the durability fallback; redelivering
    // won't help if the singleton isn't configured.
    res.status(204).end();
  }
}

async function handlePush(
  req: Request,
  res: Response,
  topic: string,
): Promise<void> {
  const subscription = inferSubscriptionName(req.body, topic);

  // ── 1. Verify OIDC bearer token ──────────────────────────────────────────
  const token = extractBearerToken(req.headers.authorization);
  if (!token) {
    logger.warn('Pub/Sub push: missing bearer token', { topic, subscription });
    res.status(401).json({ error: 'missing_bearer_token' });
    return;
  }
  const audience = process.env.COORDINATOR_SERVICE_URL;
  const pushSaEmail = process.env.PUBSUB_PUSH_SA_EMAIL;
  if (!audience || !pushSaEmail) {
    // Startup guard in index.ts already prevents this in prod, but defend in
    // depth — a later config wipe should fail closed, not open.
    logger.error('Pub/Sub push: COORDINATOR_SERVICE_URL or PUBSUB_PUSH_SA_EMAIL not set', {
      topic,
      subscription,
    });
    res.status(500).json({ error: 'push_handler_misconfigured' });
    return;
  }
  const verifyResult = await verifyGoogleOidcToken(token, {
    audience,
    allowedEmails: [pushSaEmail],
  });
  if (verifyResult.ok !== true) {
    const reason = verifyResult.reason;
    logger.warn('Pub/Sub push: OIDC verification failed', {
      topic,
      subscription,
      reason,
    });
    res.status(401).json({ error: 'oidc_verification_failed', reason });
    return;
  }

  // ── 2. Validate envelope + decode payload ────────────────────────────────
  if (!isPushEnvelope(req.body)) {
    logger.warn('Pub/Sub push: malformed envelope', { topic, subscription });
    res.status(400).json({ error: 'malformed_envelope' });
    return;
  }
  const message = req.body.message;
  if (!message || typeof message.data !== 'string' || message.data.length === 0) {
    logger.warn('Pub/Sub push: envelope missing message.data', {
      topic,
      subscription,
      messageId: message?.messageId,
    });
    res.status(400).json({ error: 'envelope_missing_data' });
    return;
  }

  const messageId = message.messageId ?? null;
  const deliveryAttempt = message.deliveryAttempt ?? 1;

  let rawEvent: unknown;
  try {
    const decoded = Buffer.from(message.data, 'base64').toString('utf-8');
    rawEvent = JSON.parse(decoded);
  } catch (err) {
    // Malformed payload (not valid base64 → utf8 → JSON) is unrecoverable;
    // returning 400 stops Pub/Sub from redelivering futilely. The schema
    // validator inside dispatchEvent would also catch a parsed-but-invalid
    // event and route it to the DLQ table; here we have nothing to write.
    logger.warn('Pub/Sub push: payload decode failed', {
      topic,
      subscription,
      messageId,
      deliveryAttempt,
      error: (err as Error).message,
    });
    res.status(400).json({ error: 'payload_decode_failed' });
    return;
  }

  const eventType = (rawEvent && typeof rawEvent === 'object'
    ? (rawEvent as Record<string, unknown>).event_type
    : undefined) as string | undefined;

  // WS-4.2: extract tenant_id from the parsed event so DLQ + retry log
  // lines downstream carry real attribution.
  const envelopeTenantId = extractTenantIdFromEnvelopeEvent(rawEvent);
  if (envelopeTenantId) setTraceContext({ tenantId: envelopeTenantId });

  logger.info('Pub/Sub push: received', {
    topic,
    subscription,
    messageId,
    deliveryAttempt,
    event_type: eventType,
    tenant_id: envelopeTenantId ?? 'unknown',
  });

  // ── 3. Dispatch ──────────────────────────────────────────────────────────
  try {
    await dispatchEvent(rawEvent, deliveryAttempt, subscription);
    logger.info('Pub/Sub push: dispatched', {
      topic,
      subscription,
      messageId,
      deliveryAttempt,
      event_type: eventType,
      disposition: 'ack',
    });
    res.status(204).end();
  } catch (err) {
    // Name-based classification (with `instanceof` as a safety belt) routes
    // correctly when the same module is loaded under two paths at runtime —
    // `instanceof` then returns false even for a "real" DlqRoutedError.
    const errName = (err as { name?: string } | null)?.name;
    const error = err as Error;

    // 1. dispatchEvent already wrote dlq_messages + threw → ack.
    if (errName === 'DlqRoutedError' || error instanceof DlqRoutedError) {
      logger.info('Pub/Sub push: schema-invalid → DLQ table, acking', {
        topic, subscription, messageId, deliveryAttempt,
        event_type: eventType, disposition: 'dlq_ack',
      });
      res.status(204).end();
      return;
    }

    // 2. Concurrent processing on the same entity → let Pub/Sub retry.
    if (errName === 'EntityBusyError' || error instanceof EntityBusyError) {
      const busyErr = err as { eventId?: string; entityId?: string };
      logger.info('Pub/Sub push: entity busy — 500 for retry', {
        topic, subscription, messageId, deliveryAttempt,
      });
      res.status(500).json({
        error: 'entity_busy',
        event_id: busyErr.eventId,
        entity_id: busyErr.entityId,
      });
      return;
    }

    // 3. Subscriber-side poison cap. By attempt 8 we accept the event isn't
    // recoverable and DLQ proactively — avoids 2 more useless retries before
    // Pub/Sub's maxDeliveryAttempts=10 cap kicks in.
    if (deliveryAttempt >= POISON_DELIVERY_ATTEMPT_CAP) {
      try {
        await writeToDlqMessages(rawEvent, error, deliveryAttempt, messageId, topic, 'over-attempt');
      } catch (dlqErr) {
        logger.error('Over-attempt DLQ write failed', {
          messageId, dlqErr: (dlqErr as Error).message,
        });
      }
      logger.warn('Pub/Sub push: over-attempt cap reached — DLQ + ack', {
        topic, subscription, messageId, deliveryAttempt,
        event_type: eventType, disposition: 'over_attempt_ack',
      });
      res.status(204).end();
      return;
    }

    // 4. Classification.
    const classification = classifyError(error);
    if (classification === 'permanent') {
      try {
        await writeToDlqMessages(rawEvent, error, deliveryAttempt, messageId, topic, 'permanent');
      } catch (dlqErr) {
        logger.error('Permanent-error DLQ write failed', {
          messageId, dlqErr: (dlqErr as Error).message,
        });
      }
      logger.warn('Permanent processing error; DLQ + ack', {
        messageId, deliveryAttempt, errorName: errName, error: error.message,
        tenant_id: envelopeTenantId ?? 'unknown',
      });
      res.status(204).end();
      return;
    }

    // 5. Transient — Pub/Sub will redeliver per the subscription's retry_policy.
    logger.warn('Transient processing error; 500 for retry', {
      messageId, deliveryAttempt, errorName: errName, error: error.message,
      tenant_id: envelopeTenantId ?? 'unknown',
    });
    res.status(500).json({ error: 'transient', message: error.message.substring(0, 200) });
  }
}

// Pub/Sub provides the full subscription path (`projects/<proj>/subscriptions/<name>`)
// in the envelope. We extract the short name for log-friendliness; if absent
// (e.g. a manually-crafted test payload) we fall back to the topic with the
// `-coordinator-push` convention used in pubsub_push.tf so dashboards still
// match the alert filter.
function inferSubscriptionName(body: unknown, topic: string): string {
  if (body && typeof body === 'object') {
    const sub = (body as { subscription?: unknown }).subscription;
    if (typeof sub === 'string' && sub.length > 0) {
      const idx = sub.lastIndexOf('/');
      return idx >= 0 ? sub.slice(idx + 1) : sub;
    }
  }
  return `${topic}-${process.env.ENVIRONMENT || 'dev'}-coordinator-push`;
}
