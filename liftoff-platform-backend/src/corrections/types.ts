// Correction Protocol Types
// Per implementation plan: Enterprise-grade forward correction system

// Correction types - how an action can be corrected
export type CorrectionType =
  | 'archive'        // Archive/soft-delete the created resource
  | 'amend'          // Update to previous state with amendment record
  | 'delete'         // Hard delete (time-limited, e.g., Slack)
  | 'refund'         // Financial compensation (creates new transaction)
  | 'credit'         // Apply credit instead of refund
  | 'void'           // Void transaction (if not yet settled)
  | 'follow_up'      // Send correction/follow-up communication
  | 'not_correctable'; // Explicitly mark as not correctable

// Correction registry entry - defines how an action can be corrected
export interface CorrectionRegistryEntry {
  id: string;
  toolName: string;
  integrationType: string;
  correctionToolName: string | null;
  correctionType: CorrectionType;
  timeWindowSeconds: number | null;
  requiresPreviousState: boolean;
  userFacingLabel: string | null;
  requiresHitlApproval: boolean;
  hitlLevel: number | null;
  maxCorrectionChain: number;
  createdAt: Date;
  updatedAt: Date;
}

// Correction eligibility check result
export interface CorrectionEligibility {
  eligible: boolean;
  correctionType?: CorrectionType;
  correctionToolName?: string | null;
  reason?: string;
  hint?: string;
  timeRemaining?: number | null; // seconds remaining for time-limited corrections
  requiresApproval?: boolean;
  requiresPreviousState?: boolean;
  label?: string | null;
}

// Correction options response (user-facing)
export interface CorrectionOptions {
  correctable: boolean;
  correctionType?: CorrectionType;
  label?: string;
  description?: string;
  requiresApproval?: boolean;
  timeRemaining?: number | null;
  reason?: string; // For not-correctable
  suggestion?: string; // For not-correctable
}

// Correction request input
export interface CorrectionRequestInput {
  tenantId: string;
  auditLogId: string;
  reason?: string;
  requestedBy: string; // user ID
}

// Correction request result
export interface CorrectionRequestResult {
  success: boolean;
  correctionRequestId?: string;
  status: 'requested' | 'gated' | 'ineligible' | 'error';
  approvalRequestId?: string; // If HITL approval required
  error?: string;
}

// Bulk correction request input
export interface BulkCorrectionRequest {
  auditLogIds: string[];
  reason?: string;
  stopOnError?: boolean;
}

// Bulk correction response
export interface BulkCorrectionResponse {
  results: Array<{
    auditLogId: string;
    status: 'requested' | 'ineligible' | 'error';
    correctionRequestId?: string;
    error?: string;
  }>;
  summary: {
    total: number;
    requested: number;
    ineligible: number;
    errors: number;
  };
}

// Correction history entry
export interface CorrectionHistoryEntry {
  id: string;
  action: string;
  correctionOf: string | null;
  outcome: 'success' | 'error' | 'gated';
  triggeredBy: string;
  createdAt: Date;
  inputArgs: Record<string, unknown>;
  outputSummary: string | null;
}

// Tenant correction configuration
export interface CorrectionConfig {
  tenantId: string;
  requireApprovalAll: boolean;
  autoApproveWindow: number | null; // seconds
  requireOriginalActor: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// Rate limit configuration
export interface CorrectionRateLimits {
  tenantId: string;
  maxPerMinute: number;
  maxPerHour: number;
  maxPerDay: number;
  createdAt: Date;
  updatedAt: Date;
}

// Rate limit check result
export interface RateLimitCheckResult {
  allowed: boolean;
  retryAfter?: number; // seconds
  remaining?: {
    minute: number;
    hour: number;
    day: number;
  };
}

// Rate usage tracking
export interface CorrectionRateUsage {
  tenantId: string;
  windowStart: Date;
  windowType: 'minute' | 'hour' | 'day';
  count: number;
}

// Correction budget
export interface CorrectionBudget {
  tenantId: string;
  budgetLimit: number | null; // null = unlimited
  budgetUsed: number;
  budgetPeriod: string;
  periodStart: Date;
  createdAt: Date;
  updatedAt: Date;
}

// Budget check result
export interface BudgetCheckResult {
  allowed: boolean;
  remaining?: number;
}

// Financial correction record
export interface FinancialCorrection {
  id: string;
  tenantId: string;
  originalAuditLogId: string;
  correctionAuditLogId: string;
  correctionType: CorrectionType;
  amountCents: number;
  currency: string;
  reason: string;
  reconciled: boolean;
  reconciledAt: Date | null;
  reconciledBy: string | null;
  createdAt: Date;
}

// Financial correction insert input
export interface InsertFinancialCorrectionInput {
  tenantId: string;
  originalAuditLogId: string;
  correctionAuditLogId: string;
  correctionType: CorrectionType;
  amountCents: number;
  currency: string;
  reason: string;
}

// Correction event payload (for Pub/Sub)
export interface CorrectionRequestedPayload {
  correctionRequestId: string;
  tenantId: string;
  originalAuditLogId: string;
  correctionToolName: string;
  correctionType: CorrectionType;
  requiresPreviousState: boolean;
  reason?: string;
  requestedBy: string;
  timeout: string; // ISO timestamp
  maxRetries: number;
  retryCount: number;
}

// Bulk correction event payload
export interface BulkCorrectionRequestedPayload {
  correctionRequestIds: string[];
  tenantId: string;
  corrections: Array<{
    correctionRequestId: string;
    originalAuditLogId: string;
    correctionToolName: string;
    correctionType: CorrectionType;
    requiresPreviousState: boolean;
  }>;
  reason?: string;
  requestedBy: string;
  timeout: string;
  maxRetries: number;
  retryCount: number;
}

// Usage stats response
export interface CorrectionUsageStats {
  rateLimits: CorrectionRateLimits;
  currentUsage: {
    minute: number;
    hour: number;
    day: number;
  };
  budget: CorrectionBudget | null;
}

// Pending approval for HITL-gated corrections
export interface PendingCorrectionApproval {
  correctionRequestId: string;
  feedbackId: string;
  tenantId: string;
  originalAuditLogId: string;
  correctionToolName: string;
  correctionType: CorrectionType;
  requiresPreviousState: boolean;
  reason?: string;
  requestedBy: string;
  createdAt: Date;
  expiresAt: Date;
}
