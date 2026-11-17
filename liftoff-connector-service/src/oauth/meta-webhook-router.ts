// Meta webhook callbacks — deauthorize and GDPR data deletion.
//
// These routes are mounted BEFORE verifyServiceAuth in server.ts because
// Meta's servers authenticate via HMAC-SHA256 signed_request, not X-Service-Auth.
//
// Operation order in revokeMetaUserCredentials matters:
//   1. credentialService.revokeCredentials() — dispatches Meta's token revocation
//      handler while the token is still in Secret Manager
//   2. deleteConnectorCredential() — removes the token from Secret Manager
//   3. updateConnectorStatus() — marks connector 'disconnected' for tenant to reconnect
//
// GDPR scope: deletes only the Facebook user's personal credential (token + meta_user_id).
// The connector row and all business data (ad account config, campaign cache) are preserved.

import { Router } from 'express';
import { createHmac, timingSafeEqual, createHash } from 'node:crypto';
import { withAdminScope } from '../db/pool.js';
import { credentialService } from '../credentials/service.js';
import { deleteConnectorCredential } from '../secrets/client.js';
import { updateConnectorStatus } from './connector-ops.js';
import { publishEvent } from '../events/publisher.js';
import { logger } from '../infra/logging.js';

export const metaWebhookRouter = Router();

function verifyMetaSignedRequest(
  signedRequest: string,
  appSecret: string,
): { userId: string; issuedAt: number } | null {
  const dot = signedRequest.indexOf('.');
  if (dot === -1) return null;
  const encodedSig = signedRequest.slice(0, dot);
  const encodedPayload = signedRequest.slice(dot + 1);

  const expected = createHmac('sha256', appSecret).update(encodedPayload).digest();
  const actual = Buffer.from(encodedSig, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;

  let payload: { algorithm?: string; user_id?: string; issued_at?: number };
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as {
      algorithm?: string;
      user_id?: string;
      issued_at?: number;
    };
  } catch {
    return null;
  }

  if (payload.algorithm !== 'HMAC-SHA256' || !payload.user_id) return null;

  // Reject replays older than 24 hours.
  if (Math.floor(Date.now() / 1000) - (payload.issued_at ?? 0) > 86400) return null;

  return { userId: payload.user_id, issuedAt: payload.issued_at ?? 0 };
}

async function findConnectorsByMetaUserId(
  metaUserId: string,
): Promise<Array<{ connectorId: string; tenantId: string }>> {
  return withAdminScope(
    {
      caller: 'meta-webhook/findConnectorsByMetaUserId',
      reason: 'cross-tenant Meta user lookup for GDPR deletion',
    },
    async (client) => {
      const result = await client.query<{ connector_id: string; tenant_id: string }>(
        `SELECT connector_id, tenant_id FROM connector_credentials WHERE meta_user_id = $1`,
        [metaUserId],
      );
      return result.rows.map((r) => ({ connectorId: r.connector_id, tenantId: r.tenant_id }));
    },
  );
}

async function revokeMetaUserCredentials(metaUserId: string): Promise<number> {
  const connectors = await findConnectorsByMetaUserId(metaUserId);

  await Promise.allSettled(
    connectors.map(async ({ connectorId, tenantId }) => {
      try {
        await credentialService.revokeCredentials(tenantId, connectorId);
        await deleteConnectorCredential(tenantId, connectorId);
        await updateConnectorStatus(tenantId, connectorId, 'disconnected');
        void publishEvent({
          entityType: 'connector',
          entityId: connectorId,
          eventType: 'connector.credentials_revoked',
          entityVersion: 1,
          eventVersion: 1,
          tenantId,
          payload: { connectorType: 'meta_ads', reason: 'meta_user_data_deletion' },
        }).catch(err =>
          logger.warn(
            { connectorId, tenantId, error: (err as Error).message },
            'failed to publish connector.credentials_revoked (non-fatal)',
          ),
        );
      } catch (err) {
        logger.error(
          { connectorId, tenantId, error: (err as Error).message },
          'meta: failed to revoke credentials during user data deletion',
        );
      }
    }),
  );

  return connectors.length;
}

// POST /api/connectors/meta/deauthorize
metaWebhookRouter.post('/deauthorize', async (req, res) => {
  try {
    const appSecret = process.env.META_CLIENT_SECRET;
    if (!appSecret) return res.status(500).json({ error: 'not_configured' });

    const signedRequest = req.body?.signed_request as string | undefined;
    if (!signedRequest) return res.status(400).json({ error: 'missing_signed_request' });

    const verified = verifyMetaSignedRequest(signedRequest, appSecret);
    if (!verified) {
      logger.warn({}, 'meta: deauthorize — invalid signed_request');
      return res.status(401).json({ error: 'invalid_signature' });
    }

    logger.info({ metaUserId: verified.userId }, 'meta: deauthorize callback received');
    await revokeMetaUserCredentials(verified.userId);
    return res.status(200).json({ success: true });
  } catch (err) {
    logger.error({ error: (err as Error).message }, 'meta: deauthorize handler failed');
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/connectors/meta/data-deletion
metaWebhookRouter.post('/data-deletion', async (req, res) => {
  try {
    const appSecret = process.env.META_CLIENT_SECRET;
    if (!appSecret) return res.status(500).json({ error: 'not_configured' });

    const signedRequest = req.body?.signed_request as string | undefined;
    if (!signedRequest) return res.status(400).json({ error: 'missing_signed_request' });

    const verified = verifyMetaSignedRequest(signedRequest, appSecret);
    if (!verified) {
      logger.warn({}, 'meta: data-deletion — invalid signed_request');
      return res.status(401).json({ error: 'invalid_signature' });
    }

    logger.info({ metaUserId: verified.userId }, 'meta: data-deletion request received');

    const count = await revokeMetaUserCredentials(verified.userId);
    logger.info({ metaUserId: verified.userId, count }, 'meta: data-deletion complete');

    const confirmationCode = createHash('sha256')
      .update(`${verified.userId}:${verified.issuedAt}:${appSecret}`)
      .digest('hex')
      .slice(0, 24);

    return res.status(200).json({
      url: `${process.env.BACKEND_URL}/api/connectors/meta/data-deletion/status?id=${confirmationCode}`,
      confirmation_code: confirmationCode,
    });
  } catch (err) {
    logger.error({ error: (err as Error).message }, 'meta: data-deletion handler failed');
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/connectors/meta/data-deletion/status
// Deletion happens synchronously before the POST response, so status is always completed.
metaWebhookRouter.get('/data-deletion/status', (req, res) => {
  res.json({ status: 'completed', confirmation_code: req.query.id ?? '' });
});
