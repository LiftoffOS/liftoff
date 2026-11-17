import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { auditLogService } from './service';
import { logAudit } from '../infrastructure/logging';
import { tenantAuthMiddleware } from '../infrastructure/middleware';
import { auditCtx } from '../infrastructure/audit-context';
import { ValidationError } from '../tenant-members/service';

export const auditLogRouter = Router();

// Separate rate limiters for read vs. report so a single user downloading
// a long CSV (many GETs) doesn't exhaust the budget that the final
// `audit.csv_downloaded` POST needs. Both are per-tenant.
const auditReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req) => `${req.params.tenantId}-audit-read`,
  message: { error: 'Too many audit requests, please try again later' },
});

const auditExportLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: (req) => `${req.params.tenantId}-audit-export`,
  message: { error: 'Too many export-completed reports' },
});

// Audit Logs is an Enterprise-plan feature. The frontend hides the section for
// non-Enterprise tenants; enforce it on the API too so the endpoint cannot be
// called directly on a lower tier.
async function requireEnterprise(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!(await auditLogService.isEnterprise(req.params.tenantId))) {
      res.status(403).json({ error: 'Audit Logs are available on the Enterprise plan.' });
      return;
    }
    next();
  } catch (err) {
    next(err);
  }
}

const querySchema = z.object({
  startDate: z.string().datetime(),
  endDate: z.string().datetime(),
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).optional(),
});

auditLogRouter.get(
  '/:tenantId/events',
  auditReadLimiter,
  tenantAuthMiddleware('viewAuditLogs'),
  requireEnterprise,
  async (req: Request, res: Response) => {
    try {
      const { tenantId } = req.params;
      const parse = querySchema.safeParse(req.query);
      if (!parse.success) {
        return res
          .status(400)
          .json({ error: 'Invalid parameters', details: parse.error.errors });
      }
      const { startDate, endDate, cursor, limit } = parse.data;
      const result = await auditLogService.list(
        tenantId,
        new Date(startDate),
        new Date(endDate),
        { cursor, limit },
      );
      logAudit('audit.accessed', auditCtx(req), {
        tenantId,
        startDate,
        endDate,
        entriesReturned: result.entries.length,
        hasMore: result.hasMore,
      });
      res.json(result);
    } catch (err) {
      if (err instanceof ValidationError) {
        return res.status(400).json({ error: (err as Error).message });
      }
      const e = err as Error;
      console.error('Audit list error', e.message, e.stack);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

const exportCompletedSchema = z.object({
  startDate: z.string().datetime(),
  endDate: z.string().datetime(),
  totalRows: z.number().int().min(0),
});

auditLogRouter.post(
  '/:tenantId/events/export-completed',
  auditExportLimiter,
  tenantAuthMiddleware('viewAuditLogs'),
  requireEnterprise,
  async (req: Request, res: Response) => {
    const { tenantId } = req.params;
    const parse = exportCompletedSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({ error: 'Invalid', details: parse.error.errors });
    }
    logAudit('audit.csv_downloaded', auditCtx(req), {
      tenantId,
      resourceType: 'audit_log_export',
      resourceId: tenantId,
      newState: {
        startDate: parse.data.startDate,
        endDate: parse.data.endDate,
        totalRows: parse.data.totalRows,
      },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.status(204).end();
  },
);
