// Slack Events API webhook — workspace-OAuth connector side.
//
// Distinct from the per-agent Slack adapter in platform-backend
// (src/agent-chat/slack-adapter/webhook-router.ts), which handles per-agent
// app installs for user↔agent comms. THIS endpoint is for the workspace-OAuth
// Slack connector that customers connect via the /connectors/slack flow —
// agent WORK tools (read channel history, post messages, react) flow through
// it, and event-driven reactive subscriptions on Slack messages will fire
// from here.
//
// Architectural context:
//  - Slack's May 2025 rate-limit change throttles `conversations.history` and
//    `conversations.replies` to 1 req/min for non-marketplace commercial apps
//    on installs created after May 29, 2025. Polling at scale is dead under
//    that limit.
//  - Events API is NOT subject to that throttle. Subscribing to message events
//    is the structurally correct shape for inbox-style agent workflows on
//    Slack.
//  - This endpoint is Phase A of the cutover: receive, verify, deduplicate,
//    log. Phase B (gated on ADR-019) wires events into reactive subscriptions
//    so agents are actually invoked.
//
// Constraints inherited from Slack:
//  - Respond 200 within 3 seconds or Slack retries (3× burst, then back-off)
//  - Verify HMAC-SHA256 signature with the app signing secret
//  - Reject timestamps older than 5 minutes (replay window)
//  - Deduplicate via `event_id` — Slack retries carry the same id

import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import { withAdminScope } from '../db/pool.js';
import { logger } from '../infra/logging.js';
import { publishSlackEvent } from './slack-event-publisher.js';

const slackEventsRouter = Router();

// ── Signature verification ──────────────────────────────────────────────

/**
 * Verify Slack request signature using the app's signing secret.
 *
 * Slack signs every inbound request: `v0=<HMAC_SHA256(secret, "v0:" + ts + ":" + body)>`.
 * We recompute and `timingSafeEqual` to prevent timing oracles. Requests older
 * than 5 minutes are rejected to prevent replay.
 *
 * Exported for tests.
 */
export function verifySlackSignature(
  rawBody: Buffer,
  timestamp: string,
  signature: string,
  signingSecret: string,
): boolean {
  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 300;
  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts) || ts < fiveMinutesAgo) return false;

  const baseString = `v0:${timestamp}:${rawBody.toString('utf8')}`;
  const computed =
    'v0=' +
    crypto.createHmac('sha256', signingSecret).update(baseString).digest('hex');

  const a = Buffer.from(computed);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ── Deduplication ───────────────────────────────────────────────────────

/**
 * Insert the event_id; ON CONFLICT DO NOTHING means we have already
 * processed it. Returns true when the event is a duplicate (already seen).
 *
 * Fails OPEN — if the dedup INSERT errors we process the event anyway.
 * Better to risk a double-process than to silently drop the event on a
 * transient DB issue.
 */
async function isDuplicate(eventId: string): Promise<boolean> {
  try {
    const result = await withAdminScope(
      { caller: 'slack-webhook-router', reason: 'event dedup' },
      (client) =>
        client.query(
          'INSERT INTO slack_event_dedup (event_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING event_id',
          [eventId],
        ),
    );
    return result.rowCount === 0;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, eventId },
      'slack event dedup INSERT failed — failing open',
    );
    return false;
  }
}

// ── Tenant resolution ───────────────────────────────────────────────────

interface SlackConnectorRow {
  id: string;
  tenant_id: string;
}

/**
 * Resolve the tenant and connector row from a Slack event's team_id.
 *
 * The Slack OAuth callback stores `team_id` in `connectors.config->>'externalAccountId'`
 * (see src/oauth/identity-fetchers.ts → fetchSlackIdentity, where
 * externalAccountId is set to auth.test's team_id). We look up the active
 * Slack connector for that workspace and return its id + tenant.
 *
 * Returns null if no active Slack connector matches (likely an uninstall race
 * or a Slack event from a workspace we haven't seen) — caller should ack 200
 * and move on.
 */
async function resolveTenant(slackTeamId: string): Promise<SlackConnectorRow | null> {
  try {
    const result = await withAdminScope(
      { caller: 'slack-webhook-router', reason: 'tenant resolution from team_id' },
      (client) =>
        client.query<SlackConnectorRow>(
          `SELECT id, tenant_id
           FROM connectors
           WHERE type = 'slack'
             AND status = 'active'
             AND config->>'externalAccountId' = $1
           ORDER BY created_at DESC
           LIMIT 1`,
          [slackTeamId],
        ),
    );
    return result.rows[0] ?? null;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, slackTeamId },
      'slack tenant resolution failed',
    );
    return null;
  }
}

// ── Signing secret resolution ───────────────────────────────────────────

/**
 * The workspace-OAuth Slack connector has ONE signing secret per environment
 * (the dev/prod apps are separate, but each has its own single secret).
 * Loaded from the SLACK_SIGNING_SECRET env var, which is wired to Secret
 * Manager via the deploy substitution.
 */
function getSigningSecret(): string | null {
  return process.env.SLACK_SIGNING_SECRET ?? null;
}

// ── Route ───────────────────────────────────────────────────────────────

/**
 * POST /api/connectors/slack/events
 *
 * Mounted with `express.raw({ type: 'application/json' })` so req.body is
 * the raw Buffer needed for HMAC verification. The router parses the body
 * itself.
 */
slackEventsRouter.post('/', async (req: Request, res: Response) => {
  const rawBody = req.body as Buffer;
  if (!Buffer.isBuffer(rawBody)) {
    logger.warn({}, 'slack events: req.body is not a Buffer — express.raw missing?');
    res.sendStatus(400);
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
  } catch {
    res.sendStatus(400);
    return;
  }

  // 1. URL verification challenge — sent once when Slack first configures the
  //    Event Subscriptions Request URL. Echoes the challenge token. No
  //    signature on this path (Slack docs: "URL verification requests will not
  //    contain signed headers"), so we MUST respond before any verification.
  if (body.type === 'url_verification') {
    res.json({ challenge: (body as { challenge?: string }).challenge ?? '' });
    return;
  }

  // 2. Signature verification. Slack sends:
  //    X-Slack-Request-Timestamp + X-Slack-Signature.
  const signingSecret = getSigningSecret();
  if (!signingSecret) {
    logger.error({}, 'slack events: SLACK_SIGNING_SECRET unset');
    res.sendStatus(500);
    return;
  }

  const timestamp = req.headers['x-slack-request-timestamp'];
  const signature = req.headers['x-slack-signature'];
  if (typeof timestamp !== 'string' || typeof signature !== 'string') {
    res.sendStatus(401);
    return;
  }
  if (!verifySlackSignature(rawBody, timestamp, signature, signingSecret)) {
    logger.warn(
      { team_id: (body as { team_id?: string }).team_id },
      'slack events: invalid signature',
    );
    res.sendStatus(401);
    return;
  }

  // 3. Only event_callback envelopes are processed below. Other top-level
  //    types (app_rate_limited, etc.) get acked but not handled.
  const envelopeType = body.type;
  const eventId = (body as { event_id?: string }).event_id;
  const slackTeamId = (body as { team_id?: string }).team_id;

  if (envelopeType !== 'event_callback' || !eventId) {
    res.sendStatus(200);
    return;
  }

  // 4. Dedup BEFORE tenant resolution — retries on the same event_id should
  //    be cheap acks regardless of whether the underlying connector still
  //    exists.
  if (await isDuplicate(eventId)) {
    res.sendStatus(200);
    return;
  }

  // 5. Tenant resolution from team_id. Slack always includes team_id on
  //    event_callback envelopes. Without it, we cannot route.
  if (!slackTeamId) {
    res.sendStatus(200);
    return;
  }
  const connector = await resolveTenant(slackTeamId);
  if (!connector) {
    // No active Slack connector for this workspace — uninstall race or
    // unknown workspace. Ack and drop.
    logger.info(
      { team_id: slackTeamId, event_id: eventId },
      'slack events: no active connector for team — dropping',
    );
    res.sendStatus(200);
    return;
  }

  // 6. Publish onto the shared connector-events topic. Reactive
  //    subscriptions + event-triggered agents consume the topic and pick
  //    up Slack push events identically to polled events (ADR-019).
  //
  //    Ack BEFORE publish: Slack's 3-second timeout for 200 responses is
  //    the binding constraint, and Pub/Sub publish latency varies. The
  //    publish is fire-and-forget; failures are logged + metric-emitted
  //    but never bubble up. If a publish fails the event is lost (no
  //    retry queue) — acceptable because (a) Slack will resend on its own
  //    schedule if our ack times out, and (b) push-event loss is a noisy-
  //    log incident not a correctness violation given subscriptions are
  //    forward-only (ADR-019 §"forward-only semantics").
  const innerEvent = (body as { event?: Record<string, unknown> }).event;

  // 5b. Chat routing lives in platform-backend, but Slack allows only ONE
  //     Events URL per app and this endpoint owns it (see step 6). Forward
  //     the message-shaped events its chat handler needs, BEFORE the ack:
  //     this service runs with Cloud Run's default CPU throttling, so work
  //     queued after the response can be frozen, and a dropped forward means
  //     someone's DM never gets an answer. The call is capped well inside
  //     Slack's 3s budget.
  const forwardable = innerEvent
    && (innerEvent.type === 'message' || innerEvent.type === 'app_mention');
  if (forwardable) {
    const { forwardSlackEventToChat } = await import('../oauth/slack-workspace-handoff.js');
    await forwardSlackEventToChat({
      team_id: slackTeamId,
      api_app_id: (body as { api_app_id?: string }).api_app_id,
      event_id: eventId,
      event: innerEvent as Record<string, unknown>,
    });
  }

  res.sendStatus(200);

  if (innerEvent) {
    void publishSlackEvent({
      connectorId: connector.id,
      tenantId: connector.tenant_id,
      slackTeamId,
      eventId,
      slackEvent: innerEvent,
    }).catch((err) =>
      logger.warn(
        {
          err: (err as Error).message,
          tenant_id: connector.tenant_id,
          connector_id: connector.id,
          event_id: eventId,
        },
        'slack event publish failed (non-fatal; event dropped)',
      ),
    );
  }
});

export { slackEventsRouter };
