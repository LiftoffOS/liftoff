// What the model reads: the view in place of a large result, query rows
// within a budget, the job's list — each bounded and saying what it left out.

import { renderDatasetList, renderDatasetView, renderQueryResult } from '../render';

const ID = '2f6f2a2e-0d4c-4e0e-9a6e-2c6b7f3f1a11';

describe('renderDatasetView', () => {
  it('names the count, the id, the label, the fields with their shape, a shortened sample, and the way to read it', () => {
    const text = renderDatasetView({
      id: ID,
      label: 'records: subreddit founder',
      recordCount: 92,
      truncated: false,
      fields: [
        { name: 'title', type: 'text', present: 1, avgChars: 58, sample: 'How I…' },
        { name: 'score', type: 'number', present: 1, sample: '10' },
        { name: 'selftext', type: 'text', present: 0.9, avgChars: 1834 },
        { name: 'comments', type: 'list', present: 0.7, avgItems: 12.4 },
        { name: 'flair', type: 'text', present: 0.2, avgChars: 8 },
        ...Array.from({ length: 10 }, (_, i) => ({ name: `f${i}`, type: 'text' as const, present: 0.1 })),
        { name: '_run', type: 'number', present: 1 },
      ],
      sample: [
        { title: 'How I got my first customers', score: 10, selftext: 'y'.repeat(500), comments: [1, 2, 3], empty: null },
        { title: 'Second', score: 2 },
      ],
    });
    expect(text).toContain(`92 records were fetched and kept as dataset ${ID} ("records: subreddit founder").`);
    expect(text).toContain('Fields: title (text), score (number), selftext (text, avg 1.8k chars), comments (list, avg 12.4 items), flair (text, in 20%), f0 (text, in 10%)');
    expect(text).toContain('; also f7, f8, f9; _run (number: which run added the record).');
    expect(text).toContain('Sample (2 of 92, long values shortened):');
    expect(text).toContain(`"selftext":"${'y'.repeat(160)}…[+340 chars]"`);
    expect(text).toContain('{"title":"Second","score":2}');
    expect(text).not.toContain('"empty"');
    expect(text).toContain('dataset_query');
    expect(text).toContain('dataset_extract');
    expect(text).toContain('do not run the capability again');
  });

  it('says when the kept records are the first of a larger result', () => {
    const text = renderDatasetView({ id: ID, label: 'l', recordCount: 50000, truncated: true, fields: [], sample: [] });
    expect(text).toContain('The first 50000 records of a larger result were fetched and kept');
    expect(text).toContain('Fields: no named fields.');
    expect(text).not.toContain('Sample');
  });
});

describe('renderQueryResult', () => {
  const rows = (n: number, body = 'x'.repeat(300)) => Array.from({ length: n }, (_, i) => ({ _ordinal: i + 1, title: `T${i + 1}`, body }));

  it('renders one row a line with long values shortened, and says which rows of the total these are', () => {
    const text = renderQueryResult({ rows: rows(3), total: 92, offset: 0, limit: 3 }, ['title', 'body']);
    expect(text).toContain(`{"_ordinal":1,"title":"T1","body":"${'x'.repeat(240)}…[+60 chars]"}`);
    expect(text).toMatch(/\n\nRows 1–3 of 92 matching records\. Next: offset 3\.$/);
  });

  it('gives a sole selected text field its room, and says when the page is the last', () => {
    const text = renderQueryResult({ rows: rows(2), total: 2, offset: 0, limit: 50 }, ['body']);
    expect(text).toContain(`"body":"${'x'.repeat(300)}"`);
    expect(text).toMatch(/Rows 1–2 of 2 matching records\. That is every match\.$/);
  });

  it('cuts a page that is over the budget and says how many rows it left out', () => {
    const text = renderQueryResult({ rows: rows(100, 'z'.repeat(200)), total: 100, offset: 0, limit: 100 }, undefined);
    const shown = (text.match(/"_ordinal":/g) ?? []).length;
    expect(shown).toBeGreaterThan(10);
    expect(shown).toBeLessThan(100);
    expect(text).toContain(`Rows 1–${shown} of 100 matching records (${100 - shown} of this page left out for length`);
    expect(text).toContain(`Next: offset ${shown}.`);
  });

  it('says when nothing matches, and when one row alone is too large', () => {
    expect(renderQueryResult({ rows: [], total: 0, offset: 0, limit: 50 }, undefined)).toMatch(/^No records match/);
    const huge = { _ordinal: 1, ...Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`f${i}`, 'q'.repeat(200)])) };
    expect(renderQueryResult({ rows: [huge], total: 1, offset: 0, limit: 1 }, undefined)).toMatch(/^The first row alone is over the size/);
  });
});

describe('renderDatasetList', () => {
  it('lists each dataset with its id, label, count and fields, or says there are none', () => {
    expect(renderDatasetList([])).toMatch(/^No datasets are kept/);
    const text = renderDatasetList([
      { id: ID, label: 'posts', source: 's', sourceRef: 'r', recordCount: 92, bytes: 1, fields: [{ name: 'title', type: 'text', present: 1 }], createdAt: new Date() },
    ]);
    expect(text).toBe(`- ${ID} "posts": 92 records; fields title (text)`);
  });
});

import { renderAggregateResult, renderGroupedExtract } from '../render';

describe('renderGroupedExtract', () => {
  const groups = (n: number, answer = 'a summary') => Array.from({ length: n }, (_, i) => ({ group: `p${i + 1}`, records: 20 - i, answer }));

  it('renders one line a group and names the derived dataset that holds every answer', () => {
    const text = renderGroupedExtract(groups(3), { id: ID, recordCount: 3 }, 57);
    expect(text).toBe(
      '- p1 (20 records): a summary\n- p2 (19 records): a summary\n- p3 (18 records): a summary\n\n'
      + `3 groups, answered over 57 records. Every group's answer is kept as dataset ${ID} (3 records; fields group, records, answer) — query it with dataset_query.`,
    );
  });

  it('shows as many groups as fit the row budget and says how many were left out, still naming the dataset with every one', () => {
    const text = renderGroupedExtract(groups(50, 'z'.repeat(1_000)), { id: ID, recordCount: 50 }, 900);
    const shown = (text.match(/^- p\d+ \(/gm) ?? []).length;
    expect(shown).toBeGreaterThan(5);
    expect(shown).toBeLessThan(50);
    expect(text).toContain(`${shown} of 50 groups shown; ${50 - shown} left out for length. Every group's answer is kept as dataset ${ID} (50 records`);
    expect(text.length).toBeLessThan(13_000);
  });

  it('says when the answers could not be kept', () => {
    expect(renderGroupedExtract(groups(1), undefined, 20)).toContain('could not be kept as a dataset this time');
  });
});

describe('renderAggregateResult', () => {
  it('renders the count, and the distinct values with their counts', () => {
    expect(renderAggregateResult({ count: 17 })).toBe('17 matching records.');
    expect(renderAggregateResult({ count: 1 })).toBe('1 matching record.');
    expect(renderAggregateResult({ distinct: { field: 'author', values: [{ value: 'alice', count: 12 }, { value: null, count: 1 }] } }))
      .toBe('Distinct values of author (2, most frequent first):\n"alice": 12\n(none): 1');
    expect(renderAggregateResult({ count: 0, distinct: { field: 'author', values: [] } }))
      .toBe('0 matching records.\n\nNo records match, so author has no values here.');
  });
});

import { DATASET_INVENTORY_BUDGET_TOKENS, renderDatasetInventory } from '../render';

describe('renderDatasetInventory', () => {
  const summary = (i: number, over: Partial<Parameters<typeof renderDatasetInventory>[0][number]> = {}) => ({
    id: `2f6f2a2e-0d4c-4e0e-9a6e-2c6b7f3f1a${String(i).padStart(2, '0')}`,
    label: `dataset ${i}`, source: 's', sourceRef: 'r', recordCount: 100 + i, bytes: 1,
    fields: [{ name: 'body', type: 'text' as const, present: 1, avgChars: 380 }, { name: 'postId', type: 'text' as const, present: 1 }],
    createdAt: new Date(), runs: 1, ...over,
  });

  it('is empty when the conversation holds no datasets', () => {
    expect(renderDatasetInventory([])).toBe('');
  });

  it('names what is kept, how to read it and what is charged, then each dataset newest first with its runs and fields', () => {
    const text = renderDatasetInventory([summary(2, { runs: 2, recordCount: 275 }), summary(1)]);
    expect(text.startsWith('Datasets kept for this conversation. Read them with dataset_query (uses no model) or dataset_extract (uses the model and is metered like any answer); the fetch is not charged again, and dataset_list uses no model.\n')).toBe(true);
    const lines = text.split('\n').slice(1);
    expect(lines[0]).toBe(`- 2f6f2a2e-0d4c-4e0e-9a6e-2c6b7f3f1a02 "dataset 2" — 275 records, 2 runs; fields body (text, avg 380 chars), postId (text)`);
    expect(lines[1]).toBe(`- 2f6f2a2e-0d4c-4e0e-9a6e-2c6b7f3f1a01 "dataset 1" — 101 records; fields body (text, avg 380 chars), postId (text)`);
    expect(lines).toHaveLength(2);
    expect(text).not.toContain('older dataset');
    // Neither the free claim the shipped view made nor an inner term.
    expect(text).not.toMatch(/never charged|no charge|nothing charged/);
  });

  it('keeps the newest datasets that fit the budget, drops the oldest, and says only what dataset_list can return', () => {
    const many = Array.from({ length: 40 }, (_, i) => summary(40 - i));
    const text = renderDatasetInventory(many);
    expect(text.length).toBeLessThanOrEqual(DATASET_INVENTORY_BUDGET_TOKENS * 4 + 80);
    const shown = (text.match(/^- /gm) ?? []).length;
    expect(shown).toBeGreaterThan(3);
    expect(shown).toBeLessThan(40);
    // The newest is first and the ones shown are the newest.
    expect(text.split('\n')[1]).toContain('"dataset 40"');
    expect(text).toContain(`"dataset ${40 - shown + 1}"`);
    expect(text).not.toContain(`"dataset ${40 - shown}"`);
    expect(text.endsWith(`+${40 - shown} older datasets; dataset_list lists them.`)).toBe(true);
  });

  it('shows the newest even when it alone is over the budget', () => {
    const wide = summary(1, { fields: Array.from({ length: 200 }, (_, i) => ({ name: `field_number_${i}`, type: 'text' as const, present: 1 })) });
    const text = renderDatasetInventory([wide, summary(2)]);
    expect((text.match(/^- /gm) ?? []).length).toBe(1);
    expect(text).toContain('+1 older dataset; dataset_list lists them.');
  });
});
