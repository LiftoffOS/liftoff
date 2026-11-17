// Slack Events endpoint + the signature/dedup primitives the Slack surfaces
// share.
//
// The Liftoff app's single Events URL belongs to connector-service (it
// publishes every message to connector-events for reactive subscriptions and
// forwards chat events here over service auth), so this endpoint is a
// direct-delivery fallback and the answer to Slack's url_verification
// challenge.
//
// Design constraints inherited from Slack:
//  - Must respond within 3 seconds (Slack retries otherwise)
//  - Must deduplicate retried events (Slack sends the same event up to 3x)
//  - Verify the HMAC signature before acting on anything

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { getPool } from '../../infrastructure/database';

const webhookRouter = Router();

// ── Signature verification ──────────────────────────────────────────────

/**
 * Verify a Slack request signature against a given signing secret.
 *
 * Slack signs every inbound request with the app's signing secret.
 * We recompute the HMAC and use timingSafeEqual to prevent timing attacks.
 * Requests older than 5 minutes are rejected to prevent replay attacks.
 *
 * Exported so the workspace-app entry can reuse it with the env-held secret.
 */
export function verifySlackSignature(
  rawBody: Buffer,
  timestamp: string,
  signature: string,
  signingSecret: string,
): boolean {
  // Reject requests older than 5 minutes (replay prevention)
  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 300;
  if (parseInt(timestamp, 10) < fiveMinutesAgo) return false;

  const baseString = `v0:${timestamp}:${rawBody.toString()}`;
  const computed =
    'v0=' +
    crypto
      .createHmac('sha256', signingSecret)
      .update(baseString)
      .digest('hex');

  // Both buffers must be the same length for timingSafeEqual
  const a = Buffer.from(computed);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;

  return crypto.timingSafeEqual(a, b);
}

/** Signature check for the workspace app (env-held signing secret, ADR-040). */
export function verifyWorkspaceSlackSignature(
  rawBody: Buffer,
  timestamp: string,
  signature: string,
): boolean {
  const secret = process.env.LIFTOFF_SLACK_SIGNING_SECRET;
  if (!secret) return false;
  return verifySlackSignature(rawBody, timestamp, signature, secret);
}

// ── Deduplication ───────────────────────────────────────────────────────

/**
 * Check if an event has already been processed.
 *
 * Slack retries events within 3 seconds if it doesn't get a 200.  We use
 * `slack_event_dedup` (INSERT ... ON CONFLICT DO NOTHING) as a lightweight
 * dedup table.  Returns true when the event_id was already seen.
 *
 * Fails open — if the dedup INSERT errors we process the event anyway.
 *
 * Exported (as isDuplicateSlackEvent) for the workspace-app event handler.
 */
async function isDuplicate(eventId: string): Promise<boolean> {
  const pool = getPool();
  try {
    const result = await pool.query(
      'INSERT INTO slack_event_dedup (event_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING event_id',
      [eventId],
    );
    return result.rowCount === 0; // No row inserted → duplicate
  } catch {
    return false; // Fail open
  }
}

export { isDuplicate as isDuplicateSlackEvent };

// ── Route ───────────────────────────────────────────────────────────────

// POST /api/agent-chat/slack/events
//
// Legacy direct-to-PB Slack events endpoint. In the shipped topology the
// Liftoff app's single Events URL belongs to connector-service, which
// publishes to connector-events and forwards chat events to
// /api/internal/agent-slack/workspace-event. This endpoint remains so a
// workspace app pointed straight here still works, and so Slack's
// url_verification challenge always has an answer.
//
// The per-agent branch it used to carry is gone with ADR-040: those apps,
// their installs, and the machinery that minted them have been deleted.
webhookRouter.post('/', async (req: Request, res: Response) => {
  const rawBody = req.body as Buffer;
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    res.sendStatus(400);
    return;
  }

  if (body?.type === 'url_verification') {
    res.json({ challenge: (body as { challenge: string }).challenge });
    return;
  }

  const apiAppId = body?.api_app_id as string | undefined;
  const { isWorkspaceAppEvent } = await import('./workspace-app');
  if (!apiAppId || !isWorkspaceAppEvent(apiAppId)) {
    res.sendStatus(200); // Not ours — ack and ignore.
    return;
  }

  const { handleWorkspaceSlackEvent } = await import('./workspace-event-handler');
  await handleWorkspaceSlackEvent({
    rawBody,
    body,
    timestamp: req.headers['x-slack-request-timestamp'] as string | undefined,
    signature: req.headers['x-slack-signature'] as string | undefined,
    res,
  });
});

export { webhookRouter as slackWebhookRouter };
