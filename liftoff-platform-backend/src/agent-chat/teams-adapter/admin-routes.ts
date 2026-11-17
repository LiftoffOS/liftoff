// Teams admin routes (tenant-member authenticated), mounted after authMiddleware.
//
//   GET /connect-url?tenantId=     → a single Microsoft authorization URL. The
//                                    admin signs in once; the callback exchanges
//                                    the code, publishes to the org catalog, and
//                                    redirects into Teams' add-app dialog.

import { Router, type Request, type Response } from 'express';
import { AccountService } from '../../accounts/service';
import { TenantMembersService } from '../../tenant-members/service';
import { getBackendUrl } from '../../infrastructure/control-plane-url';

const router = Router();
const accountService = new AccountService();
const tenantMembersService = new TenantMembersService();

/** Verify the caller is an authenticated member of the tenant. */
async function verifyCallerAccess(
  req: Request,
  res: Response,
  tenantId: string,
): Promise<{ accountId: string } | null> {
  const firebaseUid = req.ctx?.userId;
  if (!firebaseUid) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  const account = await accountService.getByFirebaseUid(firebaseUid);
  if (!account) {
    res.status(401).json({ error: 'Account not found' });
    return null;
  }
  const membership = await tenantMembersService.getMembership(tenantId, account.id);
  if (!membership) {
    res.status(404).json({ error: 'Tenant not found' });
    return null;
  }
  return { accountId: account.id };
}

function encodeState(obj: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

/**
 * The Microsoft sign-in URL that connects a Teams tenant. Shared by the
 * dashboard route below and the assistants' connection_start, so the two
 * cannot drift on scope or redirect.
 *
 * Single authorization-code flow: the admin signs in once and consents to the
 * delegated AppCatalog.ReadWrite.All scope. Core chat needs no Graph
 * application permissions (identity comes from the Bot Framework roster), so
 * there's no separate /adminconsent round-trip — just this one screen.
 *
 * Returns null when Teams is not configured for this deployment.
 */
export function buildTeamsConnectUrl(tenantId: string, _accountId: string): string | null {
  const appId = process.env.TEAMS_BOT_APP_ID;
  if (!appId) return null;
  const redirectUri = encodeURIComponent(`${getBackendUrl()}/api/agent-chat/teams/oauth-callback`);
  const scope = encodeURIComponent(
    'https://graph.microsoft.com/AppCatalog.ReadWrite.All offline_access openid',
  );
  const state = encodeState({ tenantId });
  return (
    `https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize` +
    `?client_id=${appId}&response_type=code&response_mode=query` +
    `&redirect_uri=${redirectUri}&scope=${scope}&state=${state}`
  );
}

// GET /api/agent-chat/teams/connect-url?tenantId=...
router.get('/connect-url', async (req: Request, res: Response) => {
  const tenantId = req.query.tenantId as string;
  if (!tenantId) return res.status(400).json({ error: 'Missing tenantId query parameter' });

  const caller = await verifyCallerAccess(req, res, tenantId);
  if (!caller) return;

  const url = buildTeamsConnectUrl(tenantId, caller.accountId);
  if (!url) return res.status(500).json({ error: 'Teams not configured' });
  return res.json({ url });
});

export { router as teamsAdminRouter };

