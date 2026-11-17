// PR 3 / Gap A — GET /api/admin/accounts/:accountId/state.
//
// Consolidated read of all state relevant to an enterprise account.
// Returns:
//   { data: <AccountStateSnapshot>,
//     audit: { actionId, action: 'account.state.read', actor, timestamp },
//     healthCheck: { ok, issues[] } }
//
// PR 0 conventions apply:
//   - Zod-validated params (accountId must be UUID; rejected with 400).
//   - Audit row written via logAdminAction (exceptions bubble — Q3).
//   - Response wrapped via wrapAdminResponse with healthCheck.
//
// healthCheck.issues[] is a curated list (see inferHealthIssues in the
// service). Operators must NOT interpret ok=true as "everything is perfect."
// Documented in docs/admin-api.md.
//
// Mounted in src/admin/router.ts; admin-auth + adminAccount injection happens
// in the router-level middleware, so this handler only needs to read the
// resolved accountId and call the service.

import { Request, Response, NextFunction } from 'express';
import { logAdminAction } from './middleware';
import { wrapAdminResponse, adminError } from './conventions';
import { accountIdParam } from './zod-helpers';
import { validateRequest } from './validate-request';
import {
  readAccountState,
  inferHealthIssues,
  type AccountStateSnapshot,
} from './account-state-service';
import { AccountNotFoundError } from '../accounts/service';

export const accountStateRequestSchema = { params: accountIdParam };

export const validateAccountStateRequest = validateRequest(accountStateRequestSchema);

export async function handleAccountStateRead(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { accountId } = req.params;
    const adminAccount = (req as Request & { adminAccount?: { id: string; email: string } })
      .adminAccount;

    let snapshot: AccountStateSnapshot;
    try {
      snapshot = await readAccountState(accountId);
    } catch (err) {
      if (err instanceof AccountNotFoundError) {
        res.status(404).json(adminError('account_not_found', `accountId=${err.accountId}`));
        return;
      }
      throw err;
    }

    const issues = inferHealthIssues(snapshot);
    const healthCheck = { ok: issues.length === 0, issues };

    // Per Q3 — exceptions bubble; audit-log loss is a real incident.
    const audit = await logAdminAction(
      adminAccount?.id ?? 'admin:no-id',
      'account.state.read',
      'account',
      accountId,
      null,
      req,
    );

    res.status(200).json(wrapAdminResponse(snapshot, audit, healthCheck));
  } catch (err) {
    next(err);
  }
}
