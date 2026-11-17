// Agent Performance-Understanding Harness — shared reconstruction contract.
//
// One canonical run shape feeds ALL evaluation. Tenant-runtime already emits
// `CanonicalTrajectory` (src/trajectories) — we REUSE it verbatim as the
// normalized shape. The workforce-service and platform-backend runtimes do not
// sink trajectories, so their adapters MAP their native run tables into this
// same `CanonicalTrajectory` shape (see src/diagnostics/adapters/*).
//
// The engine-invariant auditors need MORE than the message/tool shape — they
// read the raw engine tables (run-state / session JSONL / delegation /
// provisioning events). Those live on `RawEngineEvidence`, attached alongside
// the canonical trajectory on a `ReconstructedRun`.

import type { CanonicalTrajectory } from '../../trajectories/types';
import type { FailureClass } from '../../invocations/types';

export type { CanonicalTrajectory, CanonicalMessage, CanonicalContentBlock } from '../../trajectories/types';

/** The exactly-four agents this harness covers — no starting subset. */
export type AgentKind = 'user-created' | 'caio' | 'hrbp' | 'insights';

/** Which native runtime produced a run. Drives adapter + invariant selection. */
export type Runtime = 'tenant-runtime' | 'workforce-service' | 'platform-backend';

export const RUNTIME_FOR_AGENT: Record<AgentKind, Runtime> = {
  'user-created': 'tenant-runtime',
  caio: 'workforce-service',
  hrbp: 'workforce-service',
  insights: 'platform-backend',
};

/** Stable identifier a caller hands an adapter to reconstruct ONE run.
 *  The `key` semantics differ per the Scope table:
 *    - user-created → invocation_id
 *    - caio / insights → thread_id
 *    - hrbp → run_id
 */
export interface RunRef {
  agentKind: AgentKind;
  tenantId: string;
  /** The agent's identity within its runtime (internal_agents UUID for the
   *  three system agents; the compiled-instruction agent_id for user-created). */
  agentId: string;
  /** Reconstruction key — invocation_id | thread_id | run_id per agentKind. */
  key: string;
}

/** Raw engine tables the invariant auditors read beyond the canonical shape.
 *  Every field is optional: an adapter populates only what its runtime has.
 *  The auditors guard on presence and skip checks whose evidence is absent
 *  (a missing table is a coverage gap, not a violation). */
export interface RawEngineEvidence {
  /** tenant-runtime: invocations row (outcome/tokens/cost/tool_calls/timing). */
  invocation?: InvocationRow;
  /** tenant-runtime: agent_run_states.state (typed AgentRunItem[] document). */
  runState?: { schemaVersion: string; state: unknown };
  /** tenant-runtime: live pause/resume rows (agent_scheduled_invocations
   *  carrying a HybridResumeState workflow_resume_payload). */
  livePauses?: PausedRunRow[];
  /** tenant-runtime: child invocations spawned by delegation. */
  childInvocations?: InvocationRow[];
  /** All runtimes: audit_logs / agent_audit_logs rows for this run. */
  auditLogs?: AuditRow[];
  /** workforce HRBP: hrbp_provisioning_runs + events + compensation rows. */
  hrbp?: HrbpEvidence;
  /** platform-backend insights / workforce CAIO: terminal loop metadata
   *  reconstructed from the messages + usage log (no run-state table). */
  loopMeta?: LoopMeta;
  /** Insights/CAIO render results as visualization blocks; this is the count
   *  observed across assistant messages. Drives the tool-conformance
   *  "expected outputs present" check (the canonical message shape can't carry
   *  visualization blocks). */
  visualizationBlockCount?: number;
}

export interface InvocationRow {
  id: string;
  tenantId: string;
  agentId: string;
  parentInvocationId: string | null;
  triggeredBy: string;
  outcome: 'success' | 'error' | 'escalated' | null;
  /** Granular failure taxonomy (migration 308) for outcome='error' runs; null otherwise.
   *  Grounds the RCA agent's root-cause analysis (transient_infra vs agent_declined vs
   *  stalled vs tool_error … change what the LLM should even bother diagnosing). */
  failureClass: FailureClass | null;
  errorMessage: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  toolCalls: Array<{ id?: string; name?: string; input?: unknown; output?: unknown; error?: string }>;
  startedAt: string;
  completedAt: string | null;
}

export interface PausedRunRow {
  /** scheduled_by_invocation_id — the invocation that paused. */
  invocationId: string;
  /** workflow_resume_payload->>'pauseReason' (hitl_approval / ask_user / delay…). */
  pauseReason: string;
  /** workflow_resume_payload->'hitlContext'->>'approvalId', when a HITL pause. */
  approvalId: string | null;
  /** agent_scheduled_invocations.status (pending / fired / cancelled / errored). */
  status: string;
  /** fired_at — null while still pending. */
  firedAt: string | null;
  createdAt: string;
  /** fires_at — the resume/expiry fire deadline. Past-deadline + still pending
   *  is the structural signature of a lost resume. */
  expiresAt: string;
}

export interface AuditRow {
  id: string;
  action: string;
  outcome: 'success' | 'error' | 'gated';
  errorCode: string | null;
  /** Already sanitized at insert time (credentials/PII redacted). */
  inputArgs: unknown;
  triggeredBy: string;
  createdAt: string;
}

export interface HrbpEvidence {
  run: { id: string; planId: string; status: string; specCount: number };
  events: Array<{
    specId: string;
    step: string;
    status: string;
    internalAgentId: string | null;
    idempotencyKey: string | null;
    errorMessage: string | null;
    createdAt: string;
  }>;
  compensations: Array<{ specId: string; action: string; status: string; errorMessage: string | null }>;
}

/** Loop-level facts the simple `runPlatformAgent` invariants need but that the
 *  message shape alone can't express (the terminator + budget high-water). */
export interface LoopMeta {
  iterations: number;
  maxIterations: number;
  cumulativeInputTokens: number;
  cumulativeOutputTokens: number;
  maxCumulativeTokens?: number;
  /** Mirrors PlatformAgentExecutionResult.terminator. */
  terminator?: 'normal' | 'error' | 'token_budget' | 'max_iterations' | 'tool_blocker' | string;
}

/** What an adapter returns for a single run: the canonical shape every
 *  metric/judge consumes + the raw engine evidence the invariants need. */
export interface ReconstructedRun {
  ref: RunRef;
  runtime: Runtime;
  trajectory: CanonicalTrajectory;
  raw: RawEngineEvidence;
  /** The agent's spec text (role/responsibilities/system prompt) used by the
   *  conformance judge. Loaded by the adapter from the spec source per the
   *  Scope table. */
  spec: AgentSpec;
}

export interface AgentSpec {
  agentKind: AgentKind;
  /** Free-text spec the conformance judge reasons against. */
  text: string;
  /** Structured fields when the runtime exposes them. */
  role?: string;
  responsibilities?: string;
  additionalContext?: string;
}

/** Every adapter implements this. The driver layer is adapter-agnostic. */
export interface RuntimeAdapter {
  runtime: Runtime;
  /** Reconstruct ONE run into the canonical shape + raw evidence. Returns null
   *  when the run can't be found / reconstructed (logged by caller). */
  reconstruct(ref: RunRef): Promise<ReconstructedRun | null>;
  /** List recent REAL run refs for an agent, newest first, for passive eval.
   *  Zero side effects. */
  listRecent(opts: { tenantId: string; agentId: string; agentKind: AgentKind; limit: number; sinceIso?: string }): Promise<RunRef[]>;
  /** Discover the tenant's ACTIVE agents (by run volume) from the run source of
   *  truth, so the harvest evaluates ALL of them rather than a single configured
   *  id. Optional — only the tenant-runtime (user-created) adapter implements it;
   *  the system agents are single fixed ids. Zero side effects. */
  listActiveAgents?(opts: { tenantId: string; limit: number; sinceIso?: string }): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// Findings — the deterministic gating currency. Every invariant auditor and
// the tool-conformance auditor emit `Finding`s. MAST/TRAIL taxonomy on
// `failureMode` (see Fixed decisions: "MAST + TRAIL failure taxonomy").
// ---------------------------------------------------------------------------

export type Severity = 'info' | 'warn' | 'error' | 'critical';

/** Per-runtime engine stage a finding attributes to. Used by RCA + clustering. */
export type Stage =
  | 'input'
  | 'planning'
  | 'tool-selection'
  | 'tool-execution'
  | 'oversight-gate'
  | 'delegation'
  | 'session-persistence'
  | 'resume'
  | 'termination'
  | 'output'
  | 'engine';

export interface Finding {
  /** Stable invariant id, e.g. 'hybrid.toolcall_result_integrity'. */
  invariant: string;
  severity: Severity;
  /** Which engine component the violation lives in. */
  component: Stage;
  /** Human-readable description of what broke. */
  message: string;
  /** Concrete evidence (ids, counts, offending values) for the audit trail. */
  evidence: Record<string, unknown>;
  /** MAST/TRAIL failure-mode label for cross-run clustering. */
  failureMode?: string;
}

/** Whether a set of findings should BLOCK (dev) / ROLLBACK (prod). Only
 *  deterministic error/critical findings gate; semantic judge output never
 *  reaches this function (it's alert-only). */
export function isGatingFailure(findings: Finding[]): boolean {
  return findings.some((f) => f.severity === 'error' || f.severity === 'critical');
}
