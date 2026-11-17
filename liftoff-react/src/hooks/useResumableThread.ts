// Keep the open conversation on the history entry, so a reload resumes it.
//
// The read half of this already existed and is load-bearing in production: the
// /share/<id> resolver hands a thread over as `location.state.threadId`, and
// every chat surface opens it. AgentChatPage gets its `agentId` the same way
// from the teams list, with nothing in the URL at all. Both survive a refresh,
// because BrowserRouter puts router state in `history.state.usr` and the
// browser keeps that across a reload.
//
// What was missing was the WRITE. A thread the person started by typing was
// held in `useState` and nowhere else, so remounting the page after a refresh
// found nothing and opened a blank chat — the conversation still there, but
// only reachable through the Chat History modal.
//
// So: reconcile the entry to the live thread. No URL change, no id in the
// address bar, and per-history-entry is exactly the right grain — a refresh or
// a Back lands on the entry that knows its thread, while a sidebar click pushes
// a NEW entry carrying nothing, which is still a deliberate fresh start.

import { useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { readResumeThread, threadScope, writeResumeThread } from '../lib/chatNavState'

/**
 * Whether a failure to load a transcript means the thread is GONE, as opposed
 * to temporarily unreachable.
 *
 * The distinction is the whole point of the check. A resumed thread that 404s
 * was deleted, and holding onto it would strand the person on a permanently
 * blank page. A resumed thread that fails to load because the network dropped
 * is the exact case this feature exists to survive — losing connection and
 * reloading is how people GET here — so anything that is not a definite
 * "no longer yours" keeps the thread and lets react-query retry.
 *
 * Reads the status off the error rather than testing `instanceof ApiError`:
 * this runs on every chat surface, several of which partially mock
 * services/api in their tests, and a hook this low should not force every one
 * of them to re-export the class. A transport failure carries no status and so
 * falls through, which is the behaviour that matters.
 */
export function isThreadGone(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const status = (error as { status?: unknown }).status
  return status === 404 || status === 403
}

interface UseResumableThreadOptions {
  /** Undefined while the tenant is still loading. Stamped onto the entry so a
   *  reload after switching tenant in another tab does not hand back a thread
   *  from the tenant they left. */
  tenantId: string | undefined
  /** What the thread hangs off within the tenant: the agent id on agent chat,
   *  and the surface name on the assistants, which have one conversation space
   *  each. */
  scopeId: string
}

/**
 * Mirror `currentThreadId` onto the current history entry, and hand back the
 * thread this entry is holding.
 *
 * The page keeps owning the state; this reads and writes the entry around it.
 * The returned id is what the surface's existing "arrived with a thread"
 * effect should open — it is the same `location.state.threadId` those effects
 * already read, but checked against the stamp, so an entry left over from
 * another tenant is refused rather than opened.
 *
 * Null until the tenant resolves. Every caller's greeting effect already waits
 * on the tenant too, so nothing acts on the gap.
 */
export function useResumableThread(
  currentThreadId: string | null,
  { tenantId, scopeId }: UseResumableThreadOptions,
): string | null {
  const location = useLocation()
  const navigate = useNavigate()

  const scope = threadScope(tenantId, scopeId)
  const resumeThreadId = tenantId ? readResumeThread(location.state, scope) : null

  // Whether the page has ever actually held a thread.
  //
  // This is what separates "not adopted yet" from "New chat". On the mount
  // after a reload the entry holds a thread and `currentThreadId` is still
  // null, because the surface adopts it in an effect that has not run — and
  // clearing the entry on that pass would throw away the very thing being
  // restored. Until a thread has been seen, this hook only ever writes.
  const hasHeldThread = useRef(false)

  useEffect(() => {
    if (currentThreadId) hasHeldThread.current = true

    // Nothing to stamp WITH yet. Writing now would put an empty tenant on the
    // entry and a later render would have to correct it; waiting costs
    // nothing, because there is no thread to lose before the tenant resolves.
    if (!tenantId) return
    if (!currentThreadId && !hasHeldThread.current) return

    const state = location.state ?? null
    const next = writeResumeThread(state, currentThreadId, scope)
    // Same reference means nothing would change. This is the loop guard: every
    // navigate below produces a new location, which re-runs this effect, which
    // then finds the entry already correct and stops.
    if (next === state) return

    // pathname AND search. AgentChatPage carries ?agentId= and ?f=, and
    // navigating to the bare pathname would silently drop them — which is how
    // the old seed scrub managed to erase the agent id.
    navigate(`${location.pathname}${location.search}`, { replace: true, state: next })
  }, [currentThreadId, tenantId, scope, location, navigate])

  return resumeThreadId
}
