// PR3: shared caller-resolution helper. Extracted from insights/router.ts so
// the new browser-sessions REST + SSE routers can authorize callers the same
// way (Firebase UID → account → tenant role) without duplicating the lookup.
//
// Every endpoint that uses this pattern asks: who is the caller's account,
// what tenant are they acting in, and what's their role there? On any failure
// the handler can early-return with the right status code.

import { AccountService } from '../accounts/service';
import { getCallerRole } from '../insights/chat-repository';

const accountService = new AccountService();

export interface CallerContext {
  accountId: string;
  tenantId: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
}

export type CallerResolution =
  | { ok: true; caller: CallerContext }
  | { ok: false; status: number; error: string };

export async function resolveCaller(
  firebaseUid: string | undefined,
  tenantId: string,
): Promise<CallerResolution> {
  if (!firebaseUid) {
    return { ok: false, status: 401, error: 'Authentication required' };
  }

  const account = await accountService.getByFirebaseUid(firebaseUid);
  if (!account) {
    return { ok: false, status: 401, error: 'Account not found' };
  }

  const role = await getCallerRole(tenantId, account.id);
  if (!role) {
    // Treat as 404 — never confirm tenant existence to non-members.
    return { ok: false, status: 404, error: 'Tenant not found' };
  }

  return { ok: true, caller: { accountId: account.id, tenantId, role } };
}
