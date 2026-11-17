// Deterministic injection detection on the tenant-runtime side — DETECT +
// SURFACE posture for untrusted content (webhook triggers, tool results).
//
// Unlike the platform-backend chat path (which HARD-BLOCKS a trusted user), TR
// screens UNTRUSTED content: a Block does NOT drop the content — it emits an
// `injection_finding` (audit + metric; the trigger caller additionally raises
// an operator-inbox record where a full ExecutionContext exists). Nothing is
// auto-blocked and hitlLevel is NOT raised: the platform deliberately keeps
// agent autonomy operator-controlled (agent-execution/service.ts:600-604), so
// the value here is detection + operator visibility + audit, not enforcement.
//
// Per-tenant gated, shadow-first. Gating uses the TR entitlements client (TR is
// a CLIENT of the platform-backend entitlements source). A global env
// kill-switch forces off everywhere.

import { enforcePromptInput, extractScannableText, MAX_SCAN_CHARS, type InjectionDecision } from '@liftoffos/injection-detector';
import { isFeatureEnabled } from '../entitlements-client/service';
import { insertAuditLog } from '../audit';
import { logger } from '../infrastructure/logging';
import { ask } from '../typesafe/client';
import { isContentScreenEnabled } from '../typesafe/flags';
import { UNTRUSTED_CONTENT_HARMFUL_LABELS, UNTRUSTED_CONTENT_SET, type UntrustedContentLabel } from '../typesafe/questions';

export type InjectionMode = 'off' | 'shadow' | 'enforce';
export type InjectionPlacement = 'trigger' | 'tool_result';

export const INJECTION_DETECTION_FLAG = 'injection_detection';
export const INJECTION_DETECTION_ENFORCE_FLAG = 'injection_detection_enforce';

function killed(): boolean {
  return process.env.INJECTION_DETECTION_KILL === '1';
}

/** Resolve the per-tenant mode. Fails safe to 'off' on any flag-read error. */
export async function resolveInjectionMode(tenantId: string): Promise<InjectionMode> {
  if (killed()) return 'off';
  const on = await isFeatureEnabled(tenantId, INJECTION_DETECTION_FLAG).catch(() => false);
  if (!on) return 'off';
  const enforce = await isFeatureEnabled(tenantId, INJECTION_DETECTION_ENFORCE_FLAG).catch(() => false);
  return enforce ? 'enforce' : 'shadow';
}

// ── Metrics (bounded cardinality only) ────────────────────────────────────────
// TR emits metrics as structured log lines that Cloud Monitoring turns into
// log-based metrics — the same mechanism as observability/runtime-extensions-
// metrics.ts (NOT prom-client). Labels are bounded: `placement` and `verdict`
// are closed sets, and `detector` — present only on the semantic pass's own
// counters — takes one value.
function emitMetric(
  metricName: string,
  kind: 'counter' | 'histogram',
  value: number,
  labels: Record<string, string | number>,
): void {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(labels)) {
    if (v !== undefined && v !== null && v !== '') clean[k] = String(v);
  }
  logger.info({ metric_name: metricName, metric_kind: kind, metric_value: value, ...clean });
}

/** Max characters of the flagged content captured for calibration. */
const SHADOW_SAMPLE_MAX_CHARS = 2000;

/**
 * Restricted shadow-sample store. On a would-block in SHADOW mode, capture the
 * flagged CONTENT (bounded) so operators can review what the detector flagged
 * and finalize thresholds. SEPARATE from the PII-safe audit (which is hash-only):
 * this emits a distinctly-marked structured log line (`injection_shadow_sample`)
 * intended for a restricted, short-retention log sink (operator-only IAM =
 * restricted; log-bucket retention = TTL). Only fires in shadow, so no flagged
 * content is ever captured once a placement enforces.
 */
function captureShadowSample(
  placement: InjectionPlacement,
  tenantId: string,
  text: string,
  decision: InjectionDecision,
): void {
  logger.warn({
    injection_shadow_sample: true,
    tenant_id: tenantId,
    placement,
    verdict: decision.verdict,
    reason_codes: decision.reasons.map((r) => r.code).join(','),
    prompt_hash: decision.hash,
    sample: text.slice(0, SHADOW_SAMPLE_MAX_CHARS),
  });
}

export interface UntrustedScreenCtx {
  tenantId: string;
  /** Optional: some framed sources (e.g. vendor-MCP results in the bridge) do
   *  not carry an agentId. Gating only needs tenantId; agentId is an audit label. */
  agentId?: string;
  invocationId?: string;
  triggeredBy?: string;
}

export interface UntrustedScreenResult {
  /** True when the (enforce or shadow) verdict was `block` — a finding was raised. */
  finding: boolean;
  /**
   * The SEMANTIC pass, IN FLIGHT. Resolves true when it raised a finding.
   *
   * A promise rather than a boolean because no caller may wait for it. The
   * deterministic pass is regex over at most 20,000 characters with no I/O;
   * the semantic one is a vendor request with a three-second deadline, and
   * `agent-execution/service.ts` AWAITS this function on every
   * `untrusted_inbound` run before the run starts. Returning a resolved
   * boolean would have put those three seconds on the front of every webhook
   * run to compute a value no caller reads — detection is
   * visibility, and visibility never belongs on the critical path.
   *
   * Separate from `finding` for a different reason: `finding` is the
   * deterministic verdict, and the trigger caller branches on it to raise an
   * operator escalation. The semantic pass is the coverage the English-only
   * ruleset lacks, not a second vote on the same question, so it audits and
   * changes no caller's behaviour.
   *
   * Never rejects. Absent only when the mode is `off`, where nothing ran.
   */
  semanticScreen?: Promise<boolean>;
  mode: InjectionMode;
  decision: InjectionDecision;
}

const ALLOW: InjectionDecision = { verdict: 'allow', score: 0, reasons: [], hash: '', scannedChars: 0 };

// ── The semantic pass ─────────────────────────────────────────────────────
//
// The deterministic detector is an English-only ruleset and says so at the top
// of its own file: "non-English injection must be caught downstream". This is
// downstream. One pinned Jev Choice over the same text, on the same per-tenant
// gate, raising the same `injection_finding` row with `semantic` in its reason
// codes — and, like everything else in this file, never blocking and never
// raising hitlLevel.

/** Below this there is no room for a directive worth a request. A BOUND, not a
 *  calibration: it is here to stop a two-word tool result costing a vendor
 *  call, and nothing about the decision depends on where exactly it sits. */
export const SEMANTIC_MIN_CHARS = 200;

/** How many `(invocationId, hash)` pairs are remembered. A run re-observing an
 *  unchanged page, or re-reading the same record, is one screen; the cap keeps
 *  a long-lived process from remembering every run it ever served. */
const SEMANTIC_SEEN_CAP = 5_000;
const semanticSeen = new Set<string>();

/** Claim `(invocation, content)` for this screen, or null when another screen
 *  already holds it.
 *
 *  The claim is taken BEFORE the request, not after it: `frameUntrusted`'s hook
 *  and the browser loop both fire without waiting, so two screens of the same
 *  page can be in flight at once, and a claim taken on the way back would let
 *  both of them pay. Released again when the request produced no answer, so a
 *  vendor blip costs one skipped screen rather than silencing that content for
 *  the rest of the run. */
function claimScreen(invocationId: string | undefined, hash: string): (() => void) | null {
  // No invocation, no key. The screen then runs UNDEDUPLICATED rather than
  // collapsing unrelated calls under one `undefined` key, which would silence
  // every screen after the first for every caller that has no invocation.
  if (!invocationId) return () => {};
  const key = `${invocationId}:${hash}`;
  if (semanticSeen.has(key)) return null;
  if (semanticSeen.size >= SEMANTIC_SEEN_CAP) {
    const oldest = semanticSeen.values().next();
    if (!oldest.done) semanticSeen.delete(oldest.value);
  }
  semanticSeen.add(key);
  return () => semanticSeen.delete(key);
}

/** Test seam: forget what has been screened. */
export function _resetSemanticDedupeForTesting(): void {
  semanticSeen.clear();
}

/** The answer shape this file reads off the Choice. */
interface ContentAnswer {
  choice?: string;
  probabilities?: Partial<Record<UntrustedContentLabel, number>>;
}

/** Whether the answer clears CONTENT_T, summed over the two harmful labels.
 *  Summed for the same reason the chat guard sums its two: content split
 *  between "do something else" and "send me your credentials" is neither
 *  label's plurality and is both. */
export function isSemanticFinding(answers: unknown): boolean {
  const p = (answers as Record<string, ContentAnswer> | undefined)?.content_kind?.probabilities ?? {};
  const harmful = UNTRUSTED_CONTENT_HARMFUL_LABELS.reduce((sum, label) => sum + (p[label] ?? 0), 0);
  return harmful >= (UNTRUSTED_CONTENT_SET.thresholds.CONTENT_T as number);
}

/**
 * The semantic pass, run after the deterministic one. Returns whether it
 * raised a finding; never throws, never blocks, never mutates the content.
 *
 * Skipped when the deterministic verdict was already `block` (that IS a
 * finding, and a second one says nothing new), below the size floor, under the
 * kill, and for a `(invocation, content)` pair already screened.
 */
async function semanticPass(
  placement: InjectionPlacement,
  text: string,
  ctx: UntrustedScreenCtx,
  mode: InjectionMode,
  decision: InjectionDecision,
): Promise<boolean> {
  if (!isContentScreenEnabled()) return false;
  if (decision.verdict === 'block') return false;
  if (text.length < SEMANTIC_MIN_CHARS) return false;
  const release = claimScreen(ctx.invocationId, decision.hash);
  if (!release) return false;

  // The detector's own cap, reused rather than a second number: whatever the
  // deterministic pass looked at is what the semantic pass looks at.
  const bounded = text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text;
  const answered = await ask(UNTRUSTED_CONTENT_SET, { content: bounded }, {
    deadlineMs: 3_000,
    attemptTimeoutMs: 2_000,
    maxRetries: 1,
    tenantId: ctx.tenantId,
    ...(ctx.agentId ? { runtimeAgentId: ctx.agentId } : {}),
    ...(ctx.invocationId ? { invocationId: ctx.invocationId } : {}),
  }).catch(() => null);
  // No answer is not an answer of "ordinary": the claim goes back so the next
  // sight of this content in this run is screened rather than skipped.
  if (!answered) { release(); return false; }
  if (!isSemanticFinding(answered.answers)) return false;

  emitMetric(mode === 'enforce' ? 'injection_finding_total' : 'injection_shadow_block_total', 'counter', 1, {
    placement, detector: 'semantic',
  });
  // The same row the deterministic finding writes, through the same function,
  // with `semantic` in its reason codes so the two are told apart by what they
  // say rather than by which call site wrote them.
  await auditFinding(placement, ctx, mode, {
    ...decision,
    reasons: [...decision.reasons, { code: 'semantic', message: 'The semantic screen read a directive in this content.' }],
    scannedChars: bounded.length,
  });
  return true;
}

/** Emit the PII-safe audit event for a raised finding. */
async function auditFinding(
  placement: InjectionPlacement,
  ctx: UntrustedScreenCtx,
  mode: InjectionMode,
  decision: InjectionDecision,
): Promise<void> {
  await insertAuditLog(null, ctx.tenantId, {
    internalAgentId: ctx.agentId,
    invocationId: ctx.invocationId,
    action: 'injection_finding',
    inputArgs: {
      placement,
      mode,
      shadow: mode !== 'enforce',
      verdict: decision.verdict,
      score: decision.score,
      reasonCodes: decision.reasons.map((r) => r.code).join(','),
      promptHash: decision.hash,
      scannedChars: decision.scannedChars,
    },
    outcome: 'success',
    triggeredBy: ctx.triggeredBy ?? (ctx.agentId ? `agent:${ctx.agentId}` : 'system:injection-detector'),
  }).catch((err) => logger.warn({ err: (err as Error).message }, 'injection finding audit failed (non-fatal)'));
}

/**
 * Screen an untrusted text blob (DETECT + SURFACE). Only a `block` verdict
 * raises a finding (audit + metric); `review`/`allow` are silent here to hold
 * noise down on high-volume untrusted content. Never blocks or mutates the
 * content — the caller still frames it through the existing untrusted wrapper.
 */
export async function screenUntrustedText(
  placement: InjectionPlacement,
  text: string,
  ctx: UntrustedScreenCtx,
): Promise<UntrustedScreenResult> {
  const mode = await resolveInjectionMode(ctx.tenantId);
  if (mode === 'off') return { finding: false, mode, decision: ALLOW };

  const started = Date.now();
  const decision = enforcePromptInput(text, {
    source: placement,
    tenantId: ctx.tenantId,
    agentId: ctx.agentId,
  });
  emitMetric('injection_detector_latency_ms', 'histogram', Date.now() - started, { placement });
  emitMetric('injection_verdict_total', 'counter', 1, { placement, verdict: decision.verdict });

  const isBlock = decision.verdict === 'block';
  if (isBlock) {
    if (mode === 'shadow') {
      emitMetric('injection_shadow_block_total', 'counter', 1, { placement });
      captureShadowSample(placement, ctx.tenantId, text, decision);
    } else {
      emitMetric('injection_finding_total', 'counter', 1, { placement });
    }
    await auditFinding(placement, ctx, mode, decision);
  }
  // The coverage the deterministic ruleset does not have. Inside here rather
  // than at each call site, so every caller that already reaches this function
  // gets it with no new plumbing — and STARTED rather than awaited, so the
  // deterministic verdict returns at the speed it always has.
  const semanticScreen = semanticPass(placement, text, ctx, mode, decision)
    .catch((err) => {
      logger.warn({ err: (err as Error).message }, 'semantic injection screen failed (non-fatal)');
      return false;
    });
  return { finding: isBlock, semanticScreen, mode, decision };
}

/** Screen a structured untrusted payload by extracting its string leaf values. */
export async function screenUntrustedStructured(
  placement: InjectionPlacement,
  value: unknown,
  ctx: UntrustedScreenCtx,
): Promise<UntrustedScreenResult> {
  return screenUntrustedText(placement, extractScannableText(value), ctx);
}
