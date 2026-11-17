// Audit context helpers.
//
// The unified workspace audit feed (src/audit-log/repository.ts) filters
// `audit_log` rows by `user_id IS NOT NULL` and `tenant_id = $1`. Because
// `audit_log.user_id` is a UUID column, the buffered flush in
// `infrastructure/logging.ts` runs `validateUuid()` on the userId before
// insert — Firebase UIDs (28 alphanumeric chars) fail that validation and
// become NULL, which means the audit row is then invisible in the workspace
// feed.
//
// `req.ctx.userId` is the Firebase UID (set by authMiddleware). To surface
// the audit row to the workspace, callers must pass the workspace
// accountId (UUID) in `LogContext.userId`. This helper resolves the right
// actor accountId per request:
//
//   1. If `tenantAuthMiddleware` ran upstream, `(req as any).actorAccountId`
//      is already the workspace accountId — use it (sync, zero DB cost).
//   2. Otherwise, fall back to an `accounts.firebase_uid` lookup (async).
//
// Always prefer (1) by gating audit-emitting routes behind
// `tenantAuthMiddleware`. The async fallback exists for legitimate
// non-tenant-scoped paths (Phase 3 security events, slack OAuth callback,
// billing proxy).

import type { Request } from 'express';
import type { LogContext } from './logging';
import { AccountService } from '../accounts/service';
import { withAdminScope } from './database';

let _accountService: AccountService | null = null;
function accountService(): AccountService {
  if (!_accountService) _accountService = new AccountService();
  return _accountService;
}

/**
 * Synchronous audit context builder.
 *
 * Returns a LogContext suitable for `logAudit(action, ctx, details)` where
 * `userId` is the workspace accountId (when resolvable) and `tenantId` is
 * either the override or whatever `tenantAuthMiddleware` already set.
 *
 * Use this on routes guarded by `tenantAuthMiddleware`. For other routes,
 * use `resolveAuditActor` (async).
 */
export function auditCtx(req: Request, override?: { tenantId?: string }): LogContext {
  const actorAccountId = (req as unknown as { actorAccountId?: string }).actorAccountId;
  return {
    ...req.ctx,
    ...(override?.tenantId !== undefined && { tenantId: override.tenantId }),
    // Fall back to req.ctx.userId only when no actor accountId is
    // available — that fallback is the firebase UID and will be NULLed by
    // the audit flush. Better to record `user_id: NULL` (visible as
    // "system action" in the unified feed's filter) than to leak a
    // firebase UID as if it were an accountId.
    userId: actorAccountId ?? req.ctx?.userId,
  };
}

/**
 * Async actor resolution for routes without `tenantAuthMiddleware`.
 *
 * Resolves Firebase UID → accountId via the accounts table, then looks up
 * the user's primary (oldest) tenant membership for fallback tenant
 * attribution. Callers that need a SPECIFIC tenant (e.g. Phase 3 security
 * events on a multi-tenant user) should pass `explicitTenantId` and
 * verify membership separately.
 *
 * Returns null when the request is unauthenticated or the user has no
 * account row yet.
 */
export async function resolveAuditActor(req: Request): Promise<{
  accountId: string;
  primaryTenantId: string | null;
} | null> {
  const firebaseUid = req.user?.uid ?? req.ctx?.userId;
  if (!firebaseUid) return null;
  const account = await accountService().getByFirebaseUid(firebaseUid);
  if (!account) return null;
  const r = await withAdminScope(
    { caller: 'audit-context.resolveAuditActor', reason: 'pre-tenant-context auth lookup: resolve user primary tenant from tenant_members (no tenant scope yet)' },
    (client) => client.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM tenant_members WHERE account_id = $1 ORDER BY joined_at ASC LIMIT 1`,
      [account.id],
    ),
  );
  return { accountId: account.id, primaryTenantId: r.rows[0]?.tenant_id ?? null };
}

/**
 * Verifies the given Firebase-authenticated user is a member of `tenantId`,
 * returning the resolved accountId. Used by Phase 3 routers where the
 * client supplies a tenantId in the body and we must confirm membership
 * before emitting an audit row.
 *
 * Returns null on any failure (unauthenticated, account not found, not a
 * member of `tenantId`). Callers should treat null as 401/403.
 */
export async function verifyAccountInTenant(
  req: Request,
  tenantId: string,
): Promise<{ accountId: string } | null> {
  const firebaseUid = req.user?.uid ?? req.ctx?.userId;
  if (!firebaseUid) return null;
  const account = await accountService().getByFirebaseUid(firebaseUid);
  if (!account) return null;
  const r = await withAdminScope(
    { caller: 'audit-context.verifyAccountInTenant', reason: 'pre-tenant-context membership verification (client-supplied tenantId; exact WHERE tenant_id+account_id)' },
    (client) => client.query<{ n: number }>(
      `SELECT 1 AS n FROM tenant_members WHERE tenant_id = $1 AND account_id = $2 LIMIT 1`,
      [tenantId, account.id],
    ),
  );
  if (r.rows.length === 0) return null;
  return { accountId: account.id };
}
