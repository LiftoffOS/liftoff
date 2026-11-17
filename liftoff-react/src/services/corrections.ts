// Corrections Service
// API for the Correction Protocol - forward correction system for agent actions

import { api } from './api'

// Correction types - how an action can be corrected
export type CorrectionType =
  | 'archive'
  | 'amend'
  | 'delete'
  | 'refund'
  | 'credit'
  | 'void'
  | 'follow_up'
  | 'not_correctable'

// Response from GET /api/audit-logs/:id/correction-options
export interface CorrectionOptions {
  correctable: boolean
  correctionType?: CorrectionType
  label?: string
  description?: string
  requiresApproval?: boolean
  timeRemaining?: number | null
  reason?: string // For not-correctable
  suggestion?: string // For not-correctable
}

// Response from POST /api/audit-logs/:id/correct
export interface CorrectionRequestResult {
  success: boolean
  correctionRequestId?: string
  status: 'requested' | 'gated' | 'ineligible' | 'error'
  approvalRequestId?: string
  error?: string
}

// Entry in correction history
export interface CorrectionHistoryEntry {
  id: string
  action: string
  correctionOf: string | null
  outcome: 'success' | 'error' | 'gated'
  triggeredBy: string
  createdAt: string
  inputArgs: Record<string, unknown>
  outputSummary: string | null
}

// Get correction options for an audit log
export async function getCorrectionOptions(
  tenantId: string,
  auditLogId: string
): Promise<CorrectionOptions> {
  return api.get<CorrectionOptions>(
    `/api/audit-logs/${auditLogId}/correction-options?tenantId=${tenantId}`
  )
}

// Request a correction for an audit log
export async function requestCorrection(
  tenantId: string,
  auditLogId: string,
  reason?: string
): Promise<CorrectionRequestResult> {
  return api.post<CorrectionRequestResult>(
    `/api/audit-logs/${auditLogId}/correct?tenantId=${tenantId}`,
    reason ? { reason } : undefined
  )
}

// Get correction history for an audit log
export async function getCorrectionHistory(
  tenantId: string,
  auditLogId: string
): Promise<{ history: CorrectionHistoryEntry[] }> {
  return api.get<{ history: CorrectionHistoryEntry[] }>(
    `/api/audit-logs/${auditLogId}/correction-history?tenantId=${tenantId}`
  )
}
