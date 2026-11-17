// LLM-judge plumbing for the diagnostics harness. This is the NATIVE judge,
// used directly and as the fallback when the DeepEval service is unreachable.
// Provider + model are CONFIGURABLE (same design as the DeepEval evaluator), so
// we can swap between Anthropic / OpenAI / Google without code changes:
//   DIAGNOSTICS_JUDGE_PROVIDER  anthropic | openai | google  (default: anthropic)
//   DIAGNOSTICS_JUDGE_TIER      large | medium | small                          (default: large)
//   DIAGNOSTICS_JUDGE_MODEL     exact model id; overrides the tier              (optional)
// Routing goes through the existing llmClient, which resolves the concrete
// model id from each provider's tier table (src/llm/providers/*).

import { llmClient } from '../../../llm';
import { normalizeTier, type LLMProvider, type LLMModelTier } from '../../../llm/types';
import { logger as log } from '../../../infrastructure/logging';
import type { CanonicalTrajectory } from '../../reconstruct/trace-model';
import { collectToolUses, finalAssistantText, objective } from '../trajectory-util';

const VALID_PROVIDERS: LLMProvider[] = ['anthropic', 'openai', 'google'];
const VALID_TIERS: LLMModelTier[] = ['large', 'medium', 'small'];

interface JudgeModelConfig {
  provider: LLMProvider;
  tier: LLMModelTier;
  model?: string;
}

/** Resolve the judge provider/model from env. Defaults to Anthropic large;
 *  invalid values fall back to the defaults rather than throwing (advisory). */
function resolveJudgeConfig(): JudgeModelConfig {
  const p = process.env.DIAGNOSTICS_JUDGE_PROVIDER as LLMProvider | undefined;
  const provider = p && VALID_PROVIDERS.includes(p) ? p : 'anthropic';
  const t = normalizeTier(process.env.DIAGNOSTICS_JUDGE_TIER) as LLMModelTier | undefined;
  // Default to large: judge reliability gates how much the scores can be
  // trusted (DeepEval itself defaults to the full gpt-4.1, not a mini/nano).
  const tier = t && VALID_TIERS.includes(t) ? t : 'large';
  const model = process.env.DIAGNOSTICS_JUDGE_MODEL || undefined;
  return { provider, tier, model };
}

/** Build the llmClient request body, letting an explicit model override the tier. */
function judgeRequest(cfg: JudgeModelConfig, system: string, user: string, maxTokens: number) {
  return {
    messages: [
      { role: 'system' as const, content: system },
      { role: 'user' as const, content: user },
    ],
    ...(cfg.model ? { model: cfg.model } : { tier: cfg.tier }),
    maxTokens,
    temperature: 0,
  };
}

/** Compact, judge-friendly serialization of a trajectory (tool sequence +
 *  final answer). Keeps the prompt small — judging is meant to be near-free. */
export function serializeForJudge(traj: CanonicalTrajectory): string {
  const uses = collectToolUses(traj);
  const toolLine = uses.map((u) => u.name).join(' → ') || '(no tools)';
  return [
    `OBJECTIVE: ${objective(traj)}`,
    `TOOL SEQUENCE: ${toolLine}`,
    `OUTCOME: ${traj.trajectory_meta.outcome}`,
    `FINAL ANSWER:\n${finalAssistantText(traj).slice(0, 4000)}`,
  ].join('\n\n');
}

/** Best-effort JSON extraction from a model response (handles ```json fences
 *  and leading prose). Returns null on failure. */
export function extractJson<T>(text: string): T | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

export interface JudgeResult {
  score: number; // 0..1
  pass: boolean;
  reasoning: string;
  /** Set when the judge call itself failed (advisory output unavailable). */
  unavailable?: boolean;
}

/** Run a judge prompt on the configured judge model (default Anthropic).
 *  Returns an `unavailable` result rather than throwing, because judges are
 *  ADVISORY (alert-only) and must never break the gating path. */
export async function runJudge(opts: {
  system: string;
  user: string;
  tenantId: string;
  purpose: string;
}): Promise<JudgeResult> {
  const cfg = resolveJudgeConfig();
  try {
    const res = await llmClient.complete(
      judgeRequest(cfg, opts.system, opts.user, 1024),
      { provider: cfg.provider },
      { tenantId: opts.tenantId, purpose: opts.purpose },
    );
    const parsed = extractJson<{ score?: number; pass?: boolean; reasoning?: string }>(res.content);
    if (!parsed) {
      log.warn({ message: 'judge: could not parse verdict JSON', purpose: opts.purpose });
      return { score: 0, pass: false, reasoning: 'unparseable judge response', unavailable: true };
    }
    const score = clamp01(parsed.score ?? (parsed.pass ? 1 : 0));
    return {
      score,
      pass: parsed.pass ?? score >= 0.7,
      reasoning: parsed.reasoning ?? '',
    };
  } catch (err) {
    log.warn({ message: 'judge: LLM call failed (advisory, non-blocking)', purpose: opts.purpose, provider: cfg.provider, err: (err as Error).message });
    return { score: 0, pass: false, reasoning: `judge unavailable: ${(err as Error).message}`, unavailable: true };
  }
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/** Like runJudge, but returns the FULL parsed JSON object (for richer verdicts
 *  such as RCA that carry fields beyond score/pass/reasoning). Returns null on
 *  any failure — caller treats null as "advisory output unavailable". */
export async function runStructuredJudge<T>(opts: {
  system: string;
  user: string;
  tenantId: string;
  purpose: string;
  maxTokens?: number;
}): Promise<T | null> {
  const cfg = resolveJudgeConfig();
  try {
    const res = await llmClient.complete(
      judgeRequest(cfg, opts.system, opts.user, opts.maxTokens ?? 1024),
      { provider: cfg.provider },
      { tenantId: opts.tenantId, purpose: opts.purpose },
    );
    return extractJson<T>(res.content);
  } catch (err) {
    log.warn({ message: 'structured judge: LLM call failed (advisory)', purpose: opts.purpose, provider: cfg.provider, err: (err as Error).message });
    return null;
  }
}

/** Like runStructuredJudge, but supports a per-call provider/tier override, one
 *  not-valid-JSON retry, and returns the RESOLVED model id alongside the parsed
 *  object (for grading reproducibility). Null after two failed parses. */
export async function runStructured<T>(opts: {
  system: string;
  user: string;
  tenantId: string;
  purpose: string;
  maxTokens?: number;
  cfgOverride?: { provider: LLMProvider; tier: LLMModelTier; model?: string };
}): Promise<{ parsed: T; resolvedModel: string } | null> {
  const cfg = opts.cfgOverride ?? resolveJudgeConfig();
  const attempt = async (system: string, user: string): Promise<{ parsed: T; resolvedModel: string } | null> => {
    const res = await llmClient.complete(
      judgeRequest(cfg, system, user, opts.maxTokens ?? 4096),
      { provider: cfg.provider },
      { tenantId: opts.tenantId, purpose: opts.purpose },
    );
    const parsed = extractJson<T>(res.content);
    if (parsed === null) return null;
    return { parsed, resolvedModel: res.model || cfg.model || cfg.tier };
  };
  try {
    const first = await attempt(opts.system, opts.user);
    if (first) return first;
    return await attempt(
      opts.system,
      `${opts.user}\n\nYour previous output was not valid JSON. Output ONLY the JSON object.`,
    );
  } catch (err) {
    log.warn({ message: 'runStructured: LLM call failed (advisory)', purpose: opts.purpose, provider: cfg.provider, err: (err as Error).message });
    return null;
  }
}
