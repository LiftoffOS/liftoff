// Work that goes on after a reply, on a platform assistant's conversation.
//
// A turn is bounded — its rounds, the model's context window, and the clock on
// the stream that carries it — and when a bound closes one with work still to
// do, the rest is queued and runs on the same conversation as a further turn.
// Its reply lands in the transcript like any other, minutes later, with no
// stream open in between. Without this read the conversation reads as finished
// in exactly the window where it is not, and the person leaves.
//
// So: while a conversation is open and nothing is streaming, ask whether work
// is queued for it. While there is, the page shows the same activity the
// person sees during a turn; when it clears, the transcript is refetched, so
// the reply appears without a reload.
//
// Polled rather than pushed, because there is no stream to push down: the turn
// that queued the work ended, and the one that will answer has not started.

import { useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getLiftoffThreadContinuation, type ChatThreadContinuation } from '../services/liftoffChat'
import { getInsightsThreadContinuation } from '../services/insightsChat'

/** How often the queued work is asked about. A continuation waits for the
 *  conversation to be free and then runs a whole turn, so this is a state
 *  that changes over minutes; twenty seconds keeps the transition visible
 *  without polling a person's open tab hard. */
const POLL_MS = 20_000

export type ThreadContinuationSurface = 'liftoff' | 'insights'

const READ = {
  liftoff: getLiftoffThreadContinuation,
  insights: getInsightsThreadContinuation,
} as const

export interface UseThreadContinuationOptions {
  /** Undefined while the tenant is still loading. */
  tenantId: string | undefined
  /** The open conversation, or null when there is none. */
  threadId: string | null
  /** True while a turn is streaming: the person is already watching the work,
   *  and the read is paused so a live turn is never polled behind. */
  isStreaming: boolean
  /** Called once each time queued work finishes, so the caller can refetch the
   *  transcript that now holds its reply. */
  onFinished?: () => void
}

export interface ThreadContinuationState {
  /** The queued work, or null when there is none. */
  continuation: ChatThreadContinuation | null
  /** Whether the conversation should read as still working. */
  isWorking: boolean
}

export function useThreadContinuation(
  surface: ThreadContinuationSurface,
  { tenantId, threadId, isStreaming, onFinished }: UseThreadContinuationOptions,
): ThreadContinuationState {
  const queryClient = useQueryClient()
  const enabled = !!tenantId && !!threadId && !isStreaming

  const query = useQuery({
    queryKey: ['thread-continuation', surface, tenantId, threadId],
    queryFn: () => READ[surface](tenantId!, threadId!),
    enabled,
    refetchInterval: enabled ? POLL_MS : false,
    refetchOnWindowFocus: true,
    // A failed read is not a statement that the work is gone: keep the last
    // answer rather than flickering the conversation back to finished.
    staleTime: POLL_MS,
  })

  const continuation = query.data ?? null
  const isWorking = continuation !== null

  // The transition that matters is live → gone: the continuation finished, so
  // its reply is in the transcript and nothing else will say so. Fired once
  // per transition, and never on the first answer.
  const wasWorking = useRef(false)
  // The callback is held in a ref so a caller that passes a fresh function
  // each render does not re-fire the transition; written in an effect rather
  // than during render, which is the rule for every ref here.
  const notify = useRef(onFinished)
  useEffect(() => {
    notify.current = onFinished
  }, [onFinished])
  useEffect(() => {
    if (wasWorking.current && !isWorking) notify.current?.()
    wasWorking.current = isWorking
  }, [isWorking])

  // A person's message cancels the work queued for the conversation (the
  // server does it on the way in), so a stream starting makes the cached
  // answer wrong immediately rather than at the next poll.
  useEffect(() => {
    if (!isStreaming || !tenantId || !threadId) return
    queryClient.setQueryData(['thread-continuation', surface, tenantId, threadId], null)
    wasWorking.current = false
  }, [isStreaming, queryClient, surface, tenantId, threadId])

  return { continuation, isWorking }
}
