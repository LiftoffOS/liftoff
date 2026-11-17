// Unread state at the service boundary.
//
// `AgentChatThread.unread` is declared required, so this layer is where that
// becomes true rather than a hopeful type. A backend that predates the field
// sends nothing; coercing once here means one place decides what absent means,
// instead of three UI surfaces each remembering to treat undefined as false.

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

import {
  createAgentChatThread,
  getAgentChatUnreadCounts,
  listAgentChatThreads,
  markAgentChatThreadRead,
} from './agentChat'

const TENANT = '44444444-4444-4444-4444-444444444444'
const AGENT = 'internal-agent-sales-001'
const THREAD = '55555555-5555-5555-5555-555555555555'

function thread(over: Record<string, unknown> = {}) {
  return {
    id: THREAD,
    tenantId: TENANT,
    accountId: 'acc-1',
    channel: 'web',
    agentId: AGENT,
    title: 'A thread',
    createdAt: '2026-08-07T10:00:00.000Z',
    updatedAt: '2026-08-07T11:00:00.000Z',
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('listAgentChatThreads unread normalisation', () => {
  it('passes a true flag through', async () => {
    getMock.mockResolvedValue({ threads: [thread({ unread: true })], nextCursor: null, hasMore: false })

    const result = await listAgentChatThreads(TENANT, AGENT)

    expect(result.threads[0].unread).toBe(true)
  })

  it('coerces an absent flag to false, so an older backend renders no dot', async () => {
    getMock.mockResolvedValue({ threads: [thread()], nextCursor: null, hasMore: false })

    const result = await listAgentChatThreads(TENANT, AGENT)

    expect(result.threads[0].unread).toBe(false)
  })

  it('coerces a non-boolean to false rather than trusting truthiness', async () => {
    getMock.mockResolvedValue({ threads: [thread({ unread: 'yes' })], nextCursor: null, hasMore: false })

    const result = await listAgentChatThreads(TENANT, AGENT)

    expect(result.threads[0].unread).toBe(false)
  })

  it('keeps pagination fields intact', async () => {
    getMock.mockResolvedValue({ threads: [thread()], nextCursor: 'cursor-1', hasMore: true })

    const result = await listAgentChatThreads(TENANT, AGENT)

    expect(result.nextCursor).toBe('cursor-1')
    expect(result.hasMore).toBe(true)
  })

  it('survives a payload with no threads array at all', async () => {
    getMock.mockResolvedValue({ nextCursor: null, hasMore: false })

    const result = await listAgentChatThreads(TENANT, AGENT)

    expect(result.threads).toEqual([])
  })
})

describe('createAgentChatThread unread normalisation', () => {
  it('gives a freshly created thread an explicit false', async () => {
    postMock.mockResolvedValue({ thread: thread(), messages: [] })

    const result = await createAgentChatThread(TENANT, AGENT)

    expect(result.thread.unread).toBe(false)
    expect(result.messages).toEqual([])
  })
})

describe('markAgentChatThreadRead', () => {
  it('posts to the thread read route with only the tenant in the body', async () => {
    postMock.mockResolvedValue(undefined)

    await markAgentChatThreadRead(TENANT, AGENT, THREAD)

    // The account is never in the body: the server takes it from the
    // authenticated caller, so one person cannot mark another's threads read.
    expect(postMock).toHaveBeenCalledWith(
      `/api/agent-chat/${AGENT}/threads/${THREAD}/read`,
      { tenantId: TENANT },
    )
  })
})

describe('getAgentChatUnreadCounts', () => {
  it('requests the single-segment counts route with the tenant encoded', async () => {
    getMock.mockResolvedValue({ counts: { [AGENT]: 2 } })

    const result = await getAgentChatUnreadCounts(TENANT)

    expect(getMock).toHaveBeenCalledWith(
      `/api/agent-chat/unread-counts?tenantId=${encodeURIComponent(TENANT)}`,
    )
    expect(result.counts).toEqual({ [AGENT]: 2 })
  })
})
