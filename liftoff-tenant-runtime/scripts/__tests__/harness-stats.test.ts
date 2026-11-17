// harness-stats — the aggregation, without needing Cloud Logging.
//
// The point of the script is that every W4 change cites a before and an after,
// so the numbers it prints have to be right and the window has to be stated.

import { parseArgs, quantiles, compare, normalizeEntries, HEADLINE, EVENT_FOR, REPORTS } from '../harness-stats';

describe('arguments', () => {
  // A window nobody chose produces a number nobody can compare against, which
  // is the situation this script exists to end.
  it('refuses to run without an explicit --since', () => {
    expect(() => parseArgs(['--report', 'catalog'])).toThrow(/--since is required/);
  });

  it('rejects a report it does not have', () => {
    expect(() => parseArgs(['--since', '2026-08-01', '--report', 'nonsense'])).toThrow(/--report must be one of/);
  });

  it('defaults to dev and the catalog report', () => {
    expect(parseArgs(['--since', '2026-08-01'])).toEqual({
      env: 'dev', since: '2026-08-01', report: 'catalog', limit: 5000,
    });
  });

  it('reads env, report and limit', () => {
    expect(parseArgs(['--env', 'prod', '--since', '2026-08-01', '--report', 'context-pressure', '--limit', '10']))
      .toEqual({ env: 'prod', since: '2026-08-01', report: 'context-pressure', limit: 10 });
  });
});

describe('every report is backed by an event we actually emit', () => {
  it.each(REPORTS)('%s', (report) => {
    expect(EVENT_FOR[report]).toBeTruthy();
  });

  it('covers the four the plan names', () => {
    expect(REPORTS).toEqual(['catalog', 'tool-results', 'prompt-tiers', 'context-pressure']);
  });
});

describe('quantiles', () => {
  // A mean hides exactly the tail these budgets exist to bound: the tool-result
  // distribution that motivated all of this was p50=350 and p99=33,275.
  it('reports the tail, not just the middle', () => {
    const values = [...Array(99).fill(100), 100000];
    const q = quantiles(values);
    expect(q.p50).toBe(100);
    expect(q.max).toBe(100000);
    expect(q.p95).toBeLessThan(q.max);
  });

  it('is order-independent', () => {
    expect(quantiles([5, 1, 3])).toEqual(quantiles([1, 3, 5]));
  });

  it('returns zeroes rather than NaN on an empty series', () => {
    expect(quantiles([])).toEqual({ n: 0, p50: 0, p95: 0, max: 0 });
  });

  it('handles a single sample', () => {
    expect(quantiles([42])).toEqual({ n: 1, p50: 42, p95: 42, max: 42 });
  });
});

// ── The comparison ──────────────────────────────────────────────────────────
//
// A before/after that reports the wrong direction is worse than no comparison,
// because it will be quoted.
describe('compare', () => {
  it('reports a reduction as down, with a negative delta', () => {
    const c = compare(16795, 6616);
    expect(c.direction).toBe('down');
    expect(c.delta).toBe(-10179);
    expect(c.percent).toBe('-60.6%');
  });

  it('reports a regression as up', () => {
    expect(compare(100, 150)).toMatchObject({ direction: 'up', delta: 50, percent: '50.0%' });
  });

  it('reports no movement as flat', () => {
    expect(compare(100, 100)).toMatchObject({ direction: 'flat', delta: 0, percent: '0.0%' });
  });

  // A percentage against a zero baseline is not a percentage. Said rather than
  // printed as Infinity and left for the reader to interpret.
  it('refuses a percentage with no baseline', () => {
    expect(compare(0, 500).percent).toBe('n/a (no baseline)');
  });
});

describe('headline metrics', () => {
  it('every report has one, so a comparison always has something to print', () => {
    for (const report of REPORTS) {
      expect(HEADLINE[report]).toBeDefined();
      expect(typeof HEADLINE[report].label).toBe('string');
    }
  });

  it('the catalog headline is the schema-char median', () => {
    const entries = [{ schemaChars: 100 }, { schemaChars: 200 }, { schemaChars: 300 }];
    expect(HEADLINE.catalog.of(entries)).toBe(200);
  });

  it('a report with no matching entries yields zero rather than NaN', () => {
    for (const report of REPORTS) {
      expect(HEADLINE[report].of([])).toBe(0);
    }
  });
});

describe('entry normalization', () => {
  // Two shapes an operator can produce: raw `gcloud logging read` output, and
  // an already-unwrapped array from `jq '.[].jsonPayload'`.
  it('unwraps raw Cloud Logging entries', () => {
    const out = normalizeEntries([{ jsonPayload: { event: 'tool_catalog_size', toolCount: 3 } }], 'tool_catalog_size');
    expect(out).toEqual([{ event: 'tool_catalog_size', toolCount: 3 }]);
  });

  it('accepts already-unwrapped payloads', () => {
    const out = normalizeEntries([{ event: 'tool_catalog_size', toolCount: 3 }], 'tool_catalog_size');
    expect(out).toHaveLength(1);
  });

  // A file exported for one report must not be silently misread as another —
  // the numbers would be wrong and nothing would say so.
  it('drops entries belonging to a different event', () => {
    const out = normalizeEntries([
      { event: 'tool_catalog_size', toolCount: 3 },
      { event: 'prompt_tier_layout', stableChars: 10 },
    ], 'tool_catalog_size');
    expect(out).toEqual([{ event: 'tool_catalog_size', toolCount: 3 }]);
  });

  it('tolerates a non-array export rather than throwing', () => {
    expect(normalizeEntries({ not: 'an array' }, 'tool_catalog_size')).toEqual([]);
  });
});

describe('comparison arguments', () => {
  it('accepts a compare window', () => {
    const a = parseArgs([
      '--since', '2026-08-09', '--compare-since', '2026-08-01', '--compare-until', '2026-08-08',
    ]);
    expect(a.compareSince).toBe('2026-08-01');
    expect(a.compareUntil).toBe('2026-08-08');
  });

  it('refuses an end with no start', () => {
    expect(() => parseArgs(['--since', '2026-08-09', '--compare-until', '2026-08-08']))
      .toThrow(/--compare-until needs --compare-since/);
  });

  it('accepts a file source', () => {
    expect(parseArgs(['--since', '2026-08-01', '--file', '/tmp/export.json']).file).toBe('/tmp/export.json');
  });
});

describe('comparing two saved exports', () => {
  it('accepts a baseline export alongside the current one', () => {
    const a = parseArgs([
      '--since', '2026-08-09', '--file', '/tmp/after.json', '--compare-file', '/tmp/before.json',
    ]);
    expect(a.file).toBe('/tmp/after.json');
    expect(a.compareFile).toBe('/tmp/before.json');
  });

  // Reading the same file twice reports a delta of zero — a wrong answer
  // indistinguishable from "nothing changed", and one that would be quoted.
  it('refuses a file-mode comparison with no baseline file', () => {
    expect(() => parseArgs(['--since', '2026-08-09', '--file', '/tmp/after.json', '--compare-since', '2026-08-01']))
      .toThrow(/needs --compare-file/);
  });

  it('refuses to compare a saved export against a live query', () => {
    expect(() => parseArgs(['--since', '2026-08-09', '--compare-file', '/tmp/before.json']))
      .toThrow(/needs --file/);
  });
});
