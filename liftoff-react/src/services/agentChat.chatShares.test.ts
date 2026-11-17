// Share links at the service boundary.
//
// The backend REQUIRES agentId for a team's own threads and rejects it with a
// 400 for the two platform surfaces, so what goes on the wire per kind is the
// whole contract. The two agent-backed kinds are pinned here byte for byte,
// including key order, because they shipped first and must not drift while the
// two new kinds are added beside them.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const getMock = vi.fn()
const postMock = vi.fn()

vi.mock('./api', () => ({
  api: {
    get: (...args: unknown[]) => getMock(...args),
    post: (...args: unknown[]) => postMock(...args),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  ApiError: class ApiError extends Error {},
}))

vi.mock('../config/firebase', () => ({ auth: { currentUser: null } }))

import { createChatShare, resolveChatShare } from './agentChat'

const TENANT = '44444444-4444-4444-4444-444444444444'
const AGENT = 'internal-agent-sales-001'
const THREAD = '55555555-5555-5555-5555-555555555555'

/** The body handed to api.post, which is what JSON.stringify then sends. */
function sentBody(): Record<string, unknown> {
  return postMock.mock.calls[0][1] as Record<string, unknown>
}

beforeEach(() => {
  vi.clearAllMocks()
  postMock.mockResolvedValue({ id: 'share-1' })
})

describe('createChatShare', () => {
  it('sends the team with an agent chat, unchanged', async () => {
    await createChatShare({
      tenantId: TENANT,
      agentId: AGENT,
      threadId: THREAD,
      threadKind: 'agent',
    })

    expect(postMock).toHaveBeenCalledWith('/api/chat-shares', {
      tenantId: TENANT,
      agentId: AGENT,
      threadId: THREAD,
      threadKind: 'agent',
    })
    expect(Object.keys(sentBody())).toEqual(['tenantId', 'agentId', 'threadId', 'threadKind'])
  })

  it('sends the Chief AI Officer team with a plan chat, unchanged', async () => {
    await createChatShare({
      tenantId: TENANT,
      agentId: AGENT,
      threadId: THREAD,
      threadKind: 'team_plan',
    })

    expect(postMock).toHaveBeenCalledWith('/api/chat-shares', {
      tenantId: TENANT,
      agentId: AGENT,
      threadId: THREAD,
      threadKind: 'team_plan',
    })
    expect(Object.keys(sentBody())).toEqual(['tenantId', 'agentId', 'threadId', 'threadKind'])
  })

  // toEqual treats an undefined value as an absent key, so the assertion that
  // matters here is on the keys: the field has to be gone, not empty.
  it('omits the team entirely for an insights chat', async () => {
    await createChatShare({ tenantId: TENANT, threadId: THREAD, threadKind: 'insights' })

    expect(Object.keys(sentBody())).toEqual(['tenantId', 'threadId', 'threadKind'])
    expect('agentId' in sentBody()).toBe(false)
    expect(sentBody()).toEqual({ tenantId: TENANT, threadId: THREAD, threadKind: 'insights' })
  })

  it('omits the team entirely for a Liftoff chat', async () => {
    await createChatShare({ tenantId: TENANT, threadId: THREAD, threadKind: 'liftoff' })

    expect(Object.keys(sentBody())).toEqual(['tenantId', 'threadId', 'threadKind'])
    expect('agentId' in sentBody()).toBe(false)
    expect(sentBody()).toEqual({ tenantId: TENANT, threadId: THREAD, threadKind: 'liftoff' })
  })

  it('returns the new share id', async () => {
    postMock.mockResolvedValue({ id: 'share-9' })

    const result = await createChatShare({
      tenantId: TENANT,
      threadId: THREAD,
      threadKind: 'liftoff',
    })

    expect(result).toEqual({ id: 'share-9' })
  })
})

describe('resolveChatShare', () => {
  it('encodes the share id into the path', async () => {
    getMock.mockResolvedValue({ tenantId: TENANT, threadId: THREAD, threadKind: 'insights' })

    const resolution = await resolveChatShare('a/b?c')

    expect(getMock).toHaveBeenCalledWith('/api/chat-shares/a%2Fb%3Fc')
    expect(resolution).toEqual({ tenantId: TENANT, threadId: THREAD, threadKind: 'insights' })
  })
})
