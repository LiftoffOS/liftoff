// Shared Types
// Per Phase G3: Shared type definitions for API contracts
// These types are shared between backend and frontend via openapi-typescript generation

// ============================================================================
// Common API Types
// ============================================================================

export interface ApiError {
  error: string;
  code?: string;
  details?: Record<string, unknown>;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

export interface CursorPaginatedResponse<T> {
  items: T[];
  cursor: string | null;
  hasMore: boolean;
}

// ============================================================================
// Agent Oversight Types
// ============================================================================
//
// Phase 1b: deleted the stale HitlLevel = 0 | 1 | 2 | 3 | 4 orphan and its
// associated OversightSettings + SensitiveWorkConfig interfaces. Zero live
// importers — the production OversightSettings is defined in
// src/internal-agent-oversight/types.ts and uses AutonomyLevel, not HitlLevel.
// The canonical HitlLevel = 1 | 2 | 3 | 4 | 5 lives in
// src/internal-agents/types.ts (and @liftoffos/shared-types).

// ============================================================================
// Human Feedback Types
// ============================================================================

export type FeedbackStatus = 'pending' | 'assigned' | 'in_progress' | 'resolved' | 'canceled' | 'escalated' | 'expired';

export type FeedbackType = 'clarification' | 'approval' | 'escalation' | 'review';

export type FeedbackPriority = 'low' | 'normal' | 'high' | 'critical';

export interface FeedbackOption {
  id: string;
  label: string;
  description?: string;
  action: 'approve' | 'reject' | 'modify' | 'escalate';
}

export interface FeedbackRequest {
  id: string;
  tenantId: string;
  agentId?: string;
  workflowId?: string;
  taskId?: string;
  type: FeedbackType;
  priority: FeedbackPriority;
  status: FeedbackStatus;
  title: string;
  description: string;
  context?: Record<string, unknown>;
  options: FeedbackOption[];
  assignedTo?: string;
  resolvedBy?: string;
  resolvedAt?: Date;
  expiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface FeedbackResolution {
  feedbackId: string;
  resolvedBy: string;
  optionId: string;
  action: string;
  comment?: string;
  customData?: Record<string, unknown>;
}

// ============================================================================
// Agent Audit Log Types
// ============================================================================

export type AuditLogEventType =
  | 'workflow_started'
  | 'workflow_completed'
  | 'workflow_failed'
  | 'task_started'
  | 'task_completed'
  | 'task_failed'
  | 'tool_invoked'
  | 'tool_completed'
  | 'tool_failed'
  | 'hitl_requested'
  | 'hitl_approved'
  | 'hitl_rejected'
  | 'hitl_escalated'
  | 'memory_stored'
  | 'memory_retrieved';

export type TriggeredBy = `human:${string}` | 'agent' | 'cron' | `event:${string}`;

export interface AuditLogEntry {
  id: string;
  tenantId: string;
  internalAgentId?: string;
  userId?: string;
  threadId?: string;
  invocationId?: string;
  workflowId?: string;
  taskId?: string;
  eventType: AuditLogEventType;
  triggeredBy: TriggeredBy;
  toolName?: string;
  inputSummary?: string;
  outputSummary?: string;
  errorMessage?: string;
  durationMs?: number;
  tokenCount?: number;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

// ============================================================================
// Entitlements Types
// Per Phase H3: Team count based pricing model (not tier-based)
// ============================================================================

// Team tiers available for purchase (from PricingPage.tsx)
export const TEAM_TIERS = [5, 10, 25, 50, 75, 100, 200] as const;
export type TeamTier = (typeof TEAM_TIERS)[number];

// Pricing constants
export const BASE_PRICE_PER_TEAM_YEARLY = 250;
export const BASE_PRICE_PER_TEAM_MONTHLY = 300;

// Entitlement represents a tenant's capacity and enabled features
// Capacity caps removed in Phase 1 entitlements rework — credits are the limiter
export interface Entitlement {
  id: string;
  tenantId: string;
  version: number;

  // Capacity: Number of autonomous teams purchased
  teamCount: number;
  isCustomPricing: boolean; // Enterprise customers with custom contracts

  // Operational status
  tenantOperationalStatus: 'pending' | 'active' | 'suspended' | 'churned';
  agentExecutionAllowed: boolean;

  // Credit/usage tracking
  remainingIncludedCredits: number;
  overageAllowed: boolean;
  includedMonthlyCredits: number;
  overageCeiling: number;

  // Paid add-on features (from PricingPage additionalFeatures)
  advancedAnalyticsEnabled: boolean;
  sharedCollaborationEnabled: boolean;
  humanExpertsEnabled: boolean;
  prioritySupportEnabled: boolean;
  dedicatedSupportEnabled: boolean;
  advancedSecurityEnabled: boolean;
  complianceEnabled: boolean; // SOC2/GDPR
  ssoEnabled: boolean;
  overageProtectionEnabled: boolean;
  customRetentionEnabled: boolean;

  // Autonomous operation features (add-ons per Phase H3)
  scheduledAgentsEnabled: boolean;
  agentDelegationEnabled: boolean;
  crossAgentLearningEnabled: boolean;
  autoReflectionEnabled: boolean;

  createdAt: Date;
  updatedAt: Date;
}

// ============================================================================
// Tool Classification Types
// ============================================================================

export type SensitivityCategory =
  | 'customerCommunication'
  | 'financialActions'
  | 'dataChanges'
  | 'externalPublishing'
  | 'hiringDecisions';

export interface ToolClassification {
  toolName: string;
  integrationType: string;
  categories: SensitivityCategory[];
  draftVariant?: string;
  classifiedAt: Date;
}

// ============================================================================
// WebSocket Message Types (Human Feedback)
// ============================================================================

export type WebSocketMessageType =
  | 'feedback:created'
  | 'feedback:updated'
  | 'feedback:resolved'
  | 'feedback:assigned'
  | 'notification'
  | 'heartbeat';

export interface WebSocketMessage {
  type: WebSocketMessageType;
  payload: unknown;
  timestamp: string;
}

export interface FeedbackNotification {
  type: 'new_feedback' | 'feedback_assigned' | 'feedback_expiring' | 'feedback_resolved';
  title: string;
  message: string;
  feedbackId?: string;
  priority?: FeedbackPriority;
}
