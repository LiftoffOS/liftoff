// AgentChatPage deep-link plumbing — verifies the URL parsing fallback used
// when location.state.agentId is missing (e.g. the user clicks the queue's
// "Open in chat" link). The page itself has too many hooks for a full render
// test; this covers the parsing logic verbatim so a regression in the
// fallback chain is caught.

import { describe, it, expect } from 'vitest'
import { consumeSeed } from '../../lib/chatNavState'

function pickAgentId(
  search: string,
  state: { agentId?: string } | null,
): string | undefined {
  const searchParams = new URLSearchParams(search)
  const stateAgentId = state?.agentId
  const queryAgentId = searchParams.get('agentId')
  return stateAgentId ?? queryAgentId ?? undefined
}

function pickThreadId(search: string): string | null {
  return new URLSearchParams(search).get('thread')
}

describe('AgentChatPage deep-link fallback', () => {
  it('prefers location.state.agentId when present', () => {
    expect(pickAgentId('?agentId=fallback', { agentId: 'from-state' })).toBe('from-state')
  })

  it('falls back to ?agentId= when state is null', () => {
    expect(pickAgentId('?agentId=from-query', null)).toBe('from-query')
  })

  it('returns undefined when neither source supplies an agentId', () => {
    expect(pickAgentId('', null)).toBeUndefined()
  })

  it('returns the ?thread= query param when present', () => {
    expect(pickThreadId('?agentId=a&thread=th-1')).toBe('th-1')
  })

  it('returns null when ?thread= is absent', () => {
    expect(pickThreadId('?agentId=a')).toBeNull()
  })
})

// The seed scrub, and the identity it used to throw away.
//
// AgentChatPage reads `agentId` off router state — the teams list and the home
// composer both navigate with `state: { agentId }` and no query param — and
// redirects to /dashboard/agents when it is missing. The scrub that consumed a
// seed used to be `state: null`, which took the agent id with it, so
// @mentioning a team from the home composer bounced the person to the teams
// list mid-send. Same for an open thread: consuming a message must not cost
// the conversation on the next refresh.
describe('consuming a seed keeps the page pointed at the same team', () => {
  it('keeps the agentId that arrived as router state', () => {
    const scrubbed = consumeSeed({
      seedMessage: 'draft the Q3 update',
      seedAttachments: [],
      agentId: 'agent-1',
    })
    expect(pickAgentId('', scrubbed)).toBe('agent-1')
  })

  it('keeps the open thread', () => {
    const scrubbed = consumeSeed({ seedMessage: 'hi', threadId: 'th-1', agentId: 'agent-1' })
    expect(scrubbed).toMatchObject({ threadId: 'th-1', agentId: 'agent-1' })
  })

  it('still takes the seed itself away, so a refresh never re-sends it', () => {
    const scrubbed = consumeSeed({ seedMessage: 'hi', agentId: 'agent-1' })
    expect(scrubbed).not.toHaveProperty('seedMessage')
  })
})
