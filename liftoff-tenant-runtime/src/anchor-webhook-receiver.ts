// Public-ingress Anchor webhook receiver. Deployed as a separate Cloud Run
// service (SERVICE_TYPE=anchor-webhook-receiver) so /webhooks/anchor can
// accept Anchor's unauthenticated POSTs. Forwards the verbatim body +
// headers to agent-service with an OIDC bearer; agent-service re-verifies
// the HMAC using the per-tenant secret in the connector vault.

import express from 'express';
import { GoogleAuth } from 'google-auth-library';
import { logger } from './infrastructure/logging';

const PORT = parseInt(process.env.PORT ?? '8080', 10);
const auth = new GoogleAuth();
let idTokenClient: Awaited<ReturnType<GoogleAuth['getIdTokenClient']>> | null = null;

async function getIdTokenClient(audience: string) {
  if (!idTokenClient) idTokenClient = await auth.getIdTokenClient(audience);
  return idTokenClient;
}

export function startAnchorWebhookReceiver(): void {
  const upstream = process.env.ANCHOR_WEBHOOK_UPSTREAM_URL;
  if (!upstream) {
    logger.error('ANCHOR_WEBHOOK_UPSTREAM_URL not set; receiver cannot start');
    process.exit(1);
  }

  const app = express();
  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'anchor-webhook-receiver' }));
  app.post(
    '/webhooks/anchor',
    express.raw({ type: 'application/json', limit: '1mb' }),
    async (req, res) => {
      try {
        const client = await getIdTokenClient(upstream);
        const token = await client.idTokenProvider.fetchIdToken(upstream);
        const forwardHeaders: Record<string, string> = {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        };
        const sig = req.header('Anchor-Signature');
        const ts = req.header('Anchor-Timestamp');
        if (sig) forwardHeaders['Anchor-Signature'] = sig;
        if (ts) forwardHeaders['Anchor-Timestamp'] = ts;
        const upstreamRes = await fetch(`${upstream}/webhooks/anchor`, {
          method: 'POST',
          headers: forwardHeaders,
          body: req.body as Buffer,
        });
        res.status(upstreamRes.status).end();
      } catch (err) {
        logger.error({ err: (err as Error).message }, 'anchor webhook forward failed');
        res.status(502).end();
      }
    },
  );
  app.listen(PORT, () => logger.info({ port: PORT, upstream }, 'anchor-webhook-receiver listening'));
}
