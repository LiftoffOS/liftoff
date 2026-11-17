// Rubric generation: one LLM call producing a weighted JSON rubric, validated
// and stamped with stable per-item ids (c<catIdx>.i<itemIdx>) so scoring can be
// keyed by id and every item's max comes from here, never the scoring model.

import { z } from 'zod';
import { randomUUID } from 'crypto';
import type { ReconstructedRun } from '../../reconstruct/trace-model';
import { normalizeTier, type LLMProvider, type LLMModelTier } from '../../../llm/types';
import { runStructured } from '../judge/llm-judge';
import { serializeForGrading } from './serialize';
import { RUBRIC_SYSTEM, RUBRIC_PROMPT_VERSION } from './prompts';

const RubricZ = z
  .object({
    categories: z
      .array(
        z.object({
          name: z.string().max(60),
          weight: z.number().min(0).max(1),
          items: z
            .array(
              z.object({
                criterion: z.string().max(300),
                points: z.number().int().min(1).max(100),
                verification: z.string().max(500),
              }),
            )
            .min(1)
            .max(10),
        }),
      )
      .min(1)
      .max(6),
  })
  .refine((r) => Math.abs(r.categories.reduce((s, c) => s + c.weight, 0) - 1) < 0.05, {
    message: 'category weights must sum to ~1.0',
  });

export interface StoredRubricItem {
  id: string;
  criterion: string;
  points: number;
  verification: string;
}
export interface StoredRubricCategory {
  name: string;
  weight: number;
  items: StoredRubricItem[];
}
export interface StoredRubric {
  rubric_id: string;
  session_id: string;
  tenant_id: string;
  prompt_version: string;
  generated_by: string;      // requested provider:tier spec
  generated_by_model: string; // resolved model id
  categories: StoredRubricCategory[];
  created_at: string;
}

/** Resolve DIAGNOSTICS_RUBRIC_* env into a judge config override, defaulting to
 *  anthropic large. A blank/invalid value falls back to the default. */
function rubricCfg(spec?: string): { override: { provider: LLMProvider; tier: LLMModelTier; model?: string }; label: string } {
  const raw = (spec ?? process.env.DIAGNOSTICS_RUBRIC_MODEL ?? '').trim();
  const [provider, rawTier] = raw.split(':');
  const tier = normalizeTier(rawTier);
  const validProviders: LLMProvider[] = ['anthropic', 'openai', 'google'];
  const validTiers: LLMModelTier[] = ['large', 'medium', 'small'];
  const p = validProviders.includes(provider as LLMProvider) ? (provider as LLMProvider) : 'anthropic';
  const t = validTiers.includes(tier as LLMModelTier) ? (tier as LLMModelTier) : 'large';
  return { override: { provider: p, tier: t }, label: `${p}:${t}` };
}

export async function generateRubric(
  run: ReconstructedRun,
  artifactUris: string[],
  rubricModel?: string,
): Promise<StoredRubric | null> {
  const { text } = await serializeForGrading(run.trajectory, artifactUris);
  const cfg = rubricCfg(rubricModel);
  const res = await runStructured<z.infer<typeof RubricZ>>({
    system: RUBRIC_SYSTEM,
    user: text,
    tenantId: run.ref.tenantId,
    purpose: 'diagnostics_rubric_gen',
    cfgOverride: cfg.override,
  });
  if (!res) return null;
  const parsed = RubricZ.safeParse(res.parsed);
  if (!parsed.success) return null;

  const categories: StoredRubricCategory[] = parsed.data.categories.map((c, ci) => ({
    name: c.name,
    weight: c.weight,
    items: c.items.map((it, ii) => ({
      id: `c${ci}.i${ii}`,
      criterion: it.criterion,
      points: it.points,
      verification: it.verification,
    })),
  }));

  return {
    rubric_id: randomUUID(),
    session_id: run.ref.key,
    tenant_id: run.ref.tenantId,
    prompt_version: RUBRIC_PROMPT_VERSION,
    generated_by: cfg.label,
    generated_by_model: res.resolvedModel,
    categories,
    created_at: new Date().toISOString(),
  };
}
