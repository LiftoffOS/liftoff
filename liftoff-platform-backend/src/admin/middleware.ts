// Admin Auth Middleware
// Per Phase 0.1: SE-001 (Critical), TE-001 (Critical)
// Addresses: Admin router lacks authorization middleware - kill switches unprotected

import { Request, Response, NextFunction } from 'express';
import { getPool } from '../infrastructure/database';
import { logAudit } from '../infrastructure/logging';
import type { AdminAuditRecord } from './conventions';

/**
 * Admin authentication middleware
 * Verifies the authenticated user has is_platform_admin = true
 * Required for all admin routes per SE-001
 */
export async function adminAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // Require authentication first
    const firebaseUid = req.user?.uid;
    if (!firebaseUid) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication required',
        requestId: req.ctx?.requestId,
      });
      return;
    }

    // Look up account by Firebase UID and check platform admin status
    const pool = getPool();
    const result = await pool.query(
      `SELECT id, email, is_platform_admin FROM accounts WHERE firebase_uid = $1`,
      [firebaseUid]
    );

    if (result.rows.length === 0) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Account not found',
        requestId: req.ctx?.requestId,
      });
      return;
    }

    const account = result.rows[0];

    // Verify platform admin status
    if (!account.is_platform_admin) {
      // Log unauthorized admin access attempt
      logAudit('admin.access_denied', req.ctx, {
        accountId: account.id,
        email: account.email,
        reason: 'not_platform_admin',
        attemptedAction: `${req.method} ${req.path}`,
      });

      res.status(403).json({
        error: 'Forbidden',
        message: 'Platform admin access required',
        requestId: req.ctx?.requestId,
      });
      return;
    }

    // Attach admin account info to request for downstream use
    (req as any).adminAccount = {
      id: account.id,
      email: account.email,
      isPlatformAdmin: true,
    };

    // Add account ID to logging context
    if (req.ctx) {
      req.ctx.adminId = account.id;
    }

    req.log?.info({ adminId: account.id }, 'Admin access granted');
    next();
  } catch (error) {
    req.log?.error({ error }, 'Admin auth middleware error');
    next(error);
  }
}

/**
 * Log admin action to audit table for comprehensive audit logging
 * Per Phase 0.1 Action 4: Add comprehensive audit logging for all admin actions
 */
export async function logAdminAction(
  adminId: string,
  action: string,
  targetType: string,
  targetId: string | null,
  details: Record<string, unknown> | null,
  req: Request
): Promise<AdminAuditRecord> {
  const pool = getPool();

  // Get IP address (handle proxies).
  const ipAddress = req.headers['x-forwarded-for']
    ? (req.headers['x-forwarded-for'] as string).split(',')[0].trim()
    : req.socket?.remoteAddress || null;

  const userAgent = req.headers['user-agent'] || null;

  // RETURNING id + created_at so the caller can echo the audit row in the
  // response envelope without a follow-up query. Exceptions bubble (Q3).
  const result = await pool.query<{ id: string; created_at: Date }>(
    `INSERT INTO admin_action_audit (admin_id, action, target_type, target_id, details, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6::inet, $7)
     RETURNING id, created_at`,
    [adminId, action, targetType, targetId, details ? JSON.stringify(details) : null, ipAddress, userAgent]
  );

  const row = result.rows[0];
  const adminAccount = (req as Request & { adminAccount?: { id: string; email: string } }).adminAccount;
  return {
    actionId: row.id,
    action,
    actor: {
      accountId: adminAccount?.id ?? adminId,
      email: adminAccount?.email ?? null,
    },
    timestamp: row.created_at.toISOString(),
  };
}
