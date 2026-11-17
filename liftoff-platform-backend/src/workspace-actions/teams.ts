// The workspace's teams, as every surface names them: the AI workforce (the
// agents, the collaborators, the coding-tool connections) and the human
// workforce (people, with the teams they are assigned to). One read, the
// Teams page's, projected into the vocabulary the assistants and the Chief
// AI Officer use (D10: teams; AI workforce; human workforce).

import { getWorkforce } from '../workforce/service';
import type { WorkforceClaudeCodeKey } from '../workforce/assembly';
import { internalAgentService } from '../internal-agents/service';
import { externalAgentService } from '../external-agents/service';
import type { InternalAgent } from '../internal-agents/types';
import type { ExternalAgent } from '../external-agents/types';
import type { PersonWithAssignments } from '../person-assignments/types';

export interface WorkspaceTeams {
  aiWorkforce: {
    teams: InternalAgent[];
    collaborators: ExternalAgent[];
    connections: WorkforceClaudeCodeKey[];
  };
  humanWorkforce: PersonWithAssignments[];
}

/** The whole Teams page: teams, collaborators, coding-tool connections and
 *  the people, with the activity and hours-saved figures the page shows.
 *  For teams_list, which renders all of it. */
export async function getTeams(tenantId: string, actorAccountId?: string): Promise<WorkspaceTeams> {
  const workforce = await getWorkforce(tenantId, actorAccountId);
  return {
    aiWorkforce: {
      teams: workforce.internalAgents,
      collaborators: workforce.externalAgents,
      connections: workforce.claudeCodeKeys,
    },
    humanWorkforce: workforce.personnel,
  };
}

export interface AiWorkforce {
  teams: InternalAgent[];
  collaborators: ExternalAgent[];
}

/** The AI workforce alone: two reads, no personnel, activity or hours-saved.
 *  For everything that resolves a team by name, the connect-time overview
 *  and the Chief AI Officer's roster read, none of which shows the rest. */
export async function listAiWorkforce(tenantId: string): Promise<AiWorkforce> {
  const [teams, collaborators] = await Promise.all([
    internalAgentService.listAllByTenant(tenantId),
    externalAgentService.listAllByTenant(tenantId),
  ]);
  return { teams, collaborators };
}

/** Find one team by name (nickname or role), case-insensitive, exact first
 *  then normalised; null when nothing or more than one matches. */
export function findTeamByName(teams: InternalAgent[], name: string): InternalAgent | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const lower = name.toLowerCase().trim();
  const exact = teams.filter((t) => t.role.toLowerCase() === lower || (t.messagingNickname ?? '').toLowerCase() === lower);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const n = norm(name);
  const normalized = teams.filter((t) => norm(t.role) === n || (t.messagingNickname ? norm(t.messagingNickname) === n : false));
  return normalized.length === 1 ? normalized[0] : null;
}

/** A team's display name, the way every chat surface shows it. */
export function teamDisplayName(team: Pick<InternalAgent, 'role' | 'messagingNickname'>): string {
  return team.messagingNickname || team.role;
}
