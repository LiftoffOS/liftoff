// teams_list: who exists in this workspace — the AI workforce (teams,
// collaborators, coding-tool connections) and the human workforce.
//
// A read any member may make. Distinct from Liftoff's list_colleagues, which
// answers "who can be brought into this conversation" (delegation stays
// teams-only); this answers "who exists".

import { tenantMembersService } from '../../tenant-members';
import type { Actor } from '../actor';
import { getTeams, teamDisplayName } from '../teams';
import type { WorkspaceActionTool } from './types';

const COLLABORATION_MODE_TEXT: Record<string, string> = {
  request_help: 'teams can ask it for help',
  receive_delegated: 'it can hand work to teams',
  two_way: 'both ways',
  observe_only: 'observe only',
};

export const teamsListTool: WorkspaceActionTool = {
  definition: {
    name: 'teams_list',
    description:
      'Everyone in this workspace: the AI workforce (the agents with their status and a one-line summary, the external agents with how they work with the agents, and the coding-tool connections) and the human workforce (each person, their workspace role, and the agents they are assigned to). Use it to answer who exists and what state they are in; use the agent ids it returns when another tool needs one.',
    input_schema: {
      type: 'object',
      properties: {
        includeHumans: { type: 'boolean', description: 'Include the human workforce (default true)' },
      },
    },
  },
  permission: null,
  async execute(input, actor: Actor) {
    const { aiWorkforce, humanWorkforce } = await getTeams(actor.tenantId, actor.accountId);
    const teamNameById = new Map(aiWorkforce.teams.map((t) => [t.id, teamDisplayName(t)]));

    const teams = aiWorkforce.teams.map((t) => ({
      id: t.id,
      name: teamDisplayName(t),
      role: t.role,
      status: t.status,
      summary: t.summary ? t.summary.slice(0, 200) : null,
      ...(t.pendingIntegrations?.length ? { waitingOnConnections: t.pendingIntegrations } : {}),
    }));

    const collaborators = aiWorkforce.collaborators.map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      summary: c.summary ? c.summary.slice(0, 200) : (c.description ? c.description.slice(0, 200) : null),
      collaborationMode: c.collaborationMode,
      collaborationModeText: COLLABORATION_MODE_TEXT[c.collaborationMode] ?? c.collaborationMode,
      worksWith: c.allowedInternalAgentIds.map((id) => teamNameById.get(id) ?? id),
    }));

    const connections = aiWorkforce.connections.map((k) => ({
      id: k.id,
      name: k.name,
      kind: k.keyType,
      status: k.status,
      lastUsedAt: k.lastUsedAt,
    }));

    let humans: Array<Record<string, unknown>> = [];
    if (input.includeHumans !== false) {
      const members = await tenantMembersService.listMembers(actor.tenantId, { limit: 200 });
      const roleByAccount = new Map(members.members.map((m) => [m.accountId, m.role]));
      humans = humanWorkforce.map((p) => ({
        accountId: p.accountId,
        name: [p.firstName, p.lastName].filter(Boolean).join(' ').trim() || p.email,
        role: roleByAccount.get(p.accountId) ?? null,
        assignedTeams: p.assignments.map((a) => a.agentName),
      }));
    }

    return {
      aiWorkforce: { teams, collaborators, connections },
      ...(input.includeHumans !== false ? { humanWorkforce: humans } : {}),
    };
  },
};

export const teamsTools: WorkspaceActionTool[] = [teamsListTool];
