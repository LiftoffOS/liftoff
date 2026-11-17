import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { AccountService } from '../../accounts/service';
import { TenantMembersService } from '../../tenant-members/service';
import { log } from '../../infrastructure/logging';
import {
  getInstalledWorkspaceInstall,
  getWorkspaceDefaultAgent,
  setWorkspaceDefaultAgent,
} from './workspace-repository';

const adminRouter = Router();
const accountService = new AccountService();
const tenantMembersService = new TenantMembersService();

// ── Retired per-agent app endpoints (ADR-016, removed by ADR-040) ────────────
// Per-agent Slack apps are gone: the apps, their installs, and all the code
// that minted them have been deleted. Connecting the Slack connector installs
// the single Liftoff app. These stubs stay so a stale client gets a clear
// answer instead of a bare 404.

function goneRetired(_req: Request, res: Response): void {
  res.status(410).json({
    error: 'slack_per_agent_apps_retired',
    message: 'Per-team Slack apps are retired. Connect Slack from the Connections page instead.',
  });
}

adminRouter.get('/pending-installs', goneRetired);
adminRouter.post('/bulk-install-urls', goneRetired);
adminRouter.post('/create-app', goneRetired);

/** Verify the caller is an authenticated member of the tenant. Same shape the
 *  Teams admin routes use, and for the same reason: the global auth middleware
 *  establishes WHO is calling, not which tenants they may act on. */
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

// ── Workspace default team member ────────────────────────────────────────────
// The bottom rung of the routing ladder (see profile-routing.ts). A thread
// binding beats a channel binding, and both beat this; without it, the only
// answer to "nobody has chosen yet" is the picker, which a workspace that
// talks overwhelmingly to one team member has to dismiss forever.

adminRouter.get('/workspace-default', async (req: Request, res: Response) => {
  const tenantId = req.query.tenantId as string;
  if (!tenantId) {
    res.status(400).json({ error: 'Missing tenantId query parameter' });
    return;
  }
  if (!await verifyCallerAccess(req, res, tenantId)) return;

  try {
    const install = await getInstalledWorkspaceInstall(tenantId);
    if (!install) {
      res.status(404).json({ error: 'slack_workspace_not_connected' });
      return;
    }
    res.json({
      slackTeamId: install.slackTeamId,
      defaultAgentId: await getWorkspaceDefaultAgent(tenantId, install.slackTeamId),
    });
  } catch (err) {
    log.error({ tenantId, error: (err as Error).message }, 'slack workspace-default read failed');
    res.status(500).json({ error: 'workspace_default_read_failed' });
  }
});

const setDefaultSchema = z.object({
  tenantId: z.string().uuid(),
  // Null clears it, which puts the workspace back to being asked each time.
  // Explicitly nullable rather than optional so "clear" is a deliberate value
  // and a client that forgot the field cannot silently unset it.
  agentId: z.string().uuid().nullable(),
});

adminRouter.put('/workspace-default', async (req: Request, res: Response) => {
  const parsed = setDefaultSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body', details: parsed.error.errors });
    return;
  }
  const { tenantId, agentId } = parsed.data;
  if (!await verifyCallerAccess(req, res, tenantId)) return;

  try {
    const install = await getInstalledWorkspaceInstall(tenantId);
    if (!install) {
      res.status(404).json({ error: 'slack_workspace_not_connected' });
      return;
    }
    const updated = await setWorkspaceDefaultAgent(tenantId, install.slackTeamId, agentId);
    if (!updated) {
      res.status(404).json({ error: 'slack_workspace_not_connected' });
      return;
    }
    log.info({ tenantId, slackTeamId: install.slackTeamId, agentId }, 'slack workspace default set');
    res.json({ slackTeamId: install.slackTeamId, defaultAgentId: agentId });
  } catch (err) {
    log.error({ tenantId, error: (err as Error).message }, 'slack workspace-default write failed');
    res.status(500).json({ error: 'workspace_default_write_failed' });
  }
});

export { adminRouter as slackAdminRouter };
