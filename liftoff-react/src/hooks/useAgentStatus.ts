// useAgentStatus — admin hook for polling live invocation state from the
// platform-backend agent-status proxy. Stops polling once the invocation
// reaches a terminal state.

import { useQuery } from '@tanstack/react-query'
import { getAgentStatus } from '../services/agentStatus'
import type { AgentStatusResponse } from '../types/agentStatus'

export function useAgentStatus(
  tenantId: string | null,
  invocationId: string | null,
  options: { enabled?: boolean; pollIntervalMs?: number } = {},
) {
  return useQuery<AgentStatusResponse>({
    queryKey: ['agentStatus', tenantId, invocationId],
    queryFn: () => getAgentStatus(tenantId as string, invocationId as string),
    enabled: !!tenantId && !!invocationId && (options.enabled ?? true),
    refetchInterval: (query) => {
      const data = query.state.data
      if (data?.isTerminal) return false
      return options.pollIntervalMs ?? 1500
    },
    staleTime: 1000,
  })
}
