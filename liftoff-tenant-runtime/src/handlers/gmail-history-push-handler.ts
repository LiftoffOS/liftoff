// WS-9.2 — Gmail Pub/Sub push receiver.
//
// Google Gmail publishes history notifications to GMAIL_WATCH_TOPIC; Pub/Sub
// pushes them to this endpoint with an OIDC token. We fetch the new messages
// via users.history.list since the last history_id, normalize them, and
// republish to connector-events-${env} so the existing reactive-subscription
// + event-trigger consumers see Gmail-pushed messages identically to polled
// ones.
//
// Status code contract: 204 = ack (always, unless OIDC fails). Failures
// inside the handler are logged + ack'd so a malformed history fetch doesn't
// loop a permanently-bad payload.

import { Router, type Request, type Response } from 'express';
import { PubSub } from '@google-cloud/pubsub';
import crypto from 'crypto';
import { getPool } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';
import { setTraceContext } from '../infrastructure/safe-trace-context';
import { extractBearerToken, verifyGoogleOidcToken } from '../security/oidc-verifier';
import { getManagedSecret } from '../infrastructure/secret-store';

const router = Router();

interface GmailHistoryPushPayload {
  emailAddress: string;
  historyId: string | number;
}

router.post('/gmail-history-push', async (req: Request, res: Response) => {
  // 1. Verify OIDC bearer token (gmail Pub/Sub push uses the same scheduler-SA
  // pattern as the rest of the platform).
  const token = extractBearerToken(req.headers.authorization);
  if (!token) {
    logger.warn('gmail-history-push: missing bearer token');
    return res.status(401).json({ error: 'missing_bearer_token' });
  }
  // The audience is the Cloud Run service URL that hosts this endpoint. TR
  // services self-identify via TENANT_RUNTIME_URL — read through the
  // runtime-env validator (the plan §16 invariant). The validator state
  // carries either the resolved URL or a structured error we surface as
  // 500 below.
  const { getTenantRuntimeUrl } = await import('../infrastructure/runtime-env');
  const audience = getTenantRuntimeUrl();
  const pushSaEmail = process.env.PUBSUB_PUSH_SA_EMAIL;
  if (!audience || !pushSaEmail) {
    logger.error('gmail-history-push: AGENT_SERVICE_URL or PUBSUB_PUSH_SA_EMAIL not set');
    return res.status(500).json({ error: 'push_handler_misconfigured' });
  }
  const verify = await verifyGoogleOidcToken(token, { audience, allowedEmails: [pushSaEmail] });
  if (verify.ok !== true) {
    const reason = (verify as { ok: false; reason: string }).reason;
    logger.warn({ reason }, 'gmail-history-push: OIDC verification failed');
    return res.status(401).json({ error: 'oidc_verification_failed' });
  }

  // 2. Decode the Pub/Sub envelope.
  const message = (req.body as { message?: { data?: string } }).message;
  if (!message || typeof message.data !== 'string' || message.data.length === 0) {
    return res.status(400).json({ error: 'envelope_missing_data' });
  }
  let payload: GmailHistoryPushPayload;
  try {
    payload = JSON.parse(Buffer.from(message.data, 'base64').toString('utf-8')) as GmailHistoryPushPayload;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'gmail-history-push: payload decode failed');
    return res.status(400).json({ error: 'payload_decode_failed' });
  }

  // 3. Look up the subscription row by gmail user identity.
  const pool = getPool();
  const sub = await pool.query(
    `SELECT id, connector_id, tenant_id, history_id
     FROM gmail_watch_subscriptions
     WHERE gmail_user_id = $1`,
    [payload.emailAddress],
  );
  if (sub.rowCount === 0) {
    logger.warn({ emailAddress: payload.emailAddress }, 'gmail-history-push: no subscription');
    return res.status(204).end();
  }
  const row = sub.rows[0];
  setTraceContext({ tenantId: row.tenant_id });

  // 4. Fetch new messages via connector-service. The CS endpoint already
  // owns Gmail credentials + retry; we POST a "history list" request with
  // the last known historyId and receive the message envelopes.
  const base = process.env.CONNECTOR_SERVICE_URL;
  if (!base) {
    logger.error('gmail-history-push: CONNECTOR_SERVICE_URL not set');
    return res.status(500).json({ error: 'connector_service_url_missing' });
  }
  let historyResp: { messages?: Array<{ id: string; normalized?: unknown }>; nextHistoryId?: string };
  try {
    const r = await fetch(
      `${base}/api/connectors/${encodeURIComponent(row.connector_id)}/gmail/history`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tenant-id': row.tenant_id,
          ...(getManagedSecret('CONNECTOR_SERVICE_TOKEN') ? { Authorization: `Bearer ${getManagedSecret('CONNECTOR_SERVICE_TOKEN')}` } : {}),
        },
        body: JSON.stringify({ startHistoryId: row.history_id }),
      },
    );
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    historyResp = (await r.json()) as typeof historyResp;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, connector_id: row.connector_id, tenant_id: row.tenant_id },
      'gmail-history-push: history fetch failed; acking and waiting for next notification',
    );
    return res.status(204).end();
  }

  // 5. Publish each normalized message to connector-events-${env}.
  const topicName = `connector-events-${process.env.ENVIRONMENT ?? 'dev'}`;
  const publisher = new PubSub().topic(topicName);
  for (const m of historyResp.messages ?? []) {
    try {
      // entityType MUST match the catalog's declared `polling.entityType` for
      // google_mail (= 'Email', see connector-service src/catalog/connectors.ts).
      // event-trigger.ts builds its routing map from the catalog and looks up
      // (source, entityType) → registered agent topics. Emitting 'Message'
      // here (the prior value) caused every Gmail push to miss the map and
      // be silently dropped — agents registered for `email.received` never
      // received anything despite the watch + handler firing correctly.
      await publisher.publishMessage({
        data: Buffer.from(JSON.stringify({
          eventId: `${m.id}-${historyResp.nextHistoryId ?? row.history_id}`,
          eventUUID: crypto.randomUUID(),
          tenantId: row.tenant_id,
          connectorId: row.connector_id,
          entityType: 'Email',
          entityId: m.id,
          eventType: 'connector.record.synced',
          occurredAt: new Date().toISOString(),
          payload: { source: 'google_mail', data: m.normalized ?? {} },
        })),
        attributes: {
          tenantId: row.tenant_id,
          entityType: 'Email',
          source: 'google_mail',
          eventType: 'connector.record.synced',
          connectorId: row.connector_id,
          delivery: 'push',
        },
      });
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, message_id: m.id },
        'gmail-history-push: publish failed for message; continuing',
      );
    }
  }

  // 6. Advance the history cursor.
  if (historyResp.nextHistoryId) {
    await pool.query(
      `UPDATE gmail_watch_subscriptions SET history_id = $1 WHERE id = $2`,
      [historyResp.nextHistoryId, row.id],
    );
  }

  res.status(204).end();
});

export default router;
