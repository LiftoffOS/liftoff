// GitHub App lifecycle webhooks.
//
// WHY THIS IS A PRIMARY PATH, NOT A SAFETY NET
// ────────────────────────────────────────────
// When the person connecting is not an owner of the organization, GitHub does
// not install the App — it records a REQUEST and returns `setup_action=request`
// with no installation id. An owner approves later, possibly weeks later, in a
// different browser, signed in as a different person. There is no redirect back
// to us at that moment and no browser to redirect. `installation.created` is the
// only signal that it happened.
//
// So this router is load-bearing for correctness in a way the Meta and Slack
// webhook routers are not, and it runs the SAME completion function the callback
// runs (see github-app-bind.ts) rather than a second implementation that would
// drift from it.
//
// AUTHENTICATED BY HMAC, NOT BY SERVICE TOKEN. GitHub's servers call this, so it
// is mounted BEFORE `verifyServiceAuth` alongside the Meta and Slack webhook
// mounts, and proves authenticity with `X-Hub-Signature-256` over the raw body.
// It needs the raw bytes — a re-serialized body produces a different digest — so
// it is mounted with `express.raw`.

import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import { logger } from '../infra/logging.js';
import { completeGithubAppInstallation } from '../oauth/github-app-bind.js';
import { findTenantsAwaitingInstall } from '../oauth/github-app-pending.js';
import {
  findConnectorByTenantAndType,
  mergeConnectorConfig,
  updateConnectorStatus,
} from '../oauth/connector-ops.js';
import { getInstallation, listInstallationRepositories } from '../oauth/github-app.js';
import { publishGithubWebhookEvent } from './github-event-publisher.js';

export const githubWebhookRouter = Router();

/**
 * Constant-time comparison of the delivered signature against ours.
 *
 * `timingSafeEqual` throws on a length mismatch rather than returning false, so
 * the lengths are checked first — an exception here would surface as a 500 and
 * read as "our webhook is broken" rather than "that signature was wrong".
 */
function verifySignature(rawBody: Buffer, signatureHeader: string, secret: string): boolean {
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

githubWebhookRouter.post('/webhook', async (req: Request, res: Response) => {
  const secret = process.env.GITHUB_APP_WEBHOOK_SECRET;
  if (!secret) {
    // Unconfigured is not the same as unauthorized. Accepting an unverifiable
    // delivery would mean acting on anything the internet posts here, so this
    // refuses — but says why, because a silent 401 during rollout looks
    // identical to a wrong secret.
    logger.error({}, 'github_webhook_secret_not_configured');
    return res.status(503).json({ error: 'webhook not configured' });
  }

  const rawBody = req.body as Buffer;
  if (!Buffer.isBuffer(rawBody)) {
    logger.error({}, 'github_webhook_body_not_raw');
    return res.status(500).json({ error: 'raw body required' });
  }

  const signature = req.headers['x-hub-signature-256'];
  if (typeof signature !== 'string' || !verifySignature(rawBody, signature, secret)) {
    // A rejected delivery is indistinguishable from a dropped one at the edge,
    // and this hop crosses a proxy that re-serializes ordinary JSON bodies — so
    // the rejection has to say WHICH of the three inputs was wrong, or the next
    // person is left guessing.
    //
    // No secret and no payload content is logged: a length, a digest of what
    // arrived, and whether the header was there at all is enough to tell "the
    // bytes changed" from "the header never arrived" from "the secret differs".
    logger.warn(
      {
        event: req.headers['x-github-event'],
        signature_header_present: typeof signature === 'string',
        body_bytes: rawBody.length,
        body_sha256: crypto.createHash('sha256').update(rawBody).digest('hex').slice(0, 16),
        expected_sig_prefix: `sha256=${crypto
          .createHmac('sha256', secret)
          .update(rawBody)
          .digest('hex')}`.slice(0, 22),
        received_sig_prefix: typeof signature === 'string' ? signature.slice(0, 22) : null,
        content_type: req.headers['content-type'],
        content_length: req.headers['content-length'],
        secret_fingerprint: crypto.createHash('sha256').update(secret).digest('hex').slice(0, 8),
      },
      'github_webhook_bad_signature',
    );
    return res.status(401).json({ error: 'invalid signature' });
  }

  let body: Record<string, unknown> & {
    action?: string;
    installation?: { id?: number; account?: { login?: string } };
  };
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'invalid json' });
  }

  const event = typeof req.headers['x-github-event'] === 'string'
    ? (req.headers['x-github-event'] as string)
    : '';
  const deliveryId = typeof req.headers['x-github-delivery'] === 'string'
    ? (req.headers['x-github-delivery'] as string)
    : '';
  const installationId = Number(body.installation?.id ?? 0);
  const accountLogin = body.installation?.account?.login ?? '';

  // ACK FIRST. GitHub retries on a non-2xx and disables a webhook that fails
  // persistently; none of the work below is something GitHub should wait on or
  // retry into. Failures are logged and reconciled by the next delivery or by
  // the user reconnecting.
  res.status(202).json({ received: true });

  try {
    // Entity events — the reactive path. Everything below this block is
    // installation lifecycle; this is the one branch that wakes an agent.
    //
    // After the ACK, per the note above: the publish fans out per holding
    // tenant, and a slow or failing Pub/Sub call must not become a non-2xx.
    // A dropped publish costs one event; a hook GitHub disables costs all of
    // them.
    if (event === 'pull_request' || event === 'issues') {
      const published = await publishGithubWebhookEvent({
        installationId,
        githubEvent: event,
        deliveryId,
        body,
      });
      logger.info(
        {
          event,
          action: body.action,
          installation_id: installationId,
          delivery_id: deliveryId,
          tenants_published: published,
        },
        'github_webhook_entity_event',
      );
      return;
    }

    if (event === 'installation' && (body.action === 'created' || body.action === 'new_permissions_accepted')) {
      // The path that resolves an org-owner approval days after the request.
      await completeGithubAppInstallation({ installationId, source: 'webhook' });
      return;
    }

    if (event === 'installation' && (body.action === 'deleted' || body.action === 'suspend')) {
      await forEachInstalledConnector(installationId, accountLogin, async (tenantId, connectorId) => {
        // The App is gone on GitHub's side. `error` is the status the
        // connections page already renders as "Needs Reconnect", which is
        // exactly what the user has to do — and the installation id is cleared
        // so credential resolution falls back to the user token rather than
        // repeatedly minting against an installation that no longer exists.
        await mergeConnectorConfig(tenantId, connectorId, {
          installationId: null,
          installState: 'uninstalled',
        });
        await updateConnectorStatus(tenantId, connectorId, 'error');
      });
      return;
    }

    if (event === 'installation_repositories') {
      // Without this the stored repository list becomes fiction the first time
      // somebody adds a repo on GitHub — the same staleness class as a
      // connector that reads `active` while it is dead.
      const installation = await getInstallation(installationId);
      const repositories =
        installation?.repositorySelection === 'selected'
          ? await listInstallationRepositories(installationId)
          : null;
      await forEachInstalledConnector(installationId, accountLogin, async (tenantId, connectorId) => {
        await mergeConnectorConfig(tenantId, connectorId, {
          repositorySelection: installation?.repositorySelection ?? 'all',
          repositoryNames: repositories?.names ?? null,
          repositoryCount: repositories?.total ?? null,
        });
      });
      return;
    }
  } catch (err) {
    logger.error(
      { err: (err as Error).message, event, installation_id: installationId },
      'github_webhook_handler_failed',
    );
  }
});

/**
 * Apply a change to whichever connector row holds this installation.
 *
 * A webhook carries no tenant context, so the row is found by the installation
 * id it already stores — which, unlike the pending-request match, is exact. The
 * account login is only used for logging when nothing matches.
 */
async function forEachInstalledConnector(
  installationId: number,
  accountLogin: string,
  apply: (tenantId: string, connectorId: string) => Promise<void>,
): Promise<void> {
  const { withAdminScope } = await import('../db/pool.js');
  const rows = await withAdminScope(
    {
      caller: 'events/github-webhook-router',
      reason: 'GitHub webhook carries no tenant context',
    },
    async (client) => {
      const res = await client.query(
        `SELECT tenant_id, id FROM connectors
          WHERE type = 'github' AND (config->>'installationId')::bigint = $1`,
        [installationId],
      );
      return res.rows as Array<{ tenant_id: string; id: string }>;
    },
  );

  if (rows.length === 0) {
    logger.warn(
      { installation_id: installationId, account: accountLogin },
      'github_webhook_no_connector_for_installation',
    );
    return;
  }
  for (const row of rows) await apply(row.tenant_id, row.id);
}

/** Re-exported so the router module owns its own surface for tests. */
export { findTenantsAwaitingInstall, findConnectorByTenantAndType };
