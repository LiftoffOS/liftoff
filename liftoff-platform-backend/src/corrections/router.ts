// Correction Protocol API Router
// Per implementation plan: API endpoints for correction operations

import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { correctionService } from './service';
import { checkCorrectionConfigPermissions } from './permissions';

import { authedWithDelegation } from '../support-delegation/authed';
import { log } from '../infrastructure/logging';
import { tenantMembersService } from '../tenant-members/service';
import { AccountService } from '../accounts/service';
import { verifyTenantOwnership } from '../infrastructure/tenant-role-auth';

export const correctionRouter = Router();
const accountService = new AccountService();

// Resolve Firebase UID to account UUID (tenant_members uses account_id, not Firebase UID)
async function getAccountId(req: Request): Promise<string | null> {
  const firebaseUid = (req as any).user?.uid;
  if (!firebaseUid) return null;
  const account = await accountService.getByFirebaseUid(firebaseUid);
  return account?.id || null;
}

// ==========================================================================
// Schemas
// ==========================================================================

const correctionRequestSchema = z.object({
  reason: z.string().max(1000).optional(),
});

const bulkCorrectionRequestSchema = z.object({
  auditLogIds: z.array(z.string().uuid()).min(1).max(50),
  reason: z.string().max(1000).optional(),
  stopOnError: z.boolean().optional().default(false),
});

const correctionConfigSchema = z.object({
  requireApprovalAll: z.boolean().optional(),
  autoApproveWindow: z.number().int().min(0).max(86400).optional().nullable(),
  requireOriginalActor: z.boolean().optional(),
});

// ==========================================================================
// Rate Limiters
// ==========================================================================

const correctionRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 correction requests per minute per tenant
  keyGenerator: (req) => `correction:${req.query.tenantId}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Rate limit exceeded', retryAfter: 60 },
});

const readRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  keyGenerator: (req) => `correction-read:${req.query.tenantId}`,
  standardHeaders: true,
  legacyHeaders: false,
});

// Service auth middleware for internal endpoints
const serviceAuthMiddleware = async (req: Request, res: Response, next: () => void) => {
  const serviceToken = req.headers['x-service-auth'] as string | undefined;
  const expectedToken = process.env.TENANT_RUNTIME_SERVICE_TOKEN;

  if (!expectedToken) {
    return res.status(500).json({ error: 'Service authentication not configured' });
  }

  const isValid = serviceToken &&
    Buffer.byteLength(serviceToken) === Buffer.byteLength(expectedToken) &&
    crypto.timingSafeEqual(Buffer.from(serviceToken), Buffer.from(expectedToken));

  if (!isValid) {
    return res.status(401).json({ error: 'Invalid service authentication' });
  }

  next();
};

// ==========================================================================
// Public User Endpoints
// ==========================================================================

// GET /api/audit-logs/:id/correction-options
// Get available corrections with user-facing labels
correctionRouter.get(
  '/audit-logs/:id/correction-options',
  ...authedWithDelegation,
  readRateLimiter,
  async (req: Request, res: Response) => {
    try {
      const tenantId = req.query.tenantId as string;
      const accountId = await getAccountId(req);

      if (!tenantId) {
        return res.status(400).json({ error: 'tenantId is required' });
      }

      if (!accountId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      // SE-001: Verify user belongs to tenant
      const membership = await tenantMembersService.getMembership(tenantId, accountId);
      if (!membership) {
        return res.status(403).json({ error: 'Not authorized for this tenant' });
      }

      const options = await correctionService.getCorrectionOptions(tenantId, req.params.id);
      res.json(options);
    } catch (error) {
      log.error({ error, auditLogId: req.params.id }, 'Failed to get correction options');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// POST /api/audit-logs/:id/correct
// Request correction for an action
correctionRouter.post(
  '/audit-logs/:id/correct',
  ...authedWithDelegation,
  verifyTenantOwnership,
  correctionRateLimiter,
  async (req: Request, res: Response) => {
    try {
      const tenantId = req.query.tenantId as string;
      const accountId = await getAccountId(req);

      if (!tenantId) {
        return res.status(400).json({ error: 'tenantId is required' });
      }

      if (!accountId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const parseResult = correctionRequestSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({
          error: 'Validation failed',
          details: parseResult.error.errors,
        });
      }

      const result = await correctionService.requestCorrection({
        tenantId,
        auditLogId: req.params.id,
        reason: parseResult.data.reason,
        requestedBy: accountId,
      });

      if (!result.success) {
        return res.status(400).json(result);
      }

      res.status(202).json(result);
    } catch (error) {
      log.error({ error, auditLogId: req.params.id }, 'Failed to request correction');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// POST /api/audit-logs/bulk-correct
// Request correction for multiple actions
correctionRouter.post(
  '/audit-logs/bulk-correct',
  ...authedWithDelegation,
  verifyTenantOwnership,
  correctionRateLimiter,
  async (req: Request, res: Response) => {
    try {
      const tenantId = req.query.tenantId as string;
      const accountId = await getAccountId(req);

      if (!tenantId) {
        return res.status(400).json({ error: 'tenantId is required' });
      }

      if (!accountId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const parseResult = bulkCorrectionRequestSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({
          error: 'Validation failed',
          details: parseResult.error.errors,
        });
      }

      const result = await correctionService.requestBulkCorrection(
        tenantId,
        accountId,
        parseResult.data
      );

      res.status(202).json(result);
    } catch (error) {
      log.error({ error }, 'Failed to request bulk correction');
      if ((error as Error).message.includes('Maximum')) {
        return res.status(400).json({ error: (error as Error).message });
      }
      if ((error as Error).message.includes('Rate limit')) {
        return res.status(429).json({ error: (error as Error).message });
      }
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// GET /api/audit-logs/:id/correction-history
// Get full audit trail including corrections
correctionRouter.get(
  '/audit-logs/:id/correction-history',
  ...authedWithDelegation,
  readRateLimiter,
  async (req: Request, res: Response) => {
    try {
      const tenantId = req.query.tenantId as string;
      const accountId = await getAccountId(req);

      if (!tenantId) {
        return res.status(400).json({ error: 'tenantId is required' });
      }

      if (!accountId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      // SE-002: Verify user belongs to tenant
      const membership = await tenantMembersService.getMembership(tenantId, accountId);
      if (!membership) {
        return res.status(403).json({ error: 'Not authorized for this tenant' });
      }

      const history = await correctionService.getCorrectionHistory(tenantId, req.params.id);
      res.json({ history });
    } catch (error) {
      log.error({ error, auditLogId: req.params.id }, 'Failed to get correction history');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ==========================================================================
// Admin Configuration Endpoints
// ==========================================================================

// GET /api/tenants/:id/correction-config
// Get tenant correction configuration
correctionRouter.get(
  '/tenants/:id/correction-config',
  ...authedWithDelegation,
  readRateLimiter,
  async (req: Request, res: Response) => {
    try {
      const tenantId = req.params.id;
      const accountId = await getAccountId(req);

      if (!accountId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      // SE-003: Verify user belongs to tenant
      const membership = await tenantMembersService.getMembership(tenantId, accountId);
      if (!membership) {
        return res.status(403).json({ error: 'Not authorized for this tenant' });
      }

      const config = await correctionService.getCorrectionConfig(tenantId);

      // Return defaults if not configured
      res.json(config || {
        tenantId,
        requireApprovalAll: false,
        autoApproveWindow: null,
        requireOriginalActor: false,
      });
    } catch (error) {
      log.error({ error, tenantId: req.params.id }, 'Failed to get correction config');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// PUT /api/tenants/:id/correction-config
// Update tenant correction configuration
correctionRouter.put(
  '/tenants/:id/correction-config',
  ...authedWithDelegation,
  async (req: Request, res: Response) => {
    try {
      const tenantId = req.params.id;
      const accountId = await getAccountId(req);

      if (!accountId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      // Check permissions
      const permissionResult = await checkCorrectionConfigPermissions(tenantId, accountId);
      if (!permissionResult.allowed) {
        return res.status(403).json({ error: permissionResult.reason });
      }

      const parseResult = correctionConfigSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({
          error: 'Validation failed',
          details: parseResult.error.errors,
        });
      }

      const config = await correctionService.updateCorrectionConfig(tenantId, parseResult.data);
      res.json(config);
    } catch (error) {
      log.error({ error, tenantId: req.params.id }, 'Failed to update correction config');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// GET /api/tenants/:id/correction-usage
// Get rate limit and budget usage
correctionRouter.get(
  '/tenants/:id/correction-usage',
  ...authedWithDelegation,
  readRateLimiter,
  async (req: Request, res: Response) => {
    try {
      const tenantId = req.params.id;
      const accountId = await getAccountId(req);

      if (!accountId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      // SE-004: Verify user belongs to tenant
      const membership = await tenantMembersService.getMembership(tenantId, accountId);
      if (!membership) {
        return res.status(403).json({ error: 'Not authorized for this tenant' });
      }

      const usage = await correctionService.getCorrectionUsage(tenantId);
      res.json(usage);
    } catch (error) {
      log.error({ error, tenantId: req.params.id }, 'Failed to get correction usage');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ==========================================================================
// Internal Service Endpoints
// ==========================================================================

// POST /api/internal/corrections/cleanup
// Clean up expired rate usage entries (called by Cloud Scheduler)
correctionRouter.post(
  '/internal/corrections/cleanup',
  serviceAuthMiddleware,
  async (req: Request, res: Response) => {
    try {
      const cleanedCount = await correctionService.cleanupExpiredRateUsage();

      log.info({ cleanedCount }, 'Cleaned up expired rate usage');
      res.json({ success: true, cleanedCount });
    } catch (error) {
      log.error({ error }, 'Failed to cleanup rate usage');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);


