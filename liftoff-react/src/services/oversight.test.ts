// oversight service — verifies the discriminated QueueItem types compile and
// the new respondToClarification function posts to the right path with the
// right body.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const getMock = vi.fn()
const postMock = vi.fn().mockResolvedValue(undefined)

vi.mock('./api', () => ({
  api: {
    get: (...args: unknown[]) => getMock(...args),
    post: (...args: unknown[]) => postMock(...args),
  },
}))

import {
  listApprovals,
  respondToClarification,
  standingApprovalAllowed,
  type ApprovalItem,
  type ClarificationItem,
  type QueueItem,
} from './oversight'

describe('listApprovals', () => {
  beforeEach(() => {
    getMock.mockReset()
  })

  it('returns the discriminated items array', async () => {
    const approval: ApprovalItem = {
      kind: 'approval',
      id: 'a1', tenantId: 't', agentId: 'g', hitlLevel: 1,
      pendingToolCalls: [], reason: 'level_1_gate', status: 'pending',
      expiresAt: '2026-06-11T00:00:00Z',
      createdAt: '2026-06-10T00:00:00Z',
      updatedAt: '2026-06-10T00:00:00Z',
    }
    const clarification: ClarificationItem = {
      kind: 'clarification',
      id: 'c1', tenantId: 't', agentId: 'g', threadId: 'th',
      question: 'Continue?',
      source: 'anchor_intervention',
      vendorRequestId: 'req-1',
      createdAt: '2026-06-10T00:01:00Z',
      expiresAt: '2026-06-11T00:01:00Z',
    }
    const items: QueueItem[] = [approval, clarification]
    const counts = {
      total: 141,
      approvalsStandard: 1,
      approvalsCritical: 0,
      approvalsOther: 0,
      clarifications: 1,
      escalations: 139,
    }
    getMock.mockResolvedValueOnce({ items, cursor: null, hasMore: false, total: 141, counts })

    const result = await listApprovals('tenant-1', { limit: 20 })
    expect(result.items).toEqual(items)
    // `total` is the size of the queue, not of this page.
    expect(result.total).toBe(141)
    expect(result.counts).toEqual(counts)
    expect(getMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/internal-agent-oversight/hitl-approvals?'),
    )
  })

  it('asks for no status: the runtime decides what is actionable', async () => {
    getMock.mockResolvedValueOnce({ items: [], cursor: null, hasMore: false, total: 0, counts: null })

    await listApprovals('tenant-1', { limit: 20 })

    expect(getMock.mock.calls[0][0]).not.toContain('status=')
  })

  it('scopes to an agent when asked', async () => {
    getMock.mockResolvedValueOnce({ items: [], cursor: null, hasMore: false, total: 0, counts: null })

    await listApprovals('tenant-1', { agentId: 'agent-9' })

    expect(getMock.mock.calls[0][0]).toContain('agentId=agent-9')
  })

  it('discriminator allows narrowing without unsafe casts', () => {
    const item: QueueItem = {
      kind: 'clarification',
      id: 'c1', tenantId: 't', agentId: 'g', threadId: 'th',
      question: '?', source: 'recovery_llm', vendorRequestId: null,
      createdAt: '', expiresAt: '',
    }
    if (item.kind === 'clarification') {
      // TypeScript narrows here — accessing question/source compiles.
      expect(item.question).toBe('?')
      expect(item.source).toBe('recovery_llm')
    }
  })
})

describe('respondToClarification', () => {
  beforeEach(() => {
    postMock.mockClear()
  })

  it('POSTs to /clarifications/:id/respond with the tenant + response body', async () => {
    await respondToClarification('tenant-1', 'clar-1', 'go ahead')
    expect(postMock).toHaveBeenCalledWith(
      '/api/internal-agent-oversight/clarifications/clar-1/respond?tenantId=tenant-1',
      { response: 'go ahead' },
    )
  })
})

describe('standingApprovalAllowed (always-apply suppression policy)', () => {
  it('allows a standing decision for low-risk gate reasons', () => {
    for (const r of ['level_1_gate', 'destructive_gate', 'communication_review', 'rate_limit_exceeded'] as const) {
      expect(standingApprovalAllowed(r)).toBe(true)
    }
  })
  it('suppresses a standing decision for high-risk gate reasons', () => {
    for (const r of ['super_destructive_gate', 'merge_to_main', 'sensitive_work'] as const) {
      expect(standingApprovalAllowed(r)).toBe(false)
    }
  })
})
