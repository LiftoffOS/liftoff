// Backend-only types for the insights module
// Shared types (VisualizationBlock, etc.) are in shared-types.ts

export interface TimeRange {
  start: Date;
  end: Date;
}

// ── Data provider return types ──────────────────────────────────────────

export interface InternalAgentStats {
  agentId: string;
  agentName: string;
  role: string;
  status: string;
  taskCount: number;
  costUsd: number;
  successRate: number;
  errorCount: number;
}

export interface ExternalAgentStats {
  agentId: string;
  agentName: string;
  costType: 'per_task' | 'per_month' | null;
  costAmount: number | null;
  taskCount: number;
  computedCostUsd: number;
}

export interface InvocationStats {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  invocationCount: number;
  /** The subset of the above that carries NO provider-reported cost: real
   *  tokens, zero dollars. A total alone cannot distinguish "this was cheap"
   *  from "we never learned what this cost", and only the first is good news.
   *  Reported rather than estimated: a token count times a rate-table entry
   *  cannot reproduce request-level pricing tiers, batch discounts or
   *  negotiated rates, so an estimate here would be a made-up number sitting in
   *  the same field as measured ones. */
  uncostedInvocationCount: number;
  uncostedInputTokens: number;
  uncostedOutputTokens: number;
}

export interface AgentCostEntry {
  totalCostUsd: number;
  rawModelCostUsd?: number;
  ouConsumed: number;
  invocationCount: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCachedTokens?: number;
  /** See InvocationStats — the subset with no provider-reported cost. */
  uncostedInvocationCount?: number;
  uncostedInputTokens?: number;
  uncostedOutputTokens?: number;
}

export interface HitlApprovalStats {
  totalApprovals: number;
  approvedCount: number;
  rejectedCount: number;
  pendingCount: number;
  expiredCount: number;
  avgDecisionTimeMs: number | null;
}

export interface MemberActivity {
  accountId: string;
  displayName: string;
  approvalCount: number;
  correctionCount: number;
}

export interface CorrectionStats {
  totalCorrections: number;
  byAgent: Array<{ agentId: string; agentName: string; correctionCount: number }>;
}

export type TimeGrouping = 'hour' | 'day' | 'month';

export interface AuditLogAggregation {
  timeBreakdown: Array<{ date: string; count: number; successCount: number; errorCount: number; humanCount: number; aiCount: number }>;
  topAgents: Array<{ agentId: string; agentName: string; actionCount: number; successRate: number }>;
  totalActions: number;
  totalSuccess: number;
  totalErrors: number;
  avgDurationMs: number | null;
}

export interface TenantMemberInfo {
  accountId: string;
  displayName: string;
  email: string;
  role: string;
}

export interface OversightSettings {
  autonomyLevel: string;
  sensitiveWorkCategories: string[];
  escalationRules: Record<string, unknown>;
}

export interface UsageDashboard {
  totalCreditsUsed: number;
  remainingCredits: number;
  creditsPerHour: number;
}

export interface ConnectorHealthEntry {
  connector: string;
  totalActions: number;
  successCount: number;
  failureCount: number;
  avgDurationMs: number;
  errorRate: number;
}

// ── Rate limiter types ──────────────────────────────────────────────────

export interface InsightsRateLimitResult {
  allowed: boolean;
  retryAfter?: number;
  remaining: {
    minute: number;
    hour: number;
    day: number;
  };
}

// ── Conversation summarization types (Phase 6) ─────────────────────────

/**
 * Structured snapshot of older conversation turns, maintained on long
 * threads so the LLM can keep context across many messages without
 * shipping the entire history on every turn. Stored as JSONB on
 * insights_chat_threads.rolling_summary (migration 078).
 */
export interface ConversationSummary {
  /** One-sentence description of what the user is currently investigating. */
  userIntent: string;
  /** Important data points the assistant returned (numbers + dates). */
  keyFacts: string[];
  /** Questions the user asked that haven't been fully answered yet. */
  openQuestions: string[];
  /** Conclusions or hypotheses the conversation reached. */
  previousFindings: string[];
  /** Suggested follow-up directions. */
  nextSteps: string[];
  /** ISO timestamp of the most recent message included in this summary. */
  summarizedThrough: string;
  /** How many messages were rolled into this summary. */
  messageCount: number;
}

// ── Report service types ────────────────────────────────────────────────

export interface InsightsReportData {
  metricCards: import('./shared-types').MetricCardBlock[];
  barCharts: import('./shared-types').BarChartBlock[];
  trendCharts: import('./shared-types').TrendChartBlock[];
  tables: import('./shared-types').TableBlock[];
  textBlocks: import('./shared-types').TextBlock[];
  blocks: import('./shared-types').VisualizationBlock[];
}
