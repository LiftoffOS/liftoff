// Team-preset provisioning — internal (WF → PB) route.
//
// POST /api/internal/team-presets/:id/provision
// Service-auth (x-service-auth). Tenant is taken from the x-tenant-id header (the
// authenticated service context), NEVER from the body. Validation runs BEFORE any
// run row is created, so a contract failure returns a 4xx with no side effect.

import { Router, type Request, type Response } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { validateProvisionRequest, type ProvisionRequest } from './validation';
import { teamProvisioningService } from './service';
import { log } from '../infrastructure/logging';

export const teamProvisioningRouter = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function serviceAuth(req: Request, res: Response, next: () => void): void {
  // WF → PB service auth (same token as the agent-templates internal router the CAIO
  // already calls). team_preset__provision is a WF tool.
  const token = req.headers['x-service-auth'] as string | undefined;
  const expected = process.env.WORKFORCE_SERVICE_TOKEN;
  if (!expected) { res.status(500).json({ error: 'Service authentication not configured' }); return; }
  const ok =
    token &&
    Buffer.byteLength(token) === Buffer.byteLength(expected) &&
    crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  if (!ok) { res.status(401).json({ error: 'Invalid service authentication' }); return; }
  next();
}

const bindingSchema = z.object({
  roleKey: z.string().min(1).max(100),
  connectorId: z.string().uuid(),
  repoScope: z.array(z.string().min(1).max(300)).max(200).optional(),
});

const provisionBodySchema = z.object({
  presetId: z.string().min(1).max(100).optional(),
  idempotencyKey: z.string().min(1).max(200),
  bindings: z.array(bindingSchema).min(1).max(20),
  escalationRecipientOverrides: z.record(z.string(), z.string()).optional(),
});

teamProvisioningRouter.post('/:id/provision', serviceAuth, async (req: Request, res: Response) => {
  const presetId = req.params.id;

  // TENANT: from the service context, never the body.
  const tenantId = req.headers['x-tenant-id'] as string | undefined;
  if (!tenantId || !UUID_RE.test(tenantId)) {
    return res.status(400).json({ error: 'x-tenant-id header (UUID) is required' });
  }
  const workforcePlanId = (req.headers['x-workforce-plan-id'] as string | undefined) ?? null;
  if (workforcePlanId && !UUID_RE.test(workforcePlanId)) {
    return res.status(400).json({ error: 'x-workforce-plan-id, if present, must be a UUID' });
  }

  const parsed = provisionBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid provision request', detail: parsed.error.issues });
  }
  const request = parsed.data as ProvisionRequest;

  try {
    // Validate the FULL contract before any run row exists — a failure is a clean 4xx.
    const validated = await validateProvisionRequest(tenantId, presetId, request);
    if (!validated.ok) {
      return res.status(validated.err.status).json({ error: validated.err.error });
    }

    const { result, conflict } = await teamProvisioningService.provision(tenantId, presetId, request, workforcePlanId);
    if (conflict) return res.status(conflict.status).json({ error: conflict.error });
    return res.status(200).json(result);
  } catch (err) {
    log.error({ error: (err as Error).message, presetId, tenantId }, 'team-preset provision failed');
    return res.status(500).json({ error: 'Internal server error' });
  }
});
