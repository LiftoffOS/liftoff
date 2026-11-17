import { Router } from 'express';
import { getPoolForService } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';

export const skillsRouter = Router();

// GET /api/agents/:internalAgentId/skills?tenantId=...
// Returns active skills for an agent. Called by platform-backend to power the
// skills display in advanced settings (TeamUpdatePage).
// The path param is the platform-backend internalAgentId; we join through
// internal_agent_runtime_mapping to resolve to the tenant-runtime agent_id.
skillsRouter.get('/:internalAgentId/skills', async (req, res) => {
  const { internalAgentId } = req.params;
  const tenantId = req.query.tenantId as string;

  if (!tenantId) {
    return res.status(400).json({ error: 'tenantId is required' });
  }

  try {
    const pool = getPoolForService('scheduled-execution');
    const result = await pool.query<{
      id: string;
      name: string;
      description: string;
      instruction: string;
      tags: string[];
      provenance: string;
      protected: boolean;
    }>(
      // provenance/protected are returned because the control plane READS this
      // endpoint to decide whether the flywheel may rewrite a skill. Omitting
      // them made every skill look unprotected and provenance-less, which both
      // disabled the protection check and let a write-back down-stamp learned
      // skills to distilled — the exact loss ADR-043 exists to prevent.
      `SELECT s.id, s.name, s.description, s.instruction, s.tags, s.provenance, s.protected
       FROM agent_skills s
       JOIN internal_agent_runtime_mapping m
         ON m.agent_id = s.agent_id AND m.tenant_id = s.tenant_id
       WHERE m.internal_agent_id = $1::uuid
         AND s.tenant_id = $2::uuid
         AND s.status = 'active'
       ORDER BY s.created_at ASC`,
      [internalAgentId, tenantId],
    );

    res.json({ skills: result.rows });
  } catch (err) {
    logger.error({ internalAgentId, tenantId, error: (err as Error).message }, 'Failed to fetch agent skills');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/agents/missing-skills?tenantId=...
// Returns agents that have an active compiled_instruction but no active skills.
// Used by platform-backend backfill runner to find agents that need decomposition.
// Returns internalAgentId so platform-backend can look up instruction content.
skillsRouter.get('/missing-skills', async (req, res) => {
  const tenantId = req.query.tenantId as string;

  if (!tenantId) {
    return res.status(400).json({ error: 'tenantId is required' });
  }

  try {
    const pool = getPoolForService('scheduled-execution');
    const result = await pool.query<{
      internal_agent_id: string;
      agent_id: string;
      tenant_id: string;
      system_prompt: string;
      user_instructions: string;
      instructions_md: string | null;
    }>(
      `SELECT m.internal_agent_id, ci.agent_id, ci.tenant_id,
              ci.system_prompt, ci.user_instructions, ci.instructions_md
       FROM compiled_instructions ci
       JOIN internal_agent_runtime_mapping m
         ON m.agent_id = ci.agent_id AND m.tenant_id = ci.tenant_id
       LEFT JOIN agent_skills sk
         ON sk.agent_id = ci.agent_id AND sk.status = 'active'
       WHERE ci.status = 'active'
         AND ci.tenant_id = $1::uuid
         AND sk.id IS NULL
       ORDER BY ci.created_at ASC`,
      [tenantId],
    );

    res.json({ agents: result.rows });
  } catch (err) {
    logger.error({ tenantId, error: (err as Error).message }, 'Failed to fetch agents missing skills');
    res.status(500).json({ error: 'Internal server error' });
  }
});
