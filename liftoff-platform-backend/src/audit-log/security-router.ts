import { Router } from 'express';
import { z } from 'zod';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { logAudit } from '../infrastructure/logging';
import { resolveAuditActor, verifyAccountInTenant } from '../infrastructure/audit-context';

// Phase 3: Firebase-managed security events. Password change and MFA
// enrollment complete client-side; the backend reports the event after
// Firebase resolves. Client-asserted (industry standard for client-side
// auth) — acceptable risk for compliance audit trails.
//
// Multi-tenant attribution: clients SHOULD send `tenantId` in the body
// (the tenant the user was operating in at the time of the security
// event). When omitted, the audit is attributed to the user's primary
// (oldest) tenant — best-effort fallback.

export const securityEventRouter = Router();

const securityRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: (req) => `${req.user?.uid ?? ipKeyGenerator(req.ip ?? "")}-sec`,
  message: { error: 'Too many security event reports' },
});

const SECURITY_EVENT_TYPES = [
  'account.password_changed',
  'account.mfa_enrolled',
  'account.mfa_disabled',
  'account.mfa_method_added',
  'account.mfa_method_removed',
  'account.mfa_challenge_completed',
  'account.session_revoked',
] as const;

const bodySchema = z.object({
  type: z.enum(SECURITY_EVENT_TYPES),
  tenantId: z.string().uuid().optional(),
  // Bounded metadata to prevent audit_log row bloat from a malicious
  // client. logAudit's sanitizer redacts secret-like keys but doesn't
  // enforce size; cap the JSON payload here.
  metadata: z.record(z.unknown()).optional(),
});

securityEventRouter.post(
  '/security-events',
  securityRateLimiter,
  async (req, res) => {
    if (!req.user?.uid) {
      return res.status(401).json({ error: 'Unauthenticated' });
    }

    const parse = bodySchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({ error: 'Invalid', details: parse.error.errors });
    }

    // Reject overly large metadata blobs (8 KB JSON limit, mirrors the
    // implicit limit in `agent_audit_logs.input_args`'s CHECK constraint).
    const metadata = parse.data.metadata ?? {};
    if (JSON.stringify(metadata).length > 8192) {
      return res.status(400).json({ error: 'metadata too large (max 8 KB)' });
    }

    let accountId: string;
    let tenantId: string | undefined;

    if (parse.data.tenantId) {
      // Client supplied a specific tenant — verify membership before attributing.
      const verified = await verifyAccountInTenant(req, parse.data.tenantId);
      if (!verified) {
        return res.status(403).json({ error: 'Not a member of the requested tenant' });
      }
      accountId = verified.accountId;
      tenantId = parse.data.tenantId;
    } else {
      // No tenant supplied — best-effort fallback to user's primary tenant.
      const actor = await resolveAuditActor(req);
      if (!actor) {
        return res.status(401).json({ error: 'Unauthenticated' });
      }
      accountId = actor.accountId;
      tenantId = actor.primaryTenantId ?? undefined;
    }

    logAudit(
      parse.data.type,
      { ...req.ctx, tenantId, userId: accountId },
      {
        resourceType: 'account',
        resourceId: accountId,
        newState: metadata,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      },
    );
    res.status(204).end();
  },
);
