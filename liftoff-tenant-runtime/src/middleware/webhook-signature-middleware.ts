// Webhook Signature Verification Middleware
// Per Section 12: HMAC signature verification for connector webhooks

import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { logger } from '../infrastructure/logging';
import { getPool } from '../infrastructure/database';

// Supported signature schemes
type SignatureScheme = 'hmac-sha256' | 'hmac-sha1' | 'hmac-md5';

interface WebhookSignatureConfig {
  enabled: boolean;
  scheme: SignatureScheme;
  headerName: string;
  secretKey: string;
  timestampHeaderName?: string;
  timestampToleranceSec?: number;
}

// Get webhook signature config from database for a connector
async function getSignatureConfig(connectorId: string): Promise<WebhookSignatureConfig | null> {
  const pool = getPool();

  try {
    const result = await pool.query(
      `SELECT webhook_config FROM connectors WHERE id = $1`,
      [connectorId]
    );

    if (!result.rows[0]?.webhook_config) {
      return null;
    }

    const config = result.rows[0].webhook_config;
    return {
      enabled: config.signatureVerificationEnabled ?? false,
      scheme: config.signatureScheme ?? 'hmac-sha256',
      headerName: config.signatureHeaderName ?? 'x-webhook-signature',
      secretKey: config.webhookSecret ?? '',
      timestampHeaderName: config.timestampHeaderName,
      timestampToleranceSec: config.timestampToleranceSec ?? 300, // 5 minutes default
    };
  } catch (error) {
    logger.error('Failed to get webhook signature config', {
      connectorId,
      error: (error as Error).message,
    });
    return null;
  }
}

// Compute HMAC signature
function computeSignature(
  payload: string,
  secret: string,
  scheme: SignatureScheme
): string {
  const algorithm = scheme.replace('hmac-', '');
  const hmac = crypto.createHmac(algorithm, secret);
  hmac.update(payload);
  return hmac.digest('hex');
}

// Verify webhook signature
function verifySignature(
  payload: string,
  signature: string,
  secret: string,
  scheme: SignatureScheme
): boolean {
  const expectedSignature = computeSignature(payload, secret, scheme);

  // Use timing-safe comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  } catch {
    // Buffer lengths don't match
    return false;
  }
}

// Verify timestamp is within tolerance
function verifyTimestamp(
  timestamp: string | undefined,
  toleranceSec: number
): { valid: boolean; error?: string } {
  if (!timestamp) {
    return { valid: true }; // Timestamp verification is optional
  }

  let timestampDate: Date;

  // Try parsing as Unix timestamp (seconds or milliseconds)
  const numericTimestamp = parseInt(timestamp, 10);
  if (!isNaN(numericTimestamp)) {
    // If timestamp is in seconds (10 digits), convert to milliseconds
    timestampDate = new Date(
      numericTimestamp < 10000000000 ? numericTimestamp * 1000 : numericTimestamp
    );
  } else {
    // Try parsing as ISO date string
    timestampDate = new Date(timestamp);
  }

  if (isNaN(timestampDate.getTime())) {
    return { valid: false, error: 'Invalid timestamp format' };
  }

  const now = Date.now();
  const diff = Math.abs(now - timestampDate.getTime()) / 1000;

  if (diff > toleranceSec) {
    return {
      valid: false,
      error: `Timestamp outside tolerance window (${diff}s > ${toleranceSec}s)`,
    };
  }

  return { valid: true };
}

// Middleware factory
export function webhookSignatureMiddleware() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const connectorId = req.params.connectorId;

    if (!connectorId) {
      // No connector ID in route, skip verification
      return next();
    }

    const config = await getSignatureConfig(connectorId);

    if (!config || !config.enabled) {
      // Signature verification not enabled for this connector
      logger.debug('Webhook signature verification not enabled', { connectorId });
      return next();
    }

    if (!config.secretKey) {
      logger.warn('Webhook signature verification enabled but no secret configured', {
        connectorId,
      });
      return next();
    }

    // Get the signature from the request header
    const signature = req.headers[config.headerName.toLowerCase()] as string;

    if (!signature) {
      logger.warn('Webhook signature missing', {
        connectorId,
        headerName: config.headerName,
      });
      res.status(401).json({
        error: 'Webhook signature missing',
        header: config.headerName,
      });
      return;
    }

    // Verify timestamp if configured
    if (config.timestampHeaderName) {
      const timestamp = req.headers[config.timestampHeaderName.toLowerCase()] as string;
      const timestampResult = verifyTimestamp(timestamp, config.timestampToleranceSec || 300);

      if (!timestampResult.valid) {
        logger.warn('Webhook timestamp verification failed', {
          connectorId,
          error: timestampResult.error,
        });
        res.status(401).json({
          error: 'Webhook timestamp verification failed',
          details: timestampResult.error,
        });
        return;
      }
    }

    // Get raw body for signature verification
    // Note: This requires the route to use express.raw() or a custom body parser
    let rawBody: string;

    if (Buffer.isBuffer(req.body)) {
      rawBody = req.body.toString('utf8');
    } else if (typeof req.body === 'string') {
      rawBody = req.body;
    } else {
      // Body has already been parsed as JSON, stringify it
      // Note: This may not match the original payload exactly
      rawBody = JSON.stringify(req.body);
    }

    // Handle different signature formats (e.g., "sha256=xxx" or just "xxx")
    let signatureValue = signature;
    const signatureParts = signature.split('=');
    if (signatureParts.length === 2) {
      signatureValue = signatureParts[1];
    }

    // Verify the signature
    const isValid = verifySignature(rawBody, signatureValue, config.secretKey, config.scheme);

    if (!isValid) {
      logger.warn('Webhook signature verification failed', {
        connectorId,
        scheme: config.scheme,
      });
      res.status(401).json({
        error: 'Invalid webhook signature',
      });
      return;
    }

    logger.debug('Webhook signature verified successfully', {
      connectorId,
      scheme: config.scheme,
    });

    next();
  };
}

// Export for testing
export const _internal = {
  computeSignature,
  verifySignature,
  verifyTimestamp,
};
