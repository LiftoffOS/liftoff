// Key-pair Authentication Router.
//
// Ported from platform-backend/src/connectors/keypair-router.ts. Used by
// connectors like Snowflake that authenticate via RSA keypair + JWT.
//
// Deviations from source:
//   - Secret Manager / Pub/Sub publishing of the private key is replaced
//     by credentialService.storeCredentials(tenantId, connectorId,
//     'keypair', { privateKey, … }) — the connector-service owns secret
//     storage directly, so there is no tenant-runtime to notify.
//   - Verification initiates status transitions locally. The actual
//     verify probe is run by the downstream execute dispatcher (out of
//     scope for this router).
//   - Firebase account lookup → x-account-id header (web-tier already
//     verified Firebase before calling).
//
// Mount path: /api/connectors/keypair (see server.ts).

import { Router, Request, Response } from 'express';
import crypto from 'node:crypto';
import { logger } from '../infra/logging.js';
import { ConnectorType } from '../types.js';
import { credentialService } from '../credentials/service.js';
import { publishAuditEvent } from '../events/audit-publisher.js';
import {
  createConnector,
  getConnectorById,
  mergeConnectorConfig,
  updateConnectorStatus,
} from './connector-ops.js';

type KeyPairConnectorType = 'snowflake';

interface KeyPairProviderConfig {
  displayName: string;
  keySize: number;
  instructions: (username: string) => string[];
}

const KEYPAIR_PROVIDER_CONFIGS: Record<KeyPairConnectorType, KeyPairProviderConfig> = {
  snowflake: {
    displayName: 'Snowflake',
    keySize: 2048,
    instructions: (username: string) => [
      'Copy the public key above (without the header/footer lines)',
      `In Snowflake, run: ALTER USER ${username} SET RSA_PUBLIC_KEY='<paste key>';`,
      'Then click "Verify Connection" to test the authentication',
    ],
  },
};

export function usesKeyPairAuth(
  connectorType: ConnectorType,
): connectorType is KeyPairConnectorType {
  return connectorType in KEYPAIR_PROVIDER_CONFIGS;
}

function getAccountId(req: Request): string | null {
  const h = req.header('x-account-id');
  return h && typeof h === 'string' && h.length > 0 ? h : null;
}

export const keypairRouter = Router();

// ──────────────────────────────────────────────────────────────────────
// POST /:connectorType/setup — generate keypair + return public key
// ──────────────────────────────────────────────────────────────────────

keypairRouter.post('/:connectorType/setup', async (req: Request, res: Response) => {
  try {
    const { connectorType } = req.params;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { tenantId, ...providerConfig } = body as { tenantId?: unknown } & Record<string, unknown>;
    // "Reconnect" passes the connector row id → reuse that row; else create new.
    const reconnectConnectorId =
      typeof body.connectorId === 'string' ? (body.connectorId as string) : undefined;

    if (!usesKeyPairAuth(connectorType as ConnectorType)) {
      return res.status(400).json({
        error: `Connector type '${connectorType}' does not support key pair authentication`,
      });
    }

    const config = KEYPAIR_PROVIDER_CONFIGS[connectorType as KeyPairConnectorType];

    if (!tenantId || typeof tenantId !== 'string') {
      return res.status(400).json({ error: 'tenantId is required' });
    }

    const validationError = validateProviderConfig(
      connectorType as KeyPairConnectorType,
      providerConfig,
    );
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    const accountId = getAccountId(req);
    if (!accountId) {
      return res.status(401).json({ error: 'Unauthorized (x-account-id header required)' });
    }

    // Generate RSA key pair.
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: config.keySize,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    // Reconnect target reuse; else create a new pending connector.
    const reconnectTarget = reconnectConnectorId
      ? await getConnectorById(tenantId, reconnectConnectorId)
      : null;
    let connector;
    if (reconnectTarget && reconnectTarget.type === connectorType) {
      // Reuse the row the user clicked Reconnect on, but refresh its
      // providerConfig — the user may have corrected the account/host/region
      // that made the previous connection fail, so a stale config must not
      // survive the reconnect.
      connector = await updateConnectorStatus(tenantId, reconnectTarget.id, 'pending');
      await mergeConnectorConfig(tenantId, reconnectTarget.id, {
        ...providerConfig,
        authType: 'keypair',
        status: 'pending_key_setup',
      });
    } else {
      connector = await createConnector({
        tenantId,
        type: connectorType as ConnectorType,
        name: config.displayName,
        config: {
          ...providerConfig,
          authType: 'keypair',
          status: 'pending_key_setup',
        },
      });
    }

    // Persist the private key through the credentialService (Secret
    // Manager + connector_credentials row).
    await credentialService.storeCredentials(
      tenantId,
      connector.id,
      'keypair',
      {
        privateKey,
        metadata: {
          authType: 'keypair',
          connectorType,
          providerConfig,
        },
      },
      [],
    );

    // Calculate public key fingerprint (SHA-256 of DER-encoded SPKI).
    const publicKeyDer = crypto.createPublicKey(publicKey).export({
      type: 'spki',
      format: 'der',
    });
    const fingerprint = crypto.createHash('sha256').update(publicKeyDer).digest('base64');

    logger.info(
      {
        connectorId: connector.id,
        connectorType,
        tenantId,
        accountId,
      },
      'connector.keypair_setup_started',
    );

    try {
      await publishAuditEvent({
        tenantId,
        userId: accountId,
        eventType: 'connector.keypair_setup_started',
        resourceId: connector.id,
        newState: { connectorId: connector.id, connectorType },
      });
    } catch (err) {
      logger.warn(
        { err, connectorId: connector.id },
        'audit publish (connector.keypair_setup_started) failed',
      );
    }

    const username = getUsername(connectorType as KeyPairConnectorType, providerConfig);

    return res.json({
      connectorId: connector.id,
      publicKey,
      fingerprint: `SHA256:${fingerprint}`,
      instructions: config.instructions(username),
    });
  } catch (error) {
    logger.error({ error: (error as Error).message }, 'Key pair setup failed');
    return res.status(500).json({ error: 'Failed to set up connection' });
  }
});

// ──────────────────────────────────────────────────────────────────────
// POST /:connectorType/verify — mark connector as pending verification
// ──────────────────────────────────────────────────────────────────────

keypairRouter.post('/:connectorType/verify', async (req: Request, res: Response) => {
  try {
    const { connectorType } = req.params;
    const { connectorId, tenantId } = (req.body ?? {}) as {
      connectorId?: string;
      tenantId?: string;
    };

    if (!usesKeyPairAuth(connectorType as ConnectorType)) {
      return res.status(400).json({
        error: `Connector type '${connectorType}' does not support key pair authentication`,
      });
    }

    if (!connectorId || !tenantId) {
      return res.status(400).json({ error: 'connectorId and tenantId are required' });
    }

    const connector = await getConnectorById(tenantId, connectorId);
    if (!connector) {
      return res.status(404).json({ error: 'Connector not found' });
    }

    if (connector.type !== connectorType) {
      return res.status(400).json({
        error: `Connector is not a ${connectorType} connector`,
      });
    }

    // Flip to pending so the downstream dispatcher picks it up for
    // verification on next execute.
    await updateConnectorStatus(tenantId, connectorId, 'pending');

    logger.info(
      { connectorId, connectorType, tenantId },
      'connector.keypair_verify_requested',
    );

    return res.json({
      message:
        'Verification initiated. The connector status will update once verification completes.',
      connectorId,
    });
  } catch (error) {
    logger.error(
      { error: (error as Error).message },
      'Key pair verification request failed',
    );
    return res.status(500).json({ error: 'Failed to initiate verification' });
  }
});

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function validateProviderConfig(
  connectorType: KeyPairConnectorType,
  config: Record<string, unknown>,
): string | null {
  switch (connectorType) {
    case 'snowflake':
      if (!config.accountIdentifier) return 'accountIdentifier is required';
      if (!config.username) return 'username is required';
      return null;
    default:
      return null;
  }
}

function getUsername(
  connectorType: KeyPairConnectorType,
  config: Record<string, unknown>,
): string {
  switch (connectorType) {
    case 'snowflake':
      return (config.username as string) || 'YOUR_USERNAME';
    default:
      return 'YOUR_USERNAME';
  }
}
