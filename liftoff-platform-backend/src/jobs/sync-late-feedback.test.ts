// src/jobs/sync-late-feedback.test.ts
import { syncUnsentFeedback, startSyncJob, stopSyncJob } from './sync-late-feedback'
import { LateFeedback } from '../hitl-late-feedback/types'

// Mock dependencies
jest.mock('../hitl-late-feedback/repository', () => ({
  lateFeedbackRepository: {
    getUnsynced: jest.fn(),
    markSynced: jest.fn(),
    recordSyncAttempt: jest.fn(),
  },
}))

jest.mock('../connectors/tenant-runtime-client', () => ({
  tenantRuntimeClient: {
    sendLateFeedback: jest.fn(),
  },
}))

import { lateFeedbackRepository } from '../hitl-late-feedback/repository'
import { tenantRuntimeClient } from '../connectors/tenant-runtime-client'

const mockRepository = lateFeedbackRepository as jest.Mocked<typeof lateFeedbackRepository>
const mockRuntimeClient = tenantRuntimeClient as jest.Mocked<typeof tenantRuntimeClient>

// Helper to create mock LateFeedback with all required fields
function createMockLateFeedback(overrides: Partial<LateFeedback> = {}): LateFeedback {
  return {
    id: 'feedback-1',
    tenantId: 'tenant-1',
    approvalId: 'approval-1',
    agentId: 'agent-1',
    internalAgentId: 'team-1',
    workflowId: 'workflow-1',
    hitlLevel: 1,
    toolCallsHash: 'hash-1',
    pendingToolCalls: [],
    gateReason: 'level_1_gate',
    decision: 'would_approve',
    decidedBy: 'user-1',
    decidedByRole: 'admin',
    rejectionReason: null,
    approvalCreatedAt: new Date('2024-01-01T00:00:00Z'),
    approvalExpiredAt: new Date('2024-01-01T05:00:00Z'),
    feedbackProvidedAt: new Date('2024-01-01T06:00:00Z'),
    syncedToRuntime: false,
    syncAttempts: 0,
    lastSyncError: null,
    syncedAt: null,
    createdAt: new Date('2024-01-01T06:00:00Z'),
    ...overrides,
  }
}

describe('syncUnsentFeedback', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('should return empty stats when no unsynced feedback exists', async () => {
    mockRepository.getUnsynced.mockResolvedValue([])

    const stats = await syncUnsentFeedback()

    expect(stats).toEqual({ processed: 0, succeeded: 0, failed: 0 })
    expect(mockRuntimeClient.sendLateFeedback).not.toHaveBeenCalled()
  })

  it('should successfully sync feedback to runtime', async () => {
    const unsyncedFeedback = [
      createMockLateFeedback({
        id: 'feedback-1',
        tenantId: 'tenant-1',
        approvalId: 'approval-1',
        decision: 'would_approve',
        decidedBy: 'user-1',
        decidedByRole: 'admin',
        toolCallsHash: 'hash-1',
        syncAttempts: 0,
      }),
    ]

    mockRepository.getUnsynced.mockResolvedValue(unsyncedFeedback)
    mockRuntimeClient.sendLateFeedback.mockResolvedValue({ success: true })
    mockRepository.markSynced.mockResolvedValue(undefined)

    const stats = await syncUnsentFeedback()

    expect(stats).toEqual({ processed: 1, succeeded: 1, failed: 0 })
    expect(mockRepository.markSynced).toHaveBeenCalledWith('feedback-1')
  })

  it('should record sync attempt on failure', async () => {
    const unsyncedFeedback = [
      createMockLateFeedback({
        id: 'feedback-1',
        tenantId: 'tenant-1',
        approvalId: 'approval-1',
        decision: 'would_reject',
        decidedBy: 'user-1',
        decidedByRole: 'admin',
        toolCallsHash: 'hash-1',
        syncAttempts: 2,
      }),
    ]

    mockRepository.getUnsynced.mockResolvedValue(unsyncedFeedback)
    mockRuntimeClient.sendLateFeedback.mockRejectedValue(new Error('Network error'))
    mockRepository.recordSyncAttempt.mockResolvedValue(undefined)

    const stats = await syncUnsentFeedback()

    expect(stats).toEqual({ processed: 1, succeeded: 0, failed: 1 })
    expect(mockRepository.recordSyncAttempt).toHaveBeenCalledWith(
      'feedback-1',
      'Network error'
    )
  })

  it('should handle runtime returning failure status', async () => {
    const unsyncedFeedback = [
      createMockLateFeedback({
        id: 'feedback-1',
        tenantId: 'tenant-1',
        approvalId: 'approval-1',
        decision: 'would_approve',
        decidedBy: 'user-1',
        decidedByRole: 'member',
        toolCallsHash: 'hash-1',
        syncAttempts: 0,
      }),
    ]

    mockRepository.getUnsynced.mockResolvedValue(unsyncedFeedback)
    mockRuntimeClient.sendLateFeedback.mockResolvedValue({ success: false })
    mockRepository.recordSyncAttempt.mockResolvedValue(undefined)

    const stats = await syncUnsentFeedback()

    expect(stats).toEqual({ processed: 1, succeeded: 0, failed: 1 })
    expect(mockRepository.recordSyncAttempt).toHaveBeenCalledWith(
      'feedback-1',
      'Sync returned failure'
    )
  })

  it('should process multiple feedback items', async () => {
    const unsyncedFeedback = [
      createMockLateFeedback({
        id: 'feedback-1',
        tenantId: 'tenant-1',
        approvalId: 'approval-1',
        decision: 'would_approve',
        decidedBy: 'user-1',
        decidedByRole: 'admin',
        toolCallsHash: 'hash-1',
        syncAttempts: 0,
      }),
      createMockLateFeedback({
        id: 'feedback-2',
        tenantId: 'tenant-2',
        approvalId: 'approval-2',
        decision: 'would_reject',
        decidedBy: 'user-2',
        decidedByRole: 'admin',
        toolCallsHash: 'hash-2',
        syncAttempts: 1,
      }),
      createMockLateFeedback({
        id: 'feedback-3',
        tenantId: 'tenant-1',
        approvalId: 'approval-3',
        decision: 'would_approve',
        decidedBy: 'user-3',
        decidedByRole: 'member',
        toolCallsHash: 'hash-3',
        syncAttempts: 0,
      }),
    ]

    mockRepository.getUnsynced.mockResolvedValue(unsyncedFeedback)
    mockRuntimeClient.sendLateFeedback
      .mockResolvedValueOnce({ success: true })
      .mockRejectedValueOnce(new Error('Timeout'))
      .mockResolvedValueOnce({ success: true })

    const stats = await syncUnsentFeedback()

    expect(stats).toEqual({ processed: 3, succeeded: 2, failed: 1 })
  })

  it('should respect max attempts limit', async () => {
    // Items with 5+ attempts should not be returned by getUnsynced
    mockRepository.getUnsynced.mockResolvedValue([])

    const stats = await syncUnsentFeedback()

    expect(mockRepository.getUnsynced).toHaveBeenCalledWith({
      limit: 100,
      maxAttempts: 5,
    })
    expect(stats.processed).toBe(0)
  })
})

describe('Sync Job Lifecycle', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.clearAllMocks()
  })

  afterEach(() => {
    jest.useRealTimers()
    stopSyncJob()
  })

  it('should run sync at regular intervals', async () => {
    mockRepository.getUnsynced.mockResolvedValue([])

    startSyncJob()

    // Initial run happens immediately on start (per plan)
    await Promise.resolve()
    expect(mockRepository.getUnsynced).toHaveBeenCalledTimes(1)

    // After 1 minute (second run)
    jest.advanceTimersByTime(60 * 1000)
    await Promise.resolve() // Let promises resolve

    expect(mockRepository.getUnsynced).toHaveBeenCalledTimes(2)

    // After another minute (third run)
    jest.advanceTimersByTime(60 * 1000)
    await Promise.resolve()

    expect(mockRepository.getUnsynced).toHaveBeenCalledTimes(3)
  })

  it('should stop running when stopSyncJob is called', async () => {
    mockRepository.getUnsynced.mockResolvedValue([])

    startSyncJob()
    await Promise.resolve() // Initial immediate run

    jest.advanceTimersByTime(60 * 1000)
    await Promise.resolve() // Second run

    stopSyncJob()

    jest.advanceTimersByTime(60 * 1000)
    await Promise.resolve()

    // Should not have been called again after stop (immediate + one interval = 2)
    expect(mockRepository.getUnsynced).toHaveBeenCalledTimes(2)
  })

  it('should continue running even if sync fails', async () => {
    mockRepository.getUnsynced.mockRejectedValue(new Error('Database error'))

    startSyncJob()
    await Promise.resolve() // Initial immediate run (fails)

    jest.advanceTimersByTime(60 * 1000)
    await Promise.resolve() // Second run (fails)

    // Should still schedule next run despite error
    jest.advanceTimersByTime(60 * 1000)
    await Promise.resolve() // Third run (fails)

    // Immediate + 2 intervals = 3 calls
    expect(mockRepository.getUnsynced).toHaveBeenCalledTimes(3)
  })
})
