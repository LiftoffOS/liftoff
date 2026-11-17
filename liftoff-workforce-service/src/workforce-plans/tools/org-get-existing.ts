// org__get_existing_structure Tool
//
// Returns a summary of the tenant's current internal agents so the CAIO
// can see what already exists before proposing additions. Critical for
// returning users: the CAIO should not propose duplicates of agents that
// are already provisioned.
//
// Reads the roster through tenant-agents.ts, which calls the service-auth
// GET /api/internal/workspace-actions/teams and returns the teams beside the
// external agents, so the CAIO sees the whole AI workforce (D8).
//
// A lookup that fails says so. "Could not check" is not "nothing is there" —
// same contract as the connector lookup in tenant-connectors.ts. The model
// reports this tool's output to the user as fact, so an empty result has to
// mean an empty workspace and nothing else.

import { listTenantAgents } from '../tenant-agents.js';
import type { RawAgent, RawCollaborator } from '../tenant-agents.js';
import type { WorkforcePlanTool, WorkforcePlanToolContext } from './types.js';

interface OrgInput {
  includeInactive?: boolean;
}

type InternalAgentStatus = 'draft' | 'active' | 'paused';

interface OrgAgentSummary {
  id: string;
  name: string;
  agentType: string;
  status: InternalAgentStatus;
  roleSummary: string;
  integrationTypes: string[];
}

interface OrgCollaboratorSummary {
  id: string;
  name: string;
  status: string;
  collaborationMode: string;
  /** The teams (by id) this collaborator is allowed to work with. */
  allowedInternalAgentIds: string[];
}

interface OrgOutput {
  /** False when the roster could not be read. The model must not treat a
   *  false here as evidence of an empty workspace. */
  lookupSucceeded: boolean;
  totalAgents: number;
  activeCount: number;
  pausedCount: number;
  draftCount: number;
  agents: OrgAgentSummary[];
  /** The external agents: systems the teams work with. Listed so a plan
   *  can bind a team to one by id, and so the CAIO does not propose a
   *  collaborator that already exists. */
  collaborators: OrgCollaboratorSummary[];
  message: string;
}

function summariseCollaborator(c: RawCollaborator): OrgCollaboratorSummary {
  return {
    id: c.id,
    name: c.name,
    status: c.status ?? 'pending',
    collaborationMode: c.collaborationMode ?? 'request_help',
    allowedInternalAgentIds: c.allowedInternalAgentIds ?? [],
  };
}

function summariseAgent(agent: RawAgent): OrgAgentSummary {
  // Prefer responsibilities for the summary if present; fall back to role.
  const summary =
    agent.responsibilities && agent.responsibilities.length > 0
      ? agent.responsibilities.slice(0, 240)
      : (agent.role ?? '');

  // Deduplicate integration types for a compact picture.
  const types = new Set<string>();
  for (const integration of agent.integrations ?? []) {
    if (integration.type && integration.type.length > 0) {
      types.add(integration.type);
    }
  }

  return {
    id: agent.id,
    name: agent.role ?? agent.id,
    agentType: agent.agentType ?? 'agent',
    status: (agent.status ?? 'draft') as InternalAgentStatus,
    roleSummary: summary,
    integrationTypes: Array.from(types).sort(),
  };
}

export const orgGetExistingStructureTool: WorkforcePlanTool = {
  definition: {
    name: 'org__get_existing_structure',
    description:
      'Fetch the tenant\'s current AI workforce so you can avoid proposing duplicates and frame your plan as additions to an existing org. Returns a list of all the agents with their name, type, status, role summary, and connected integration types, and the external agents (systems the agents work with) with their status, collaboration mode and the agents they are allowed to work with. By default only active and draft agents are listed; set includeInactive=true to also list paused agents (their count is always reported either way). Check `lookupSucceeded` — when it is false the roster could not be read, which is NOT the same as the workspace being empty. Always call this early in a planning conversation.',
    input_schema: {
      type: 'object',
      properties: {
        includeInactive: {
          type: 'boolean',
          description: 'Whether to list paused agents in the result. Default false.',
        },
      },
    },
  },

  async execute(
    rawInput: Record<string, unknown>,
    ctx: WorkforcePlanToolContext,
  ): Promise<OrgOutput> {
    const input = rawInput as unknown as OrgInput;
    const includeInactive = input.includeInactive ?? false;

    const lookup = await listTenantAgents(ctx.tenantId);

    if (!lookup.ok) {
      return {
        lookupSucceeded: false,
        totalAgents: 0,
        activeCount: 0,
        pausedCount: 0,
        draftCount: 0,
        agents: [],
        collaborators: [],
        message:
          'The existing AI workforce could not be read just now, so this is NOT a statement that the workspace is empty and NOT evidence of a blank-slate org. Do not tell the user they are starting from scratch. Ask what they already have running before proposing anything new.',
      };
    }

    const allAgents = lookup.agents;
    const collaborators = (lookup.collaborators ?? []).map(summariseCollaborator);

    const filtered = includeInactive
      ? allAgents
      : allAgents.filter(a => a.status !== 'paused');

    const summaries = filtered.map(summariseAgent);

    const activeCount = allAgents.filter(a => a.status === 'active').length;
    const pausedCount = allAgents.filter(a => a.status === 'paused').length;
    const draftCount = allAgents.filter(a => a.status === 'draft').length;

    // The paused count is reported even when paused agents are filtered out of
    // the list. A paused agent is still provisioned, and a model that cannot
    // see it will happily propose a duplicate of it.
    const pausedNote = pausedCount > 0 && !includeInactive
      ? ` ${pausedCount} paused agent${pausedCount === 1 ? ' is' : 's are'} also provisioned but not listed above — call this tool again with includeInactive=true before proposing anything that might duplicate one.`
      : '';

    let message: string;
    if (allAgents.length === 0 && collaborators.length === 0) {
      message =
        'No agents yet. This is a blank-slate workspace - the user is starting from scratch.';
    } else if (allAgents.length === 0) {
      message = `No agents yet, but ${collaborators.length} external agent${collaborators.length === 1 ? '' : 's'} already connected (listed under collaborators).`;
    } else if (summaries.length === 0) {
      message = `No active or draft agents.${pausedNote}`;
    } else {
      message = `${summaries.length} agent${summaries.length === 1 ? '' : 's'} currently in the workforce (${activeCount} active, ${draftCount} draft${includeInactive ? `, ${pausedCount} paused` : ''}).${pausedNote}`;
    }

    return {
      lookupSucceeded: true,
      totalAgents: allAgents.length,
      activeCount,
      pausedCount,
      draftCount,
      agents: summaries,
      collaborators,
      message,
    };
  },
};
