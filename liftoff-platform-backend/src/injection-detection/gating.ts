// Per-tenant gating, screening, and PII-safe audit for the deterministic
// injection detector on the platform-backend side (chat pre-filter + MCP
// tool-definition scanning).
//
// PB is the entitlements / feature-flag SOURCE (not a client), so gating reads
// the feature-flags data directly via FeatureFlagService — deliberately NOT the
// TR-side entitlements client. Rollout is per-tenant and shadow-first:
//   off      — detector does not run
//   shadow   — detector runs; verdicts are audited; NOTHING is blocked/flagged
//   enforce  — chat Block short-circuits before the LLM guard; tool-def hits flag
// A global env kill-switch (INJECTION_DETECTION_KILL=1) forces off everywhere.
//
// PB has no prom-client metrics layer, so the structured audit event emitted
// here IS the observability signal (bounded fields only: verdict/score/reason
// codes/hash — never the raw text).

import { FeatureFlagService } from '../feature-flags/service';
import { log, logAudit } from '../infrastructure/logging';
import {
  enforcePromptInput,
  enforceStructuredInput,
  type InjectionDecision,
} from '@liftoffos/injection-detector';
import { scanToolDefinitionsForInjection } from '../mcp/tool-validator';
import type { MCPToolDefinition, ToolDefinitionInjectionFinding } from '../mcp/types';

export type InjectionMode = 'off' | 'shadow' | 'enforce';

/**
 * WHERE the text is being screened. This is the scope split (E2): the same
 * detector runs everywhere, but what a finding MEANS depends on where it was
 * found.
 *
 *  chat        — a person typing to their team member. Hard-block posture,
 *                unchanged: they are present, and they can rephrase.
 *  tool_ingress— text arriving from outside (MCP tool definitions, connector
 *                output). DETECT ONLY, never block: this is third-party content
 *                that is legitimately full of imperative language, and blocking
 *                it would break working integrations on a false positive.
 *  persistence — text about to be written somewhere durable: a memory, a skill,
 *                a knowledge item, a settled reply. This is where blocking
 *                belongs, because a poisoned row keeps working on the agent
 *                every run afterwards, long after whoever sent it is gone.
 */
export type InjectionPlacement = 'chat' | 'tool_ingress' | 'persistence';

/**
 * Placement policy, in code rather than in flags.
 *
 * The per-tenant flags decide whether the detector runs at all and whether the
 * tenant is in enforce; this decides what enforce is allowed to DO at each
 * placement. Keeping it here rather than in a flag means an operator cannot
 * accidentally turn tool-ingress into a blocking surface, which is the failure
 * mode that kept this feature switched off.
 */
const PLACEMENT_MAY_BLOCK: Record<InjectionPlacement, boolean> = {
  chat: true,
  tool_ingress: false,
  persistence: true,
};

export const INJECTION_DETECTION_FLAG = 'injection_detection';
export const INJECTION_DETECTION_ENFORCE_FLAG = 'injection_detection_enforce';

const flags = new FeatureFlagService();

function killed(): boolean {
  return process.env.INJECTION_DETECTION_KILL === '1';
}

// Small per-tenant TTL cache so the chat pre-screen doesn't hit the feature_flags
// table on every turn. TR gates via the (already cached) entitlements client; PB
// reads flags directly, so it caches here. 30s is short enough that a flag flip
// (e.g. shadow → enforce during rollout) takes effect within a turn or two.
const MODE_CACHE_TTL_MS = 30_000;
const modeCache = new Map<string, { mode: InjectionMode; expires: number }>();

/**
 * Resolve the effective mode for a tenant AT a placement. Fails safe to 'off'
 * on any flag-read error.
 *
 * The flag lookup is per-tenant (and cached on that key); the placement then
 * downgrades `enforce` to `shadow` where blocking is not allowed. Doing it in
 * this order means one cache entry per tenant rather than one per
 * tenant-and-placement, and the policy stays in one place.
 */
export async function resolveInjectionModeAt(
  tenantId: string,
  placement: InjectionPlacement,
): Promise<InjectionMode> {
  const mode = await resolveInjectionMode(tenantId);
  if (mode === 'enforce' && !PLACEMENT_MAY_BLOCK[placement]) return 'shadow';
  return mode;
}

/** Resolve the per-tenant mode. Fails safe to 'off' on any flag-read error. */
export async function resolveInjectionMode(tenantId: string): Promise<InjectionMode> {
  if (killed()) return 'off';
  const cached = modeCache.get(tenantId);
  if (cached && cached.expires > Date.now()) return cached.mode;

  const on = await flags.isEnabled(INJECTION_DETECTION_FLAG, tenantId).catch(() => false);
  let mode: InjectionMode = 'off';
  if (on) {
    const enforce = await flags
      .isEnabled(INJECTION_DETECTION_ENFORCE_FLAG, tenantId)
      .catch(() => false);
    mode = enforce ? 'enforce' : 'shadow';
  }
  modeCache.set(tenantId, { mode, expires: Date.now() + MODE_CACHE_TTL_MS });
  return mode;
}

// PB has no prom-client; metrics are emitted as structured log lines that Cloud
// Monitoring turns into log-based metrics — the SAME metric names/shape TR emits
// (observability/runtime-extensions-metrics convention), so the injection
// metrics are symmetric across both services. Labels are bounded.
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
  log.info({ metric_name: metricName, metric_kind: kind, metric_value: value, ...clean });
}

/** Max characters of the flagged content captured for calibration. */
const SHADOW_SAMPLE_MAX_CHARS = 2000;

/**
 * Restricted shadow-sample store. On a would-block in SHADOW mode, capture the
 * flagged CONTENT (bounded) so operators can review what the detector flagged
 * and finalize thresholds. SEPARATE from the PII-safe audit (hash-only): emits a
 * distinctly-marked structured log line (`injection_shadow_sample`) for a
 * restricted, short-retention log sink (operator-only IAM = restricted; retention
 * = TTL). Only fires in shadow.
 */
function captureShadowSample(
  placement: string,
  tenantId: string,
  text: string,
  decision: InjectionDecision,
): void {
  log.warn({
    injection_shadow_sample: true,
    tenant_id: tenantId,
    placement,
    verdict: decision.verdict,
    reason_codes: decision.reasons.map((r) => r.code).join(','),
    prompt_hash: decision.hash,
    sample: text.slice(0, SHADOW_SAMPLE_MAX_CHARS),
  });
}

interface ScreenAuditCtx {
  tenantId: string;
  /** The agent whose write this is. Optional because not every persisted
   *  string belongs to one: a file a PERSON uploads is screened on the way in
   *  and has no producing agent, and naming an arbitrary one would put the
   *  finding in that agent's audit trail. The detector's own context has
   *  always accepted it as optional. */
  agentId?: string;
  userId?: string;
  threadId?: string;
  requestId?: string;
}

const ALLOW: InjectionDecision = {
  verdict: 'allow',
  score: 0,
  reasons: [],
  hash: '',
  scannedChars: 0,
};

/** Emit the PII-safe audit event for a non-allow verdict at a placement. */
function auditDecision(
  placement: string,
  ctx: ScreenAuditCtx,
  mode: InjectionMode,
  decision: InjectionDecision,
  wouldBlock: boolean,
): void {
  logAudit(
    'injection.detected',
    { tenantId: ctx.tenantId, userId: ctx.userId, requestId: ctx.requestId },
    {
      placement,
      agentId: ctx.agentId,
      mode,
      shadow: mode !== 'enforce',
      verdict: decision.verdict,
      score: decision.score,
      reasonCodes: decision.reasons.map((r) => r.code).join(','),
      promptHash: decision.hash,
      scannedChars: decision.scannedChars,
      wouldBlock,
    },
  );
}

export interface ChatScreenResult {
  block: boolean;
  decision: InjectionDecision;
}

/**
 * Screen a direct-chat message. HARD-BLOCK posture: in `enforce` mode a `block`
 * verdict rejects the turn (the caller short-circuits BEFORE the LLM guard and
 * the model call). In `shadow`/`off` nothing is blocked. Every non-allow verdict
 * is audited (in shadow the audit records `wouldBlock` for calibration).
 */
export async function screenChatMessage(
  content: string,
  ctx: ScreenAuditCtx,
): Promise<ChatScreenResult> {
  const mode = await resolveInjectionMode(ctx.tenantId);
  if (mode === 'off') return { block: false, decision: ALLOW };

  const started = Date.now();
  const decision = enforcePromptInput(content, {
    source: 'chat',
    tenantId: ctx.tenantId,
    agentId: ctx.agentId,
    sessionId: ctx.threadId,
    requestId: ctx.requestId,
    userId: ctx.userId,
  });
  emitMetric('injection_detector_latency_ms', 'histogram', Date.now() - started, { placement: 'chat' });
  emitMetric('injection_verdict_total', 'counter', 1, { placement: 'chat', verdict: decision.verdict });

  const wouldBlock = decision.verdict === 'block';
  if (wouldBlock) {
    if (mode === 'enforce') {
      emitMetric('injection_finding_total', 'counter', 1, { placement: 'chat' });
    } else {
      emitMetric('injection_shadow_block_total', 'counter', 1, { placement: 'chat' });
      captureShadowSample('chat', ctx.tenantId, content, decision);
    }
  }
  if (decision.verdict !== 'allow') {
    auditDecision('chat', ctx, mode, decision, wouldBlock);
  }
  return { block: mode === 'enforce' && wouldBlock, decision };
}

/**
 * Screen discovered MCP tool metadata for injection (FLAG posture, never
 * reject). Runs the scan, audits every finding (PII-safe), and returns
 * operator-visible flags ONLY in `enforce` mode; `shadow` audits without
 * surfacing; `off` returns none. Absent tenantId → skip.
 */
export async function screenToolDefinitions(
  tools: MCPToolDefinition[],
  tenantId: string | undefined,
): Promise<ToolDefinitionInjectionFinding[]> {
  if (!tenantId) return [];
  // This is the `tool_ingress` placement: detect and audit, never reject. Tool
  // definitions come from third-party servers whose descriptions are
  // legitimately imperative ("Always call this before..."), so refusing them on
  // a detector hit would break working integrations. The blocking posture lives
  // on the persistence paths instead.
  //
  // Read through resolveInjectionMode (the raw tenant mode) rather than
  // resolveInjectionModeAt: the return value here controls whether findings are
  // SHOWN to an operator, not whether anything is blocked, and a tenant in
  // enforce should still see them.
  const mode = await resolveInjectionMode(tenantId);
  if (mode === 'off') return [];
  const findings = scanToolDefinitionsForInjection(tools);
  for (const f of findings) {
    if (mode === 'enforce') emitMetric('injection_finding_total', 'counter', 1, { placement: 'tool_definition' });
    else emitMetric('injection_shadow_block_total', 'counter', 1, { placement: 'tool_definition' });
    logAudit(
      'injection.detected',
      { tenantId },
      {
        placement: 'tool_definition',
        mode,
        shadow: mode !== 'enforce',
        toolName: f.toolName,
        field: f.field,
        reasonCodes: f.code,
        score: f.score,
        promptHash: f.hash,
      },
    );
  }
  return mode === 'enforce' ? findings : [];
}

// ── Persistence screening (E2) ──────────────────────────────────────────
//
// Everything below guards a WRITE. The asymmetry with chat is deliberate: a
// blocked chat message costs one rephrase, while a poisoned memory or skill
// keeps instructing the agent on every future run, and nobody is watching by
// then. So this is the one place the detector is allowed to refuse.

/** What is being written. Named so the audit says which store was protected. */
export type PersistenceKind =
  | 'memory'
  | 'skill'
  | 'knowledge_item'
  | 'settled_reply'
  // Producer-supplied text on a media attachment: its filename and alt. Both
  // are attacker-influencable (a browser download names itself; alt is written
  // by a model that just read a page it did not choose) and both land in a
  // transcript that keeps being read.
  | 'media';

export interface PersistenceScreenResult {
  block: boolean;
  decision: InjectionDecision;
}

/**
 * Screen text on its way into durable storage.
 *
 * Returns `block: true` only when the tenant is in enforce mode AND the verdict
 * is block. Everything else audits and allows, so turning the flag on cannot
 * silently start dropping writes.
 */
export async function screenPersistedContent(
  kind: PersistenceKind,
  content: string,
  ctx: ScreenAuditCtx,
): Promise<PersistenceScreenResult> {
  if (!content) return { block: false, decision: ALLOW };

  const mode = await resolveInjectionModeAt(ctx.tenantId, 'persistence');
  if (mode === 'off') return { block: false, decision: ALLOW };

  const started = Date.now();
  const decision = enforcePromptInput(content, {
    source: `persistence:${kind}`,
    tenantId: ctx.tenantId,
    agentId: ctx.agentId,
    sessionId: ctx.threadId,
    requestId: ctx.requestId,
    userId: ctx.userId,
  });
  const placement = `persistence:${kind}`;
  emitMetric('injection_detector_latency_ms', 'histogram', Date.now() - started, { placement });
  emitMetric('injection_verdict_total', 'counter', 1, { placement, verdict: decision.verdict });

  const wouldBlock = decision.verdict === 'block';
  if (wouldBlock) {
    if (mode === 'enforce') {
      emitMetric('injection_finding_total', 'counter', 1, { placement });
    } else {
      emitMetric('injection_shadow_block_total', 'counter', 1, { placement });
      captureShadowSample(placement, ctx.tenantId, content, decision);
    }
  }
  if (decision.verdict !== 'allow') {
    auditDecision(placement, ctx, mode, decision, wouldBlock);
  }

  return { block: mode === 'enforce' && wouldBlock, decision };
}

/**
 * Structured variant, for a whole object rather than one string (a skill with
 * its name, description, and instruction; a classification payload). Uses the
 * detector's own text extraction so nested fields are covered.
 */
export async function screenPersistedStructure(
  kind: PersistenceKind,
  value: unknown,
  ctx: ScreenAuditCtx,
): Promise<PersistenceScreenResult> {
  const mode = await resolveInjectionModeAt(ctx.tenantId, 'persistence');
  if (mode === 'off') return { block: false, decision: ALLOW };

  const decision = enforceStructuredInput(value, {
    source: `persistence:${kind}`,
    tenantId: ctx.tenantId,
    agentId: ctx.agentId,
    sessionId: ctx.threadId,
    requestId: ctx.requestId,
    userId: ctx.userId,
  });
  const placement = `persistence:${kind}`;
  emitMetric('injection_verdict_total', 'counter', 1, { placement, verdict: decision.verdict });

  const wouldBlock = decision.verdict === 'block';
  if (wouldBlock && mode !== 'enforce') {
    emitMetric('injection_shadow_block_total', 'counter', 1, { placement });
  }
  if (decision.verdict !== 'allow') {
    auditDecision(placement, ctx, mode, decision, wouldBlock);
  }

  return { block: mode === 'enforce' && wouldBlock, decision };
}
