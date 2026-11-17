import { parseJudgeSpec, flattenRubric, validateJudgeItems, totalFor } from '../score';
import type { StoredRubric } from '../rubric';

const rubric: StoredRubric = {
  rubric_id: 'r1', session_id: 's1', tenant_id: 't1',
  prompt_version: 'rubric-v1', generated_by: 'anthropic:large', generated_by_model: 'm',
  created_at: 'now',
  categories: [
    { name: 'a', weight: 0.5, items: [
      { id: 'c0.i0', criterion: 'x', points: 60, verification: 'v' },
      { id: 'c0.i1', criterion: 'y', points: 40, verification: 'v' },
    ] },
    { name: 'b', weight: 0.5, items: [
      { id: 'c1.i0', criterion: 'z', points: 100, verification: 'v' },
    ] },
  ],
};

describe('parseJudgeSpec', () => {
  it('drops malformed, dedupes, and caps at 4', () => {
    const out = parseJudgeSpec('anthropic:large, bogus:tier, anthropic:large, google:medium, openai:small, openai:small, anthropic-vertex:large, google:small');
    // 'anthropic-vertex' is dropped with 'bogus': the provider is retired, so a
    // stale env spec naming it degrades to the valid entries rather than failing.
    expect(out.map((j) => `${j.provider}:${j.tier}`)).toEqual([
      'anthropic:large', 'google:medium', 'openai:small', 'google:small',
    ]);
  });
  it('reads the retired top-tier name as large, deduped against large itself', () => {
    // Deploy-time env (terraform, cloudbuild) can still carry the old name.
    expect(parseJudgeSpec('anthropic:flagship, anthropic:large, google:flagship').map((j) => `${j.provider}:${j.tier}`))
      .toEqual(['anthropic:large', 'google:large']);
  });
  it('falls back to the default mix on a blank/all-invalid input (never empty)', () => {
    expect(parseJudgeSpec('   ').map((j) => `${j.provider}:${j.tier}`)).toEqual(['anthropic:large', 'google:large']);
    expect(parseJudgeSpec('nope:nope').map((j) => `${j.provider}:${j.tier}`)).toEqual(['anthropic:large', 'google:large']);
  });
});

describe('validateJudgeItems', () => {
  const flat = flattenRubric(rubric).items;
  it('accepts exactly one finite result per id and clamps to rubric points', () => {
    const out = validateJudgeItems(
      [{ id: 'c0.i0', awarded: 100 }, { id: 'c0.i1', awarded: -5 }, { id: 'c1.i0', awarded: 50 }],
      flat,
    );
    expect(out).not.toBeNull();
    expect(out!.find((i) => i.id === 'c0.i0')!.awarded).toBe(60); // clamped to points
    expect(out!.find((i) => i.id === 'c0.i1')!.awarded).toBe(0);  // clamped to >=0
  });
  it('drops the judge on missing / duplicate / extra / non-finite', () => {
    expect(validateJudgeItems([{ id: 'c0.i0', awarded: 1 }, { id: 'c0.i1', awarded: 1 }], flat)).toBeNull(); // missing c1.i0
    expect(validateJudgeItems([{ id: 'c0.i0', awarded: 1 }, { id: 'c0.i0', awarded: 1 }, { id: 'c1.i0', awarded: 1 }], flat)).toBeNull(); // dup
    expect(validateJudgeItems([{ id: 'c0.i0', awarded: 1 }, { id: 'c0.i1', awarded: 1 }, { id: 'c1.i0', awarded: 1 }, { id: 'x', awarded: 1 }], flat)).toBeNull(); // extra
    expect(validateJudgeItems([{ id: 'c0.i0', awarded: Infinity }, { id: 'c0.i1', awarded: 1 }, { id: 'c1.i0', awarded: 1 }], flat)).toBeNull();
  });
});

describe('totalFor (weight-sum normalization)', () => {
  it('full marks → 100', () => {
    const { items, weightByCat, catPoints } = flattenRubric(rubric);
    const perItem = items.map((i) => ({ id: i.id, awarded: i.points, max: i.points }));
    expect(totalFor(perItem, items, weightByCat, catPoints)).toBeCloseTo(100);
  });
  it('normalizes by the validated weight sum even when weights do not sum to 1', () => {
    const skewed: StoredRubric = { ...rubric, categories: rubric.categories.map((c) => ({ ...c, weight: 0.48 })) };
    const { items, weightByCat, catPoints } = flattenRubric(skewed);
    const perItem = items.map((i) => ({ id: i.id, awarded: i.points, max: i.points }));
    expect(totalFor(perItem, items, weightByCat, catPoints)).toBeCloseTo(100); // 0.48 weights normalise out
  });
});
