/**
 * Person-Assignments Types
 *
 * AgentOrigin classifies where an assignable agent came from:
 *   - 'internal' = built within the Liftoff platform (an internal_agents row)
 *   - 'external' = user-connected external agent (an external_agents row)
 *
 * DB column: `agent_origin` (renamed from `agent_type` in migration 101).
 *
 * Claude Code proxy connections use 'external' — they're user-connected
 * agents, same as MCP external agents. The agent_id references
 * claude_code_proxy_keys.id; the listing query JOINs both external_agents
 * and claude_code_proxy_keys for the 'external' origin.
 *
 * The API property key stays `agentType` on all person-assignment shapes to
 * avoid breaking the existing API contract with liftoff-react.
 */
export type AgentOrigin = 'internal' | 'external';

export interface PersonAgentAssignment {
  id: string;
  tenantId: string;
  accountId: string;
  agentId: string;
  agentType: AgentOrigin;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface AgentAssignment {
  agentId: string;
  agentType: AgentOrigin;
  agentName: string;
}

export interface PersonWithAssignments {
  accountId: string;
  personId: string;
  firstName: string;
  lastName: string;
  email: string;
  onboardStatus: string | null;
  joinedAt: string;
  costPerMonth: string | null;
  /** Trailing 30-day HITL decision count (approvals + rejections) for this account. */
  tasks30d: number;
  isAssignable: boolean;
  assignments: AgentAssignment[];
}

export interface UpdatePersonAssignmentsInput {
  assignments: Array<{
    agentId: string;
    agentType: AgentOrigin;
  }>;
}
