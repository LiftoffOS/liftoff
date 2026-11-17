// Follow a turn somebody else is running.
//
// The sender holds an SSE stream and sees their turn token by token. Nobody
// else can attach to it — it is the response to their POST, on one Cloud Run
// instance, with no session affinity to route a second viewer there. So the
// backend writes the execution events down and this reads them back by cursor.
//
// The cursor is what makes joining late work: open the thread halfway through
// a two-minute turn and the first read returns everything so far, not just
// what happens next.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTenant } from './useTenant'
import type { ChatPresenceTransport, TurnEvent } from '../services/presence'
import type { ChatStreamingState } from '../components/Chat/ChatMessages'
import type { Contributor } from '../types/contributors'
import { parseDelegationStarted } from '../services/chatSurface'

// Faster than the 3s presence poll: this one is only running while a turn is
// actually streaming and somebody is watching it, so the extra rate is bounded
// by real activity rather than by traffic.
const FOLLOW_INTERVAL_MS = 1000

interface ObservedTurnState {
  text: string
  thinking: boolean
  currentTool: string | null
  /** The phrase the backend authored for `currentTool`, recorded on the frame
   *  so a follower reads exactly what the sender reads. */
  currentToolLabel: string | null
  /** "Working with <name>" while a hand-over runs; cleared exactly as the
   *  sender's own hook clears it, on the next text or tool call. */
  activityOverride: string | null
  /** Every colleague brought into the reply so far, as the sender sees them. */
  contributors: Contributor[]
  done: boolean
}

const IDLE: ObservedTurnState = {
  text: '', thinking: false, currentTool: null, currentToolLabel: null, activityOverride: null, contributors: [], done: false,
}

/**
 * Returns a ChatStreamingState when another person's turn is in flight, so the
 * conversation can render it through exactly the same bubble the sender sees.
 * Null when there is nothing to follow.
 */
export function useObservedTurn(
  /** Which chat surface the turn is running on. */
  transport: ChatPresenceTransport | null,
  threadId: string | null,
  liveTurnId: string | null | undefined,
  /** The sender's own turn is excluded — they have the real stream. */
  isOwnTurn: boolean,
): ChatStreamingState | null {
  const { currentTenant: tenant } = useTenant()
  const tenantId = tenant?.id
  const queryClient = useQueryClient()

  const [state, setState] = useState<ObservedTurnState>(IDLE)
  const cursorRef = useRef(0)

  // A surface that records no per-turn execution events has no cursor to read,
  // so there is nothing to follow even while somebody else's turn is running.
  // Standing down here rather than polling a route that does not exist is what
  // keeps the empty bubble off those surfaces.
  const enabled =
    !!tenantId && !!transport?.turnEvents && !!threadId && !!liveTurnId && !isOwnTurn

  // A new turn starts from nothing. Both halves matter: without the cursor
  // reset the follower asks for events past the previous turn's high-water
  // mark, and without the text reset the new turn's output appends onto the
  // old one's. Declared above the polling effect so it runs first on the
  // commit where the turn changes.
  // The state reset happens during render, the cursor reset in the effect.
  //
  // They were one effect, which meant the commit where the turn changes could
  // paint the previous turn's text once before clearing it. A ref cannot be
  // written during render, so only the cursor stays behind.
  const [seenTurnId, setSeenTurnId] = useState(liveTurnId)
  if (liveTurnId !== seenTurnId) {
    setSeenTurnId(liveTurnId)
    setState(IDLE)
  }

  // Disabling clears what was being followed. Enabling does not, so a
  // consumer that toggles back on mid-turn keeps what it had.
  const [wasEnabled, setWasEnabled] = useState(enabled)
  if (enabled !== wasEnabled) {
    setWasEnabled(enabled)
    if (!enabled) setState(IDLE)
  }

  useEffect(() => {
    cursorRef.current = 0
  }, [liveTurnId])

  const apply = useCallback((events: TurnEvent[]) => {
    if (events.length === 0) return
    setState((prev) => {
      let next = { ...prev }
      for (const e of events) {
        switch (e.kind) {
          case 'text':
            next = {
              ...next,
              text: next.text + String(e.payload?.text ?? ''),
              // Output means the agent is past deciding what to do.
              thinking: false,
              currentTool: null, currentToolLabel: null,
              activityOverride: null,
            }
            break
          case 'thinking':
            next = { ...next, thinking: true, currentTool: null, currentToolLabel: null }
            break
          case 'tool_call':
            next = {
              ...next,
              thinking: false,
              currentTool: String(e.payload?.tool ?? ''),
              currentToolLabel: typeof e.payload?.label === 'string' ? e.payload.label : null,
              activityOverride: null,
            }
            break
          case 'delegation_started': {
            // The same frame the sender's stream carries, recorded with the
            // same payload, read through the same parser, so a follower
            // attributes the live reply exactly as the sender does.
            const contributor = parseDelegationStarted(e.payload ?? {})
            if (!contributor) break
            next = {
              ...next,
              thinking: false,
              currentTool: null, currentToolLabel: null,
              activityOverride: `Working with ${contributor.label}`,
              contributors: next.contributors.some(c => c.id === contributor.id)
                ? next.contributors
                : [...next.contributors, contributor],
            }
            break
          }
          case 'tool_result':
            next = { ...next, currentTool: null, currentToolLabel: null }
            break
          case 'done':
          case 'error':
            next = { ...next, done: true, thinking: false, currentTool: null, currentToolLabel: null }
            break
          default:
            break
        }
      }
      return next
    })
    cursorRef.current = events[events.length - 1].seq
  }, [])

  useEffect(() => {
    if (!enabled) return

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const poll = async () => {
      try {
        // Non-null by `enabled`, which already required the method.
        const res = await transport!.turnEvents!(
          tenantId!, threadId!, liveTurnId!, cursorRef.current,
        )
        if (cancelled) return
        apply(res.events)
        if (res.done) {
          // The persisted message is the authority on the final text, so hand
          // over to it rather than leaving the observed copy on screen — that
          // is what keeps the two from disagreeing.
          void queryClient.invalidateQueries({
            queryKey: transport!.messagesQueryKey(tenantId!, threadId!),
          })
          return
        }
      } catch {
        // Following is best effort; the persisted message still arrives on the
        // presence poll's latestMessageAt hint.
      }
      if (!cancelled) timer = setTimeout(() => { void poll() }, FOLLOW_INTERVAL_MS)
    }

    void poll()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [enabled, tenantId, transport, threadId, liveTurnId, apply, queryClient])

  if (!enabled || state.done) return null

  return {
    userMessage: '',
    assistantText: state.text,
    currentTool: state.currentTool,
    currentToolLabel: state.currentToolLabel,
    activityOverride: state.activityOverride,
    contributors: state.contributors,
    thinking: state.thinking,
    hasExtra: false,
  }
}
