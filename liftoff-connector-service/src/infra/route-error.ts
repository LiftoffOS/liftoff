import type { Response } from 'express';
import { logger } from './logging.js';
import { isReconnectRequiredOAuthError } from '../credentials/service.js';

export function handleRouteError(res: Response, err: unknown, label: string): void {
  if (isReconnectRequiredOAuthError(err)) {
    if (!res.headersSent) {
      res.status(401).json({ error: 'Connector re-authorization required — please reconnect in Settings.' });
    }
    return;
  }
  logger.error({ err }, `${label}: unhandled error`);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }
}
