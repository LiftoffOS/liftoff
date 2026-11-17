// The two hand-over frames on the Insights Manager's and the Chief AI
// Officer's streams route the way Liftoff's do: a colleague brought in is
// named for the live bubble, and a colleague that paused ends the turn without
// an error. Parsed once, in chatSurface, so one shape reaches every page.

import { describe, it, expect, vi } from 'vitest'
import { dispatchSseEvent as dispatchInsights, type StreamInsightsChatCallbacks } from './insightsChat'
import { dispatchSseEvent as dispatchTeamPlan, type StreamTeamPlanChatCallbacks } from './teamPlanChat'
import { parseDelegationPaused } from './chatSurface'

function callbacks() {
  return {
    onThinking: vi.fn(),
    onToolCall: vi.fn(),
    onTextDelta: vi.fn(),
    onContentBlock: vi.fn(),
    onDelegationStarted: vi.fn(),
    onDelegationPaused: vi.fn(),
    onComplete: vi.fn(),
    onError: vi.fn(),
    onInterruptDelivered: vi.fn(),
  } satisfies Required<StreamInsightsChatCallbacks> & Required<StreamTeamPlanChatCallbacks>
}

const PAUSE = {
  author: 'caio',
  authorLabel: 'Chief AI Officer',
  delegateThreadId: 'tp-9',
  reason: 'Chief AI Officer is waiting on an approval before it can continue.',
}

describe.each([
  ['insights', dispatchInsights],
  ['team plan', dispatchTeamPlan],
] as const)('%s SSE dispatch of a hand-over', (_surface, dispatch) => {
  it('names the colleague brought in, for the live bubble', () => {
    const cb = callbacks()
    dispatch('delegation_started', { author: 'liftoff', authorLabel: 'Liftoff' }, cb)
    expect(cb.onDelegationStarted).toHaveBeenCalledWith({ id: 'liftoff', label: 'Liftoff' })
  })

  it('routes delegation_paused as terminal and not as a failure', () => {
    const cb = callbacks()
    dispatch('delegation_paused', PAUSE, cb)
    expect(cb.onDelegationPaused).toHaveBeenCalledWith(PAUSE)
    expect(cb.onError).not.toHaveBeenCalled()
    expect(cb.onComplete).not.toHaveBeenCalled()
  })

  it('still reports a pause whose destination could not be resolved', () => {
    const cb = callbacks()
    dispatch('delegation_paused', { author: 'caio', authorLabel: 'Chief AI Officer', reason: 'Waiting.' }, cb)
    expect(cb.onDelegationPaused).toHaveBeenCalledWith({
      author: 'caio',
      authorLabel: 'Chief AI Officer',
      delegateThreadId: null,
      reason: 'Waiting.',
    })
  })
})

describe('parseDelegationPaused', () => {
  it('normalises every field rather than requiring it', () => {
    expect(parseDelegationPaused({})).toEqual({ author: '', authorLabel: '', delegateThreadId: null, reason: '' })
    expect(parseDelegationPaused({ ...PAUSE, delegateThreadId: 7 })).toEqual({ ...PAUSE, delegateThreadId: null })
  })
})
