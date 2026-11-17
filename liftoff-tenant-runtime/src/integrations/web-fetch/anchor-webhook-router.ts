import { Router, type Request, type Response } from 'express';
import express from 'express';
import { verifyAnchorSignature, handleAnchorEvent } from './anchor-webhook';
import { resolveAnchorWebhookSecret } from './anchor-webhook-secret-resolver';
import { logger } from '../../infrastructure/logging';

export const anchorWebhookRouter = Router();

anchorWebhookRouter.post(
  '/webhooks/anchor',
  express.raw({ type: 'application/json' }),
  async (req: Request, res: Response) => {
    const sigHeader = req.header('Anchor-Signature');
    const tsHeader = req.header('Anchor-Timestamp');
    if (!sigHeader || !tsHeader) return res.status(400).end();

    const rawBody = req.body as Buffer;
    let envelope: { id: string; type: string; created: string; project_id: string; data: Record<string, unknown> } | undefined;
    try {
      envelope = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return res.status(400).end();
    }
    if (!envelope) return res.status(400).end();

    let secret: string | null;
    try {
      secret = await resolveAnchorWebhookSecret(envelope);
    } catch (err) {
      logger.error({ err: (err as Error).message, envelopeId: envelope.id }, 'webhook secret resolution failed');
      return res.status(500).end();
    }
    if (!secret) return res.status(401).end();

    if (!verifyAnchorSignature(rawBody, sigHeader, tsHeader, secret)) {
      logger.warn({ envelopeId: envelope.id }, 'anchor webhook signature mismatch');
      return res.status(401).end();
    }

    // Ack within Anchor's 10s timeout; dispatch async.
    res.status(204).end();
    handleAnchorEvent(envelope).catch((err) => {
      logger.error({ err, envelopeId: envelope?.id }, 'anchor webhook handler failed');
    });
  },
);
