// Management routes for per-agent inbound webhooks.
//
// Mounted into internalAgentsRouter under `/:internalAgentId/webhook*`. The
// frontend is the only consumer — we deliberately do not expose external
// developer APIs for this surface.
//
// Endpoints:
//   POST   /api/internal-agents/:id/webhook            — provision (idempotent)
//   GET    /api/internal-agents/:id/webhook            — metadata
//   PATCH  /api/internal-agents/:id/webhook            — update settings
//   DELETE /api/internal-agents/:id/webhook            — destroy source + rules + history
//   POST   /api/internal-agents/:id/webhook/reset      — rotate URL + secret
//   GET    /api/internal-agents/:id/webhook/audit-log  — recent admin actions
//   GET    /api/internal-agents/:id/webhook/deliveries — recent inbound calls
//
// Tenant resolution: tenantId comes from `?tenantId=` (existing internal-
// agents router convention). Actor + membership: every request runs through
// `verifyTenantMembership` so an authenticated user can only manage webhooks
// for tenants they belong to. Plan §2: "Management routes go under the
// existing Firebase + tenant-membership middleware."

import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { z } from 'zod';
import { BlockedUrlError } from '../common/url-guard';
import {
  OUTBOUND_EVENT_TYPES,
  deleteWebhook as deleteOutboundWebhook,
  isOutboundEventType,
  listWebhooks as listOutboundWebhooks,
  registerWebhook as registerOutboundWebhook,
  setWebhookEnabled as setOutboundWebhookEnabled,
} from './outbound-webhooks';
import { withTenantScope } from '../infrastructure/database';
import { AccountService } from '../accounts/service';
import { tenantMembersService } from '../tenant-members/service';
import { internalAgentService } from '../internal-agents/service';
import {
  getSourceForAgent,
  updateSource,
  deleteSource,
  listRecentDeliveries,
  getTenantCaps,
  upsertTenantCaps,
  purgeDeliveriesBySha256,
  type EventSource,
} from './service';
import { provisionForAgent, resetCredentials } from './provisioner';
import { secretHint } from './signing';
import { getWebhookBaseUrl } from '../infrastructure/webhook-base-url';

export const webhookManagementRouter = Router({ mergeParams: true });
const accountService = new AccountService();

// Public URL prefix the UI hands operators. Lives on its own subdomain
// (webhooks.example.com env-specific) and is purpose-built for this
// usage — see src/infrastructure/webhook-base-url.ts for the rationale
// behind a dedicated WEBHOOK_BASE_URL env var rather than reusing
// BACKEND_URL. The prefix INCLUDES the /v1 version segment so this
// helper is a trivial concat.
//
// getWebhookBaseUrl() throws if WEBHOOK_BASE_URL is unset. Called lazily
// (not at module load) so unit tests that load routes.ts via side-effect
// from internalAgentsServiceRouter etc. don't need to set the env var.
// Production paths that invoke inboundUrl all run in request context
// after the app has booted; a misconfigured deploy surfaces as a 500 on
// the first webhook-management request rather than a boot crash.
function inboundUrl(token: string): string {
  return `${getWebhookBaseUrl()}/${token}`;
}

// ── Auth ──────────────────────────────────────────────────────────────────

interface WebhookContext {
  tenantId: string;
  agentId: string;
  accountId: string;
}

declare global {
  namespace Express {
    interface Request {
      webhookCtx?: WebhookContext;
    }
  }
}

/**
 * Verify the caller (a) has a Firebase identity, (b) maps to an account,
 * (c) is a member of the tenant supplied via ?tenantId=, AND (d) the
 * supplied internal agent exists in that tenant. Stashes a `webhookCtx` on
 * the request for downstream handlers; no handler should re-derive these.
 *
 * 404 vs 403 distinction: missing membership is 403 (caller exists, doesn't
 * have access). Missing agent in an otherwise-accessible tenant is 404.
 * This matches the rest of the internal-agents router.
 */
async function verifyTenantMembership(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const tenantId = req.query.tenantId as string | undefined;
  const agentId = req.params.internalAgentId;
  if (!tenantId) {
    res.status(400).json({ error: 'tenantId is required' });
    return;
  }
  if (!agentId) {
    res.status(400).json({ error: 'agentId is required' });
    return;
  }
  const firebaseUid = req.ctx?.userId;
  if (!firebaseUid) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  const account = await accountService.getByFirebaseUid(firebaseUid);
  if (!account) {
    res.status(401).json({ error: 'Account not found' });
    return;
  }
  const membership = await tenantMembersService.getMembership(tenantId, account.id);
  if (!membership) {
    res.status(403).json({ error: 'Access denied to tenant resources' });
    return;
  }
  const agent = await internalAgentService.getById(agentId, tenantId);
  if (!agent) {
    res.status(404).json({ error: 'agent not found' });
    return;
  }
  req.webhookCtx = { tenantId, agentId, accountId: account.id };
  next();
}

// Apply membership middleware to every nested route.
webhookManagementRouter.use((req, res, next) => {
  void verifyTenantMembership(req, res, next);
});

function publicMetadata(source: EventSource): {
  url: string;
  enabled: boolean;
  hmacRequired: boolean;
  secretHint: string;
  rateLimitPerMinute: number;
  contentFilterEnabled: boolean;
  piiHashMode: boolean;
  lastEventAt: string | null;
} {
  return {
    url: inboundUrl(source.urlToken),
    enabled: source.enabled,
    hmacRequired: source.hmacRequired,
    secretHint: source.signingSecretHint,
    rateLimitPerMinute: source.rateLimitPerMinute,
    contentFilterEnabled: source.contentFilterEnabled,
    piiHashMode: source.piiHashMode,
    lastEventAt: source.lastEventAt,
  };
}

const patchSchema = z.object({
  enabled: z.boolean().optional(),
  hmacRequired: z.boolean().optional(),
  rateLimitPerMinute: z.number().int().min(1).max(10000).optional(),
  contentFilterEnabled: z.boolean().optional(),
  piiHashMode: z.boolean().optional(),
});

// Safety net so route handlers don't drop unhandled-rejection traces into
// the framework's default error handler.
function asyncRoute(
  handler: (req: Request, res: Response) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}

function ctx(req: Request): WebhookContext {
  // verifyTenantMembership guarantees this is set; the bang is a type-narrow.
  return req.webhookCtx!;
}

// POST /:agentId/webhook — provision (idempotent)
webhookManagementRouter.post(
  '/',
  asyncRoute(async (req, res) => {
    const c = ctx(req);
    // Fetch the agent fresh from internalAgentService to get the display
    // name — verifyTenantMembership already confirmed existence and access.
    const agent = await internalAgentService.getById(c.agentId, c.tenantId);
    const agentName = agent?.messagingNickname || agent?.role || undefined;

    const result = await provisionForAgent({
      tenantId: c.tenantId,
      agentId: c.agentId,
      agentName,
      actorUserId: c.accountId,
    });

    res.status(result.newSecret ? 201 : 200).json({
      url: inboundUrl(result.urlToken),
      // newSecret is null when re-provisioning an existing source — the UI
      // must not display anything in that case.
      secret: result.newSecret ?? '',
    });
  }),
);

// GET /:agentId/webhook — metadata
webhookManagementRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const c = ctx(req);
    const source = await getSourceForAgent(c.tenantId, c.agentId);
    if (!source) {
      res.status(404).json({ error: 'Webhook not provisioned' });
      return;
    }
    res.json(publicMetadata(source));
  }),
);

// PATCH /:agentId/webhook — update settings
webhookManagementRouter.patch(
  '/',
  asyncRoute(async (req, res) => {
    const c = ctx(req);
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.errors });
      return;
    }
    const source = await getSourceForAgent(c.tenantId, c.agentId);
    if (!source) {
      res.status(404).json({ error: 'Webhook not provisioned' });
      return;
    }
    const updated = await updateSource({
      tenantId: c.tenantId,
      sourceId: source.id,
      patch: parsed.data,
      actorUserId: c.accountId,
    });
    if (!updated) {
      res.status(404).json({ error: 'Webhook not provisioned' });
      return;
    }
    res.json(publicMetadata(updated));
  }),
);

// DELETE /:agentId/webhook — destroy source, trigger rules, and delivery history
webhookManagementRouter.delete(
  '/',
  asyncRoute(async (req, res) => {
    const c = ctx(req);
    const source = await getSourceForAgent(c.tenantId, c.agentId);
    if (!source) {
      res.status(404).json({ error: 'Webhook not provisioned' });
      return;
    }
    const ok = await deleteSource({
      tenantId: c.tenantId,
      sourceId: source.id,
      actorUserId: c.accountId,
    });
    if (!ok) {
      res.status(404).json({ error: 'Webhook not provisioned' });
      return;
    }
    res.status(204).send();
  }),
);

// POST /:agentId/webhook/reset — rotate URL + signing secret atomically
webhookManagementRouter.post(
  '/reset',
  asyncRoute(async (req, res) => {
    const c = ctx(req);
    const source = await getSourceForAgent(c.tenantId, c.agentId);
    if (!source) {
      res.status(404).json({ error: 'Webhook not provisioned' });
      return;
    }
    const result = await resetCredentials({
      tenantId: c.tenantId,
      sourceId: source.id,
      actorUserId: c.accountId,
    });
    res.json({
      url: inboundUrl(result.urlToken),
      secret: result.newSecret,
      secretHint: secretHint(result.newSecret),
    });
  }),
);

// GET /:agentId/webhook/audit-log — recent administrative actions.
//
// Reads from the canonical `audit_log` table (event_type = 'webhook.*',
// resource_type = 'event_source', resource_id = source.id). Response shape
// is preserved so the existing React reader keeps working unchanged.
webhookManagementRouter.get(
  '/audit-log',
  asyncRoute(async (req, res) => {
    const c = ctx(req);
    const limitParam = parseInt(String(req.query.limit ?? '50'), 10);
    const limit = Math.max(1, Math.min(200, Number.isFinite(limitParam) ? limitParam : 50));

    const source = await getSourceForAgent(c.tenantId, c.agentId);
    if (!source) {
      res.status(404).json({ error: 'Webhook not provisioned' });
      return;
    }
    const rows = await withTenantScope(c.tenantId, async (client) => {
      const r = await client.query<{
        id: string;
        action: string;
        user_id: string | null;
        metadata: Record<string, unknown>;
        previous_state: Record<string, unknown> | null;
        new_state: Record<string, unknown> | null;
        timestamp: string;
      }>(
        `SELECT id, action, user_id, metadata, previous_state, new_state, timestamp
         FROM audit_log
         WHERE tenant_id = $1
           AND event_type LIKE 'webhook.%'
           AND resource_type = 'event_source'
           AND resource_id = $2
           AND deleted_at IS NULL
         ORDER BY timestamp DESC
         LIMIT $3`,
        [c.tenantId, source.id, limit],
      );
      return r.rows;
    });
    res.json({
      entries: rows.map((row) => ({
        id: row.id,
        action: row.action,
        actorUserId: row.user_id,
        // Surface both legacy metadata and the new structured diff so the
        // UI can show either. Older rows (pre-migration backfill) carry
        // previousState/newState already inside metadata.
        metadata: {
          ...row.metadata,
          previousState: row.previous_state,
          newState: row.new_state,
        },
        createdAt: row.timestamp,
      })),
    });
  }),
);

// GET /:agentId/webhook/deliveries — recent inbound calls
webhookManagementRouter.get(
  '/deliveries',
  asyncRoute(async (req, res) => {
    const c = ctx(req);
    const limitParam = parseInt(String(req.query.limit ?? '5'), 10);
    const limit = Math.max(1, Math.min(50, Number.isFinite(limitParam) ? limitParam : 5));
    const source = await getSourceForAgent(c.tenantId, c.agentId);
    if (!source) {
      res.status(404).json({ error: 'Webhook not provisioned' });
      return;
    }
    const deliveries = await listRecentDeliveries(c.tenantId, source.id, limit);
    res.json({ deliveries });
  }),
);

// ──────────────────────────────────────────────────────────────────────────
// Tenant-level admin endpoints. Mounted on a separate router so they can
// require a stricter (owner/admin) role check than the per-agent routes.
// ──────────────────────────────────────────────────────────────────────────

export const webhookTenantAdminRouter = Router();

async function verifyTenantAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const tenantId = req.query.tenantId as string | undefined;
  if (!tenantId) {
    res.status(400).json({ error: 'tenantId is required' });
    return;
  }
  const firebaseUid = req.ctx?.userId;
  if (!firebaseUid) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  const account = await accountService.getByFirebaseUid(firebaseUid);
  if (!account) {
    res.status(401).json({ error: 'Account not found' });
    return;
  }
  const membership = await tenantMembersService.getMembership(tenantId, account.id);
  if (!membership) {
    res.status(403).json({ error: 'Access denied to tenant resources' });
    return;
  }
  // Caps + DSAR are admin/owner only.
  if (membership.role !== 'owner' && membership.role !== 'admin') {
    res.status(403).json({ error: 'Requires owner or admin role' });
    return;
  }
  req.webhookCtx = { tenantId, agentId: '', accountId: account.id };
  next();
}

webhookTenantAdminRouter.use((req, res, next) => {
  void verifyTenantAdmin(req, res, next);
});

const capsSchema = z.object({
  maxRequestsPerMinute: z.number().int().min(1).max(100000).optional(),
  // Nullable to allow clearing the budget back to "unlimited".
  dailyRunBudget: z.number().int().min(0).max(1_000_000).nullable().optional(),
});

// GET /api/event-sources/tenant-caps?tenantId=…
webhookTenantAdminRouter.get(
  '/tenant-caps',
  asyncRoute(async (req, res) => {
    const c = ctx(req);
    const caps = await getTenantCaps(c.tenantId);
    res.json(caps ?? {
      tenantId: c.tenantId,
      maxRequestsPerMinute: 1000,
      dailyRunBudget: null,
    });
  }),
);

// PUT /api/event-sources/tenant-caps?tenantId=…
webhookTenantAdminRouter.put(
  '/tenant-caps',
  asyncRoute(async (req, res) => {
    const c = ctx(req);
    const parsed = capsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.errors });
      return;
    }
    const updated = await upsertTenantCaps({
      tenantId: c.tenantId,
      maxRequestsPerMinute: parsed.data.maxRequestsPerMinute,
      dailyRunBudget: parsed.data.dailyRunBudget ?? null,
      actorUserId: c.accountId,
    });
    // upsertTenantCaps emits a webhook.caps_updated audit row when the values
    // actually change — see service.ts. No additional logging needed here.
    res.json(updated);
  }),
);

const dsarSchema = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/i, 'sha256 must be 64 hex chars'),
  reason: z.string().min(1).max(500),
});

// POST /api/event-sources/dsar-purge?tenantId=…
//
// Delete every event_deliveries row whose body matches the supplied hash.
// Cross-tenant in scope: a sha256 collision is astronomically unlikely, so
// we don't require the caller to scope to a tenant they already control.
// The membership middleware still enforces that the caller is an
// owner/admin of SOME tenant (basic anti-abuse on a destructive op); the
// admin-scope audit log captures actor + reason.
webhookTenantAdminRouter.post(
  '/dsar-purge',
  asyncRoute(async (req, res) => {
    const c = ctx(req);
    const parsed = dsarSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.errors });
      return;
    }
    const result = await purgeDeliveriesBySha256({
      sha256: parsed.data.sha256.toLowerCase(),
      actorUserId: c.accountId,
      reason: parsed.data.reason,
    });
    res.json(result);
  }),
);

// ── Outbound webhooks (the other direction) ──────────────────────────────────
// Owner/admin only, same as the caps and DSAR routes above: pointing a
// customer's data at a third-party endpoint is a governance decision.
//
// Registration and ENABLING are separate acts. A registered endpoint is inert
// until somebody turns it on, so the decision to start sending is always
// deliberate rather than a side effect of typing a URL.

const outboundRegisterSchema = z.object({
  url: z.string().url(),
  eventTypes: z.array(z.string()).min(1),
});

webhookTenantAdminRouter.get(
  '/outbound-webhooks',
  asyncRoute(async (req, res) => {
    res.json({
      webhooks: await listOutboundWebhooks(ctx(req).tenantId),
      // Told, rather than left for somebody to discover by trial: an event
      // type that is not on this list is silently never delivered.
      availableEventTypes: OUTBOUND_EVENT_TYPES,
    });
  }),
);

webhookTenantAdminRouter.post(
  '/outbound-webhooks',
  asyncRoute(async (req, res) => {
    const parsed = outboundRegisterSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.errors });
      return;
    }
    const unknown = parsed.data.eventTypes.filter((t) => !isOutboundEventType(t));
    if (unknown.length > 0) {
      // Refused rather than filtered. Silently dropping an event type the
      // caller asked for produces an endpoint that works, mostly, for reasons
      // nobody can see.
      res.status(400).json({ error: 'Unknown event types', unknown, available: OUTBOUND_EVENT_TYPES });
      return;
    }
    try {
      const result = await registerOutboundWebhook({
        tenantId: ctx(req).tenantId,
        url: parsed.data.url,
        eventTypes: parsed.data.eventTypes,
      });
      // The signing secret is returned HERE and nowhere else, ever. Storing it
      // readable would make every subsequent read another copy of it.
      res.status(201).json({
        webhook: result.webhook,
        secret: result.secret,
        secretNote: 'Store this now. It is not retrievable later.',
      });
    } catch (err) {
      if (err instanceof BlockedUrlError) {
        res.status(400).json({ error: 'That URL is not reachable from the public internet', detail: err.message });
        return;
      }
      throw err;
    }
  }),
);

webhookTenantAdminRouter.put(
  '/outbound-webhooks/:id/enabled',
  asyncRoute(async (req, res) => {
    const enabled = (req.body as { enabled?: unknown })?.enabled;
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled must be true or false' });
      return;
    }
    try {
      const ok = await setOutboundWebhookEnabled(ctx(req).tenantId, req.params.id, enabled);
      if (!ok) {
        res.status(404).json({ error: 'Webhook not found' });
        return;
      }
      res.json({ id: req.params.id, enabled });
    } catch (err) {
      if (err instanceof BlockedUrlError) {
        res.status(400).json({ error: 'That URL is not reachable from the public internet', detail: err.message });
        return;
      }
      throw err;
    }
  }),
);

webhookTenantAdminRouter.delete(
  '/outbound-webhooks/:id',
  asyncRoute(async (req, res) => {
    const ok = await deleteOutboundWebhook(ctx(req).tenantId, req.params.id);
    res.status(ok ? 200 : 404).json(ok ? { deleted: true } : { error: 'Webhook not found' });
  }),
);

/** Test helper: format a metadata payload without booting the router. */
export function _publicMetadataForTesting(source: EventSource) {
  return publicMetadata(source);
}

/** Test helper: compute the inbound URL without booting the router. */
export function _inboundUrlForTesting(token: string): string {
  return inboundUrl(token);
}

// Re-exports for tests that want to bypass the membership middleware and
// hit the service layer directly.
