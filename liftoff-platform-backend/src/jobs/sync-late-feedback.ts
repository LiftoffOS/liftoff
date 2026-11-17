// src/jobs/sync-late-feedback.ts
// Per implementation plan: Background sync job for late feedback to tenant runtime

import { log } from '../infrastructure/logging'
import { lateFeedbackRepository } from '../hitl-late-feedback/repository'
import { tenantRuntimeClient } from '../connectors/tenant-runtime-client'

const MAX_SYNC_ATTEMPTS = 5
const BATCH_SIZE = 100
const JOB_INTERVAL_MS = 60 * 1000 // Run every minute (per plan)

export async function syncUnsentFeedback(): Promise<{
  processed: number
  succeeded: number
  failed: number
}> {
  const stats = { processed: 0, succeeded: 0, failed: 0 }

  try {
    // Get unsynced feedback items
    const unsynced = await lateFeedbackRepository.getUnsynced({
      limit: BATCH_SIZE,
      maxAttempts: MAX_SYNC_ATTEMPTS,
    })

    if (unsynced.length === 0) {
      return stats
    }

    log.info({ event: 'late_feedback_sync_started', count: unsynced.length })

    for (const feedback of unsynced) {
      stats.processed++

      try {
        const result = await tenantRuntimeClient.sendLateFeedback(
          feedback.tenantId,
          feedback.id,
          {
            approvalId: feedback.approvalId,
            decision: feedback.decision,
            decidedBy: feedback.decidedBy,
            decidedByRole: feedback.decidedByRole,
            rejectionReason: feedback.rejectionReason ?? undefined,
            toolCallsHash: feedback.toolCallsHash,
            pendingToolCalls: feedback.pendingToolCalls,
          }
        )

        if (result.success) {
          await lateFeedbackRepository.markSynced(feedback.id)
          stats.succeeded++
        } else {
          await lateFeedbackRepository.recordSyncAttempt(
            feedback.id,
            'Sync returned failure'
          )
          stats.failed++
        }
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        await lateFeedbackRepository.recordSyncAttempt(
          feedback.id,
          errorMessage
        )
        stats.failed++

        log.warn({
          event: 'late_feedback_sync_item_failed',
          feedbackId: feedback.id,
          attempt: feedback.syncAttempts + 1,
          error: errorMessage,
        })
      }
    }

    log.info({ event: 'late_feedback_sync_completed', ...stats })
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    log.error({ event: 'late_feedback_sync_job_failed', error: errorMessage })
  }

  return stats
}

// Job runner (can be invoked by Cloud Scheduler or internal scheduler)
let syncInterval: NodeJS.Timeout | null = null

export function startSyncJob(): void {
  if (syncInterval) {
    return // Already running
  }

  log.info({ event: 'late_feedback_sync_job_started', intervalMs: JOB_INTERVAL_MS })
  syncInterval = setInterval(syncUnsentFeedback, JOB_INTERVAL_MS)

  // Run immediately on start
  syncUnsentFeedback()
}

export function stopSyncJob(): void {
  if (syncInterval) {
    clearInterval(syncInterval)
    syncInterval = null
    log.info({ event: 'late_feedback_sync_job_stopped' })
  }
}
