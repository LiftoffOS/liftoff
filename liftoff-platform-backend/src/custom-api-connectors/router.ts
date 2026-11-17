// The capture page's endpoints.
//
// Mount path: /api/custom-api-connectors (see src/index.ts), behind the
// ordinary Firebase auth gate, with `tenantAuthMiddleware('manageConnectors')`
// on every route.
//
// PERMISSION IS RE-CHECKED AT SUBMIT rather than at mint, because a role can
// change inside the hour the link lives. The middleware is what does it, and
// it is also what proves the caller belongs to the tenant they named —
// identity is not tenancy.
//
// WHO MAY COMPLETE A CAPTURE: any member with manageConnectors (owner or
// admin), not only the person who asked. The token is scoped to the tenant and
// to the spec hash, so the person who asked can hand the link to the colleague
// who actually holds the key. The rejected alternative — scoping it to the
// requester — reads as safer and is not: the requester is frequently not the
// key holder, so the key would travel to them over Slack or email to be
// pasted, putting the secret back into a conversation, which is the one thing
// this feature exists to prevent.

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { log, logAudit } from '../infrastructure/logging';
import { auditCtx } from '../infrastructure/audit-context';
import { tenantAuthMiddleware } from '../infrastructure/middleware';
import { resolveCaller } from '../auth/resolve-caller';
import { checkWindow } from '../oauth/rate-limiter';
import {
  getCustomApiConnection,
  refreshCustomApiSpec,
  reverifyCustomApiConnection,
  updateCustomApiConnection,
} from '../connectors/connector-service-client';
import { readCapture, submitCapture } from './service';

export const customApiConnectorsRouter = Router();

/** A capture link is a 256-bit secret, so this is not brute-force protection:
 *  it bounds how fast one workspace can spend links, which is what stops a
 *  compromised session working through a thread's worth of them. */
const CAPTURE_READS_PER_MINUTE = 20;
const CAPTURE_SUBMITS_PER_MINUTE = 5;

function rateLimited(
  storeKey: string,
  key: string,
  max: number,
  res: Response,
): boolean {
  const verdict = checkWindow(storeKey, key, max, 60_000);
  if (verdict.allowed) return false;
  res.setHeader('Retry-After', String(verdict.retryAfterSec));
  res.status(429).json({ error: 'rate_limited', retryAfter: verdict.retryAfterSec });
  return true;
}

// GET /:token?tenantId= — what the page renders.
//
// Discloses nothing: a capture token stores no value, so this answers the
// declared description (provider, purpose, hosts, where the credential goes,
// how it will be checked) and whether the link has been spent.
customApiConnectorsRouter.get(
  '/capture/:token',
  tenantAuthMiddleware('manageConnectors'),
  async (req: Request, res: Response) => {
    const tenantId = req.ctx!.tenantId!;
    if (rateLimited('custom-api-capture-read', tenantId, CAPTURE_READS_PER_MINUTE, res)) return;
    try {
      const view = await readCapture({ tenantId, token: req.params.token });
      if (!view) return res.status(404).json({ error: 'not_found' });
      return res.json(view);
    } catch (error) {
      log.error({ error, tenantId }, 'Failed to read a custom API capture link');
      return res.status(500).json({ error: 'capture_read_failed' });
    }
  },
);

const submitSchema = z.object({
  tenantId: z.string().uuid(),
  // The only place a credential appears in this repo. It is forwarded to
  // connector-service, which writes Secret Manager, and is never stored,
  // logged or echoed here.
  credential: z.string().min(1).max(8192),
});

// POST /capture/:token — the person enters the credential.
customApiConnectorsRouter.post(
  '/capture/:token',
  tenantAuthMiddleware('manageConnectors'),
  async (req: Request, res: Response) => {
    const tenantId = req.ctx!.tenantId!;
    // `ctx.userId` is the caller's FIREBASE uid, and every account id on these
    // routes is an `accounts.id` uuid. They are different id spaces, and the
    // columns the id reaches (`claimed_by_account_id`, the audit row) are uuid,
    // so passing the uid straight through does not mismatch — it makes Postgres
    // raise 22P02 and the request 500.
    const caller = await resolveCaller(req.ctx?.userId, tenantId);
    if (!caller.ok) return res.status(caller.status).json({ error: caller.error });
    const accountId = caller.caller.accountId;
    const parsed = submitSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Validation failed', details: parsed.error.errors.slice(0, 5) });
    }
    if (rateLimited('custom-api-capture-submit', tenantId, CAPTURE_SUBMITS_PER_MINUTE, res)) return;

    try {
      const result = await submitCapture({
        tenantId,
        accountId,
        token: req.params.token,
        credential: parsed.data.credential,
      });
      switch (result.kind) {
        case 'not_found':
          return res.status(404).json({ error: 'not_found', message: result.message });
        case 'expired':
          return res.status(410).json({ error: 'expired', message: result.message });
        case 'in_progress':
          return res.status(409).json({ error: 'in_progress', message: result.message });
        case 'refused':
          return res.status(422).json({
            error: result.reason,
            message: result.message,
            ...(result.operations ? { operations: result.operations } : {}),
          });
        case 'connected':
          logAudit('connector.custom_api_captured', auditCtx(req), {
            resourceType: 'connector',
            resourceId: result.connectorId,
            // The completing account is recorded so the person who asked can
            // see who finished it. Never the credential and never the key's
            // last characters: the hint lives on the connector row.
            newState: { status: result.status, operationCount: result.operationCount },
          });
          return res.json(result);
      }
    } catch (error) {
      log.error({ error, tenantId }, 'Failed to complete a custom API capture');
      return res.status(500).json({ error: 'capture_submit_failed' });
    }
  },
);

// ── Repair and removal ───────────────────────────────────────────────────
//
// Three of Phase 7's four controls; the fourth — removing the connection — is
// the ordinary connector delete the Connections page already performs, and the
// `custom_api_connectors` row cascades with it. None of them implies another,
// which is the whole point of their being separate routes: a re-verify does
// not change the key, an edit does not ask for one, and a revoke keeps the
// connection and every agent bound to it.
//
// Every route carries `tenantAuthMiddleware('manageConnectors')` of its own:
// identity is not tenancy, and a connector id is a client-supplied value.

// GET /connections/:connectorId — the connection a person is about to manage.
customApiConnectorsRouter.get(
  '/connections/:connectorId',
  tenantAuthMiddleware('manageConnectors'),
  async (req: Request, res: Response) => {
    const tenantId = req.ctx!.tenantId!;
    const caller = await resolveCaller(req.ctx?.userId, tenantId);
    if (!caller.ok) return res.status(caller.status).json({ error: caller.error });
    const accountId = caller.caller.accountId;
    try {
      const connection = await getCustomApiConnection({ tenantId, accountId, connectorId: req.params.connectorId });
      if (!connection) return res.status(404).json({ error: 'not_found' });
      return res.json(connection);
    } catch (error) {
      log.error({ error, tenantId }, 'Failed to read a custom API connection');
      return res.status(500).json({ error: 'connection_read_failed' });
    }
  },
);

const specRefreshSchema = z.object({ tenantId: z.string().uuid(), apply: z.boolean().optional() });

const changesSchema = z.object({
  tenantId: z.string().uuid(),
  name: z.string().min(1).max(200).optional(),
  baseUrl: z.string().url().max(2000).optional(),
  apiHosts: z.array(z.string().min(1).max(253)).min(1).max(20).optional(),
  auth: z.discriminatedUnion('scheme', [
    z.object({ scheme: z.literal('bearer_header') }),
    z.object({ scheme: z.literal('header'), name: z.string().min(1).max(100), prefix: z.string().max(40).optional() }),
    z.object({ scheme: z.literal('query'), name: z.string().min(1).max(100) }),
    z.object({ scheme: z.literal('path'), name: z.string().min(1).max(100) }),
  ]).optional(),
  verification: z.object({
    method: z.enum(['GET', 'HEAD']),
    path: z.string().min(1).max(2000).startsWith('/'),
    query: z.record(z.string(), z.string()).optional(),
    accountIdentityField: z.string().min(1).max(200).optional(),
  }).optional(),
});

// PATCH /connections/:connectorId — hosts, placement and verification, edited
// in place and then proven. Never delete-and-recreate.
customApiConnectorsRouter.patch(
  '/connections/:connectorId',
  tenantAuthMiddleware('manageConnectors'),
  async (req: Request, res: Response) => {
    const tenantId = req.ctx!.tenantId!;
    const caller = await resolveCaller(req.ctx?.userId, tenantId);
    if (!caller.ok) return res.status(caller.status).json({ error: caller.error });
    const accountId = caller.caller.accountId;
    const parsed = changesSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Validation failed', details: parsed.error.errors.slice(0, 5) });
    }
    const { tenantId: _tenantId, ...changes } = parsed.data;
    void _tenantId;
    try {
      const updated = await updateCustomApiConnection({
        tenantId,
        accountId,
        connectorId: req.params.connectorId,
        changes,
      });
      if (updated === null) return res.status(404).json({ error: 'not_found' });
      if ('refused' in updated) {
        return res.status(422).json({ error: updated.refused, message: updated.message });
      }
      logAudit('connector.custom_api_edited', auditCtx(req), {
        resourceType: 'connector',
        resourceId: req.params.connectorId,
        newState: { fields: Object.keys(changes), verified: updated.verification.ok },
      });
      return res.json(updated);
    } catch (error) {
      log.error({ error, tenantId }, 'Failed to edit a custom API connection');
      return res.status(500).json({ error: 'connection_edit_failed' });
    }
  },
);

// POST /connections/:connectorId/spec-refresh — read the provider's
// specification again.
//
// Two steps: without `apply` it reports what changed and writes nothing.
// Applying can REMOVE an operation, and an agent bound to it loses it, so a
// person is told before that happens rather than after.
customApiConnectorsRouter.post(
  '/connections/:connectorId/spec-refresh',
  tenantAuthMiddleware('manageConnectors'),
  async (req: Request, res: Response) => {
    const tenantId = req.ctx!.tenantId!;
    const caller = await resolveCaller(req.ctx?.userId, tenantId);
    if (!caller.ok) return res.status(caller.status).json({ error: caller.error });
    const accountId = caller.caller.accountId;
    const parsed = specRefreshSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Validation failed', details: parsed.error.errors.slice(0, 5) });
    }
    try {
      const result = await refreshCustomApiSpec({
        tenantId,
        accountId,
        connectorId: req.params.connectorId,
        apply: parsed.data.apply === true,
      });
      if (result === null) return res.status(404).json({ error: 'not_found' });
      if ('refused' in result) return res.status(422).json(result);
      if (result.applied) {
        logAudit('connector.custom_api_spec_reread', auditCtx(req), {
          resourceType: 'connector',
          resourceId: req.params.connectorId,
          newState: {
            added: result.added.length,
            removed: result.removed.length,
            operationCount: result.operationCount,
          },
        });
      }
      return res.json(result);
    } catch (error) {
      log.error({ error, tenantId }, 'Failed to read a custom API specification again');
      return res.status(500).json({ error: 'connection_spec_refresh_failed' });
    }
  },
);

// POST /connections/:connectorId/verify — the repair that needs no new key.
customApiConnectorsRouter.post(
  '/connections/:connectorId/verify',
  tenantAuthMiddleware('manageConnectors'),
  async (req: Request, res: Response) => {
    const tenantId = req.ctx!.tenantId!;
    const caller = await resolveCaller(req.ctx?.userId, tenantId);
    if (!caller.ok) return res.status(caller.status).json({ error: caller.error });
    const accountId = caller.caller.accountId;
    try {
      const outcome = await reverifyCustomApiConnection({ tenantId, accountId, connectorId: req.params.connectorId });
      return res.json(outcome);
    } catch (error) {
      log.error({ error, tenantId }, 'Failed to re-verify a custom API connection');
      return res.status(500).json({ error: 'connection_verify_failed' });
    }
  },
);

