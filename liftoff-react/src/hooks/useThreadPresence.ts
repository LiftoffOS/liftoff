// Live presence for a chat thread: who is here, who is typing, and a nudge
// when somebody else's message lands.
//
// Polling rather than a live connection. The platform backend runs on Cloud
// Run with no session affinity, scale-to-zero and a 900s request cap, so a
// held-open stream per viewer is not something it can serve. A 3s poll while
// the tab is visible is well inside what a heartbeat table handles, and the
// poll doubles as the write, so it is one request per interval per viewer.

import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTenant } from './useTenant'
import type { ChatPresenceTransport, ThreadPresence } from '../services/presence'

const POLL_INTERVAL_MS = 3000

// A keystroke marks you as typing; you stay typing until this much quiet.
// Comfortably longer than the poll so a normal pause between words does not
// flicker the indicator off and on.
const TYPING_IDLE_MS = 4000

export interface UseThreadPresenceOptions {
  /** Current composer contents. Typing is derived from this changing, so no
   *  change to ChatInput or the send path is needed. */
  draft: string
  /** Suppresses the new-message refetch while this viewer's own turn streams:
   *  that path already refetches on completion, and racing it would tear down
   *  the streaming bubble early. */
  isStreaming: boolean
  /** This viewer is driving the thread's browser. Their seat is what keeps
   *  the wheel: the stale-driver sweep hands the browser back to the agent
   *  forty-five seconds after the last heartbeat, so while they drive the
   *  heartbeat keeps going whatever the tab reports, and the seat is not
   *  released on a hidden tab. A driver who is truly gone is caught by the
   *  runtime's own gate, as before. */
  holdSeat?: boolean
}

export function useThreadPresence(
  /** Which chat surface to poll. Null while the page has nothing to poll for. */
  transport: ChatPresenceTransport | null,
  threadId: string | null,
  { draft, isStreaming, holdSeat = false }: UseThreadPresenceOptions,
) {
  const { currentTenant: tenant } = useTenant()
  const tenantId = tenant?.id
  const queryClient = useQueryClient()

  const [isTyping, setIsTyping] = useState(false)

  // Derive typing from the draft changing. An empty draft is never typing,
  // which also covers the programmatic clear on send and the restore on error
  // without either needing to know about presence. Read while rendering: the
  // draft IS the answer, and a keystroke should not need a second render to
  // count as typing.
  const [lastDraft, setLastDraft] = useState(draft)
  if (draft !== lastDraft) {
    setLastDraft(draft)
    setIsTyping(!!draft.trim())
  }

  // Going idle after a pause is the one part a clock decides, so it is the one
  // part in an effect. Re-running on each keystroke restarts the countdown,
  // and the cleanup covers both stopping and unmounting.
  useEffect(() => {
    if (!isTyping) return
    const timer = setTimeout(() => setIsTyping(false), TYPING_IDLE_MS)
    return () => clearTimeout(timer)
  }, [isTyping, lastDraft])

  // Stop polling when the tab is hidden, AND release the seat immediately.
  //
  // Letting the staleness window age it out was fine while presence only drove
  // the roster: a name lingering for a few seconds costs nothing. It stopped
  // being fine when presence began deciding whether to send a browser
  // notification. "Still inside the freshness window" is not "looking at the
  // screen", and the gap between them is exactly the case somebody switches
  // tabs to wait for a reply — so every notification was suppressed for the
  // people most in need of one.
  //
  // Except for the person driving the thread's browser (holdSeat). Their seat
  // is also what the stale-driver sweep reads: no heartbeat for forty-five
  // seconds and the browser is handed back to the agent under them. A driver
  // can lose the wheel while never leaving the tab: the browser may report
  // the tab hidden, or report itself offline for half a minute, which pauses
  // every query here. So a driver's heartbeat polls in the background,
  // is not paused by the browser's online flag, and their seat is not
  // released on a hidden tab; the runtime's own gate still catches a driver
  // who is truly gone.
  const [isVisible, setIsVisible] = useState(
    typeof document === 'undefined' ? true : !document.hidden,
  )
  useEffect(() => {
    const onVisibilityChange = () => setIsVisible(!document.hidden)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [])

  const enabled = !!tenantId && !!transport && !!threadId

  // isTyping is deliberately NOT in the query key: it would refetch on every
  // transition. The interval reads whichever value is current when it fires.
  const isTypingRef = useRef(isTyping)
  useEffect(() => {
    isTypingRef.current = isTyping
  }, [isTyping])

  const query = useQuery({
    queryKey: ['thread-presence', tenantId, transport?.key, threadId],
    queryFn: () =>
      transport!.heartbeat(tenantId!, threadId!, isTypingRef.current ? 'typing' : 'viewing'),
    enabled,
    refetchInterval: isVisible || holdSeat ? POLL_INTERVAL_MS : false,
    refetchIntervalInBackground: holdSeat,
    // A driver's heartbeat is sent even when the browser believes it is
    // offline: a wrong online flag must not cost them the wheel, and a poll
    // that truly cannot reach the server simply fails and is retried on the
    // next tick.
    networkMode: holdSeat ? 'always' : 'online',
    // Presence is worthless once stale, and a failed poll ages out anyway.
    staleTime: 0,
    retry: false,
  })

  // Somebody else's message landed: refetch the list. Skipped while this
  // viewer's own turn streams — that path refetches on completion.
  const latestMessageAt = query.data?.latestMessageAt ?? null
  const lastSeenMessageAtRef = useRef<string | null>(null)
  useEffect(() => {
    if (!latestMessageAt || !enabled || isStreaming) return
    if (lastSeenMessageAtRef.current === null) {
      // First reading is the baseline for this thread, not a new message.
      lastSeenMessageAtRef.current = latestMessageAt
      return
    }
    if (latestMessageAt === lastSeenMessageAtRef.current) return
    lastSeenMessageAtRef.current = latestMessageAt
    void queryClient.invalidateQueries({
      queryKey: transport!.messagesQueryKey(tenantId!, threadId!),
    })
  }, [latestMessageAt, enabled, isStreaming, queryClient, transport, tenantId, threadId])

  // Reset the baseline on thread switch so the new thread's first reading is
  // not mistaken for a message arriving.
  useEffect(() => {
    lastSeenMessageAtRef.current = null
  }, [threadId])

  // Release the seat on the way out. Best effort: the browser may not run this
  // on a hard close, which is exactly why the server ages rows out anyway.
  useEffect(() => {
    if (!enabled) return
    return () => {
      void transport!.clear(tenantId!, threadId!).catch(() => {})
    }
  }, [enabled, tenantId, transport, threadId])

  // Same release the moment the tab is hidden, rather than waiting for unmount.
  // Hiding a tab is the whole signal that somebody has stopped watching, and it
  // is the one moment a notification becomes worth sending.
  useEffect(() => {
    if (!enabled || isVisible || holdSeat) return
    void transport!.clear(tenantId!, threadId!).catch(() => {})
  }, [enabled, isVisible, holdSeat, tenantId, transport, threadId])

  const presence: ThreadPresence | undefined = query.data
  return {
    viewers: presence?.viewers ?? [],
    isTyping,
    /** A turn streaming right now, so a non-sender knows to follow it. */
    liveTurnId: presence?.liveTurnId ?? null,
  }
}
