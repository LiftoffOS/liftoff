// Collab-session emitter — two-phase, fail-safe, latency-bounded.
//
// Phase A (captureCollabSession) is synchronous and copies every piece of
// mutable execution state (recorder messages, tool-call results, and — when
// enabled — deliverable file contents) into an immutable payload. It MUST run
// before the trajectory recorder buffer is released.
//
// Phase B (persistCollabSession) operates only on that payload. It never
// touches live execution state, runs under a CancelState so a budget timeout
// destroys any in-flight I/O, and reads the invocation on a bounded pool with a
// server-side statement_timeout. One create-only NDJSON object per session.

import { Storage } from '@google-cloud/storage';
import type { CanonicalTrajectory, CanonicalMessage } from '../trajectories/types';
import { buildCanonical } from '../trajectories/canonical-builder';
import { createBoundedPool } from '../infrastructure/database';
import { invocationsService } from '../invocations/service';
import type { InvocationOutcome } from '../invocations/types';
import { logger } from '../infrastructure/logging';
import { captureArtifacts, type CapturedArtifact } from './artifacts';
import { sinkCollabSessions } from './sink';
import type { ExecutionState, TerminalState } from '../agent-execution/types';

// v3 adds `terminal_state`. See CollabSessionRow.terminal_state — the
// four-value outcome projection cannot separate a governance refusal from a
// routine approval wait, and the export carried no other column that could.
export const COLLAB_SESSION_SCHEMA_VERSION = 3;

const GCS_IDLE_DEADLINE_MS = 2_000;

/** Sanitize a timestamp for use inside a GCS object key (drop ':' and '.'). */
export function sinkKeyGuard(ts: string): string {
  return ts.replace(/[:.]/g, '-');
}

// Mirrors invocations.outcome, 'gated' included (migration 329): a run the
// governance gate stopped is neither a success nor a plain error, and
// collapsing it into one of those is what previously made a stopped gate
// invisible to every downstream query.
type SessionOutcome = InvocationOutcome;

/** A handle Phase B can destroy on abort (pg/GCS streams both satisfy this). */
export interface Destroyable {
  destroy(_err?: Error): void;
}

export interface CancelState {
  aborted: boolean;
  inflight: Set<Destroyable>;
}

export interface CollabSessionRow {
  session_id: string;
  tenant_id: string;
  agent_id: string;
  human_id: string | null;
  thread_id: string | null;
  triggered_by: 'human' | 'agent' | 'cron' | 'event';
  task_ref: string | null;
  provider: string;
  model: string | null;
  outcome: SessionOutcome;
  /** The terminal state this run actually reached, carried ALONGSIDE the outcome
   *  rather than instead of it.
   *
   *  `outcome` is a four-value projection of eight terminal states, and two of
   *  those states collapse onto 'gated': a run governance STOPPED, and a run
   *  PAUSED waiting for a person — which will resume. Grading treats those as
   *  opposite things (one is a refusal, the other is the platform behaving as
   *  configured), and nothing else on this row could tell them apart, so any
   *  consumer reading `outcome === 'gated'` was reading two populations at once.
   *
   *  NULL only on backfilled rows: the backfill reads `invocations`, which
   *  records the projection and not the state behind it. A null here means "not
   *  recorded", never "no terminal state". */
  terminal_state: TerminalState | null;
  failure_class: string | null;
  started_at: string;
  completed_at: string;
  duration_ms: number;
  cost_usd: number | null;
  input_tokens: number;
  output_tokens: number;
  tool_call_count: number;
  n_user_messages: number | null;
  n_assistant_messages: number | null;
  n_tool_errors: number | null;
  n_distinct_tools: number | null;
  first_human_msg_idx: number | null;
  human_msg_spread: number | null;
  n_hitl_requests: number | null;
  n_hitl_approved: number | null;
  n_hitl_rejected: number | null;
  trajectory_gcs_uri: string | null;
  artifact_uris: string[] | null;
  emitted_at: string;
  source: 'live' | 'backfill';
  schema_version: number;
}

/** Immutable Phase-A capture. Holds no reference to live execution state. */
export interface CapturedSession {
  invocationId: string;
  tenantId: string;
  agentId: string;
  humanId: string | null;
  outcome: SessionOutcome;
  terminalState: TerminalState;
  toolCallCount: number;
  nToolErrors: number;
  // Message-derived features are null when the recorder buffer was unavailable.
  nUserMessages: number | null;
  nAssistantMessages: number | null;
  nDistinctTools: number | null;
  firstHumanMsgIdx: number | null;
  humanMsgSpread: number | null;
  artifacts: CapturedArtifact[] | null;
}

// ── Phase A ────────────────────────────────────────────────────────────────

/** A human message is the prepended objective (index 0) plus any user-role
 *  message carrying text and no tool_result block (tool results ride user-role
 *  messages in the canonical). */
function isHumanMessage(m: CanonicalMessage, index: number): boolean {
  if (index === 0) return true; // prepended objective
  if (m.role !== 'user') return false;
  const hasText = m.content.some((b) => b.type === 'text');
  const hasToolResult = m.content.some((b) => b.type === 'tool_result');
  return hasText && !hasToolResult;
}

function populationStdDev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / values.length;
  return Math.sqrt(variance);
}

export function messageFeatures(traj: CanonicalTrajectory): {
  nUser: number; nAssistant: number; nDistinctTools: number;
  firstHumanIdx: number | null; spread: number | null;
} {
  const msgs = traj.messages;
  const n = msgs.length;
  const humanIdx: number[] = [];
  let nAssistant = 0;
  const toolNames = new Set<string>();
  msgs.forEach((m, i) => {
    if (m.role === 'assistant') nAssistant++;
    if (isHumanMessage(m, i)) humanIdx.push(i);
    for (const b of m.content) {
      if (b.type === 'tool_use') toolNames.add(b.name);
    }
  });
  const positions = n > 1 ? humanIdx.map((i) => i / (n - 1)) : humanIdx.map(() => 0);
  return {
    nUser: humanIdx.length,
    nAssistant,
    nDistinctTools: toolNames.size,
    firstHumanIdx: humanIdx.length > 0 ? humanIdx[0] : null,
    spread: humanIdx.length > 0 ? populationStdDev(positions) : null,
  };
}

/** Synchronously snapshot all racy execution state (recorder buffer, tool
 *  results, context) into a plain object and stamp captureAt. MUST run with no
 *  await before the recorder read so the snapshot is atomic w.r.t. the buffer
 *  release. Artifact contents are attached asynchronously afterwards. */
function snapshotSync(
  state: ExecutionState,
  invocationId: string,
  outcome: SessionOutcome,
  terminalState: TerminalState,
): { session: CapturedSession; sessionStateDir: string | undefined; startedAtMs: number; captureAtMs: number } {
  const ctx = state.context;
  const captureAtMs = Date.now();
  const toolCallCount = state.completedToolCalls.length;
  const nToolErrors = state.completedToolCalls.filter((t) => !t.success).length;

  let features: ReturnType<typeof messageFeatures> | null = null;
  if (state.trajectoryContext) {
    const traj = buildCanonical({
      invocationId,
      systemPrompt: state.trajectoryContext.systemPrompt,
      objective: state.trajectoryContext.objective,
      toolDefs: state.trajectoryContext.toolDefs,
      meta: { tenantId: ctx.tenantId, agentId: ctx.agentId, completed: outcome === 'success', outcome },
    });
    if (traj) features = messageFeatures(traj);
  }

  return {
    session: {
      invocationId,
      tenantId: ctx.tenantId,
      agentId: ctx.agentId,
      humanId: ctx.triggeredByUserId ?? null,
      outcome,
      terminalState,
      toolCallCount,
      nToolErrors,
      nUserMessages: features ? features.nUser : null,
      nAssistantMessages: features ? features.nAssistant : null,
      nDistinctTools: features ? features.nDistinctTools : null,
      firstHumanMsgIdx: features ? features.firstHumanIdx : null,
      humanMsgSpread: features ? features.spread : null,
      artifacts: null,
    },
    sessionStateDir: ctx.sessionStateDir,
    startedAtMs: state.startTime.getTime(),
    captureAtMs,
  };
}

export async function captureCollabSession(
  state: ExecutionState,
  invocationId: string,
  outcome: SessionOutcome,
  terminalState: TerminalState,
): Promise<CapturedSession | null> {
  try {
    // Synchronous, atomic snapshot of racy state (no await before this returns).
    const snap = snapshotSync(state, invocationId, outcome, terminalState);
    // Async, non-blocking artifact read — awaited before execution continues, so
    // still an immutable snapshot (mtime bounded by the sync-stamped captureAt).
    if (process.env.COLLAB_ARTIFACT_SNAPSHOT_ENABLED === 'true') {
      snap.session.artifacts = await captureArtifacts(snap.sessionStateDir, snap.startedAtMs, snap.captureAtMs);
    }
    return snap.session;
  } catch (err) {
    logger.warn({ invocationId, err: (err as Error).message }, 'collab capture failed');
    return null;
  }
}

// ── Phase B ────────────────────────────────────────────────────────────────

let emitterPool: ReturnType<typeof createBoundedPool> | null = null;
function getEmitterPool(): ReturnType<typeof createBoundedPool> {
  if (!emitterPool) emitterPool = createBoundedPool({ max: 2, statementTimeoutMs: 1500 });
  return emitterPool;
}

function bucketName(): string {
  return `trajectories-${process.env.ENVIRONMENT ?? 'dev'}`;
}

/** Create-only stream write of one object; 412 (exists) resolves as success.
 *  Registered in cancel.inflight so a budget timeout destroys it. */
function writeObject(objectPath: string, payload: string | Buffer, contentType: string, cancel: CancelState): Promise<void> {
  const file = new Storage().bucket(bucketName()).file(objectPath);
  return new Promise<void>((resolve, reject) => {
    const stream = file.createWriteStream({ resumable: false, contentType, preconditionOpts: { ifGenerationMatch: 0 } });
    const idle = setTimeout(() => stream.destroy(new Error('gcs_write_idle_timeout')), GCS_IDLE_DEADLINE_MS);
    cancel.inflight.add(stream);
    const done = (err?: Error) => {
      clearTimeout(idle);
      cancel.inflight.delete(stream);
      if (err && (err as { code?: number }).code === 412) return resolve();
      if (err) return reject(err);
      resolve();
    };
    stream.on('error', done);
    stream.on('finish', () => done());
    stream.end(payload);
  });
}

/** Upload captured artifacts, then a manifest listing only successful uploads.
 *  Manifest is written LAST. Returns the object URIs (files only). */
async function uploadArtifacts(
  tenantId: string,
  invocationId: string,
  artifacts: CapturedArtifact[],
  cancel: CancelState,
): Promise<string[]> {
  const prefix = `${tenantId}/artifacts/${invocationId}`;
  const uploaded: Array<{ path: string; bytes: number; contentType: string; redacted: boolean }> = [];
  for (const a of artifacts) {
    if (cancel.aborted) break;
    const objectPath = `${prefix}/${a.relpath}`;
    try {
      await writeObject(objectPath, a.content, a.contentType, cancel);
      uploaded.push({ path: a.relpath, bytes: a.bytes, contentType: a.contentType, redacted: a.redacted });
    } catch (err) {
      logger.debug({ invocationId, relpath: a.relpath, err: (err as Error).message }, 'artifact upload failed');
    }
  }
  if (cancel.aborted || uploaded.length === 0) return uploaded.map((u) => `gs://${bucketName()}/${prefix}/${u.path}`);
  const manifest = JSON.stringify({ files: uploaded.map((u) => ({ path: u.path, bytes: u.bytes, contentType: u.contentType, redacted: u.redacted })) });
  try {
    await writeObject(`${prefix}/manifest.json`, manifest, 'application/json', cancel);
  } catch (err) {
    logger.debug({ invocationId, err: (err as Error).message }, 'artifact manifest write failed');
  }
  return uploaded.map((u) => `gs://${bucketName()}/${prefix}/${u.path}`);
}

export async function persistCollabSession(payload: CapturedSession, cancel: CancelState): Promise<void> {
  if (cancel.aborted) return;
  const inv = await invocationsService.getInvocationVia(getEmitterPool(), payload.invocationId, payload.tenantId);
  if (!inv) return;
  if (cancel.aborted) return;

  // Cost is null whenever the token component is unknown; grounding never stands
  // in for the total. mapInvocation already excludes grounding from costUsd.
  const costUsd = inv.costUsd === null ? null : inv.costUsd + inv.groundingCostUsd;

  let artifactUris: string[] | null = null;
  if (payload.artifacts && payload.artifacts.length > 0 && !cancel.aborted) {
    artifactUris = await uploadArtifacts(payload.tenantId, payload.invocationId, payload.artifacts, cancel);
  }
  if (cancel.aborted) return;

  const startedAt = inv.startedAt.toISOString();
  const completedAt = (inv.completedAt ?? inv.startedAt).toISOString();
  const emittedAt = new Date().toISOString();
  const row: CollabSessionRow = {
    session_id: payload.invocationId,
    tenant_id: payload.tenantId,
    agent_id: payload.agentId,
    human_id: payload.humanId,
    thread_id: inv.threadId,
    triggered_by: inv.triggeredBy,
    task_ref: inv.triggeredByLabel ?? inv.triggerRef ?? null,
    provider: inv.provider,
    model: inv.modelId,
    outcome: payload.outcome,
    terminal_state: payload.terminalState,
    failure_class: inv.failureClass,
    started_at: startedAt,
    completed_at: completedAt,
    duration_ms: Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime()),
    cost_usd: costUsd,
    input_tokens: inv.inputTokens,
    output_tokens: inv.outputTokens,
    tool_call_count: payload.toolCallCount,
    n_user_messages: payload.nUserMessages,
    n_assistant_messages: payload.nAssistantMessages,
    n_tool_errors: payload.nToolErrors,
    n_distinct_tools: payload.nDistinctTools,
    first_human_msg_idx: payload.firstHumanMsgIdx,
    human_msg_spread: payload.humanMsgSpread,
    // Live rows never carry HITL counts; only backfill correlates them.
    n_hitl_requests: null,
    n_hitl_approved: null,
    n_hitl_rejected: null,
    trajectory_gcs_uri: null,
    artifact_uris: artifactUris,
    emitted_at: emittedAt,
    source: 'live',
    schema_version: COLLAB_SESSION_SCHEMA_VERSION,
  };
  await sinkCollabSessions([row], liveObjectKey(payload.invocationId, emittedAt), cancel);
}

/** The GCS object key for ONE live emit of a session.
 *
 *  The key used to be `live/<invocationId>` — deterministic — and the sink writes
 *  create-only (`ifGenerationMatch: 0`) and resolves the resulting 412 as
 *  SUCCESS. That combination is correct for a retry of the same emit and wrong
 *  for a second, later one: a run that pauses for a person emits at the pause,
 *  and the terminal emit after it resumed hit the existing object and was
 *  discarded in silence. The session was frozen at the moment before the person
 *  acted, and nothing anywhere recorded that a write had been dropped.
 *
 *  `emitted_at` makes the key monotonic, so a session can legitimately write more
 *  than once. Multiple rows per session are already handled on READ: both
 *  runCollabExport and listUngradedSessions dedupe per session_id, preferring
 *  live over backfill and then the later emitted_at. The create-only 412
 *  idempotency still holds for a true retry within the same millisecond, and a
 *  retry that lands in a later one costs one extra row that the dedupe collapses. */
export function liveObjectKey(invocationId: string, emittedAt: string): string {
  return `live/${invocationId}/${sinkKeyGuard(emittedAt)}`;
}
