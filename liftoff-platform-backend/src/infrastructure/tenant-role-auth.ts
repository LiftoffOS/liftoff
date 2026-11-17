// Tenant-role authorization middlewares
//
// Shared helpers extracted from internal-agents/router so multiple routers
// (internal-agents, tenants) can reuse the same membership + min-role check
// without duplicating the implementation. The previous duplication caused
// a deviation from the plan §3.2 (one helper, two routers) — this module
// is the single source of truth.

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { AccountService } from '../accounts/service';
import { tenantMembersService } from '../tenant-members/service';
import { TenantMemberRole, ROLE_HIERARCHY } from '../tenant-members/types';

const accountService = new AccountService();

/**
 * Helper: extract tenantId from any of query/params/body so the same
 * middleware works regardless of where the caller put it. Matches the
 * existing pattern at internal-agents/router.ts:479.
 */
function extractTenantId(req: Request): string | undefined {
  return (req.query.tenantId as string) || req.params.tenantId || req.body?.tenantId;
}

/**
 * Bare ownership check — caller is a member of `tenantId`. No role floor.
 * Returns 400 missing-tenant, 401 unauthenticated, 403 non-member.
 * Mirrors the previous verifyTenantOwnership at internal-agents/router.ts:478.
 */
export async function verifyTenantOwnership(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const tenantId = extractTenantId(req);
  if (!tenantId) {
    res.status(400).json({ error: 'Missing tenant context' });
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
  next();
}

/**
 * Role-floor check — caller is a member of `tenantId` AND their role is
 * at least `minRole`. Uses ROLE_HIERARCHY (tenant-members/types) for
 * comparison. Returns the same status codes as verifyTenantOwnership plus
 * 403 for insufficient-role.
 */
export function requireMinRole(minRole: TenantMemberRole): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const tenantId = extractTenantId(req);
    if (!tenantId) {
      res.status(400).json({ error: 'Missing tenant context' });
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
    if (ROLE_HIERARCHY[membership.role] < ROLE_HIERARCHY[minRole]) {
      res.status(403).json({ error: `Requires at least ${minRole} role` });
      return;
    }
    next();
  };
}

/**
 * For routes where the tenant filter is OPTIONAL.
 *
 * `model-registry`'s rollout listings take `?tenantId=` and, when it is absent,
 * return rollouts across every tenant. Neither half was checked: naming someone
 * else's tenant read their rollouts, and omitting it read everyone's. A blanket
 * `verifyTenantOwnership` cannot be used because it 400s without a tenant id,
 * which would break the cross-tenant view the operator dashboard needs.
 *
 * So: naming a tenant requires membership of it; omitting one is a cross-tenant
 * read and requires platform admin. `req.isPlatformAdmin` is populated by
 * `attachAdminStatus`, which is on the mount of every route using this.
 */
export async function verifyTenantScopeIfNamed(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const tenantId = extractTenantId(req);
  if (!tenantId) {
    if (req.isPlatformAdmin === true) {
      next();
      return;
    }
    res.status(403).json({ error: 'Cross-tenant view requires platform admin' });
    return;
  }
  return verifyTenantOwnership(req, res, next);
}
