import { http, HttpResponse } from 'msw'
import {
  getMockApprovals,
  getMockClarifications,
  removeMockClarification,
} from '../data/oversight'
import type { ApprovalItem, QueueCounts, QueueItem } from '../../services/oversight'

// The actionable queue, in the mock's own terms: the same rule the tenant
// runtime applies in SQL. Approvals drop out once their decision window has
// passed; clarifications are only ever actionable.
function actionableQueue(agentId?: string | null): QueueItem[] {
  const now = Date.now()
  const approvalItems: ApprovalItem[] = getMockApprovals()
    .filter(a => a.status === 'pending' && (!a.expiresAt || new Date(a.expiresAt).getTime() > now))
    .map(a => ({ kind: 'approval', ...a }))

  const items: QueueItem[] = [
    ...approvalItems,
    ...getMockClarifications(),
  ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

  return agentId ? items.filter(item => item.agentId === agentId) : items
}

// The approvals whose decision window closed without an answer, mirroring the
// runtime's passed predicate: both sides of the sweeper (a lapsed row still
// reads 'pending' until it flips), never one that was actually decided.
function passedQueue(agentId?: string | null): QueueItem[] {
  const now = Date.now()
  const items: QueueItem[] = getMockApprovals()
    .filter(a =>
      (a.status === 'expired' || a.status === 'pending') &&
      !!a.expiresAt &&
      new Date(a.expiresAt).getTime() <= now,
    )
    .map((a): ApprovalItem => ({
      kind: 'approval',
      ...a,
      // Stands in for the backend's per-page late-feedback lookup.
      lateFeedbackSubmitted: mockFeedbackGiven.has(a.id),
    }))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

  return agentId ? items.filter(item => item.agentId === agentId) : items
}

// Approvals that already carry late feedback in this session.
const mockFeedbackGiven = new Set<string>()

// Bucketed counts over that same set, so the mock cannot tell the page one
// thing and the badge another.
function queueCounts(agentId?: string | null): QueueCounts {
  const items = actionableQueue(agentId)
  const approvals = items.filter((i): i is ApprovalItem => i.kind === 'approval')

  return {
    total: items.length,
    approvalsStandard: approvals.filter(a => a.hitlLevel === 1).length,
    approvalsCritical: approvals.filter(a => a.hitlLevel === 2).length,
    approvalsOther: approvals.filter(a => a.hitlLevel !== 1 && a.hitlLevel !== 2).length,
    clarifications: items.filter(i => i.kind === 'clarification').length,
  }
}

export const oversightHandlers = [
  // IMPORTANT: Specific routes must come before parameterized routes
  // The hitl-approvals routes must come before :tenantId route

  // Get pending count (must be before :approvalId and :tenantId routes)
  http.get('*/api/internal-agent-oversight/hitl-approvals/pending-count', ({ request }) => {
    const agentId = new URL(request.url).searchParams.get('agentId')
    const counts = queueCounts(agentId)
    return HttpResponse.json({ count: counts.total, ...counts })
  }),

  // List queue items (approvals + clarifications) as a discriminated union
  http.get(`*/api/internal-agent-oversight/hitl-approvals`, ({ request }) => {
    const url = new URL(request.url)
    const limit = parseInt(url.searchParams.get('limit') || '20')
    const cursor = url.searchParams.get('cursor')
    const agentId = url.searchParams.get('agentId')
    const queueWindow = url.searchParams.get('window')

    const allItems = queueWindow === 'passed' ? passedQueue(agentId) : actionableQueue(agentId)
    const cursorIndex = cursor ? parseInt(cursor, 10) : 0
    const items = allItems.slice(cursorIndex, cursorIndex + limit)
    const hasMore = cursorIndex + limit < allItems.length

    return HttpResponse.json({
      items,
      cursor: hasMore ? String(cursorIndex + limit) : null,
      hasMore,
      // The size of the queue, not of this page, and the same buckets the
      // count endpoint reports.
      total: allItems.length,
      counts: queueCounts(agentId),
    })
  }),

  // Respond to a clarification
  http.post('*/api/internal-agent-oversight/clarifications/:clarificationId/respond', async ({ params }) => {
    removeMockClarification(params.clarificationId as string)
    return new HttpResponse(null, { status: 204 })
  }),


  // Get single HITL approval
  http.get(`*/api/internal-agent-oversight/hitl-approvals/:approvalId`, ({ params }) => {
    const approvals = getMockApprovals()
    const approval = approvals.find(a => a.id === params.approvalId)
    if (!approval) {
      return HttpResponse.json({ error: 'Approval not found' }, { status: 404 })
    }
    return HttpResponse.json(approval)
  }),

  // Approve request
  http.post(`*/api/internal-agent-oversight/hitl-approvals/:approvalId/approve`, ({ params }) => {
    const approvals = getMockApprovals()
    const approval = approvals.find(a => a.id === params.approvalId)
    if (!approval) {
      return HttpResponse.json({ error: 'Approval not found' }, { status: 404 })
    }
    return HttpResponse.json({
      ...approval,
      status: 'approved',
      decidedBy: 'current-user',
      decision: 'approved',
      decidedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
  }),

  // Reject request
  http.post(`*/api/internal-agent-oversight/hitl-approvals/:approvalId/reject`, async ({ params, request }) => {
    const body = await request.json() as { reason?: string }
    const approvals = getMockApprovals()
    const approval = approvals.find(a => a.id === params.approvalId)
    if (!approval) {
      return HttpResponse.json({ error: 'Approval not found' }, { status: 404 })
    }
    return HttpResponse.json({
      ...approval,
      status: 'rejected',
      decidedBy: 'current-user',
      decision: 'rejected',
      rejectionReason: body.reason,
      decidedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
  }),

  // Submit late feedback
  http.post('*/api/internal-agent-oversight/hitl-approvals/:approvalId/late-feedback', async ({ params, request }) => {
    const body = await request.json() as { decision: string; reason?: string }
    // Recorded so a refetch of the passed view renders this one as answered,
    // the same way the backend's per-page lookup does.
    mockFeedbackGiven.add(params.approvalId as string)
    return HttpResponse.json({
      id: `feedback_${Date.now()}`,
      approvalId: params.approvalId,
      decision: body.decision,
      feedbackProvidedAt: new Date().toISOString(),
    })
  }),

  // Parameterized routes must come LAST

  // Get oversight settings
  http.get('*/api/internal-agent-oversight/:tenantId', ({ params }) => {
    return HttpResponse.json({
      tenantId: params.tenantId,
      currentVersion: 1,
      autonomy: 'balanced',
      escalation: 'important',
      sensitiveWork: {
        customerCommunication: true,
        financialActions: true,
        dataChanges: false,
        externalPublishing: true,
        hiringDecisions: false,
      },
      communication: 'review',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: new Date().toISOString(),
    })
  }),

  // Update oversight settings
  http.put('*/api/internal-agent-oversight/:tenantId', async ({ params, request }) => {
    const body = await request.json() as Record<string, unknown>
    return HttpResponse.json({
      tenantId: params.tenantId,
      currentVersion: 2,
      autonomy: body.autonomy || 'balanced',
      escalation: body.escalation || 'important',
      sensitiveWork: body.sensitiveWork || {
        customerCommunication: true,
        financialActions: true,
        dataChanges: false,
        externalPublishing: true,
        hiringDecisions: false,
      },
      communication: body.communication || 'review',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: new Date().toISOString(),
    })
  }),
]
