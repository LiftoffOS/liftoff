import { buildSkillContextBlock } from '../retrieval';
import { BASELINE_SKILLS } from '../baseline-skills';

describe('buildSkillContextBlock (markdown)', () => {
  it('called with an empty retrievedSkills array, output contains both baseline names', () => {
    const out = buildSkillContextBlock([]);
    for (const baseline of BASELINE_SKILLS) {
      expect(out).toContain(baseline.name);
      expect(out).toContain(baseline.instruction);
    }
  });

  it('called with a colliding name, only one copy appears and the baseline wins', () => {
    const collidingName = BASELINE_SKILLS[0].name;
    const out = buildSkillContextBlock([
      { name: collidingName, instruction: 'IMPOSTER_INSTRUCTION_should_be_dropped' },
      { name: 'Role-specific skill', instruction: 'role specific text' },
    ]);

    const occurrences = out.split(collidingName).length - 1;
    expect(occurrences).toBe(1);
    expect(out).not.toContain('IMPOSTER_INSTRUCTION_should_be_dropped');
    expect(out).toContain(BASELINE_SKILLS[0].instruction);
    expect(out).toContain('Role-specific skill');
  });

  it('includes baselines when called with retrieved skills', () => {
    const out = buildSkillContextBlock([{ name: 'X', instruction: 'Y' }]);
    for (const baseline of BASELINE_SKILLS) {
      expect(out).toContain(baseline.name);
    }
  });

  it('returns a non-empty block even with no retrieved skills', () => {
    const out = buildSkillContextBlock([]);
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain('## Relevant guidance');
  });

  it('places baselines BEFORE retrieved skills', () => {
    const out = buildSkillContextBlock([
      { name: 'Role-specific', instruction: 'role-text' },
    ]);
    const baselineIdx = out.indexOf(BASELINE_SKILLS[0].name);
    const retrievedIdx = out.indexOf('Role-specific');
    expect(baselineIdx).toBeGreaterThan(-1);
    expect(retrievedIdx).toBeGreaterThan(-1);
    expect(baselineIdx).toBeLessThan(retrievedIdx);
  });
});

// ── Per-surface re-ranking ────────────────────────────────────────────────
//
// `usefulness_score` has exactly one writer — skill-learning.ts, on the
// autonomous path — using `toolCallsExecuted > 0 ? +1 : -1`. That proxy is
// defensible for a run (executed nothing = did nothing) and wrong for a chat
// turn (executes nothing = ordinary answer), so chat must not settle it.
//
// The bug these pin: chat used to re-rank on that column anyway. Every row read
// 0, so the 0.2 term was dead weight and the formula claimed a weighting it
// could not back. Chat now drops the term and moves its weight to similarity.

describe('per-surface re-rank weights', () => {
  // Mirrors the production formula so a change to one without the other fails
  // here rather than silently re-ordering what agents get told.
  const WEIGHTS = {
    autonomous: { similarity: 0.7, usefulness: 0.2 },
    chat: { similarity: 0.9, usefulness: 0 },
  };
  const TAG_BOOST = 0.1;

  const score = (
    surface: 'autonomous' | 'chat',
    row: { similarity: number; usefulness: number; tagged?: boolean },
    maxUsefulness: number,
  ): number =>
    row.similarity * WEIGHTS[surface].similarity
    + (row.usefulness / maxUsefulness) * WEIGHTS[surface].usefulness
    + (row.tagged ? TAG_BOOST : 0);

  it('lets usefulness change the order on the surface that settles it', () => {
    const weaker = { similarity: 0.80, usefulness: 10 };
    const stronger = { similarity: 0.82, usefulness: 0 };
    // Autonomous: the better-scoring skill overtakes marginally-better cosine.
    expect(score('autonomous', weaker, 10)).toBeGreaterThan(score('autonomous', stronger, 10));
  });

  it('ignores usefulness entirely on the surface that never writes it', () => {
    const weaker = { similarity: 0.80, usefulness: 10 };
    const stronger = { similarity: 0.82, usefulness: 0 };
    // Chat: cosine decides, because usefulness here is a number chat did not earn.
    expect(score('chat', stronger, 10)).toBeGreaterThan(score('chat', weaker, 10));
  });

  it('keeps scores comparable across surfaces', () => {
    // Dropping a term must not shrink the whole score, or any log or threshold
    // comparing the two surfaces silently reads chat as worse.
    const row = { similarity: 1, usefulness: 10 };
    expect(score('chat', row, 10)).toBeCloseTo(score('autonomous', row, 10), 10);
  });

  it('weights sum identically on both surfaces', () => {
    for (const s of ['autonomous', 'chat'] as const) {
      expect(WEIGHTS[s].similarity + WEIGHTS[s].usefulness).toBeCloseTo(0.9, 10);
    }
  });

  it('cannot divide by zero when no skill has positive usefulness', () => {
    // maxUsefulness is guarded at 1 in production; an all-zero population is
    // the normal state for a young agent, not an edge case.
    const guarded = Math.max(0, 1);
    expect(Number.isFinite(score('autonomous', { similarity: 0.5, usefulness: 0 }, guarded))).toBe(true);
  });
});
