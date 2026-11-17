import { describe, it, expect } from 'vitest'

import {
  agentChatPresenceTransport,
  teamPlanPresenceTransport,
  liftoffPresenceTransport,
  insightsPresenceTransport,
} from './chatPresenceTransports'

// `turnEvents` is a capability, not a formality, and which surfaces have it is
// the one thing that differs between these four objects. Stating it here keeps
// a well-meaning stub from creeping back onto Liftoff or the Insights Manager:
// see useObservedTurn for what an empty-and-done stub would draw.

describe('chat presence transports', () => {
  it('offers turn replay on the surfaces that record execution events', () => {
    expect(agentChatPresenceTransport('agent-1').turnEvents).toBeTypeOf('function')
    expect(teamPlanPresenceTransport.turnEvents).toBeTypeOf('function')
  })

  it('offers none on the surfaces that record none', () => {
    expect(liftoffPresenceTransport.turnEvents).toBeUndefined()
    expect(insightsPresenceTransport.turnEvents).toBeUndefined()
  })

  it('gives every surface its own presence cache key and message list', () => {
    const transports = [
      agentChatPresenceTransport('agent-1'),
      teamPlanPresenceTransport,
      liftoffPresenceTransport,
      insightsPresenceTransport,
    ]
    const keys = transports.map(t => t.key)
    expect(new Set(keys).size).toBe(keys.length)

    const messageKeys = transports.map(t =>
      JSON.stringify(t.messagesQueryKey('tenant-1', 'thread-1')),
    )
    expect(new Set(messageKeys).size).toBe(messageKeys.length)
  })

  it('points each surface at its own message list', () => {
    expect(liftoffPresenceTransport.messagesQueryKey('tenant-1', 'thread-1')).toEqual([
      'messages', 'tenant-1', 'thread-1',
    ])
    expect(insightsPresenceTransport.messagesQueryKey('tenant-1', 'thread-1')).toEqual([
      'insights-messages', 'tenant-1', 'thread-1',
    ])
  })
})
