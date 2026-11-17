// The workspace actions, for a platform assistant that runs in ANOTHER service.
//
// Liftoff and the Insights Manager run their tool loops inside this process
// and dispatch workspace actions directly. The Chief AI Officer runs in
// workforce-service against its own database, so it reaches the identical
// registry through this router instead:
//
//   GET  /api/internal/workspace-actions/tools   the manifest (definition,
//                                                 permission, mutating) the
//                                                 CAIO registers as its own
//                                                 tools at startup
//   POST /api/internal/workspace-actions          { tool, input, tenantId }
//                                                 with the caller headers →
//                                                 one dispatch, as that person
//   GET  /api/internal/workspace-actions/teams    the AI workforce (teams and
//                                                 collaborators, the fields the
//                                                 CAIO's org read needs) for
//                                                 org__get_existing_structure
//
// The person is the one the CAIO speaks for: x-account-id names them,
// x-tenant-role is informational (membership is re-read here), and
// x-origin carries the coding tool when the CAIO turn came through
// one. Mounted BEFORE the Firebase auth gate: the caller is a service.

import { Router, type Request, type Response } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { log } from '../infrastructure/logging';
import { resolveActor } from './actor';
import { parseLiftoffOriginHeader } from './origin-header';
import { listAiWorkforce } from './teams';
import { WORKSPACE_ACTION_TOOLS, dispatchWorkspaceAction, isWorkspaceActionTool, workspaceActionPermits } from './tools';

export const workspaceActionsInternalRouter = Router();

/** WF → PB service auth, the same token and shape the CAIO's other tools use. */
function serviceAuth(req: Request, res: Response, next: () => void): void {
  const token = req.headers['x-service-auth'] as string | undefined;
  const expected = process.env.WORKFORCE_SERVICE_TOKEN;
  if (!expected) { res.status(500).json({ error: 'Service authentication not configured' }); return; }
  const ok =
    token &&
    Buffer.byteLength(token) === Buffer.byteLength(expected) &&
    crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  if (!ok) { res.status(401).json({ error: 'Invalid service authentication' }); return; }
  next();
}

workspaceActionsInternalRouter.use(serviceAuth);

// GET /tools — the manifest. `roles` is the role rule already applied
// (permissions.ts is the ONE place it lives), so the CAIO's own access matrix
// records who may call each tool without keeping a copy of the rule.
const ALL_ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
workspaceActionsInternalRouter.get('/tools', (_req: Request, res: Response) => {
  res.json({
    tools: WORKSPACE_ACTION_TOOLS.map((t) => ({
      definition: t.definition,
      permission: t.permission,
      mutating: t.mutating === true,
      roles: ALL_ROLES.filter((role) => workspaceActionPermits(t.definition.name, role)),
    })),
  });
});

// GET /teams — the AI workforce, the CAIO's org__get_existing_structure.
// Projected to what that read uses: a team's prompts and instructions stay
// here, its name, status, text and bindings travel.
workspaceActionsInternalRouter.get('/teams', async (req: Request, res: Response) => {
  const tenantId = req.query.tenantId;
  if (typeof tenantId !== 'string' || !z.string().uuid().safeParse(tenantId).success) {
    return res.status(400).json({ error: 'tenantId is required' });
  }
  try {
    const { teams, collaborators } = await listAiWorkforce(tenantId);
    return res.json({
      aiWorkforce: {
        teams: teams.map((t) => ({
          id: t.id,
          role: t.role,
          messagingNickname: t.messagingNickname,
          agentType: t.agentType,
          status: t.status,
          summary: t.summary,
          responsibilities: t.responsibilities,
          integrations: t.integrations.map((i) => ({ id: i.id, type: i.type ?? i.integrationId ?? null })),
          pendingIntegrations: t.pendingIntegrations,
          workforcePlanId: t.workforcePlanId,
        })),
        collaborators: collaborators.map((c) => ({
          id: c.id,
          name: c.name,
          description: c.description,
          status: c.status,
          collaborationMode: c.collaborationMode,
          allowedInternalAgentIds: c.allowedInternalAgentIds,
        })),
      },
    });
  } catch (err) {
    log.error({ error: (err as Error).message, tenantId }, 'workspace-actions internal: teams read failed');
    return res.status(500).json({ error: 'Internal error' });
  }
});

const dispatchBodySchema = z.object({
  tenantId: z.string().uuid(),
  tool: z.string().min(1).max(100),
  input: z.record(z.unknown()).default({}),
});

// POST / — one dispatch, as the person the CAIO speaks for.
workspaceActionsInternalRouter.post('/', async (req: Request, res: Response) => {
  const parsed = dispatchBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', details: parsed.error.errors });
  }
  const { tenantId, tool, input } = parsed.data;
  if (!isWorkspaceActionTool(tool)) {
    return res.status(404).json({ error: `Unknown tool: ${tool}` });
  }
  const accountId = req.headers['x-account-id'];
  if (typeof accountId !== 'string' || accountId.length === 0) {
    return res.status(401).json({ error: 'x-account-id is required: the action is made as a person' });
  }
  const origin = parseLiftoffOriginHeader(req.headers['x-origin']);
  try {
    const actor = await resolveActor({ tenantId, accountId, surface: 'caio', ...(origin ?? {}) });
    if (!actor) {
      return res.status(403).json({ error: 'The person is not a member of this workspace' });
    }
    const result = await dispatchWorkspaceAction(tool, input, actor);
    // The dispatcher's result is the string the model reads; the CAIO's tool
    // relays it verbatim.
    return res.json({ result });
  } catch (err) {
    log.error({ error: (err as Error).message, tenantId, tool }, 'workspace-actions internal: dispatch failed');
    return res.status(500).json({ error: 'Internal error' });
  }
});
