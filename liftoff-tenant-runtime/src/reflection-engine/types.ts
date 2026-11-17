// Reflection Engine Types
// Per Section 16: Reflection engine

export interface ReflectionTrigger {
  tenantId: string;
  triggerType: ReflectionTriggerType;
  metadata?: Record<string, any>;
}

// Per Section 16: Reflection runs after these triggers
export type ReflectionTriggerType =
  | 'repeated_failures'
  | 'repeated_human_corrections'
  | 'n_successful_runs'
  | 'scheduled'
  // Phase 5: Late feedback flagged by a human via /api/hitl-enforcement/late-feedback
  // with decision === 'rejected'. Lower threshold (2+ in 7 days) than
  // repeated_human_corrections because each flag is a deliberate post-hoc rejection.
  | 'flagged_feedback';

// Per Section 16: Reflection writes these fields
export interface ReflectionSuggestion {
  id: string;
  agentId: string;
  suggestion: string;
  evidenceRefs: EvidenceRef[];
  confidenceScore: number;
  recurrenceScore: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
  status: 'pending' | 'accepted' | 'rejected';
  createdAt: Date;
  // A7: 'instruction' (classic edit; default) | 'autonomy' (a HITL-policy/hitl-level proposal).
  kind?: string;
  // A7: the typed AutonomyAction for autonomy rows (null for instruction rows).
  actionPayload?: unknown;
  // Phase 5: Trigger type that produced this suggestion. Used by the
  // suggestion applier to refuse auto-apply of suggestions originating
  // from flagged_feedback — those must always go through explicit human
  // review because a single post-hoc rejection is not a density-stable
  // signal. NULL for legacy rows; treated as "unknown" by the applier.
  triggeredBy?: ReflectionTriggerType | null;
  // Learning loop fields
  appliedAt?: Date;
  appliedBy?: string;
  effectiveMeasure?: 'improved' | 'no_change' | 'degraded';
  feedback?: string;
}

// Evidence reference for learning loop
export interface EvidenceRef {
  type: string;
  id: string;
  timestamp?: Date;
}

// Per Section 16: Reflection quotas
export interface ReflectionQuota {
  tenantId: string;

  // Per Section 16: Max reflection runs per day per tenant
  dailyRunsLimit: number;
  dailyRunsUsed: number;
  dailyRunsRemaining: number;

  // Per Section 16: Max reflection runs per agent per week
  weeklyAgentRunsLimit: number;
  weeklyAgentRunsUsed: number;
  weeklyAgentRunsRemaining: number;

  // Per Section 16: Max concurrent reflection jobs
  maxConcurrentJobs: number;
  currentConcurrentJobs: number;
  concurrentJobsRemaining: number;
}

// Per Section 16: Reflection reads these inputs
export interface ReflectionContext {
  instructionVersion: number;
  workflowSummaries: any[];
  taskOutcomes: any[];
  escalationHistory: any[];
  undoHistory: any[];
  humanFeedback: any[];
  policyDenials: any[];
  // Phase 8C: Performance and audit data for richer reflection
  performanceSnapshot?: any;
  auditErrorPatterns?: any[];
  // Phase 5: Trigger information flows into the context so the reflection
  // prompt can focus the LLM on the signal that fired the run. triggerType
  // distinguishes scheduled vs reactive triggers, and triggerMetadata may
  // carry e.g. the specific feedbackId that fired a flagged_feedback run.
  triggerType?: ReflectionTriggerType;
  triggerMetadata?: Record<string, unknown>;
  // Phase 5: Dedicated surface for late-rejection feedback rows, populated
  // when the trigger is 'flagged_feedback'. When the specific triggering
  // feedbackId is known, that row is placed first so the LLM can anchor on
  // it instead of guessing from the shared humanFeedback array.
  flaggedFeedback?: any[];
  // Skills flywheel: injected skills that were active during the evaluated tasks.
  // Populated by the reflection service before the LLM call. When present, the
  // reflection prompt asks the LLM to rate each skill (helped/neutral/harmed)
  // and emit refinement suggestions.
  injectedSkills?: Array<{
    id: string;
    name: string;
    description: string;
    instruction: string;
    /** Autonomous-surface usefulness (agent_skills.usefulness_score). */
    usefulnessScore: number;
    /** Settled runs behind that score. The rewrite gate needs it: a score of
     *  -1 from two runs is noise, not a persistent misfire. Migration 347. */
    observationCount: number;
  }>;
}

// Evidence counts for density calculation
export interface EvidenceCounts {
  failures: number;
  humanCorrections: number;
  escalations: number;
  successfulRuns: number;
}
