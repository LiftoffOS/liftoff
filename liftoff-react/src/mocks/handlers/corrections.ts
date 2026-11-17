import { http, HttpResponse } from 'msw'
import { getSharedMockLogs } from '../data/activityLogs'
import type { CorrectionType, CorrectionOptions, CorrectionRequestResult, CorrectionHistoryEntry } from '../../services/corrections'

// Mock correction registry - defines which actions can be corrected
// These match the actions in the mock activity logs
const correctionRegistry: Record<string, { correctionType: CorrectionType; label: string; timeWindowSeconds?: number; requiresApproval?: boolean }> = {
  'send_email': { correctionType: 'follow_up', label: 'Send Correction Email' },
  'process_refund': { correctionType: 'void', label: 'Void Refund', requiresApproval: true },
  'create_ticket': { correctionType: 'archive', label: 'Archive Ticket' },
  'update_subscription': { correctionType: 'amend', label: 'Revert Subscription' },
  'generate_report': { correctionType: 'archive', label: 'Archive Report' },
  'sync_data': { correctionType: 'amend', label: 'Revert Sync' },
  'analyze_sentiment': { correctionType: 'archive', label: 'Archive Analysis' },
  'schedule_meeting': { correctionType: 'delete', label: 'Cancel Meeting', timeWindowSeconds: 3600 },
  'route_inquiry': { correctionType: 'amend', label: 'Re-route Inquiry' },
  'create_invoice': { correctionType: 'void', label: 'Void Invoice', requiresApproval: true },
  'send_notification': { correctionType: 'follow_up', label: 'Send Correction Notice' },
  'update_crm_record': { correctionType: 'amend', label: 'Revert CRM Changes' },
}

// Track which logs have been corrected (in-memory for mock)
const correctedLogs = new Set<string>()
const pendingCorrections = new Set<string>()

// Get correction type descriptions
function getDescription(correctionType: CorrectionType): string {
  switch (correctionType) {
    case 'archive':
      return 'The resource will be archived. The original record is preserved.'
    case 'amend':
      return 'The changes will be reverted to the previous state.'
    case 'delete':
      return 'The resource will be permanently deleted.'
    case 'refund':
      return 'A refund transaction will be created. The original charge record is preserved.'
    case 'credit':
      return 'A credit will be applied to the account.'
    case 'void':
      return 'The transaction will be voided if not yet settled.'
    case 'follow_up':
      return 'A follow-up communication will be sent with corrections.'
    default:
      return 'A correction action will be performed.'
  }
}

export const correctionsHandlers = [
  // GET /api/audit-logs/:id/correction-options
  http.get(`*/api/audit-logs/:id/correction-options`, async ({ params }) => {
    const auditLogId = params.id as string

    // Simulate network delay
    await new Promise(resolve => setTimeout(resolve, 200))

    // Look up the actual audit log to get its action
    const mockLogs = getSharedMockLogs()
    const auditLog = mockLogs.find(log => log.id === auditLogId)

    // Check if log exists
    if (!auditLog) {
      const response: CorrectionOptions = {
        correctable: false,
        reason: 'Audit log not found',
        suggestion: 'The activity record could not be found.',
      }
      return HttpResponse.json(response)
    }

    // Only successful actions can be corrected
    if (auditLog.outcome !== 'success') {
      const response: CorrectionOptions = {
        correctable: false,
        reason: 'Only successful actions can be corrected',
        suggestion: 'This action did not complete successfully and cannot be corrected.',
      }
      return HttpResponse.json(response)
    }

    // Check if already corrected
    if (correctedLogs.has(auditLogId)) {
      const response: CorrectionOptions = {
        correctable: false,
        reason: 'Action has already been corrected',
        suggestion: 'No further correction is needed.',
      }
      return HttpResponse.json(response)
    }

    // Check if pending correction
    if (pendingCorrections.has(auditLogId)) {
      const response: CorrectionOptions = {
        correctable: false,
        reason: 'A correction request is already pending',
        suggestion: 'Please wait for the current correction to complete.',
      }
      return HttpResponse.json(response)
    }

    // Look up the correction registry entry based on the action
    const registryEntry = correctionRegistry[auditLog.action]

    if (!registryEntry) {
      const response: CorrectionOptions = {
        correctable: false,
        reason: 'Action type not registered for correction',
        suggestion: 'This action type does not support automatic correction.',
      }
      return HttpResponse.json(response)
    }

    // Calculate time remaining if applicable
    let timeRemaining: number | null = null
    if (registryEntry.timeWindowSeconds) {
      const actionTime = new Date(auditLog.createdAt).getTime()
      const elapsed = Math.floor((Date.now() - actionTime) / 1000)
      timeRemaining = registryEntry.timeWindowSeconds - elapsed

      if (timeRemaining <= 0) {
        const response: CorrectionOptions = {
          correctable: false,
          reason: 'Time window for correction has expired',
          suggestion: 'The action occurred too long ago to be corrected.',
        }
        return HttpResponse.json(response)
      }
    }

    const response: CorrectionOptions = {
      correctable: true,
      correctionType: registryEntry.correctionType,
      label: registryEntry.label,
      description: getDescription(registryEntry.correctionType),
      requiresApproval: registryEntry.requiresApproval ?? false,
      timeRemaining,
    }
    return HttpResponse.json(response)
  }),

  // POST /api/audit-logs/:id/correct
  http.post(`*/api/audit-logs/:id/correct`, async ({ params, request }) => {
    const auditLogId = params.id as string

    // Simulate network delay
    await new Promise(resolve => setTimeout(resolve, 300))

    // Parse body (reason is optional)
    try {
      const text = await request.text()
      if (text) {
        JSON.parse(text) as { reason?: string }
      }
    } catch {
      // Empty body is OK
    }

    // Look up the audit log
    const mockLogs = getSharedMockLogs()
    const auditLog = mockLogs.find(log => log.id === auditLogId)
    if (!auditLog) {
      const response: CorrectionRequestResult = {
        success: false,
        status: 'error',
        error: 'Audit log not found',
      }
      return HttpResponse.json(response, { status: 400 })
    }

    // Check if only successful actions
    if (auditLog.outcome !== 'success') {
      const response: CorrectionRequestResult = {
        success: false,
        status: 'ineligible',
        error: 'Only successful actions can be corrected',
      }
      return HttpResponse.json(response, { status: 400 })
    }

    // Check if already corrected
    if (correctedLogs.has(auditLogId)) {
      const response: CorrectionRequestResult = {
        success: false,
        status: 'ineligible',
        error: 'Action has already been corrected',
      }
      return HttpResponse.json(response, { status: 400 })
    }

    // Check if pending
    if (pendingCorrections.has(auditLogId)) {
      const response: CorrectionRequestResult = {
        success: false,
        status: 'ineligible',
        error: 'A correction request is already pending',
      }
      return HttpResponse.json(response, { status: 400 })
    }

    // Look up registry entry
    const registryEntry = correctionRegistry[auditLog.action]
    if (!registryEntry) {
      const response: CorrectionRequestResult = {
        success: false,
        status: 'ineligible',
        error: 'Action type not registered for correction',
      }
      return HttpResponse.json(response, { status: 400 })
    }

    const correctionRequestId = `corr-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`

    if (registryEntry.requiresApproval) {
      pendingCorrections.add(auditLogId)
      const response: CorrectionRequestResult = {
        success: true,
        correctionRequestId,
        status: 'gated',
        approvalRequestId: `approval-${Date.now()}`,
      }
      return HttpResponse.json(response, { status: 202 })
    }

    // Mark as corrected (for mock purposes)
    correctedLogs.add(auditLogId)

    const response: CorrectionRequestResult = {
      success: true,
      correctionRequestId,
      status: 'requested',
    }
    return HttpResponse.json(response, { status: 202 })
  }),

  // GET /api/audit-logs/:id/correction-history
  http.get(`*/api/audit-logs/:id/correction-history`, async ({ params }) => {
    const auditLogId = params.id as string

    // Simulate network delay
    await new Promise(resolve => setTimeout(resolve, 150))

    // Look up the actual audit log
    const mockLogs = getSharedMockLogs()
    const auditLog = mockLogs.find(log => log.id === auditLogId)

    if (!auditLog) {
      return HttpResponse.json({ history: [] })
    }

    // Generate mock history starting with the original action
    const history: CorrectionHistoryEntry[] = [
      {
        id: auditLogId,
        action: auditLog.action,
        correctionOf: null,
        outcome: auditLog.outcome,
        triggeredBy: auditLog.triggeredBy,
        createdAt: auditLog.createdAt,
        inputArgs: auditLog.inputArgs,
        outputSummary: auditLog.outputSummary,
      },
    ]

    // If this log has been corrected, add correction entry
    if (correctedLogs.has(auditLogId)) {
      const registryEntry = correctionRegistry[auditLog.action]
      history.push({
        id: `${auditLogId}-correction`,
        action: registryEntry?.label || 'correction_executed',
        correctionOf: auditLogId,
        outcome: 'success',
        triggeredBy: 'human:user-123',
        createdAt: new Date().toISOString(),
        inputArgs: { originalAuditLogId: auditLogId },
        outputSummary: 'Correction completed successfully',
      })
    }

    // If pending, add correction request entry
    if (pendingCorrections.has(auditLogId)) {
      history.push({
        id: `${auditLogId}-request`,
        action: 'correction_request',
        correctionOf: auditLogId,
        outcome: 'gated',
        triggeredBy: 'human:user-123',
        createdAt: new Date().toISOString(),
        inputArgs: { originalAuditLogId: auditLogId },
        outputSummary: 'Awaiting approval',
      })
    }

    return HttpResponse.json({ history })
  }),
]
