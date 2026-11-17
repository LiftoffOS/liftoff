import { Router } from 'express';
import { z } from 'zod';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { logAudit } from '../infrastructure/logging';
import { resolveAuditActor, verifyAccountInTenant } from '../infrastructure/audit-context';

// Phase 3: /activity page read auditing. React POSTs (debounced) filter
// changes, search queries, and "See details" expansions so the audit feed
// records what reviewers looked at.
//
// Multi-tenant attribution: clients SHOULD send `tenantId` in the body
// (the tenant whose /activity page is being viewed). When omitted, the
// audit is attributed to the user's primary tenant.

export const activityEventsRouter = Router();

const ACTIVITY_EVENT_TYPES = [
  'activity.filter_applied',
  'activity.time_range_changed',
  'activity.search_performed',
  'activity.details_viewed',
  'activity.csv_exported',
] as const;

const bodySchema = z.object({
  type: z.enum(ACTIVITY_EVENT_TYPES),
  tenantId: z.string().uuid().optional(),
  resourceId: z.string().max(255).optional(),
  params: z.record(z.unknown()).optional(),
});

const activityRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: (req) => `${req.user?.uid ?? ipKeyGenerator(req.ip ?? "")}-act`,
});

activityEventsRouter.post(
  '/activity-events',
  activityRateLimiter,
  async (req, res) => {
    if (!req.user?.uid) {
      return res.status(401).json({ error: 'Unauth' });
    }

    const parse = bodySchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({ error: 'Invalid' });
    }

    const params = parse.data.params ?? {};
    if (JSON.stringify(params).length > 4096) {
      return res.status(400).json({ error: 'params too large (max 4 KB)' });
    }

    let accountId: string;
    let tenantId: string | undefined;

    if (parse.data.tenantId) {
      const verified = await verifyAccountInTenant(req, parse.data.tenantId);
      if (!verified) {
        return res.status(403).json({ error: 'Not a member of the requested tenant' });
      }
      accountId = verified.accountId;
      tenantId = parse.data.tenantId;
    } else {
      const actor = await resolveAuditActor(req);
      if (!actor) {
        return res.status(401).json({ error: 'Unauth' });
      }
      accountId = actor.accountId;
      tenantId = actor.primaryTenantId ?? undefined;
    }

    logAudit(
      parse.data.type,
      { ...req.ctx, tenantId, userId: accountId },
      {
        resourceType: 'activity_log',
        resourceId: parse.data.resourceId ?? 'list',
        newState: params,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      },
    );
    res.status(204).end();
  },
);
