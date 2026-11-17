// Drives the chat banner from outstanding state rather than from a live event.
//
// See services/pendingApproval.ts for why: the SSE event reaches only the one
// client whose turn tripped the gate, so an assignee opening the thread saw
// nothing and a reload wiped it.

import { useQuery } from '@tanstack/react-query'
import { useTenant } from './useTenant'
import { getPendingApproval, type PendingApproval } from '../services/pendingApproval'

export const PENDING_APPROVAL_QUERY_KEY = ['agent-chat', 'pending-approval']

// Gates are rare and resolving one costs a tenant-runtime round trip, so this
// polls far more slowly than presence. The SSE event and the approve action both
// invalidate the query, so the poll is a backstop for the case this hook exists
// to fix: somebody else triggered the gate, or somebody else cleared it.
const POLL_INTERVAL_MS = 20000

export function usePendingApproval(
  agentId: string | null,
  threadId: string | null,
): PendingApproval | null {
  const { currentTenant: tenant } = useTenant()
  const tenantId = tenant?.id

  const { data } = useQuery({
    queryKey: [...PENDING_APPROVAL_QUERY_KEY, tenantId, agentId, threadId],
    queryFn: () => getPendingApproval(tenantId!, agentId!, threadId!),
    enabled: !!tenantId && !!agentId && !!threadId,
    refetchInterval: POLL_INTERVAL_MS,
    // A stale banner is worse than a late one: it offers a decision that may
    // already be made. Refetching when the tab regains focus is the cheapest
    // way to catch a decision taken elsewhere, and this query is deliberately
    // exempt from the app-wide refetchOnWindowFocus: false.
    refetchOnWindowFocus: true,
  })

  return data ?? null
}
