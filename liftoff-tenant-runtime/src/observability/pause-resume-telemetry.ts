// Durable pause/resume telemetry. Single choke point for the
// pause/resume metric family so every emit site uses the SAME closed label
// vocabularies, keeps correlation ids in the structured log rather than
// on metric labels, and honors the first-classifier-emits ownership rule
// so a failure classified at a durable boundary is not re-counted by outer layers.
//
// Metric semantics:
// agent_pause_total / agent_resume_total — one inc per GENUINE attempt, tagged
// with the terminal outcome; the count is the attempts denominator. Pre-condition
// no-ops (still-pending approval, already-fired row, duplicate-claim loss,
// normal expiry, human rejection) do NOT increment these — they never make an
// engine look worse.
// agent_pause_resume_failure_total — the classified point of failure
// (terminal or degraded).
// agent_resume_fallback_total — a certified structured→snapshot fallback.
// agent_resume_duration_ms — once per claimed resume (signal→terminal).

import {
  agent_pause_total,
  agent_resume_total,
  agent_pause_resume_failure_total,
  agent_resume_fallback_total,
  agent_resume_duration_ms,
} from './runtime-extensions-metrics';
import { logger } from '../infrastructure/logging';
import type { ExecutionEngineId } from '../agent-execution/adapter/types';

// ── Closed label vocabularies ───────────────────────────────────────
export type PauseResumeOperation = 'pause' | 'resume';
export type PauseKind = 'delay' | 'ask_user' | 'hitl_approval' | 'delegation' | 'self_wake' | 'continuation';

export type PauseResumeFailureStage =
  // Pause-side
  | 'state_serialization'
  | 'state_persistence'
  | 'recovery_arming'
  | 'waiting_status_transition'
  // Resume-side
  | 'resume_enqueue'
  | 'state_lookup'
  | 'state_validation'
  | 'atomic_claim'
  | 'execution_reconstruction'
  | 'artifact_restore'
  | 'adapter_reentry'
  | 'continuation'
  | 'result_delivery';

export type PauseResumeFailureClass =
  | 'database'
  | 'queue'
  | 'missing_state'
  | 'malformed_state'
  | 'unsupported_state_version'
  | 'engine_mismatch'
  | 'artifact_incompatible'
  | 'artifact_missing'
  | 'unsupported_artifact_version'
  | 'approval_missing'
  | 'agent_unavailable'
  /** The engine the paused half ran on cannot be constructed on this
   *  deployment. The resume does not cross onto another engine: the row is
   *  released back to pending and the attempt is counted here. */
  | 'engine_unavailable'
  | 'instruction_unavailable'
  | 'adapter_error'
  | 'timeout'
  | 'state_transition'
  | 'unknown';

export type PauseResumeFailureImpact = 'degraded' | 'terminal';

export type ResumeStrategy = 'structured_session' | 'snapshot_replay' | 'workflow_cursor' | 'delegation_fanin';

/** Why a certified structured→snapshot fallback happened. Closed vocabulary —
 *  this rides a metric label, so it must never be an arbitrary string. */
export type ResumeFallbackReason =
  | 'engine_mismatch'
  | 'structured_resume_error'
  | 'artifact_incompatible'
  | 'artifact_missing'
  | 'unsupported_artifact_version';

export type PauseOutcome = 'succeeded' | 'failed';
export type ResumeOutcome = 'succeeded' | 'failed' | 'degraded';

/** Correlation identifiers for the structured LOG only — NEVER metric labels. */
export interface PauseResumeCorrelation {
  tenantId?: string;
  agentId?: string;
  invocationId?: string;
  scheduledInvocationId?: string;
  approvalId?: string;
  upstreamSessionId?: string;
}

// ── Attempt/outcome denominators ─────────────────────────────────────────────
/** One inc per genuine pause attempt, tagged with the terminal outcome. */
export function recordPauseResult(engine: ExecutionEngineId, pauseKind: PauseKind, outcome: PauseOutcome): void {
  agent_pause_total.inc({ execution_engine: engine, pause_kind: pauseKind, outcome });
}

/** One inc per genuine resume attempt, tagged with the terminal outcome (and the
 * winning strategy when a fallback was used). */
export function recordResumeResult(
  engine: ExecutionEngineId,
  pauseKind: PauseKind,
  outcome: ResumeOutcome,
  strategy?: ResumeStrategy,
): void {
  agent_resume_total.inc({
    execution_engine: engine,
    pause_kind: pauseKind,
    outcome,
    ...(strategy ? { resume_strategy: strategy } : {}),
  });
}

/** Once per claimed resume: elapsed ms from receipt of the resume signal to the
 * terminal resume result. */
export function recordResumeDurationMs(engine: ExecutionEngineId, pauseKind: PauseKind, ms: number): void {
  agent_resume_duration_ms.observe(ms, { execution_engine: engine, pause_kind: pauseKind });
}

// ── Classified failure + fallback ────────────────────────────────────────────
/** Record a classified pause/resume FAILURE at the point it is first classified.
 * Bounded labels go on the metric; correlation ids + exception text go on the
 * log. First-classifier-emits: outer layers add correlation logs, they do NOT
 * call this again for the same failure. */
export function recordPauseResumeFailure(args: {
  engine: ExecutionEngineId;
  operation: PauseResumeOperation;
  pauseKind: PauseKind;
  stage: PauseResumeFailureStage;
  failureClass: PauseResumeFailureClass;
  impact: PauseResumeFailureImpact;
  correlation?: PauseResumeCorrelation;
  error?: unknown;
}): void {
  agent_pause_resume_failure_total.inc({
    execution_engine: args.engine,
    operation: args.operation,
    pause_kind: args.pauseKind,
    stage: args.stage,
    failure_class: args.failureClass,
    impact: args.impact,
  });
  logger.warn(
    {
      event: 'pause_resume_failure',
      operation: args.operation,
      pause_kind: args.pauseKind,
      stage: args.stage,
      failure_class: args.failureClass,
      impact: args.impact,
      execution_engine: args.engine,
      ...(args.correlation ?? {}),
      err: args.error instanceof Error ? args.error.message : args.error !== undefined ? String(args.error) : undefined,
    },
    'durable pause/resume failure',
  );
}

/** Count a certified structured→snapshot fallback DECISION. This records only
 *  that a fallback was chosen and why — it does NOT assert the resume then
 *  succeeded. The eventual resume outcome (degraded on a recovered fallback) is
 *  carried by recordResumeResult at the resume boundary, which is the single
 *  source of truth for success. */
export function recordResumeFallback(args: {
  engine: ExecutionEngineId;
  pauseKind: PauseKind;
  fromStrategy: ResumeStrategy;
  toStrategy: ResumeStrategy;
  reason: ResumeFallbackReason;
}): void {
  agent_resume_fallback_total.inc({
    execution_engine: args.engine,
    pause_kind: args.pauseKind,
    from_strategy: args.fromStrategy,
    to_strategy: args.toStrategy,
    reason: args.reason,
  });
}
