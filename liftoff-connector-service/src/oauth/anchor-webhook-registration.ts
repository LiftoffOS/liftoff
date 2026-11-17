// Auto-registers / cleans up Anchor Browser webhooks on a tenant's Anchor
// account whenever they connect, rotate, or disconnect their API key.

import { credentialService } from '../credentials/service.js';
import { getConnectorCredential } from '../secrets/client.js';
import { logger } from '../infra/logging.js';

const ANCHOR_API_BASE = 'https://api.anchorbrowser.io';
const ANCHOR_SUBSCRIBED_EVENTS = [
  'intervention.requested',
  'intervention.resolved',
  'session.completed',
  'session.failed',
  'session.recording.ready',
  'identity.authenticated',
  'identity.authentication_failed',
];

// Stable receiver URL for the Anchor webhook ingress. Uses the custom-domain
// hostname, so the URL handed to Anchor survives a Cloud Run service rename,
// a region migration or a project move.
//
// WEBHOOKS_BASE_URL is the only source. It used to fall back to a hostname
// derived from ENVIRONMENT, which was safe while one organisation owned that
// domain and is not safe now: an unconfigured deployment would register a
// webhook pointing at somebody else's receiver, and the vendor would deliver
// this deployment's browser-session events there. A webhook that works but
// points elsewhere is worse than one that was never registered, because
// nothing about it looks broken from here.
//
// It must be a domain this deployment controls with a live certificate.
function receiverUrl(): string {
  const explicit = process.env.WEBHOOKS_BASE_URL?.trim();
  if (!explicit) {
    throw new Error(
      'WEBHOOKS_BASE_URL is unset, so no Anchor webhook can be registered. Set it to the ' +
      'public base URL of this deployment\'s webhook receiver (e.g. ' +
      'https://anchor-webhooks.example.com); the path /webhooks/anchor is appended.',
    );
  }
  return `${explicit.replace(/\/$/, '')}/webhooks/anchor`;
}

async function deleteWebhook(apiKey: string, webhookId: string): Promise<void> {
  const res = await fetch(`${ANCHOR_API_BASE}/v1/webhooks/${webhookId}`, {
    method: 'DELETE',
    headers: { 'anchor-api-key': apiKey },
  });
  if (!res.ok && res.status !== 404) {
    const body = await res.text().catch(() => '');
    logger.warn({ status: res.status, body }, 'anchor webhook delete failed (continuing)');
  }
}

interface RegisterResult { webhookSecret: string; webhookId: string; }

// Anchor mints the HMAC-SHA256 signing secret server-side and returns it
// in the create-webhook response. The request body has no `secret` field —
// any value we'd pass would be silently ignored. (A locally generated
// secret sent in the request body and persisted in the vault does not work:
// Anchor signs deliveries with its own internally-minted secret, so every
// intervention webhook would 401 at our HMAC verifier. A captured signed
// delivery confirms it — the body+timestamp HMAC'd with a local secret
// doesn't match Anchor's `v1=`, but HMAC'd with the secret Anchor returned
// at registration does.)
async function createWebhook(apiKey: string, url: string): Promise<{ id: string; secret: string }> {
  const res = await fetch(`${ANCHOR_API_BASE}/v1/webhooks`, {
    method: 'POST',
    headers: { 'anchor-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, subscribed_events: ANCHOR_SUBSCRIBED_EVENTS }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`anchor /v1/webhooks ${res.status}: ${body}`);
  }
  const data = (await res.json()) as { id?: string; secret?: string };
  if (!data.id) throw new Error('anchor /v1/webhooks response missing id');
  if (!data.secret) throw new Error('anchor /v1/webhooks response missing secret');
  return { id: data.id, secret: data.secret };
}

/**
 * Register (or re-register) the tenant's Anchor webhook. Deletes any prior
 * registration first using the previously-stored webhook_id. Returns the new
 * webhook id and the signing secret Anchor minted so the caller can persist
 * both in the credential's extra metadata.
 */
export async function registerAnchorWebhook(
  apiKey: string,
  previousWebhookId?: string,
): Promise<RegisterResult> {
  const url = receiverUrl();
  if (previousWebhookId) await deleteWebhook(apiKey, previousWebhookId);
  const { id, secret } = await createWebhook(apiKey, url);
  return { webhookSecret: secret, webhookId: id };
}

/** Best-effort cleanup when a tenant disconnects their Anchor connector. */
export async function unregisterAnchorWebhook(apiKey: string, webhookId: string): Promise<void> {
  await deleteWebhook(apiKey, webhookId);
}

/**
 * After storeCredentials writes the API key, call this to register the
 * webhook on the tenant's Anchor account and merge the resulting
 * {webhook_secret, webhook_id} into the credential's extraFields.
 *
 * Re-reads, merges, and rewrites the credential blob so we don't clobber
 * other extraFields set by the original submission.
 */
export async function attachAnchorWebhookToCredential(
  tenantId: string,
  connectorId: string,
  apiKey: string,
): Promise<void> {
  const blob = await getConnectorCredential(tenantId, connectorId);
  if (!blob) throw new Error(`no stored credential for connector ${connectorId}`);
  const existingExtra = ((blob.metadata as { extraFields?: Record<string, string> })?.extraFields) ?? {};
  const previousWebhookId = existingExtra.webhook_id;
  const { webhookSecret, webhookId } = await registerAnchorWebhook(apiKey, previousWebhookId);
  await credentialService.storeCredentials(
    tenantId,
    connectorId,
    'api_key',
    {
      apiKey,
      metadata: {
        authType: 'api_key',
        connectorType: 'anchor_browser',
        extraFields: {
          ...existingExtra,
          webhook_secret: webhookSecret,
          webhook_id: webhookId,
        },
      },
    },
    [],
  );
}
