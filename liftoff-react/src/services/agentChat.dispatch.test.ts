import { describe, it, expect, vi } from 'vitest'
import { dispatchSseEvent, type StreamAgentChatCallbacks } from './agentChat'

// Seam test for the structured chat pause events. The web UI was already coded
// for `awaiting_input`; this adds the missing `hitl_required` handler so a HITL
// approval pause surfaces (and deep-links into /dashboard/review from the page).

describe('dispatchSseEvent — structured pause events', () => {
  it('routes hitl_required to onHitlRequired with approvalId + reason', () => {
    const onHitlRequired = vi.fn()
    const cb: StreamAgentChatCallbacks = { onHitlRequired }
    dispatchSseEvent('hitl_required', { approvalId: 'appr-1', reason: 'needs approval' }, cb)
    // Routing defaults to empty rather than absent, so the banner never has to
    // distinguish "no route" from "field missing".
    expect(onHitlRequired).toHaveBeenCalledWith({
      approvalId: 'appr-1',
      reason: 'needs approval',
      routedTo: [],
      routedToAccountIds: [],
      routedToAdmins: false,
      unassigned: false,
      // Level 2 is the safe default: it is the level the wording treats as
      // "any member can act", so an older backend omitting it does not
      // silently promise an admin-only decision to a member.
      hitlLevel: 2,
    })
  })

  // Who was asked is what lets the chat say "waiting on Ada" instead of telling
  // whoever triggered the gate that it is waiting on them.
  it('passes the routing through when the backend resolved one', () => {
    const onHitlRequired = vi.fn()
    dispatchSseEvent(
      'hitl_required',
      {
        approvalId: 'appr-1',
        reason: 'needs approval',
        routedTo: ['Ada Lovelace'],
        routedToAccountIds: ['acc-1'],
        routedToAdmins: false,
      },
      { onHitlRequired },
    )
    expect(onHitlRequired).toHaveBeenCalledWith(
      expect.objectContaining({ routedTo: ['Ada Lovelace'], routedToAccountIds: ['acc-1'] }),
    )
  })

  it('reports an admin fallback', () => {
    const onHitlRequired = vi.fn()
    dispatchSseEvent(
      'hitl_required',
      { approvalId: 'appr-1', reason: 'x', routedToAdmins: true },
      { onHitlRequired },
    )
    expect(onHitlRequired).toHaveBeenCalledWith(
      expect.objectContaining({ routedToAdmins: true, routedTo: [] }),
    )
  })

  it('ignores a malformed hitl_required (missing approvalId)', () => {
    const onHitlRequired = vi.fn()
    dispatchSseEvent('hitl_required', { reason: 'x' }, { onHitlRequired })
    expect(onHitlRequired).not.toHaveBeenCalled()
  })

  it('still routes awaiting_input to onAwaitingInput (unchanged)', () => {
    const onAwaitingInput = vi.fn()
    dispatchSseEvent('awaiting_input', { question: 'which one?', sessionId: 'sess-1' }, { onAwaitingInput })
    expect(onAwaitingInput).toHaveBeenCalledWith({ question: 'which one?', sessionId: 'sess-1' })
  })
})

// Non-turn acknowledgments: the backend answers with these when the message
// did not start a turn (folded into an in-flight run, answered a pending
// clarification). The page shows an indicator instead of an error toast.
describe('dispatchSseEvent — interrupt / clarification acks', () => {
  it('routes interrupt_delivered to onInterruptDelivered', () => {
    const onInterruptDelivered = vi.fn()
    dispatchSseEvent('interrupt_delivered', {}, { onInterruptDelivered })
    expect(onInterruptDelivered).toHaveBeenCalledTimes(1)
  })

  it('routes clarification_accepted to onClarificationAccepted', () => {
    const onClarificationAccepted = vi.fn()
    dispatchSseEvent('clarification_accepted', {}, { onClarificationAccepted })
    expect(onClarificationAccepted).toHaveBeenCalledTimes(1)
  })

  it('is a no-op when the callback is absent', () => {
    expect(() => dispatchSseEvent('interrupt_delivered', {}, {})).not.toThrow()
  })
})

// A turn stopped before it said anything has no reply to hand over. The backend
// used to invent one — the transcript showed the agent saying "(stopped)" — and
// now sends a complete frame with no message instead. The handler still has to
// fire, or the composer streams forever waiting for a terminal event.
describe('dispatchSseEvent — complete with no message', () => {
  it('still ends the turn when the frame carries no message', () => {
    const onComplete = vi.fn()
    dispatchSseEvent('complete', {}, { onComplete })
    expect(onComplete).toHaveBeenCalledWith(null)
  })

  it('hands over the message when there is one', () => {
    const onComplete = vi.fn()
    const message = { id: 'm1', role: 'assistant', content: 'done' }
    dispatchSseEvent('complete', { message }, { onComplete })
    expect(onComplete).toHaveBeenCalledWith(message)
  })
})

// Message boundaries. Assistant text reaches the browser as token deltas with
// no structure of its own, so without an explicit end-of-message signal the UI
// concatenated consecutive messages into one run-on block, gluing sentences
// together at the seam ("...fetching now.Still failing..."). The paragraph break
// used to be inferred from tool calls, which only worked when a boundary
// happened to have a visible tool call beside it.
describe('dispatchSseEvent — message boundaries', () => {
  it('routes text_break to onTextBreak', () => {
    const onTextBreak = vi.fn()
    const cb: StreamAgentChatCallbacks = { onTextBreak }
    dispatchSseEvent('text_break', {}, cb)
    expect(onTextBreak).toHaveBeenCalledTimes(1)
  })

  it('does not treat a boundary as text', () => {
    const onTextDelta = vi.fn()
    const cb: StreamAgentChatCallbacks = { onTextDelta }
    dispatchSseEvent('text_break', {}, cb)
    expect(onTextDelta).not.toHaveBeenCalled()
  })

  it('ignores a boundary when the consumer does not handle it', () => {
    // Older clients must not break on a frame they do not know.
    expect(() => dispatchSseEvent('text_break', {}, {})).not.toThrow()
  })
})

describe('delegation_paused', () => {
  // A team this conversation delegated work to stopped for an approval. Unlike
  // Liftoff's identically-named frame, this is NOT terminal: the delegating
  // team keeps narrating and the stream ends through its own complete event.
  it('routes the pause with its name, approval and reason', () => {
    const onDelegationPausedNotice = vi.fn()
    dispatchSseEvent(
      'delegation_paused',
      {
        agentName: 'Security Review',
        approvalId: 'appr-1',
        reason: 'Security Review is waiting on an approval in the review queue before it can continue the delegated work.',
      },
      { onDelegationPausedNotice },
    )
    expect(onDelegationPausedNotice).toHaveBeenCalledWith({
      agentName: 'Security Review',
      approvalId: 'appr-1',
      reason: 'Security Review is waiting on an approval in the review queue before it can continue the delegated work.',
    })
  })

  it('still reports a pause whose team could not be named', () => {
    // Name resolution is best-effort. A pause with no name still stalled the
    // delegated work and still needs surfacing; swallowing the frame would
    // hide the stall from the one client watching live.
    const onDelegationPausedNotice = vi.fn()
    dispatchSseEvent('delegation_paused', { reason: 'Waiting.' }, { onDelegationPausedNotice })
    expect(onDelegationPausedNotice).toHaveBeenCalledWith({
      agentName: null,
      approvalId: null,
      reason: 'Waiting.',
    })
  })

  it('never touches the error or complete channels', () => {
    // The original defect was a pause rounding into failure prose. The typed
    // frame must not regress into either terminal channel.
    const onError = vi.fn()
    const onComplete = vi.fn()
    const onDelegationPausedNotice = vi.fn()
    dispatchSseEvent(
      'delegation_paused',
      { agentName: 'QA', approvalId: 'a', reason: 'r' },
      { onError, onComplete, onDelegationPausedNotice },
    )
    expect(onError).not.toHaveBeenCalled()
    expect(onComplete).not.toHaveBeenCalled()
  })

  it('tolerates a consumer that does not handle it', () => {
    expect(() => dispatchSseEvent('delegation_paused', { reason: 'r' }, {})).not.toThrow()
  })
})

// The same frame, the same payload and the same callback as Liftoff's
// hand-over: one handler attributes a live reply on every surface.
describe('delegation_started', () => {
  it('routes the hand-over as a contributor, the teammate by id and name', () => {
    const onDelegationStarted = vi.fn()
    dispatchSseEvent(
      'delegation_started',
      { author: 'agent-7', authorLabel: 'Security Review' },
      { onDelegationStarted },
    )
    expect(onDelegationStarted).toHaveBeenCalledWith({ id: 'agent-7', label: 'Security Review' })
  })

  it('drops a frame that names nobody, rather than chipping a nameless teammate', () => {
    // Both fields or nothing: the backend only sends the frame for a teammate
    // it could resolve, and the old `{ agentName }` shape from an older
    // backend reads as nobody rather than as an error.
    const onDelegationStarted = vi.fn()
    dispatchSseEvent('delegation_started', {}, { onDelegationStarted })
    dispatchSseEvent('delegation_started', { agentName: 'Security Review' }, { onDelegationStarted })
    dispatchSseEvent('delegation_started', { author: 'agent-7' }, { onDelegationStarted })
    dispatchSseEvent('delegation_started', { author: '', authorLabel: 'QA' }, { onDelegationStarted })
    expect(onDelegationStarted).not.toHaveBeenCalled()
  })

  it('tolerates a consumer that does not handle it', () => {
    expect(() =>
      dispatchSseEvent('delegation_started', { author: 'agent-7', authorLabel: 'QA' }, {}),
    ).not.toThrow()
  })
})
