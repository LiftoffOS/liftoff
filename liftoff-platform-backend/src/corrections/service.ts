// Correction Protocol Service
// Business logic + event publishing for correction operations

import { randomUUID } from 'crypto';
import { correctionRepository } from './repository';
import { checkCorrectionPermissions } from './permissions';
import { checkAndIncrementRateLimit, checkAndIncrementBulkRateLimit } from './rate-limiter';
import { atomicCheckAndDeductBudget } from './budget';
import { publishEvent } from '../events/publisher';
import { agentAuditLogsService } from '../agent-audit-logs/service';
import { log } from '../infrastructure/logging';
import {
  CorrectionEligibility,
  CorrectionOptions,
  CorrectionRequestInput,
  CorrectionRequestResult,
  BulkCorrectionRequest,
  BulkCorrectionResponse,
  CorrectionHistoryEntry,
  CorrectionConfig,
  CorrectionUsageStats,
  CorrectionRequestedPayload,
  BulkCorrectionRequestedPayload,
} from './types';

const CORRECTION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class CorrectionService {

  // ==========================================================================
  // Correction Eligibility
  // ==========================================================================

  async getCorrectionOptions(tenantId: string, auditLogId: string): Promise<CorrectionOptions> {
    const eligibility = await this.checkCorrectionEligibility(tenantId, auditLogId);

    if (!eligibility.eligible) {
      return {
        correctable: false,
        reason: eligibility.reason,
        suggestion: this.getSuggestion(eligibility.reason),
      };
    }

    return {
      correctable: true,
      correctionType: eligibility.correctionType,
      label: eligibility.label || undefined,
      description: this.getDescription(eligibility),
      requiresApproval: eligibility.requiresApproval,
      timeRemaining: eligibility.timeRemaining,
    };
  }

  async checkCorrectionEligibility(tenantId: string, auditLogId: string): Promise<CorrectionEligibility> {
    // 1. Get the audit log
    const auditLog = await agentAuditLogsService.getAuditLog(tenantId, auditLogId);
    if (!auditLog) {
      return { eligible: false, reason: 'Audit log not found' };
    }

    return this.checkCorrectionEligibilityWithAuditLog(tenantId, auditLogId, auditLog);
  }

  /**
   * BE-005: Check eligibility with pre-fetched audit log to avoid TOCTOU
   */
  private async checkCorrectionEligibilityWithAuditLog(
    tenantId: string,
    auditLogId: string,
    auditLog: { outcome: string; action: string; createdAt: Date }
  ): Promise<CorrectionEligibility> {
    // 2. Only successful actions can be corrected
    if (auditLog.outcome !== 'success') {
      return { eligible: false, reason: 'Only successful actions can be corrected' };
    }

    // 3. Check if action is in correction registry
    const registryEntry = await correctionRepository.getRegistryEntryByToolName(auditLog.action);
    if (!registryEntry) {
      return { eligible: false, reason: 'Action type not registered for correction' };
    }

    // 4. Check if action is correctable
    if (registryEntry.correctionType === 'not_correctable') {
      return {
        eligible: false,
        reason: registryEntry.userFacingLabel || 'This action cannot be corrected',
      };
    }

    // 5. Check if already corrected
    const alreadyCorrected = await correctionRepository.wasActionCorrected(tenantId, auditLogId);
    if (alreadyCorrected) {
      return { eligible: false, reason: 'Action has already been corrected' };
    }

    // 6. Check for pending correction request
    const hasPending = await correctionRepository.hasPendingCorrectionRequest(tenantId, auditLogId);
    if (hasPending) {
      return { eligible: false, reason: 'A correction request is already pending' };
    }

    // 7. Check correction chain depth
    const chainDepth = await correctionRepository.getCorrectionChainDepth(tenantId, auditLogId);
    if (chainDepth >= registryEntry.maxCorrectionChain) {
      return { eligible: false, reason: `Maximum correction chain depth (${registryEntry.maxCorrectionChain}) reached` };
    }

    // 8. Check time window (if applicable)
    let timeRemaining: number | null = null;
    if (registryEntry.timeWindowSeconds) {
      const elapsedSeconds = Math.floor((Date.now() - auditLog.createdAt.getTime()) / 1000);
      timeRemaining = registryEntry.timeWindowSeconds - elapsedSeconds;

      if (timeRemaining <= 0) {
        return {
          eligible: false,
          reason: `Time window for correction has expired (${registryEntry.timeWindowSeconds}s)`,
        };
      }
    }

    // User clicking "Correct" IS the approval - no additional gating needed
    return {
      eligible: true,
      correctionType: registryEntry.correctionType,
      correctionToolName: registryEntry.correctionToolName,
      requiresApproval: false,
      requiresPreviousState: registryEntry.requiresPreviousState,
      timeRemaining,
      label: registryEntry.userFacingLabel,
    };
  }

  // ==========================================================================
  // Request Correction
  // ==========================================================================

  async requestCorrection(input: CorrectionRequestInput): Promise<CorrectionRequestResult> {
    const { tenantId, auditLogId, reason, requestedBy } = input;

    // BE-005: Fetch audit log once and pass to eligibility check to avoid TOCTOU
    const auditLog = await agentAuditLogsService.getAuditLog(tenantId, auditLogId);
    if (!auditLog) {
      return { success: false, status: 'error', error: 'Audit log not found' };
    }

    // 1. Check eligibility (pass cached audit log)
    const eligibility = await this.checkCorrectionEligibilityWithAuditLog(tenantId, auditLogId, auditLog);
    if (!eligibility.eligible) {
      return {
        success: false,
        status: 'ineligible',
        error: eligibility.reason,
      };
    }

    // 2. Check permissions (use already-fetched audit log)
    const permissionResult = await checkCorrectionPermissions(
      tenantId,
      requestedBy,
      auditLog,
      eligibility.correctionToolName!
    );
    if (!permissionResult.allowed) {
      return {
        success: false,
        status: 'error',
        error: permissionResult.reason,
      };
    }

    // BE-001: Atomically check and increment rate limit (eliminates race condition)
    const rateLimitResult = await checkAndIncrementRateLimit(tenantId);
    if (!rateLimitResult.allowed) {
      return {
        success: false,
        status: 'error',
        error: `Rate limit exceeded. Retry after ${rateLimitResult.retryAfter} seconds`,
      };
    }

    // BE-002: Atomically check and deduct budget (eliminates race condition)
    const budgetResult = await atomicCheckAndDeductBudget(tenantId);
    if (!budgetResult.allowed) {
      return {
        success: false,
        status: 'error',
        error: 'Correction budget exhausted for this period',
      };
    }

    // Rate usage already incremented atomically in checkAndIncrementRateLimit

    // Insert correction_request audit log
    const correctionRequestId = randomUUID();
    await agentAuditLogsService.insertAuditLog({
      tenantId,
      action: 'correction_request',
      inputArgs: {
        originalAuditLogId: auditLogId,
        reason,
        correctionType: eligibility.correctionType,
        correctionToolName: eligibility.correctionToolName,
      },
      outcome: 'success',
      triggeredBy: `human:${requestedBy}`,
    });

    // Publish correction.requested event
    await this.publishCorrectionRequestedEvent({
      correctionRequestId,
      tenantId,
      originalAuditLogId: auditLogId,
      correctionToolName: eligibility.correctionToolName!,
      correctionType: eligibility.correctionType!,
      requiresPreviousState: eligibility.requiresPreviousState!,
      reason,
      requestedBy,
    });

    log.info({
      event: 'correction_requested',
      tenantId,
      auditLogId,
      correctionRequestId,
      correctionType: eligibility.correctionType,
    });

    return {
      success: true,
      correctionRequestId,
      status: 'requested',
    };
  }

  // ==========================================================================
  // Bulk Corrections
  // ==========================================================================

  async requestBulkCorrection(
    tenantId: string,
    requestedBy: string,
    request: BulkCorrectionRequest
  ): Promise<BulkCorrectionResponse> {
    const { auditLogIds, reason, stopOnError = false } = request;

    // Limit to 50 per request
    if (auditLogIds.length > 50) {
      throw new Error('Maximum 50 corrections per bulk request');
    }

    // BE-004: Use checkAndIncrementBulkRateLimit for bulk operations (atomic)
    const rateLimitResult = await checkAndIncrementBulkRateLimit(tenantId, auditLogIds.length);
    if (!rateLimitResult.allowed) {
      throw new Error(`Rate limit exceeded. Retry after ${rateLimitResult.retryAfter} seconds`);
    }

    const results: BulkCorrectionResponse['results'] = [];
    const corrections: BulkCorrectionRequestedPayload['corrections'] = [];

    for (const auditLogId of auditLogIds) {
      try {
        // BE-005: Fetch audit log once to avoid TOCTOU
        const auditLog = await agentAuditLogsService.getAuditLog(tenantId, auditLogId);
        if (!auditLog) {
          results.push({ auditLogId, status: 'error', error: 'Audit log not found' });
          if (stopOnError) break;
          continue;
        }

        const eligibility = await this.checkCorrectionEligibilityWithAuditLog(tenantId, auditLogId, auditLog);

        if (!eligibility.eligible) {
          results.push({
            auditLogId,
            status: 'ineligible',
            error: eligibility.reason,
          });

          if (stopOnError) break;
          continue;
        }

        // Check permissions (use already-fetched audit log)
        const permissionResult = await checkCorrectionPermissions(
          tenantId,
          requestedBy,
          auditLog,
          eligibility.correctionToolName!
        );

        if (!permissionResult.allowed) {
          results.push({ auditLogId, status: 'error', error: permissionResult.reason });
          if (stopOnError) break;
          continue;
        }

        // BE-002: Atomically check and deduct budget
        const budgetResult = await atomicCheckAndDeductBudget(tenantId);
        if (!budgetResult.allowed) {
          results.push({ auditLogId, status: 'error', error: 'Budget exhausted' });
          if (stopOnError) break;
          continue;
        }

        // Insert correction_request audit log
        const correctionRequestId = randomUUID();
        await agentAuditLogsService.insertAuditLog({
          tenantId,
          action: 'correction_request',
          inputArgs: {
            originalAuditLogId: auditLogId,
            reason,
            correctionType: eligibility.correctionType,
            correctionToolName: eligibility.correctionToolName,
            bulk: true,
          },
          outcome: 'success',
          triggeredBy: `human:${requestedBy}`,
        });

        corrections.push({
          correctionRequestId,
          originalAuditLogId: auditLogId,
          correctionToolName: eligibility.correctionToolName!,
          correctionType: eligibility.correctionType!,
          requiresPreviousState: eligibility.requiresPreviousState!,
        });

        results.push({
          auditLogId,
          status: 'requested',
          correctionRequestId,
        });

      } catch (error) {
        results.push({
          auditLogId,
          status: 'error',
          error: error instanceof Error ? error.message : 'Unknown error',
        });

        if (stopOnError) break;
      }
    }

    // Rate usage already atomically incremented in checkAndIncrementBulkRateLimit

    // BE-013: Only publish event if we have successful corrections
    if (corrections.length > 0) {
      try {
        await this.publishBulkCorrectionRequestedEvent({
          correctionRequestIds: corrections.map(c => c.correctionRequestId),
          tenantId,
          corrections,
          reason,
          requestedBy,
        });
      } catch (publishError) {
        // BE-013: Log publish failure instead of silently ignoring
        log.error({
          event: 'bulk_correction_publish_failed',
          tenantId,
          correctionCount: corrections.length,
          error: publishError instanceof Error ? publishError.message : String(publishError),
        });
        throw new Error('Failed to publish bulk correction event');
      }
    }

    return {
      results,
      summary: {
        total: auditLogIds.length,
        requested: results.filter(r => r.status === 'requested').length,
        ineligible: results.filter(r => r.status === 'ineligible').length,
        errors: results.filter(r => r.status === 'error').length,
      },
    };
  }

  // ==========================================================================
  // Correction History
  // ==========================================================================

  async getCorrectionHistory(tenantId: string, auditLogId: string): Promise<CorrectionHistoryEntry[]> {
    return correctionRepository.getCorrectionHistory(tenantId, auditLogId);
  }

  // ==========================================================================
  // Configuration Management
  // ==========================================================================

  async getCorrectionConfig(tenantId: string): Promise<CorrectionConfig | null> {
    return correctionRepository.getCorrectionConfig(tenantId);
  }

  async updateCorrectionConfig(
    tenantId: string,
    config: Partial<Omit<CorrectionConfig, 'tenantId' | 'createdAt' | 'updatedAt'>>
  ): Promise<CorrectionConfig> {
    return correctionRepository.upsertCorrectionConfig(tenantId, config);
  }

  // ==========================================================================
  // Usage Stats
  // ==========================================================================

  async getCorrectionUsage(tenantId: string): Promise<CorrectionUsageStats> {
    const [rateLimits, minuteUsage, hourUsage, dayUsage, budget] = await Promise.all([
      correctionRepository.getRateLimits(tenantId),
      correctionRepository.getRateUsage(tenantId, 'minute'),
      correctionRepository.getRateUsage(tenantId, 'hour'),
      correctionRepository.getRateUsage(tenantId, 'day'),
      correctionRepository.getBudget(tenantId),
    ]);

    return {
      rateLimits,
      currentUsage: {
        minute: minuteUsage,
        hour: hourUsage,
        day: dayUsage,
      },
      budget,
    };
  }

  // ==========================================================================
  // Cleanup (called by Cloud Scheduler)
  // ==========================================================================

  async cleanupExpiredRateUsage(): Promise<number> {
    const cleanedRateUsage = await correctionRepository.cleanupOldRateUsage();

    log.info({
      event: 'correction_rate_usage_cleanup',
      cleanedRateUsage,
    });

    return cleanedRateUsage;
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  private async publishCorrectionRequestedEvent(params: Omit<CorrectionRequestedPayload, 'timeout' | 'maxRetries' | 'retryCount'>): Promise<void> {
    await publishEvent({
      entityType: 'correction_request',
      entityId: params.correctionRequestId,
      eventType: 'correction.requested',
      entityVersion: 1,
      eventVersion: 1,
      tenantId: params.tenantId,
      payload: {
        ...params,
        timeout: new Date(Date.now() + CORRECTION_TIMEOUT_MS).toISOString(),
        maxRetries: 3,
        retryCount: 0,
      },
    });
  }

  private async publishBulkCorrectionRequestedEvent(
    params: Omit<BulkCorrectionRequestedPayload, 'timeout' | 'maxRetries' | 'retryCount'>
  ): Promise<void> {
    await publishEvent({
      entityType: 'correction_request',
      entityId: params.correctionRequestIds[0], // Use first ID as entity ID
      eventType: 'correction.bulk_requested',
      entityVersion: 1,
      eventVersion: 1,
      tenantId: params.tenantId,
      payload: {
        ...params,
        timeout: new Date(Date.now() + CORRECTION_TIMEOUT_MS).toISOString(),
        maxRetries: 3,
        retryCount: 0,
      },
    });
  }

  private getSuggestion(reason?: string): string {
    if (reason?.includes('email')) {
      return 'Consider sending a follow-up email with corrections';
    }
    if (reason?.includes('expired')) {
      return 'The action occurred too long ago to be corrected';
    }
    return 'This action type does not support automatic correction';
  }

  private getDescription(eligibility: CorrectionEligibility): string {
    const type = eligibility.correctionType;

    switch (type) {
      case 'archive':
        return 'The resource will be archived. The original creation record is preserved.';
      case 'amend':
        return 'The resource will be restored to its previous state.';
      case 'delete':
        return 'The resource will be permanently deleted.';
      case 'refund':
        return 'A refund transaction will be created. The original charge record is preserved.';
      case 'credit':
        return 'A credit will be applied to the account.';
      case 'void':
        return 'The transaction will be voided if not yet settled.';
      case 'follow_up':
        return 'A follow-up communication will be sent with corrections.';
      default:
        return 'A correction action will be performed.';
    }
  }
}

export const correctionService = new CorrectionService();
