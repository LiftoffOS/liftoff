import { generateEmbedding } from '../memory/embedding';
import { getPoolForService } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';
import { BASELINE_SKILLS } from './baseline-skills';
import type { SkillBundle } from '../instruction-compiler/internal-agent-instruction-service';

export interface RetrievedSkill {
  id: string;
  name: string;
  /** The skill's one-line purpose, and the text its embedding was generated
   *  against — so it is the closest thing to a summary the row has. Read by a
   *  disclosed render, which lists what a skill is FOR without sending its body. */
  description: string;
  instruction: string;
  tags: string[];
  similarity: number;
  /** Autonomous usefulness as stored. Present on every row so callers and
   *  tests can see what the re-rank saw; only weighted on the autonomous
   *  surface. */
  usefulnessScore: number;
  /** Final re-rank score the row was ordered by. */
  score: number;
  /** Files this skill ships with — pointers, resolved and materialized into the
   *  sandbox before the run uses them. Absent for the many skills that are text
   *  only. See migration 395. */
  bundle?: SkillBundle;
}

/**
 * Which surface is asking.
 *
 * `usefulness_score` is settled by exactly one writer — skill-learning.ts, on
 * the autonomous path — using the delta `toolCallsExecuted > 0 ? +1 : -1`. That
 * proxy is defensible there (a run that executed nothing did nothing) and wrong
 * for conversation (a turn that executes nothing is an ordinary answer), so
 * chat must not settle it.
 *
 * A surface that does not write the signal has no business weighting it: doing
 * so ranks on a number that is zero for every row, which is not a tie-break,
 * it is a claim the formula cannot back. So chat drops the term instead.
 */
export type RetrievalSurface = 'autonomous' | 'chat';

/**
 * Re-rank weights per surface. They sum to the same total so a skill's score is
 * comparable across surfaces: dropping the usefulness term on chat moves its
 * weight to similarity rather than shrinking the whole score, which would
 * otherwise make chat scores look systematically worse than autonomous ones in
 * any log or test that compared them.
 */
const RERANK_WEIGHTS: Record<RetrievalSurface, { similarity: number; usefulness: number }> = {
  autonomous: { similarity: 0.7, usefulness: 0.2 },
  chat: { similarity: 0.9, usefulness: 0 },
};

/** Additive bump for a skill tagged with one of the caller's context tags.
 *  Unchanged from the original formula, and identical on both surfaces. */
const TAG_BOOST = 0.1;

/**
 * Retrieve the top-K skills for a given objective using vector similarity, plus
 * usefulness re-ranking on the surface that actually settles usefulness.
 * Used by both autonomous execution and interactive chat to inject relevant guidance.
 */
export async function retrieveContextSkills(
  tenantId: string,
  agentId: string,
  objective: string,
  contextTags: string[],
  topK = 5,
  surface: RetrievalSurface = 'autonomous',
): Promise<RetrievedSkill[]> {
  try {
    const queryEmbedding = await generateEmbedding(objective, {
      tenantId,
      agentId,
      purpose: 'embedding_retrieval',
      taskType: 'retrieval_query',
    });

    const pool = getPoolForService('scheduled-execution');
    const oversampleK = topK * 3;

    // Fully literal SQL. An earlier revision interpolated a per-surface column
    // name here; it was safe only because the value came from a closed record,
    // which is a property a later edit can silently remove. One column, always,
    // and the surface decides its WEIGHT in JS below where nothing is
    // interpolated into a query.
    const result = await pool.query<{
      id: string;
      name: string;
      description: string;
      instruction: string;
      tags: string[];
      usefulness_score: number;
      similarity: number;
      bundle: SkillBundle | null;
    }>(
      `SELECT id, name, description, instruction, tags, usefulness_score, bundle,
              1 - (embedding <=> $1::vector) AS similarity
       FROM agent_skills
       WHERE agent_id = $2::uuid AND tenant_id = $3::uuid AND status = 'active'
         AND embedding IS NOT NULL
       ORDER BY embedding <=> $1::vector
       LIMIT $4`,
      [`[${queryEmbedding.join(',')}]`, agentId, tenantId, oversampleK],
    );

    if (result.rows.length === 0) return [];

    const weights = RERANK_WEIGHTS[surface];
    // Guarded at 1 so an all-zero (or all-negative) population cannot divide by
    // zero or invert the ordering. On chat the usefulness weight is 0, so this
    // term contributes nothing whatever the scores are.
    const maxUsefulness = Math.max(...result.rows.map(r => r.usefulness_score), 1);
    const reranked = result.rows
      .map(row => {
        const tagBoost = row.tags.some(t => contextTags.includes(t)) ? TAG_BOOST : 0;
        const score =
          row.similarity * weights.similarity
          + (row.usefulness_score / maxUsefulness) * weights.usefulness
          + tagBoost;
        return {
          id: row.id,
          name: row.name,
          // Carried so a disclosed render can say what a skill is FOR without
          // sending its body. It is also the embedding's own semantic anchor,
          // so it is the closest thing to a one-line summary that exists.
          description: row.description,
          instruction: row.instruction,
          tags: row.tags,
          similarity: row.similarity,
          usefulnessScore: row.usefulness_score,
          score,
          ...(row.bundle ? { bundle: row.bundle } : {}),
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    return reranked;
  } catch (err) {
    logger.warn({ tenantId, agentId, error: (err as Error).message },
      'retrieveContextSkills failed, returning empty skill set');
    return [];
  }
}

/** Prepend BASELINE_SKILLS and drop any retrieved skill whose name collides
 *  with a baseline (the baseline wins). Shared by markdown + text renderers
 *  so both prompt-build paths always include identity + communication
 *  guardrails regardless of what RAG returns. */
function prependBaselines<T extends { name: string; instruction: string }>(
  retrievedSkills: T[],
): Array<{ name: string; instruction: string }> {
  const baselineNames = new Set(BASELINE_SKILLS.map(s => s.name));
  const deduped = retrievedSkills.filter(s => !baselineNames.has(s.name));
  return [...BASELINE_SKILLS, ...deduped];
}

/** How retrieved skills are rendered into the prompt.
 *
 *  `inline` — every skill's full instruction, as today.
 *  `disclosed` — retrieved skills become one line each (name, id, description)
 *                plus a `read_skill(id)` tool the model calls when it wants the
 *                body.
 *
 *  Read from SKILL_DISCLOSURE_MODE, defaulting to `inline`. It is a real trade,
 *  not a free saving: tokens for a round trip, and a model that would have
 *  absorbed guidance passively may now skip reading it. That is measurable on an
 *  eval set and nowhere else, so the default stays where the behaviour is known.
 *
 *  WHAT THE TRADE IS WORTH. Retrieval takes the top 5, and disclosed mode keeps
 *  BASELINE_SKILLS inline in full, so for an agent with a handful of short
 *  skills the most this can remove from a prompt is a few thousand characters —
 *  on the order of a thousand tokens, a fraction of a percent of a 1M window. It
 *  buys that back a round trip at a time, and a round trip re-sends the whole
 *  prompt.
 *
 *  So for small skill sets the arithmetic settles it without an eval: disclosure
 *  cannot save enough to be worth one extra call, which is what the
 *  "costs more than it saves on a small set of short skills" test below
 *  asserts in miniature. Measure your agents' skill sizes before flipping the
 *  default.
 *
 *  The useful eval question is therefore not "should we turn this on" but "how
 *  large does an agent's retrieved skill block have to get before disclosure
 *  pays" — and the answer only matters once some agent's corpus is a large
 *  fraction of its prompt rather than a rounding error.
 *  `skills/eval/disclosure-tasks.ts` is the instrument for the accuracy half of
 *  that, which size data cannot answer. */
export type SkillDisclosureMode = 'inline' | 'disclosed';

/** The deployment's mode, or an explicit per-invocation override.
 *
 *  The override exists for one caller: the eval that answers whether the trade
 *  above is worth taking. Measuring it means running the same task both ways in
 *  the same deployment, which an env var read at two separate call sites cannot
 *  express. It is reachable only from the service-auth test-harness route, the
 *  same gate and the same reasoning as that route's model override.
 *
 *  Both the prompt render and the `read_skill` tool gate resolve through here,
 *  because the two must never disagree: a prompt that lists guidance the model
 *  has no tool to fetch, or a tool with nothing left to fetch, are both worse
 *  than either mode. */
export function skillDisclosureMode(override?: SkillDisclosureMode | null): SkillDisclosureMode {
  if (override) return override;
  return process.env.SKILL_DISCLOSURE_MODE === 'disclosed' ? 'disclosed' : 'inline';
}

export function buildSkillContextBlock(
  skills: Array<{
    id?: string;
    name: string;
    description?: string;
    instruction: string;
    /** What actually landed in the sandbox for this skill, when it ships files.
     *  Rendered under the skill so the model knows the paths exist and where
     *  they are. A skill whose files failed to materialize says so here rather
     *  than describing tools that are not there. */
    fileNote?: string;
  }>,
  mode: SkillDisclosureMode = 'inline',
): string {
  if (mode === 'inline') {
    const allSkills = prependBaselines(skills);
    const blocks = allSkills
      .map(s => {
        const note = (s as { fileNote?: string }).fileNote;
        return note ? `### ${s.name}\n${s.instruction}\n\n${note}` : `### ${s.name}\n${s.instruction}`;
      })
      .join('\n\n');
    return `## Relevant guidance\n\n${blocks}`;
  }

  // BASELINE_SKILLS stay inline and in full, always. They are identity and
  // safety guardrails, not retrieved suggestions, and a guardrail the model has
  // to decide to go and read is not a guardrail. Only the RETRIEVED skills are
  // reduced to a line each.
  const baselineNames = new Set(BASELINE_SKILLS.map(s => s.name));
  const baselineBlocks = BASELINE_SKILLS
    .map(s => `### ${s.name}\n${s.instruction}`)
    .join('\n\n');

  const retrieved = skills.filter(s => !baselineNames.has(s.name));
  // A skill with no id cannot be fetched back, so listing it by name alone would
  // advertise guidance the model has no way to reach. Rendered in full instead.
  const listable = retrieved.filter(s => s.id);
  const unlistable = retrieved.filter(s => !s.id);

  const parts = [`## Relevant guidance\n\n${baselineBlocks}`];
  if (unlistable.length > 0) {
    parts.push(
      unlistable
        .map(s => (s.fileNote ? `### ${s.name}\n${s.instruction}\n\n${s.fileNote}` : `### ${s.name}\n${s.instruction}`))
        .join('\n\n'),
    );
  }
  if (listable.length > 0) {
    const lines = listable
      .map(s => `- ${s.name} (${s.id})${s.description ? ` — ${s.description}` : ''}`)
      .join('\n');
    parts.push(
      '### Guidance available on request\n'
      + 'Each line is a skill you can read in full with read_skill(id). Read one '
      + 'before acting when it looks relevant to what you are about to do.\n'
      + lines,
    );
  }
  return parts.join('\n\n');
}
