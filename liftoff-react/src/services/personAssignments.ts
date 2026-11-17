import { api } from './api'

export interface AgentAssignment {
  agentId: string
  agentType: 'internal' | 'external'
  agentName: string
}

export interface PersonnelMember {
  accountId: string
  personId: string
  firstName: string
  lastName: string
  email: string
  onboardStatus: string | null
  joinedAt: string
  costPerMonth: string | null
  /** Trailing 30-day HITL decision count (approvals + rejections) for this account. */
  tasks30d: number
  isAssignable: boolean
  assignments: AgentAssignment[]
}

export async function listPersonnelWithAssignments(
  tenantId: string
): Promise<{ personnel: PersonnelMember[] }> {
  return api.get<{ personnel: PersonnelMember[] }>(
    `/api/person-assignments/personnel?tenantId=${tenantId}`
  )
}

export async function updatePersonAssignments(
  tenantId: string,
  accountId: string,
  assignments: Array<{ agentId: string; agentType: 'internal' | 'external' }>
): Promise<{ success: boolean; added: number; removed: number }> {
  return api.put<{ success: boolean; added: number; removed: number }>(
    `/api/person-assignments/${accountId}?tenantId=${tenantId}`,
    { assignments }
  )
}
