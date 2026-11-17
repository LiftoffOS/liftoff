import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTenant } from './useTenant'
import { api } from '../services/api'
import type { InternalAgent } from '../services/internalAgents'
import type { ExternalAgent } from '../services/externalAgents'
import type { PersonnelMember } from '../services/personAssignments'

export interface WorkforceClaudeCodeKey {
  id: string
  tenantId: string
  accountId: string
  keyPrefix: string
  keyHint: string
  name: string
  description: string | null
  planType: string | null
  costPerMonth: number | null
  status: 'active' | 'revoked'
  lastUsedAt: string | null
  createdAt: string
  updatedAt: string
  keyType: 'developer_proxy' | 'mcp'
  // What the row's mark is keyed on: the credential vendor ('openai' = Codex,
  // 'anthropic' = Claude Code), 'claude_code_mcp' for a collab token, or the
  // client slug of an OAuth-connected tool ('gemini-cli', 'cursor', ...; 'mcp'
  // when the backend does not know the client). Optional so the frontend
  // tolerates a platform-backend that predates the field; rows without it
  // fall back to Claude Code branding, the pre-vendor behavior.
  vendor?: string
  // OAuth-connected tools only: the name the client registered under and the
  // label the row is named with (the tooltip's text).
  clientName?: string
  clientLabel?: string
}

export interface WorkforceStats {
  hoursSavedLast30Days: number
}

export interface WorkforceResponse {
  internalAgents: InternalAgent[]
  externalAgents: ExternalAgent[]
  claudeCodeKeys: WorkforceClaudeCodeKey[]
  personnel: PersonnelMember[]
  // Optional so the frontend tolerates a platform-backend that predates the
  // server-side stats rollout (deploy-order independence).
  stats?: WorkforceStats
}

export const WORKFORCE_QUERY_KEY = ['workforce'] as const

export function useWorkforce() {
  const { currentTenant } = useTenant()

  return useQuery({
    queryKey: [...WORKFORCE_QUERY_KEY, currentTenant?.id ?? ''],
    queryFn: () =>
      api.get<WorkforceResponse>(`/api/teams/workforce?tenantId=${currentTenant!.id}`),
    enabled: !!currentTenant?.id,
    staleTime: 30_000,
  })
}

export function useInvalidateWorkforce() {
  const queryClient = useQueryClient()
  const { currentTenant } = useTenant()
  return () =>
    queryClient.invalidateQueries({
      queryKey: [...WORKFORCE_QUERY_KEY, currentTenant?.id ?? ''],
    })
}
