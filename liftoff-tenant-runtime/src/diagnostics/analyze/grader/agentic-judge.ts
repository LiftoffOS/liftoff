// Agentic deliverable judge.
//
// Each judge runs as a bounded agent via the vendor adapter (Anthropic =
// "Claude Code", Google = "Gemini CLI"), connected to a sandbox-scoped tool
// catalog and a read-only deny gate. It actively verifies each rubric item in
// the ISOLATED sandbox (file/shell tools → sandbox-executor), then emits the
// per-item JSON as its final message. Output, aggregation, cohort hashing, and
// the returned GradeResult are identical to the one-shot scoreAgainstRubric —
// only HOW each judge reaches its per-item scores changes.

import { createHash, randomUUID } from 'crypto';
import { z } from 'zod';
import type { ReconstructedRun } from '../../reconstruct/trace-model';
import { logger } from '../../../infrastructure/logging';
import { resolveModelForTier } from '../../../llm/tiers';
import { serializeForGrading } from './serialize';
import { SCORE_AGENTIC_SYSTEM, SCORE_AGENTIC_PROMPT_VERSION, RUBRIC_PROMPT_VERSION } from './prompts';
import type { StoredRubric } from './rubric';
import { flattenRubric, validateJudgeItems, totalFor, ScoreZ, type GradeResult, type JudgeCfg } from './score';
import { buildGraderCatalog, graderGateFor, seedSandboxArtifacts, type GraderIntegration } from './grader-catalog';

const GRADER_MAX_TURNS = 12;
const GRADER_TIMEOUT_MS = 200_000;
/** Agentic judges get a larger deliverable-text budget than the one-shot judge
 *  (they reason over more context and can pull the rest via sandbox tools). */
const AGENTIC_BUDGET_SCALE = 2;

/** Extract the per-item JSON from the judge's final message. Judges emit items
 *  as `{"items":[...]}`, but occasionally as a bare `[...]` array or with the
 *  closing bracket dropped — either drops the judge from the mixed panel if not
 *  tolerated. Strategy: (1) direct JSON.parse of the whole message, a ```json
 *  fence, the widest {...} span, and the widest [...] span (a bare array is
 *  wrapped as {items}); (2) if all fail, salvage the complete, balanced item
 *  objects from the items array — tolerant of a missing closing `]`/`}`. If any
 *  item is genuinely incomplete the count won't match the rubric and
 *  validateJudgeItems rejects it downstream, so salvage never yields a false
 *  grade. Null when nothing valid can be recovered. */
export function extractScore(text: string): z.infer<typeof ScoreZ> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const validate = (v: unknown): z.infer<typeof ScoreZ> | null => {
    const obj = Array.isArray(v) ? { items: v } : v;
    const res = ScoreZ.safeParse(obj);
    return res.success ? res.data : null;
  };

  const spans: string[] = [trimmed];
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) spans.push(fence[1].trim());
  const ob = trimmed.indexOf('{');
  const oe = trimmed.lastIndexOf('}');
  if (ob >= 0 && oe > ob) spans.push(trimmed.slice(ob, oe + 1));
  const ab = trimmed.indexOf('[');
  const ae = trimmed.lastIndexOf(']');
  if (ab >= 0 && ae > ab) spans.push(trimmed.slice(ab, ae + 1));
  for (const s of spans) {
    try {
      const r = validate(JSON.parse(s));
      if (r) return r;
    } catch {
      // try next span
    }
  }

  const salvaged = salvageItemObjects(trimmed);
  if (salvaged.length > 0) {
    const r = validate(salvaged);
    if (r) return r;
  }
  return null;
}

/** Collect the complete, top-level `{...}` objects inside the items array,
 *  tolerant of a missing closing `]`/`}`. String- and escape-aware so braces
 *  inside note strings never confuse the depth count. Starts just inside the
 *  `[` that follows a `"items"` key (or the first `[` for a bare array). */
function salvageItemObjects(text: string): unknown[] {
  let arrStart = text.indexOf('[');
  const key = text.indexOf('"items"');
  if (key >= 0) {
    const b = text.indexOf('[', key);
    if (b >= 0) arrStart = b;
  }
  if (arrStart < 0) return [];
  const out: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = arrStart + 1; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
    } else if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          out.push(JSON.parse(text.slice(start, i + 1)));
        } catch {
          // skip an unparseable object
        }
        start = -1;
      }
    }
  }
  return out;
}

/** Run one judge as a sandbox-backed agent. Returns the per-judge grade block or
 *  null (fell over / paused / unparseable). gradeId = traceId = invocationId with
 *  no threadId, so the judge's sandbox tool calls share one /workspace. */
async function runOneAgenticJudge(
  run: ReconstructedRun,
  rubric: StoredRubric,
  userText: string,
  artifactUris: string[],
  integrations: GraderIntegration[],
  j: JudgeCfg,
): Promise<GradeResult['judges'][number] | null> {
  const gradeId = randomUUID();
  const model = resolveModelForTier(j.provider, j.tier);

  const catalog = await buildGraderCatalog(run, j.provider, gradeId, integrations).catch((err: Error) => {
    logger.warn({ judge: `${j.provider}:${j.tier}`, err: err.message }, 'agentic grader: catalog build failed');
    return null;
  });
  if (!catalog) return null;

  // Materialize the real deliverable into this judge's sandbox /workspace (same
  // sessionId=gradeId the judge's tools use) before invoking it. Best-effort.
  await seedSandboxArtifacts(run, gradeId, artifactUris).catch((err: Error) => {
    logger.warn({ judge: `${j.provider}:${j.tier}`, err: err.message }, 'agentic grader: sandbox seed failed (non-fatal)');
  });

  const { createAdapter } = await import('../../../agent-execution/adapter');
  const adapter = createAdapter(j.provider);
  adapter.registerToolCatalog(catalog);
  adapter.registerHitlGate(graderGateFor(catalog));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GRADER_TIMEOUT_MS);
  const label = `${j.provider}:${j.tier}`;
  let lastText = '';
  let paused = false;
  let toolCalls = 0;
  let completionOutcome: string | undefined;
  let completionReason: string | undefined;
  try {
    for await (const ev of adapter.invoke(
      {
        systemPrompt: SCORE_AGENTIC_SYSTEM,
        messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
        model,
        provider: j.provider,
        tenantId: run.ref.tenantId,
        invocationId: gradeId,
        // Not an agent run. A stable identity of its own so it neither shares a
        // prompt-cache lane with real traffic nor fragments into one per call.
        agentId: 'agentic-judge',
        maxTurns: GRADER_MAX_TURNS,
        timeoutMs: GRADER_TIMEOUT_MS,
        purpose: 'diagnostics_deliverable_judge',
      },
      controller.signal,
    )) {
      if (ev.type === 'assistant_message') {
        const t = ev.content
          .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
          .map((c) => c.text)
          .join('\n');
        if (t.trim()) lastText = t;
      } else if (ev.type === 'tool_call_started') {
        toolCalls += 1;
      } else if (ev.type === 'pause_requested') {
        paused = true;
        break;
      } else if (ev.type === 'completion') {
        completionOutcome = ev.outcome;
        completionReason = ev.reason;
        break;
      }
    }
  } catch (err) {
    logger.warn({ judge: label, session: run.ref.key, model, err: (err as Error).message }, 'agentic grader: invoke failed — judge dropped');
    return null;
  } finally {
    clearTimeout(timer);
  }

  // Every drop below is a mixed-judge degradation; log the reason so a missing
  // judge is never silent (the panel must know why it shrank).
  if (paused) {
    logger.warn({ judge: label, session: run.ref.key, model, toolCalls }, 'agentic grader: judge paused (HITL gate) — dropped');
    return null;
  }
  const parsed = extractScore(lastText);
  if (!parsed) {
    logger.warn(
      { judge: label, session: run.ref.key, model, completionOutcome, completionReason, toolCalls, lastTextLen: lastText.length, tail: lastText.slice(-500) },
      'agentic grader: final message did not parse to ScoreZ — judge dropped',
    );
    return null;
  }
  const flat = flattenRubric(rubric);
  const perItem = validateJudgeItems(parsed.items, flat.items);
  if (!perItem) {
    logger.warn({ judge: label, session: run.ref.key, model, itemCount: parsed.items.length, expected: flat.items.length }, 'agentic grader: judge items failed rubric validation — dropped');
    return null;
  }
  const total = totalFor(perItem, flat.items, flat.weightByCat, flat.catPoints);
  return { judge: label, resolved_model: model, total, per_item: perItem };
}

/** Agentic sibling of scoreAgainstRubric. Same GradeResult contract; the judges
 *  actively verify in the sandbox instead of one-shot reasoning over text. */
export async function scoreAgainstRubricAgentic(
  run: ReconstructedRun,
  artifactUris: string[],
  rubric: StoredRubric,
  judges: JudgeCfg[],
  /** The agent's connectors (read-only subset) for connector-hosted deliverables.
   *  Empty (default) = sandbox-only grading over captured artifacts. */
  integrations: GraderIntegration[] = [],
): Promise<GradeResult | null> {
  const { text, artifactsPresent } = await serializeForGrading(run.trajectory, artifactUris, AGENTIC_BUDGET_SCALE);

  // Screen the untrusted deliverable before it enters the judge prompt. The
  // agentic judge ACTS on the content (runs code / follows links), so in enforce
  // mode a block verdict — the deliverable is trying to hijack the grader — skips
  // agentic grading; evaluate then falls back to the one-shot judge, which never
  // executes the content. Shadow/off modes detect-and-surface only and proceed.
  const { screenUntrustedText } = await import('../../../injection-detection/finding');
  const screen = await screenUntrustedText('tool_result', text, {
    tenantId: run.ref.tenantId,
    agentId: run.ref.agentId,
    invocationId: run.ref.key,
  });
  if (screen.finding && screen.mode === 'enforce') {
    logger.warn({ session: run.ref.key }, 'agentic grader: deliverable failed injection screen (enforce) — falling back to one-shot');
    return null;
  }

  const rubricJson = JSON.stringify({
    categories: rubric.categories.map((c) => ({
      name: c.name,
      weight: c.weight,
      items: c.items.map((it) => ({ id: it.id, criterion: it.criterion, points: it.points, verification: it.verification })),
    })),
  });
  const userText = `${text}\n\nRUBRIC:\n${rubricJson}`;

  const results = await Promise.all(judges.map((j) => runOneAgenticJudge(run, rubric, userText, artifactUris, integrations, j)));
  const surviving = results.filter((r): r is NonNullable<typeof r> => r !== null);
  if (surviving.length < judges.length) {
    // Mixed-model judging is a self-preference control; a shrunk panel is a
    // real quality regression, not a silent detail. Surface it (per-judge
    // reasons are logged inside runOneAgenticJudge).
    logger.warn(
      { session: run.ref.key, configured: judges.map((j) => `${j.provider}:${j.tier}`), survived: surviving.map((s) => s.judge) },
      'agentic grader: judge panel shrank — grading on the survivors',
    );
  }
  if (surviving.length === 0) return null;

  const totals = surviving.map((s) => s.total);
  const score = totals.reduce((a, b) => a + b, 0) / totals.length;
  const spread = Math.max(...totals) - Math.min(...totals);
  const effective_config_hash = createHash('sha1')
    .update(
      ['agentic', RUBRIC_PROMPT_VERSION, SCORE_AGENTIC_PROMPT_VERSION, rubric.generated_by_model, ...surviving.map((s) => s.resolved_model)].join('|'),
    )
    .digest('hex');

  return {
    session_id: run.ref.key,
    tenant_id: run.ref.tenantId,
    rubric_id: rubric.rubric_id,
    rubric_prompt_version: RUBRIC_PROMPT_VERSION,
    score_prompt_version: SCORE_AGENTIC_PROMPT_VERSION,
    effective_config_hash,
    judges: surviving,
    score,
    spread,
    artifacts_present: artifactsPresent,
    created_at: new Date().toISOString(),
  };
}
