// Marking read from Chat History's "All" list. Each row is marked on the
// surface it lives on, and Mark All Read reaches every surface, including every
// team with something unread. Each write clears the same caches that surface's
// own hook clears, plus "All", so no dot is left contradicting another.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

vi.mock('./useTenant', () => ({
  useTenant: () => ({ currentTenant: { id: 'tenant-abc' } }),
}))

vi.mock('../services/agentChat', () => ({
  getAgentChatUnreadCounts: vi.fn(),
  markAgentChatThreadRead: vi.fn(),
  markAllAgentChatThreadsRead: vi.fn(),
}))
vi.mock('../services/liftoffChat', () => ({
  getLiftoffUnreadCount: vi.fn(),
  markLiftoffThreadRead: vi.fn(),
  markAllLiftoffThreadsRead: vi.fn(),
}))
vi.mock('../services/insightsChat', () => ({
  getInsightsUnreadCount: vi.fn(),
  markInsightsThreadRead: vi.fn(),
  markAllInsightsThreadsRead: vi.fn(),
}))
vi.mock('../services/teamPlanChat', () => ({
  getTeamPlanUnreadCount: vi.fn(),
  markTeamPlanThreadRead: vi.fn(),
  markAllTeamPlanThreadsRead: vi.fn(),
}))

import * as agentChat from '../services/agentChat'
import * as liftoffChat from '../services/liftoffChat'
import * as insightsChat from '../services/insightsChat'
import * as teamPlanChat from '../services/teamPlanChat'
import { useAnyChatUnread, useMarkAllChatsRead, useMarkAnyThreadRead } from './useAllChatUnread'

let queryClient: QueryClient

function createWrapper() {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
}

const invalidatedKeys = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map(call => (call[0] as { queryKey: unknown[] }).queryKey)

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(agentChat.getAgentChatUnreadCounts).mockResolvedValue({ counts: {} })
  vi.mocked(liftoffChat.getLiftoffUnreadCount).mockResolvedValue({ count: 0 })
  vi.mocked(insightsChat.getInsightsUnreadCount).mockResolvedValue({ count: 0 })
  vi.mocked(teamPlanChat.getTeamPlanUnreadCount).mockResolvedValue({ count: 0 })
  for (const fn of [
    agentChat.markAgentChatThreadRead, agentChat.markAllAgentChatThreadsRead,
    liftoffChat.markLiftoffThreadRead, liftoffChat.markAllLiftoffThreadsRead,
    insightsChat.markInsightsThreadRead, insightsChat.markAllInsightsThreadsRead,
    teamPlanChat.markTeamPlanThreadRead, teamPlanChat.markAllTeamPlanThreadsRead,
  ]) vi.mocked(fn).mockResolvedValue(undefined)
})

describe('useAnyChatUnread', () => {
  it('is false when nothing anywhere is unread', async () => {
    const { result } = renderHook(() => useAnyChatUnread(), { wrapper: createWrapper() })
    await waitFor(() => expect(teamPlanChat.getTeamPlanUnreadCount).toHaveBeenCalled())
    expect(result.current).toBe(false)
  })

  it('is true when one assistant has an unread reply', async () => {
    vi.mocked(teamPlanChat.getTeamPlanUnreadCount).mockResolvedValue({ count: 2 })
    const { result } = renderHook(() => useAnyChatUnread(), { wrapper: createWrapper() })
    await waitFor(() => expect(result.current).toBe(true))
  })

  it('is true when one team has an unread reply', async () => {
    vi.mocked(agentChat.getAgentChatUnreadCounts).mockResolvedValue({ counts: { 'a-1': 1 } })
    const { result } = renderHook(() => useAnyChatUnread(), { wrapper: createWrapper() })
    await waitFor(() => expect(result.current).toBe(true))
  })
})

describe('useMarkAnyThreadRead', () => {
  it("marks a team's thread on that team, clearing its list, the team counts and All", async () => {
    const { result } = renderHook(() => useMarkAnyThreadRead(), { wrapper: createWrapper() })
    const spy = vi.spyOn(queryClient, 'invalidateQueries')

    result.current.mutate({ kind: 'agent', threadId: 't-1', agentId: 'a-1' })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(agentChat.markAgentChatThreadRead).toHaveBeenCalledWith('tenant-abc', 'a-1', 't-1')
    expect(invalidatedKeys(spy)).toEqual(expect.arrayContaining([
      ['all-chat-threads'],
      ['agent-chat-unread'],
      ['agent-chat-threads', 'a-1', 'tenant-abc'],
    ]))
  })

  it.each([
    ['liftoff', liftoffChat.markLiftoffThreadRead, ['unread'], ['threads', 'tenant-abc']],
    ['insights', insightsChat.markInsightsThreadRead, ['insights-unread'], ['insights-threads', 'tenant-abc']],
    ['team_plan', teamPlanChat.markTeamPlanThreadRead, ['team-plan-unread'], ['team-plan-threads', 'tenant-abc']],
  ] as const)('marks a %s thread on its own surface', async (kind, markFn, countKey, listKey) => {
    const { result } = renderHook(() => useMarkAnyThreadRead(), { wrapper: createWrapper() })
    const spy = vi.spyOn(queryClient, 'invalidateQueries')

    result.current.mutate({ kind, threadId: 't-1' })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(markFn).toHaveBeenCalledWith('tenant-abc', 't-1')
    expect(invalidatedKeys(spy)).toEqual(expect.arrayContaining([['all-chat-threads'], countKey, listKey]))
  })
})

describe('useMarkAllChatsRead', () => {
  it('marks every assistant and every team with something unread', async () => {
    vi.mocked(agentChat.getAgentChatUnreadCounts).mockResolvedValue({ counts: { 'a-1': 2, 'a-2': 1 } })
    const { result } = renderHook(() => useMarkAllChatsRead(), { wrapper: createWrapper() })

    result.current.mutate()

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(liftoffChat.markAllLiftoffThreadsRead).toHaveBeenCalledWith('tenant-abc')
    expect(insightsChat.markAllInsightsThreadsRead).toHaveBeenCalledWith('tenant-abc')
    expect(teamPlanChat.markAllTeamPlanThreadsRead).toHaveBeenCalledWith('tenant-abc')
    expect(agentChat.markAllAgentChatThreadsRead).toHaveBeenCalledTimes(2)
    expect(agentChat.markAllAgentChatThreadsRead).toHaveBeenCalledWith('tenant-abc', 'a-1')
    expect(agentChat.markAllAgentChatThreadsRead).toHaveBeenCalledWith('tenant-abc', 'a-2')
  })

  it('still marks the rest when one surface fails, reports the failure, and refreshes every dot', async () => {
    vi.mocked(insightsChat.markAllInsightsThreadsRead).mockRejectedValue(new Error('503'))
    const { result } = renderHook(() => useMarkAllChatsRead(), { wrapper: createWrapper() })
    const spy = vi.spyOn(queryClient, 'invalidateQueries')

    result.current.mutate()

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(liftoffChat.markAllLiftoffThreadsRead).toHaveBeenCalled()
    expect(teamPlanChat.markAllTeamPlanThreadsRead).toHaveBeenCalled()
    expect(invalidatedKeys(spy)).toEqual(expect.arrayContaining([
      ['all-chat-threads'],
      ['agent-chat-unread'],
      ['unread'],
      ['insights-unread'],
      ['team-plan-unread'],
    ]))
  })
})
