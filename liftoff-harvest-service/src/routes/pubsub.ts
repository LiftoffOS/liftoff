// Pub/Sub PUSH endpoints.
//
// Scale-to-zero consumption: Cloud Run wakes an instance on each authenticated
// push, processes exactly one message, and returns 204 (ack) or 5xx (nack ->
// Pub/Sub redelivers per the subscription retry_policy). When the burst ends and
// no requests arrive, Cloud Run scales the service back to zero. This replaces
// the always-on streaming-pull subscribers (which required a persistent
// instance and therefore never worked at min-instances=0).
//
// Auth: the service is deployed --no-allow-unauthenticated, and each push
// subscription carries an oidc_token whose SA holds run.invoker. Cloud Run
// verifies the token at ingress, so these handlers do not re-verify the JWT.

import { Router, Request, Response } from 'express';
import { log } from '../infrastructure/logging';
import { processConnectorEvent } from '../subscriber';
import { processControlPlaneEvent } from '../control-plane-subscriber';

const router = Router();

interface PushEnvelope {
  message?: {
    data?: string;
    attributes?: Record<string, string>;
    messageId?: string;
    message_id?: string;
  };
  subscription?: string;
}

/**
 * Decode a Pub/Sub push request body into the same shape the pull path handled:
 * the JSON body string, the message attributes, and the message id. Returns null
 * for a body that isn't a Pub/Sub push envelope at all (malformed) so the caller
 * can drop it rather than loop.
 */
export function decodePush(
  body: unknown,
): { data: string; attributes: Record<string, string>; messageId: string } | null {
  const msg = (body as PushEnvelope | undefined)?.message;
  if (!msg) return null;
  const data = msg.data ? Buffer.from(msg.data, 'base64').toString('utf8') : '';
  return {
    data,
    attributes: msg.attributes ?? {},
    messageId: msg.messageId ?? msg.message_id ?? '',
  };
}

router.post('/connector-events', async (req: Request, res: Response) => {
  const decoded = decodePush(req.body);
  if (!decoded) {
    log.warn('malformed Pub/Sub push envelope on /pubsub/connector-events, acking to drop');
    res.status(204).end();
    return;
  }
  const decision = await processConnectorEvent(decoded.data, decoded.attributes, decoded.messageId);
  res.status(decision === 'ack' ? 204 : 500).end();
});

router.post('/control-plane-events', async (req: Request, res: Response) => {
  const decoded = decodePush(req.body);
  if (!decoded) {
    log.warn('malformed Pub/Sub push envelope on /pubsub/control-plane-events, acking to drop');
    res.status(204).end();
    return;
  }
  const decision = await processControlPlaneEvent(decoded.attributes);
  res.status(decision === 'ack' ? 204 : 500).end();
});

export default router;
