// CollabSkill read router.
//
// Mounted at `/api/governance/collab-skill`, behind the global
// verifyServiceAuth({ tokenEnvVar: 'GOVERNANCE_SERVICE_TOKEN' }) middleware.
// SHADOW / read-only — influences no gate.

import { Router, Request, Response } from 'express';
import { listCollabSkill } from './service';
import { log } from '../infrastructure/logging';

export const collabSkillRouter = Router();

// GET /api/governance/collab-skill?tenantId=&entityType=&scope=&modelVersion=
collabSkillRouter.get('/', async (req: Request, res: Response) => {
  try {
    const tenantId = req.query.tenantId as string | undefined;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId is required' });
    }
    const entities = await listCollabSkill(tenantId, {
      entityType: req.query.entityType as string | undefined,
      scope: req.query.scope as string | undefined,
      modelVersion: req.query.modelVersion as string | undefined,
    });
    res.json(entities);
  } catch (error) {
    log.error({ error: (error as Error).message }, 'Failed to list collab skill');
    res.status(500).json({ error: (error as Error).message });
  }
});
