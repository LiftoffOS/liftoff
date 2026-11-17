// The bounded walk over an opaque vendor result: every string through the
// browser text sanitizer, every bound a labelled truncation rather than raw
// JSON, and what an ordinary result keeps.

import {
  sanitizeResultTree, RESULT_TREE_MAX_DEPTH, RESULT_TREE_MAX_KEYS, RESULT_TREE_MAX_ITEMS, RESULT_TREE_TRUNCATED,
} from '../result-sanitizer';

describe('sanitizeResultTree', () => {
  it('keeps an ordinary result byte-identical in shape and order', () => {
    const anchor = { status: 'completed', result: { answer: 'x', count: 3, ok: true, none: null }, data: { steps: 3 }, list: ['a', 'b'] };
    const out = sanitizeResultTree(anchor);
    expect(JSON.stringify(out.value)).toBe(JSON.stringify(anchor));
    expect(out).toMatchObject({ truncated: false, protectedDataOmitted: false });
  });

  it('sanitizes every string, nested keys and array items included, and says so', () => {
    const out = sanitizeResultTree({
      message: 'Signed in with password=hunter2 to https://a.example/reset-password/3f2a91b8c07d4e659a1b0d3e5f7a9b1c',
      steps: [{ note: 'card 4111 1111 1111 1111' }],
    });
    expect(out.value).toEqual({
      message: 'Signed in with password=[redacted] to https://a.example/reset-password/[redacted]',
      steps: [{ note: 'card [redacted]' }],
    });
    expect(out.protectedDataOmitted).toBe(true);
  });

  it('bounds depth, keys and items with a labelled truncation, and drops a function', () => {
    let deep: Record<string, unknown> = { leaf: 'x' };
    for (let i = 0; i < RESULT_TREE_MAX_DEPTH + 2; i++) deep = { child: deep };
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < RESULT_TREE_MAX_KEYS + 5; i++) wide[`k${i}`] = i;
    const long = Array.from({ length: RESULT_TREE_MAX_ITEMS + 5 }, (_, i) => i);
    const out = sanitizeResultTree({ deep, wide, long, fn: () => 1 });
    expect(out.truncated).toBe(true);
    expect(JSON.stringify(out.value)).toContain(RESULT_TREE_TRUNCATED);
    expect((out.value as { long: unknown[] }).long).toHaveLength(RESULT_TREE_MAX_ITEMS + 1);
    expect((out.value as { long: unknown[] }).long[RESULT_TREE_MAX_ITEMS]).toBe(RESULT_TREE_TRUNCATED);
    expect((out.value as { fn: unknown }).fn).toBe(RESULT_TREE_TRUNCATED);
    expect(Object.keys((out.value as { wide: Record<string, unknown> }).wide)).toHaveLength(RESULT_TREE_MAX_KEYS + 1);
  });

  it('a cycle becomes a labelled truncation rather than a hang', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    const out = sanitizeResultTree(a);
    expect(out.value).toEqual({ name: 'a', self: RESULT_TREE_TRUNCATED });
    expect(out.truncated).toBe(true);
  });

  it('passes scalars and null through', () => {
    expect(sanitizeResultTree('plain').value).toBe('plain');
    expect(sanitizeResultTree(42).value).toBe(42);
    expect(sanitizeResultTree(null).value).toBeNull();
    expect(sanitizeResultTree(undefined).value).toBeNull();
    expect(sanitizeResultTree(Number.NaN).value).toBeNull();
  });
});
