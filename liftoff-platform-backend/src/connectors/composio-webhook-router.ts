// Composio webhook receiver.
//
// Composio's GMAIL_NEW_GMAIL_MESSAGE trigger (and every other Composio
// trigger we register) POSTs here when it fires. The endpoint is public-
// facing (Composio's servers reach it from the internet) and is
// authenticated by HMAC-SHA256 signature per the Standard Webhooks spec:
//
//   signedContent = `${webhookId}.${webhookTimestamp}.${body}`
//   signature     = `v1,${base64(HMAC-SHA256(secret, signedContent))}`
//
// Why we don't use the @composio/core SDK for verification: the SDK does
// the same Standard Webhooks check internally, but pulling the SDK into
// platform-backend just for this would add ~10 MB of vendor SDK weight to
// every cold start. The check is 30 lines of crypto we'd own anyway.
//
// On valid signature, we publish a `connector.composio_trigger_fired`
// event to control-plane-events so tenant-runtime can dispatch it to the
// agent that's registered on the corresponding event topic
// (email.received for Gmail). The tenant_id is read from the V3 payload's
// metadata.user_id field — we set this to tenantId when creating triggers
// via composio.triggers.create(tenantId, slug, ...).

import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { log } from '../infrastructure/logging';
import { publishEventWithExplicitId } from '../events/publisher';
import { reportReconnectRequired } from './connector-service-client';

const SIGNATURE_TOLERANCE_SEC = 300; // 5-minute window

export const composioWebhookRouter = Router();

/**
 * Whether this envelope says a connected account has stopped working.
 *
 * Matched loosely on purpose. Composio's catalogue names the event
 * `composio_connected_account_expired`, but the type string has already moved
 * once (the V2/V3 split renamed the trigger events), and the cost of missing
 * it is another silent class of broken connector. Anything naming both a
 * connected account and an expiry counts.
 */
function isConnectedAccountExpired(type: string | undefined): boolean {
  if (!type) return false;
  const t = type.toLowerCase();
  return t.includes('connected_account') && (t.includes('expired') || t.includes('expire'));
}

interface WebhookV3Payload {
  id: string;
  timestamp: string;
  type: string;
  metadata: {
    log_id: string;
    trigger_slug: string;
    trigger_id: string;
    connected_account_id: string;
    auth_config_id: string;
    user_id: string;
  };
  data: Record<string, unknown>;
}

function verifyHmac(args: {
  webhookId: string;
  webhookTimestamp: string;
  webhookSignature: string;
  rawBody: Buffer;
  secret: string;
}): { ok: true } | { ok: false; reason: string } {
  // Timestamp tolerance check — reject replays older than 5 min.
  const ts = Number.parseInt(args.webhookTimestamp, 10);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'invalid_timestamp' };
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > SIGNATURE_TOLERANCE_SEC) {
    return { ok: false, reason: 'timestamp_outside_tolerance' };
  }

  // Parse the `v1,<base64sig>` header — multiple signatures may be space-
  // separated (Composio supports key rotation); accept any valid match.
  const presentedSignatures = args.webhookSignature
    .split(/\s+/)
    .filter((s) => s.startsWith('v1,'))
    .map((s) => s.slice(3));
  if (presentedSignatures.length === 0) {
    return { ok: false, reason: 'no_v1_signature' };
  }

  const signedContent = `${args.webhookId}.${args.webhookTimestamp}.${args.rawBody.toString('utf8')}`;
  const expected = crypto
    .createHmac('sha256', args.secret)
    .update(signedContent)
    .digest('base64');
  const expectedBuf = Buffer.from(expected, 'base64');

  for (const presented of presentedSignatures) {
    let presentedBuf: Buffer;
    try {
      presentedBuf = Buffer.from(presented, 'base64');
    } catch {
      continue;
    }
    if (presentedBuf.length !== expectedBuf.length) continue;
    if (crypto.timingSafeEqual(presentedBuf, expectedBuf)) return { ok: true };
  }
  return { ok: false, reason: 'signature_mismatch' };
}

// POST /api/internal/composio-webhook
composioWebhookRouter.post('/', async (req: Request, res: Response) => {
  const webhookId = req.headers['webhook-id'];
  const webhookTimestamp = req.headers['webhook-timestamp'];
  const webhookSignature = req.headers['webhook-signature'];

  if (
    typeof webhookId !== 'string' ||
    typeof webhookTimestamp !== 'string' ||
    typeof webhookSignature !== 'string'
  ) {
    return res.status(400).json({ error: 'missing webhook headers' });
  }

  const secret = process.env.COMPOSIO_WEBHOOK_SECRET;
  if (!secret) {
    log.error({}, 'composio-webhook: COMPOSIO_WEBHOOK_SECRET env unset');
    return res.status(500).json({ error: 'server_misconfigured' });
  }

  // express.raw() puts the body bytes in req.body when Content-Type matches.
  const rawBody = req.body as Buffer;
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
    return res.status(400).json({ error: 'empty body' });
  }

  const verification = verifyHmac({
    webhookId,
    webhookTimestamp,
    webhookSignature,
    rawBody,
    secret,
  });
  if (!verification.ok) {
    log.warn(
      { webhookId, reason: verification.reason },
      'composio-webhook: signature verification failed',
    );
    return res.status(401).json({ error: 'signature_invalid', reason: verification.reason });
  }

  let payload: WebhookV3Payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8')) as WebhookV3Payload;
  } catch {
    return res.status(400).json({ error: 'invalid_json' });
  }

  // Composio publishes exactly four event types, and until now every verified
  // payload was treated as a trigger firing. One of the other three says an
  // account we depend on has stopped working, and it was arriving and being
  // dropped: composio-managed connectors dispatch in-process inside tenant
  // runtime and never touch connector-service at tool-call time, so nothing
  // else was ever going to notice. That is 92 of the catalog's connectors
  // failing every call while the Connections page still showed them healthy.
  //
  // The account id is read tolerantly. Trigger payloads carry it under
  // `metadata`, and we do not have a verified sample of the expiry payload's
  // shape — Composio documents the type, not the body. Reading both places
  // costs one `??` and means a shape we guessed wrong still reports.
  if (isConnectedAccountExpired(payload.type)) {
    const expiredAccountId =
      payload.metadata?.connected_account_id
      ?? (payload.data?.connected_account_id as string | undefined)
      ?? (payload.data?.connectedAccountId as string | undefined);

    if (!expiredAccountId) {
      log.warn(
        { webhookId, payloadType: payload.type },
        'composio-webhook: account-expired carried no connected_account_id',
      );
      return res.status(200).json({ ok: true, ignored: 'no_connected_account_id' });
    }

    // Best-effort: never 5xx a bookkeeping failure back at Composio, or it
    // retries this webhook for something a retry cannot fix.
    const updated = await reportReconnectRequired({
      composioConnectedAccountId: expiredAccountId,
      reason: 'composio_account_expired',
    });

    log.warn(
      { webhookId, payloadType: payload.type, connectedAccountId: expiredAccountId, updated },
      'composio-webhook: connected account expired, connector flagged for reconnect',
    );
    return res.status(200).json({ ok: true, handled: 'connected_account_expired', updated });
  }

  // V3 trigger payloads carry the routing key in metadata.
  // V2 payloads (legacy) carry it in a flatter shape — we don't currently
  // register any triggers that would deliver V2, but if we encounter one
  // we log + 200 it to avoid Composio's retry storm.
  const md = payload.metadata;
  if (!md || typeof md.user_id !== 'string' || typeof md.connected_account_id !== 'string') {
    log.warn({ webhookId, payloadType: payload.type }, 'composio-webhook: unrecognized payload shape');
    return res.status(200).json({ ok: true, ignored: 'unrecognized_payload_shape' });
  }

  // user_id in Composio == tenantId in our system (set when calling
  // composio.triggers.create or connectedAccounts.link).
  const tenantId = md.user_id;
  const connectedAccountId = md.connected_account_id;
  const triggerSlug = md.trigger_slug;

  log.info(
    {
      webhookId,
      tenantId,
      connectedAccountId,
      triggerSlug,
      payloadType: payload.type,
    },
    'composio-webhook: trigger fired',
  );

  // Fan out to the control plane. TR's subscriber picks this up, looks up
  // the connector by external_account_id (= connectedAccountId), and
  // dispatches via the existing event-trigger map (e.g. CSR registered on
  // 'email.received' fires for GMAIL_NEW_GMAIL_MESSAGE events).
  //
  // We bypass the outbox path (used elsewhere to bind entity mutations to
  // their events transactionally) because there's no entity mutation here
  // — we're forwarding an external event. Durability is provided by
  // Composio's own retry policy: if publish fails we 5xx and Composio
  // retries within minutes.
  //
  // event_id uses composioLogId + webhookId so re-delivered webhooks
  // dedupe at the tenant-runtime side via event_processing_ledger.
  const eventId = `composio-${md.log_id}-${webhookId.replace(/^msg_/, '')}`;
  try {
    await publishEventWithExplicitId({
      eventId,
      eventVersion: 1,
      entityVersion: null,
      eventType: 'connector.composio_trigger_fired',
      entityType: 'connector',
      entityId: connectedAccountId,
      tenantId,
      payload: {
        composioConnectedAccountId: connectedAccountId,
        triggerSlug,
        triggerId: md.trigger_id,
        authConfigId: md.auth_config_id,
        composioLogId: md.log_id,
        composioWebhookId: webhookId,
        // Raw Composio data — TR's handler unwraps per-slug.
        data: payload.data,
      },
    });
  } catch (err) {
    log.error(
      { err: (err as Error).message, webhookId, tenantId, connectedAccountId },
      'composio-webhook: publish failed',
    );
    // 5xx so Composio retries — preferable to dropping the event.
    return res.status(500).json({ error: 'publish_failed' });
  }

  return res.status(200).json({ ok: true });
});
