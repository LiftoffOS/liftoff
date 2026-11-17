// Which thread this Liftoff conversation is using with each colleague.
//
// Read for one reason: a status row saying a team is waiting on an approval has
// to be able to TAKE the person to that conversation, and the row itself names
// only the team. This is what turns that name into a destination, and fetching
// it rather than carrying it on the message is what keeps the id out of the
// address bar, since the destination is handed to the router as state.
//
// Not polled. The pairing is written once per colleague per conversation and
// never changes after that, so the only moment it can be missing is the turn
// that created it, which refetches the transcript as it ends.

import { useQuery } from '@tanstack/react-query'
import { useTenant } from './useTenant'
import {
  listLiftoffThreadDelegations,
  type LiftoffThreadDelegation,
} from '../services/liftoffChat'

export const LIFTOFF_DELEGATIONS_QUERY_KEY = ['delegations'] as const

const EMPTY: LiftoffThreadDelegation[] = []

export function useLiftoffDelegations(threadId: string | null): LiftoffThreadDelegation[] {
  const { currentTenant: tenant } = useTenant()
  const tenantId = tenant?.id

  const { data } = useQuery({
    queryKey: [...LIFTOFF_DELEGATIONS_QUERY_KEY, tenantId, threadId],
    queryFn: () => listLiftoffThreadDelegations(tenantId!, threadId!),
    enabled: !!tenantId && !!threadId,
  })

  return data ?? EMPTY
}
