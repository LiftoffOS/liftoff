// HITL Enforcement Middleware
// Per implementation plan: [FIX: SE-001] RBAC Authorization Middleware

import { Request, Response, NextFunction } from 'express';
import { hitlEnforcementService } from './service';

// Permission checking (to be integrated with existing auth system)
async function checkPermission(userId: string, _permission: string): Promise<boolean> {
  // TODO: Integrate with actual RBAC system
  // For now, return true for authenticated users
  return !!userId;
}

// Get user role from request context
function getUserRole(req: Request): string {
  return req.ctx?.role || 'member';
}

// [FIX: SE-001] RBAC middleware for HITL approval endpoints
export async function requireHitlApprovalPermission(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = req.ctx?.userId;

    if (!userId) {
      res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'Authentication required',
      });
      return;
    }

    // Check user has 'hitl:approve' permission
    const hasPermission = await checkPermission(userId, 'hitl:approve');
    if (!hasPermission) {
      res.status(403).json({
        error: 'FORBIDDEN',
        message: 'User does not have permission to approve HITL requests',
      });
      return;
    }

    // For high-risk approvals (hitl_level 1), require admin role
    const approvalId = req.params.id;
    if (approvalId) {
      const approval = await hitlEnforcementService.getApprovalRequest(approvalId);
      if (approval && approval.hitlLevel === 1) {
        const userRole = getUserRole(req);
        if (userRole !== 'admin') {
          res.status(403).json({
            error: 'FORBIDDEN',
            message: 'Level 1 HITL approvals require admin role',
          });
          return;
        }
      }
    }

    next();
  } catch (error) {
    next(error);
  }
}

// [FIX: Per implementation plan] Require specific role middleware
export function requireRole(role: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.ctx?.userId;

      if (!userId) {
        res.status(401).json({
          error: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
        return;
      }

      const userRole = getUserRole(req);
      if (userRole !== role && userRole !== 'admin') {
        res.status(403).json({
          error: 'FORBIDDEN',
          message: `This action requires ${role} role`,
        });
        return;
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}

// Middleware to validate tenant access
export async function validateTenantAccess(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = req.ctx?.userId;
    const tenantId = req.ctx?.tenantId || req.params.tenantId;

    if (!userId) {
      res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'Authentication required',
      });
      return;
    }

    if (!tenantId) {
      res.status(400).json({
        error: 'BAD_REQUEST',
        message: 'Tenant ID required',
      });
      return;
    }

    // TODO: Validate user has access to tenant
    // For now, pass through

    next();
  } catch (error) {
    next(error);
  }
}
