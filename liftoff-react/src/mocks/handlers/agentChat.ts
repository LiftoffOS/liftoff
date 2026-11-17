// Agent chat — unread state.
//
// Enough of the surface for `npm run dev:mock` to exercise all three unread
// indicators end to end: the dot on a thread row, the dot on the chat history
// button, and the dot beside Message Team. Opening a thread clears its marker
// here exactly as it does on the server, so the "open it and watch all three
// go out" path is real in mock mode rather than only in dev.

import { http, HttpResponse } from 'msw'

const UNREAD_AGENT_ID = 'internal-agent-sales-001'

interface MockThread {
  id: string
  tenantId: string
  accountId: string
  channel: 'web'
  sourceLabel: null
  agentId: string
  title: string
  createdAt: string
  updatedAt: string
  unread: boolean
}

function seedThreads(): MockThread[] {
  const now = Date.now()
  return [
    {
      id: 'mock-thread-unread-001',
      tenantId: 'mock-tenant',
      accountId: 'mock-account',
      channel: 'web',
      sourceLabel: null,
      agentId: UNREAD_AGENT_ID,
      title: 'Pipeline review for the west region',
      createdAt: new Date(now - 3 * 86_400_000).toISOString(),
      updatedAt: new Date(now - 20 * 60_000).toISOString(),
      unread: true,
    },
    {
      id: 'mock-thread-read-002',
      tenantId: 'mock-tenant',
      accountId: 'mock-account',
      channel: 'web',
      sourceLabel: null,
      agentId: UNREAD_AGENT_ID,
      title: 'Draft the follow up sequence',
      createdAt: new Date(now - 6 * 86_400_000).toISOString(),
      updatedAt: new Date(now - 2 * 86_400_000).toISOString(),
      unread: false,
    },
  ]
}

let mockThreads = seedThreads()

// The platform assistants' side of Chat History's "All" list. Only the merged
// list reads these; each assistant's own list is not mocked.
const UNREAD_AGENT_NAME = 'Sales Outreach Agent'
function seedPlatformThreads() {
  const now = Date.now()
  return [
    { id: 'mock-thread-001', kind: 'liftoff', title: 'What can my teams do this week', updatedAt: new Date(now - 45 * 60_000).toISOString(), unread: false, agent: null },
    { id: 'mock-caio-thread-001', kind: 'team_plan', title: 'Plan a customer support team', updatedAt: new Date(now - 26 * 3_600_000).toISOString(), unread: true, agent: null },
    { id: 'mock-insights-thread-001', kind: 'insights', title: 'Cost by team last month', updatedAt: new Date(now - 4 * 86_400_000).toISOString(), unread: false, agent: null },
  ]
}

export const agentChatHandlers = [
  // Single-segment path, registered ahead of the /:agentId routes for the same
  // reason the server registers it first.
  http.get('*/api/agent-chat/unread-counts', () => {
    const counts: Record<string, number> = {}
    for (const thread of mockThreads) {
      if (thread.unread) counts[thread.agentId] = (counts[thread.agentId] ?? 0) + 1
    }
    return HttpResponse.json({ counts })
  }),

  http.get('*/api/chat-threads', () => {
    const teamThreads = mockThreads.map(t => ({
      id: t.id,
      kind: 'agent',
      title: t.title,
      updatedAt: t.updatedAt,
      unread: t.unread,
      agent: { id: t.agentId, name: UNREAD_AGENT_NAME },
    }))
    const threads = [...teamThreads, ...seedPlatformThreads()]
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    return HttpResponse.json({ threads, nextCursor: null, hasMore: false })
  }),

  http.get('*/api/agent-chat/:agentId/threads', ({ params }) => {
    const threads = mockThreads.filter(t => t.agentId === params.agentId)
    return HttpResponse.json({ threads, nextCursor: null, hasMore: false })
  }),

  http.post('*/api/agent-chat/:agentId/threads/read-all', ({ params }) => {
    mockThreads = mockThreads.map(t =>
      t.agentId === params.agentId ? { ...t, unread: false } : t,
    )
    return new HttpResponse(null, { status: 204 })
  }),

  http.post('*/api/agent-chat/:agentId/threads/:threadId/read', ({ params }) => {
    mockThreads = mockThreads.map(t =>
      t.id === params.threadId ? { ...t, unread: false } : t,
    )
    return new HttpResponse(null, { status: 204 })
  }),
]
