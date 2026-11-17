// Deterministic multi-judge scoring against a stored rubric.
//
// Each judge must return exactly one finite result per stored item id; a judge
// with a missing / duplicate / extra / non-finite result is dropped. Awarded is
// clamped to the item's rubric points (never the model's claimed max). Per
// category the subtotal is Σawarded/Σpoints; the judge total normalises by the
// validated category-weight sum so weight tolerance can't push it off-scale.

import { z } from 'zod';
import { createHash } from 'crypto';
import type { ReconstructedRun } from '../../reconstruct/trace-model';
import { normalizeTier, type LLMProvider, type LLMModelTier } from '../../../llm/types';
import { runStructured } from '../judge/llm-judge';
import { serializeForGrading } from './serialize';
import { SCORE_SYSTEM, SCORE_PROMPT_VERSION, RUBRIC_PROMPT_VERSION } from './prompts';
import type { StoredRubric } from './rubric';

const DEFAULT_JUDGES = 'anthropic:large,google:large';
const MAX_JUDGES = 4;

export interface JudgeCfg { provider: LLMProvider; tier: LLMModelTier }

export const ScoreZ = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      awarded: z.number().finite(),
      note: z.string().max(500).optional(),
    }),
  ),
});

export interface GradeResult {
  session_id: string;
  tenant_id: string;
  rubric_id: string;
  rubric_prompt_version: string;
  score_prompt_version: string;
  effective_config_hash: string;
  judges: Array<{
    judge: string;          // requested provider:tier
    resolved_model: string; // actual model id
    total: number;          // 0-100
    per_item: Array<{ id: string; awarded: number; max: number; note?: string }>;
  }>;
  score: number;            // mean of judge totals
  spread: number;           // max total - min total
  artifacts_present: boolean;
  created_at: string;
}

/** Parse the judge-spec env into validated (provider, tier) pairs. Drops
 *  malformed entries, dedupes, caps at 4; a blank/empty result falls back to
 *  the full default list (never an empty judge set). */
export function parseJudgeSpec(spec?: string): JudgeCfg[] {
  const validProviders: LLMProvider[] = ['anthropic', 'openai', 'google'];
  const validTiers: LLMModelTier[] = ['large', 'medium', 'small'];
  const raw = (spec ?? process.env.DIAGNOSTICS_GRADER_JUDGES ?? '').trim();
  const source = raw.length > 0 ? raw : DEFAULT_JUDGES;
  const seen = new Set<string>();
  const out: JudgeCfg[] = [];
  for (const entry of source.split(',')) {
    const [p, rawTier] = entry.trim().split(':');
    const t = normalizeTier(rawTier);
    if (!validProviders.includes(p as LLMProvider) || !validTiers.includes(t as LLMModelTier)) continue;
    const key = `${p}:${t}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ provider: p as LLMProvider, tier: t as LLMModelTier });
    if (out.length >= MAX_JUDGES) break;
  }
  if (out.length === 0) return parseJudgeSpec(DEFAULT_JUDGES);
  return out;
}

export interface FlatItem { id: string; points: number; catWeight: number; catIndex: number }

export function flattenRubric(rubric: StoredRubric): { items: FlatItem[]; weightByCat: number[]; catPoints: number[] } {
  const items: FlatItem[] = [];
  const weightByCat: number[] = [];
  const catPoints: number[] = [];
  rubric.categories.forEach((c, ci) => {
    weightByCat[ci] = c.weight;
    catPoints[ci] = c.items.reduce((s, it) => s + it.points, 0);
    for (const it of c.items) items.push({ id: it.id, points: it.points, catWeight: c.weight, catIndex: ci });
  });
  return { items, weightByCat, catPoints };
}

/** Validate a judge's raw items against the rubric: exactly one finite result
 *  per stored id, none missing/extra. Returns the clamped per-item awards or
 *  null (drop the judge). */
export function validateJudgeItems(
  raw: z.infer<typeof ScoreZ>['items'],
  flat: FlatItem[],
): Array<{ id: string; awarded: number; max: number; note?: string }> | null {
  const byId = new Map<string, { awarded: number; note?: string }>();
  for (const r of raw) {
    if (!Number.isFinite(r.awarded)) return null;
    if (byId.has(r.id)) return null; // duplicate
    byId.set(r.id, { awarded: r.awarded, note: r.note });
  }
  if (byId.size !== flat.length) return null; // missing or extra
  const out: Array<{ id: string; awarded: number; max: number; note?: string }> = [];
  for (const it of flat) {
    const r = byId.get(it.id);
    if (!r) return null;
    const awarded = Math.max(0, Math.min(it.points, r.awarded));
    out.push({ id: it.id, awarded, max: it.points, note: r.note });
  }
  return out;
}

/** Normalise per-item awards to a 0-100 total, weighting categories by their
 *  validated weights and dividing by the weight sum (D16). */
export function totalFor(
  perItem: Array<{ id: string; awarded: number; max: number }>,
  flat: FlatItem[],
  weightByCat: number[],
  catPoints: number[],
): number {
  const awardedByCat = new Map<number, number>();
  const flatById = new Map(flat.map((f) => [f.id, f]));
  for (const pi of perItem) {
    const f = flatById.get(pi.id)!;
    awardedByCat.set(f.catIndex, (awardedByCat.get(f.catIndex) ?? 0) + pi.awarded);
  }
  let weightedSubtotal = 0;
  let weightSum = 0;
  weightByCat.forEach((w, ci) => {
    const pts = catPoints[ci];
    if (pts <= 0) return;
    const subtotal = (awardedByCat.get(ci) ?? 0) / pts;
    weightedSubtotal += w * subtotal;
    weightSum += w;
  });
  if (weightSum <= 0) return 0;
  return 100 * (weightedSubtotal / weightSum);
}

export async function scoreAgainstRubric(
  run: ReconstructedRun,
  artifactUris: string[],
  rubric: StoredRubric,
  judges: JudgeCfg[],
): Promise<GradeResult | null> {
  const { text, artifactsPresent } = await serializeForGrading(run.trajectory, artifactUris);
  const flat = flattenRubric(rubric);
  const rubricJson = JSON.stringify({
    categories: rubric.categories.map((c) => ({
      name: c.name,
      weight: c.weight,
      items: c.items.map((it) => ({ id: it.id, criterion: it.criterion, points: it.points, verification: it.verification })),
    })),
  });
  const user = `${text}\n\nRUBRIC:\n${rubricJson}`;

  const results = await Promise.all(
    judges.map(async (j) => {
      const res = await runStructured<z.infer<typeof ScoreZ>>({
        system: SCORE_SYSTEM,
        user,
        tenantId: run.ref.tenantId,
        purpose: 'diagnostics_deliverable_judge',
        cfgOverride: { provider: j.provider, tier: j.tier },
      });
      if (!res) return null;
      const parsed = ScoreZ.safeParse(res.parsed);
      if (!parsed.success) return null;
      const perItem = validateJudgeItems(parsed.data.items, flat.items);
      if (!perItem) return null;
      const total = totalFor(perItem, flat.items, flat.weightByCat, flat.catPoints);
      return { judge: `${j.provider}:${j.tier}`, resolved_model: res.resolvedModel, total, per_item: perItem };
    }),
  );
  const surviving = results.filter((r): r is NonNullable<typeof r> => r !== null);
  if (surviving.length === 0) return null;

  const totals = surviving.map((s) => s.total);
  const score = totals.reduce((a, b) => a + b, 0) / totals.length;
  const spread = Math.max(...totals) - Math.min(...totals);
  const effective_config_hash = createHash('sha1')
    .update([
      'oneshot',
      RUBRIC_PROMPT_VERSION,
      SCORE_PROMPT_VERSION,
      rubric.generated_by_model,
      ...surviving.map((s) => s.resolved_model),
    ].join('|'))
    .digest('hex');

  return {
    session_id: run.ref.key,
    tenant_id: run.ref.tenantId,
    rubric_id: rubric.rubric_id,
    rubric_prompt_version: RUBRIC_PROMPT_VERSION,
    score_prompt_version: SCORE_PROMPT_VERSION,
    effective_config_hash,
    judges: surviving,
    score,
    spread,
    artifacts_present: artifactsPresent,
    created_at: new Date().toISOString(),
  };
}
