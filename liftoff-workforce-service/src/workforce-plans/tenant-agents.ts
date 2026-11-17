// Tenant agent roster lookup.
//
// The mirror of tenant-connectors.ts, for the other half of "what does this
// workspace already have". Both the org__get_existing_structure tool and the
// greeting pre-fetch read the roster through here, so there is one place that
// knows the platform-backend route and one definition of what a failed lookup
// means.
//
// Contract: a lookup either produced a roster or it did not. Failure is never
// reported as an empty workspace. Collapsing the two lets the CAIO state
// "you have no agents" as fact on the strength of a failed HTTP call.

import { log } from '../infrastructure/logging.js';
import { loadConfig } from '../infrastructure/config.js';
import { getServiceAuthHeaders } from '../infrastructure/service-auth.js';

export interface RawAgent {
  id: string;
  role?: string;
  agentType?: string;
  status?: string;
  responsibilities?: string;
  integrations?: Array<{ type?: string }>;
  /** The plan that provisioned this agent, if any. The dedup check reads it to
   *  exclude a plan's own teams when that plan is redrafted for amendment. */
  workforcePlanId?: string | null;
}

/** An external agent as platform-backend's workspace teams read
 *  returns it: a system the teams work with, listed beside them (D8). */
export interface RawCollaborator {
  id: string;
  name: string;
  status?: string;
  collaborationMode?: string;
  allowedInternalAgentIds?: string[];
  description?: string | null;
}

export type AgentLookup =
  | { ok: true; agents: RawAgent[]; collaborators: RawCollaborator[] }
  | { ok: false; reason: string };

function getPlatformBackendUrl(): string {
  return loadConfig().PLATFORM_BACKEND_URL.replace(/\/$/, '');
}

/**
 * Read the tenant's AI workforce from platform-backend: the agents and the
 * external agents, as one read.
 *
 * Uses the service-auth GET /api/internal/workspace-actions/teams, the same
 * projection the Teams page and the other assistants read. The Firebase-gated
 * /api/internal-agents sits below platform-backend's authMiddleware and cannot
 * be reached with a service token.
 */
export async function listTenantAgents(tenantId: string): Promise<AgentLookup> {
  const baseUrl = getPlatformBackendUrl();

  try {
    const url = new URL(`${baseUrl}/api/internal/workspace-actions/teams`);
    url.searchParams.set('tenantId', tenantId);

    const headers = await getServiceAuthHeaders(baseUrl, loadConfig().WORKFORCE_SERVICE_TOKEN);
    const resp = await fetch(url.toString(), { headers });

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} from platform-backend /api/internal/workspace-actions/teams`);
    }

    const data = (await resp.json()) as { aiWorkforce?: { teams?: unknown; collaborators?: unknown } };

    // A body without a well-formed teams array is a broken contract, not an
    // empty workspace. Reading `?? []` off a response that keys the list
    // differently is indistinguishable from a tenant with no teams.
    if (!Array.isArray(data.aiWorkforce?.teams)) {
      throw new Error('platform-backend returned no `aiWorkforce.teams` array — response shape changed');
    }
    const collaborators = Array.isArray(data.aiWorkforce?.collaborators)
      ? (data.aiWorkforce.collaborators as RawCollaborator[])
      : [];

    return { ok: true, agents: data.aiWorkforce.teams as RawAgent[], collaborators };
  } catch (err) {
    log.warn(
      {
        event: 'workforce_plans_list_agents_failed',
        tenantId,
        error: (err as Error).message,
      },
      'listTenantAgents HTTP call failed — reporting a lookup failure, not an empty workforce',
    );
    return { ok: false, reason: (err as Error).message };
  }
}
