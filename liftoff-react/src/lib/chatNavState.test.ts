// Router state on a chat page carries two kinds of thing, and the scrub used
// to be unable to tell them apart. These cases pin the difference down:
// one-shot instructions go, identity stays.

import { describe, it, expect } from 'vitest'
import { consumeSeed, readResumeThread, threadScope, writeResumeThread } from './chatNavState'

const SCOPE = threadScope('tenant-1', 'liftoff')

describe('consumeSeed', () => {
  it('drops every one-shot key', () => {
    expect(
      consumeSeed({
        seedMessage: 'hello',
        seedAttachments: [],
        openHistory: true,
        agentId: 'agent-1',
      }),
    ).toEqual({ agentId: 'agent-1' })
  })

  it('keeps the agent id', () => {
    // The regression this exists for. AgentChatPage reads `agentId` off router
    // state and redirects to the teams list when it is missing, so the old
    // `state: null` scrub bounced anyone who @mentioned a team from the home
    // composer, mid-send.
    expect(consumeSeed({ seedMessage: 'hi', agentId: 'agent-1' })).toEqual({ agentId: 'agent-1' })
  })

  it('keeps the open thread, so consuming a seed does not cost the conversation', () => {
    expect(consumeSeed({ seedMessage: 'hi', threadId: 'th-1', threadScope: SCOPE })).toEqual({
      threadId: 'th-1',
      threadScope: SCOPE,
    })
  })

  it('returns null when the seed was all there was', () => {
    expect(consumeSeed({ seedMessage: 'hi', seedAttachments: [] })).toBeNull()
    expect(consumeSeed(null)).toBeNull()
    expect(consumeSeed(undefined)).toBeNull()
  })

  it('does not mutate the state it was given', () => {
    const state = { seedMessage: 'hi', agentId: 'agent-1' }
    consumeSeed(state)
    expect(state.seedMessage).toBe('hi')
  })
})

describe('readResumeThread', () => {
  it('returns the thread when the stamp matches', () => {
    expect(readResumeThread({ threadId: 'th-1', threadScope: SCOPE }, SCOPE)).toBe('th-1')
  })

  it('refuses a thread stamped for another tenant', () => {
    // Switching tenant in another tab swaps in place without navigating, so
    // this entry can outlive the tenant it was written under.
    const other = threadScope('tenant-2', 'liftoff')
    expect(readResumeThread({ threadId: 'th-1', threadScope: other }, SCOPE)).toBeNull()
  })

  it('refuses a thread stamped for another team', () => {
    const a = threadScope('tenant-1', 'agent-a')
    const b = threadScope('tenant-1', 'agent-b')
    expect(readResumeThread({ threadId: 'th-1', threadScope: a }, b)).toBeNull()
  })

  it('trusts an unstamped thread', () => {
    // The share-link case: /share/<id> hands the thread over as state and the
    // backend has already checked who may open it. No stamp means somebody
    // else vouched for it, not that it is suspect.
    expect(readResumeThread({ threadId: 'th-1' }, SCOPE)).toBe('th-1')
  })

  it('returns null when there is no thread', () => {
    expect(readResumeThread({ agentId: 'agent-1' }, SCOPE)).toBeNull()
    expect(readResumeThread(null, SCOPE)).toBeNull()
  })
})

describe('writeResumeThread', () => {
  it('stamps the thread onto empty state', () => {
    expect(writeResumeThread(null, 'th-1', SCOPE)).toEqual({
      threadId: 'th-1',
      threadScope: SCOPE,
    })
  })

  it('preserves everything else on the entry', () => {
    expect(writeResumeThread({ agentId: 'agent-1' }, 'th-1', SCOPE)).toEqual({
      agentId: 'agent-1',
      threadId: 'th-1',
      threadScope: SCOPE,
    })
  })

  it('clears the thread without disturbing the rest', () => {
    // New chat. Without this, a refresh afterwards resurrects the thread the
    // person just deliberately left.
    expect(
      writeResumeThread({ agentId: 'agent-1', threadId: 'th-1', threadScope: SCOPE }, null, SCOPE),
    ).toEqual({ agentId: 'agent-1' })
  })

  it('collapses to null when clearing leaves nothing', () => {
    expect(writeResumeThread({ threadId: 'th-1', threadScope: SCOPE }, null, SCOPE)).toBeNull()
  })

  it('returns the same reference when nothing would change', () => {
    // The loop guard. Every write navigates, every navigate re-runs the
    // effect, and identity is what stops the second pass.
    const state = { threadId: 'th-1', threadScope: SCOPE }
    expect(writeResumeThread(state, 'th-1', SCOPE)).toBe(state)

    const noThread = { agentId: 'agent-1' }
    expect(writeResumeThread(noThread, null, SCOPE)).toBe(noThread)
    expect(writeResumeThread(null, null, SCOPE)).toBeNull()
  })

  it('restamps a thread whose scope has gone stale', () => {
    const state = { threadId: 'th-1', threadScope: threadScope('tenant-2', 'liftoff') }
    expect(writeResumeThread(state, 'th-1', SCOPE)).toEqual({
      threadId: 'th-1',
      threadScope: SCOPE,
    })
  })
})
