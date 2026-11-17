import { http, HttpResponse } from 'msw'
import { getSharedMockLogs } from '../data/activityLogs'

export const activityLogsHandlers = [
  // List activity logs
  http.get(`*/api/agent-audit-logs`, ({ request }) => {
    const url = new URL(request.url)
    const limit = parseInt(url.searchParams.get('limit') || '25')
    const cursor = url.searchParams.get('cursor')
    const internalAgentId = url.searchParams.get('internalAgentId')
    const externalAgentId = url.searchParams.get('externalAgentId')
    const threadId = url.searchParams.get('threadId')
    const invocationId = url.searchParams.get('invocationId')
    const outcome = url.searchParams.get('outcome')
    const startDate = url.searchParams.get('startDate')
    const endDate = url.searchParams.get('endDate')
    const action = url.searchParams.get('action')

    // Use shared mock logs instance
    let filteredLogs = getSharedMockLogs()

    if (internalAgentId) {
      filteredLogs = filteredLogs.filter(log => log.internalAgentId === internalAgentId)
    }

    if (externalAgentId) {
      filteredLogs = filteredLogs.filter(log => log.externalAgentId === externalAgentId)
    }

    if (threadId) {
      filteredLogs = filteredLogs.filter(log => log.threadId === threadId)
    }

    if (invocationId) {
      filteredLogs = filteredLogs.filter(log => log.invocationId === invocationId)
    }

    if (outcome) {
      filteredLogs = filteredLogs.filter(log => log.outcome === outcome)
    }

    if (action) {
      filteredLogs = filteredLogs.filter(log => log.action === action)
    }

    // Filter by date range
    if (startDate) {
      const start = new Date(startDate).getTime()
      filteredLogs = filteredLogs.filter(log => new Date(log.createdAt).getTime() >= start)
    }

    if (endDate) {
      const end = new Date(endDate).getTime()
      filteredLogs = filteredLogs.filter(log => new Date(log.createdAt).getTime() <= end)
    }

    const cursorIndex = cursor ? parseInt(cursor, 10) : 0
    const items = filteredLogs.slice(cursorIndex, cursorIndex + limit)
    const hasMore = cursorIndex + limit < filteredLogs.length

    return HttpResponse.json({
      items,
      cursor: hasMore ? String(cursorIndex + limit) : null,
      hasMore,
      total: filteredLogs.length,
    })
  }),

  // Get single activity log
  http.get(`*/api/agent-audit-logs/:logId`, ({ params }) => {
    const mockLogs = getSharedMockLogs()
    const log = mockLogs.find(l => l.id === params.logId)
    if (!log) {
      return HttpResponse.json({ error: 'Log not found' }, { status: 404 })
    }
    return HttpResponse.json(log)
  }),

  // ADR-030: "Run again" — re-run a failed autonomous run.
  http.post(`*/api/internal-agents/:internalAgentId/runs/:invocationId/rerun`, () => {
    return HttpResponse.json({ accepted: true }, { status: 202 })
  }),
]
