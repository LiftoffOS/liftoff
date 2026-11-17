// A2A Agent Card Router
// Serves Agent Cards for internal_agents — tenant-scoped, authenticated only.
// Not publicly discoverable (no /.well-known/agent-card.json).
//
// Auth: Firebase JWT (same as authenticated API routes).
// Mounted AFTER authMiddleware so req.user is populated.

import { Router, Request, Response } from 'express';
import { withTenantScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { AccountService } from '../accounts/service';
import { tenantMembersService } from '../tenant-members';
import { readActiveSkills } from '../internal-agents/row-mapper';
import type { AgentCard } from './types';

export const agentCardRouter = Router();

const accountService = new AccountService();

import { getBackendUrl } from '../infrastructure/control-plane-url';
// A2A agent-card URLs are deployment-specific: they name the host this
// deployment serves its API on. The prior
// `process.env.PROXY_BASE_URL?.replace(...) || '<a hard-coded host>'` silently
// emitted that host from every other deployment when the
// env was missing. Resolved lazily so module import doesn't throw on test boots.
const platformBaseUrl = (): string => getBackendUrl();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve the caller's Firebase UID → account, then verify they are a member
 * of the requested tenant. Returns 401 if no account, 403 if not a member.
 *
 * Pattern matches src/generated-files/router.ts:563-578 — never trust a
 * tenantId from the request without server-side membership enforcement.
 */
async function verifyTenantMembership(
  req: Request,
  res: Response,
  tenantId: string,
): Promise<boolean> {
  const firebaseUid = req.user?.uid;
  if (!firebaseUid) {
    res.status(401).json({ error: 'Authentication required' });
    return false;
  }

  const account = await accountService.getByFirebaseUid(firebaseUid);
  if (!account) {
    res.status(401).json({ error: 'Account not found' });
    return false;
  }

  const membership = await tenantMembersService.getMembership(tenantId, account.id);
  if (!membership) {
    // Don't confirm tenant existence to non-members.
    res.status(403).json({ error: 'Access denied' });
    return false;
  }

  return true;
}

/**
 * The columns an agent card is built from. Named explicitly so the projection
 * and the query cannot drift: every field here is a real column on
 * `internal_agents`.
 */
interface AgentCardRow {
  id: string;
  role: string;
  summary: string | null;
  responsibilities: string | null;
  skills: unknown;
}

/** Exported so the schema-contract integration test can check every name in it
 *  against the live `internal_agents` table. */
export const AGENT_CARD_COLUMNS = 'id, role, summary, responsibilities, skills';

function buildCard(agent: AgentCardRow): AgentCard {
  // A2A skills come from the authoritative skills column. This used to read a
  // `capabilities` column that has never existed on this table, so the query
  // threw and both endpoints returned 500 on every request. The real column is
  // also a better answer: a distilled skill carries its own name, description
  // and tags, where the old shape repeated one string into all three fields.
  const skills = readActiveSkills(agent.skills).map((skill, index) => ({
    id: skill.id ?? `${agent.id}:${index}`,
    name: skill.name,
    description: skill.description || skill.name,
    tags: skill.tags ?? [],
  }));

  return {
    name: agent.role,
    description: agent.summary || agent.role,
    version: '1.0.0',
    supportedInterfaces: [{
      url: `${platformBaseUrl()}/api/a2a/agents/${agent.id}/rpc`,
      protocolBinding: 'JSONRPC',
      protocolVersion: '1.0',
    }],
    capabilities: { streaming: false, pushNotifications: false },
    securitySchemes: {
      serviceToken: { type: 'apiKey', in: 'header', name: 'X-Service-Token' },
    },
    skills,
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['application/json'],
  };
}

// GET /api/a2a/agents — list all active agents in caller's tenant
agentCardRouter.get('/agents', async (req: Request, res: Response) => {
  try {
    const tenantId = req.query.tenantId as string | undefined;
    if (!tenantId || !UUID_RE.test(tenantId)) {
      return res.status(400).json({ error: 'tenantId required' });
    }

    // Verify caller is a member of the requested tenant (server-side).
    // Without this, an authenticated user from tenant A could pass
    // tenantId=tenantB and read tenant B's agents via RLS for tenantB.
    if (!(await verifyTenantMembership(req, res, tenantId))) {
      return;
    }

    // internal_agents is RLS-scoped; run within tenant scope so RLS enforces
    // tenant isolation in addition to the explicit WHERE clause.
    const result = await withTenantScope(tenantId, (client) =>
      client.query<AgentCardRow>(
        `SELECT ${AGENT_CARD_COLUMNS}
         FROM internal_agents
         WHERE tenant_id = $1 AND status = 'active' AND deleted_at IS NULL
         ORDER BY role`,
        [tenantId],
      ),
    );

    const cards = result.rows.map((r) => buildCard(r));
    return res.json({ agents: cards });
  } catch (err) {
    log.error({ error: (err as Error).message }, 'a2a agent-card list failed');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/a2a/agents/:agentId/card — single agent card
agentCardRouter.get('/agents/:agentId/card', async (req: Request, res: Response) => {
  try {
    const tenantId = req.query.tenantId as string | undefined;
    const { agentId } = req.params;

    if (!tenantId || !UUID_RE.test(tenantId)) {
      return res.status(400).json({ error: 'tenantId required' });
    }
    if (!UUID_RE.test(agentId)) {
      return res.status(400).json({ error: 'Invalid agentId' });
    }

    // Verify caller is a member of the requested tenant (server-side).
    if (!(await verifyTenantMembership(req, res, tenantId))) {
      return;
    }

    // internal_agents is RLS-scoped; run within tenant scope.
    const result = await withTenantScope(tenantId, (client) =>
      client.query<AgentCardRow>(
        `SELECT ${AGENT_CARD_COLUMNS}
         FROM internal_agents
         WHERE id = $1 AND tenant_id = $2 AND status = 'active' AND deleted_at IS NULL`,
        [agentId, tenantId],
      ),
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'agent not found' });
    }

    return res.json(buildCard(result.rows[0]));
  } catch (err) {
    log.error({ error: (err as Error).message }, 'a2a agent-card get failed');
    return res.status(500).json({ error: 'Internal server error' });
  }
});
