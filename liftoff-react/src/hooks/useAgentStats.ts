import { useMemo } from 'react'
import { useWorkforce } from './useWorkforce'
import type { InternalAgent } from '../services/internalAgents'
import type { ExternalAgent } from '../services/externalAgents'
import type { PersonnelMember } from '../services/personAssignments'

interface TeamStats {
  activeTeams: number
  tasksCompletedLast30Days: number
  hoursSavedLast30Days: number
  isLoading: boolean
}

/**
 * Centralized hook for team statistics.
 * Used by both /dashboard and /teams pages for consistent stats.
 *
 * Everything derives from the combined /api/teams/workforce payload — the
 * page's single data fetch. Hours saved is computed server-side
 * (platform-backend workforce/hours-saved.ts) over the full 30-day window;
 * this hook previously re-fetched agents, personnel, and 500 raw audit rows
 * (~485KB) to approximate the same numbers client-side.
 */
export function useAgentStats(): TeamStats {
  const { data, isPending } = useWorkforce()

  // Memoized because `?? []` mints a new array every render, which would make
  // every memo keyed on it recompute every render.
  const internalAgents = useMemo<InternalAgent[]>(() => data?.internalAgents ?? [], [data?.internalAgents])
  const externalAgents = useMemo<ExternalAgent[]>(() => data?.externalAgents ?? [], [data?.externalAgents])
  const personnel = useMemo<PersonnelMember[]>(() => data?.personnel ?? [], [data?.personnel])
  const hoursSavedLast30Days = data?.stats?.hoursSavedLast30Days ?? 0

  return useMemo(() => {
    // Active teams: internal agents with 'active' status + external agents with 'connected' status
    const activeInternalAgents = internalAgents.filter(a => a.status === 'active').length
    const activeExternalAgentCount = externalAgents.filter(a => a.status === 'connected').length
    const activeTeams = activeInternalAgents + activeExternalAgentCount

    // Tasks completed in the trailing 30 days across the whole workforce.
    // - Internal agents: invocations (Tenant Runtime)
    // - External agents: successful task events from audit_logs (Tenant Runtime)
    // - Humans: HITL decisions (approvals + rejections) from hitl_approval_requests
    const internalAgent30dTasks = internalAgents.reduce((sum, a) => sum + (a.tasks30d ?? 0), 0)
    const externalAgent30dTasks = externalAgents.reduce((sum, a) => sum + (a.tasks30d ?? 0), 0)
    const personnel30dTasks = personnel.reduce((sum, p) => sum + (p.tasks30d ?? 0), 0)
    const tasksCompletedLast30Days = internalAgent30dTasks + externalAgent30dTasks + personnel30dTasks

    return {
      activeTeams,
      tasksCompletedLast30Days,
      hoursSavedLast30Days,
      isLoading: isPending,
    }
  }, [internalAgents, externalAgents, personnel, hoursSavedLast30Days, isPending])
}
