// The extraction: the selection walked from the query, chunked, answered by
// a small model per chunk, folded into one digest; per record with saveAs,
// into a derived dataset; bounded and refused with the remedy past the bound.

const mockComplete = jest.fn();
jest.mock('../../llm', () => ({ llmClient: { complete: (...a: unknown[]) => mockComplete(...a) } }));
const mockQueryDatasets = jest.fn();
jest.mock('../query', () => ({
  ...jest.requireActual('../query'),
  queryDatasets: (...a: unknown[]) => mockQueryDatasets(...a),
}));
const mockCreateDataset = jest.fn();
jest.mock('../store', () => ({
  ...jest.requireActual('../store'),
  createDataset: (...a: unknown[]) => mockCreateDataset(...a),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { DatasetExtractError, extractFromDataset } from '../extract';

const ID = '2f6f2a2e-0d4c-4e0e-9a6e-2c6b7f3f1a11';
const ctx = { scope: { kind: 'liftoff_thread' as const, id: 'th-1' }, purpose: 'liftoff_dataset_extract' };

/** A query mock serving `records` in pages of the requested limit. */
function serve(records: Array<Record<string, unknown>>): void {
  mockQueryDatasets.mockImplementation(async (_t: string, q: { limit?: number; offset?: number }) => {
    const limit = q.limit ?? 50;
    const offset = q.offset ?? 0;
    return { rows: records.slice(offset, offset + limit), total: records.length, offset, limit };
  });
}

function calls(): Array<{ system: string; user: string; tier: string; maxTokens: number; usage: unknown }> {
  return mockComplete.mock.calls.map(([req, , usage]) => ({
    system: req.messages[0].content,
    user: req.messages[1].content,
    tier: req.tier,
    maxTokens: req.maxTokens,
    usage,
  }));
}

beforeEach(() => {
  mockComplete.mockReset();
  mockQueryDatasets.mockReset();
  mockCreateDataset.mockReset();
});

it('one chunk: the small model answers the instruction over the records, cited by ordinal, and that is the digest', async () => {
  serve([{ _ordinal: 1, body: 'pricing is too high' }, { _ordinal: 2, body: 'love the onboarding' }]);
  mockComplete.mockResolvedValue({ content: '  Two themes: price [#1], onboarding [#2].  ' });
  const out = await extractFromDataset('t1', { datasetId: ID, instruction: 'What are the themes?', select: ['body'] }, ctx);
  expect(out).toEqual({ digest: 'Two themes: price [#1], onboarding [#2].', records: 2 });
  expect(mockQueryDatasets).toHaveBeenCalledWith('t1', { datasetIds: [ID], select: ['body'], where: undefined, limit: 200, offset: 0 });
  const [call] = calls();
  expect(call.tier).toBe('small');
  expect(call.maxTokens).toBe(1500);
  expect(call.usage).toEqual({ tenantId: 't1', purpose: 'liftoff_dataset_extract' });
  expect(call.system).toContain('cite records by ordinal');
  expect(call.user).toBe('Instruction: What are the themes?\n\nRecords:\n{"_ordinal":1,"body":"pricing is too high"}\n{"_ordinal":2,"body":"love the onboarding"}');
  expect(mockCreateDataset).not.toHaveBeenCalled();
});

it('many chunks: each is answered, then one call folds the partial answers into the digest', async () => {
  const records = Array.from({ length: 300 }, (_, i) => ({ _ordinal: i + 1, body: `${i} ${'w'.repeat(600)}` }));
  serve(records);
  mockComplete.mockImplementation(async (req: { messages: Array<{ content: string }> }) => ({
    content: req.messages[0].content.startsWith('You are given partial answers') ? 'FOLDED' : `part of ${req.messages[1].content.length}`,
  }));
  const out = await extractFromDataset('t1', { datasetId: ID, instruction: 'Summarise' }, ctx);
  expect(out.digest).toBe('FOLDED');
  expect(out.records).toBe(300);
  const all = calls();
  const maps = all.filter((c) => !c.system.startsWith('You are given partial answers'));
  const reduces = all.filter((c) => c.system.startsWith('You are given partial answers'));
  expect(maps.length).toBeGreaterThan(3);
  expect(reduces).toHaveLength(1);
  for (const m of maps) expect(m.user.length).toBeLessThanOrEqual(40_000 + 'Instruction: Summarise\n\nRecords:\n'.length);
  expect(reduces[0].user).toContain('--- part 1 ---');
  expect(reduces[0].user).toContain(`--- part ${maps.length} ---`);
  expect(reduces[0].maxTokens).toBe(1200);
  // The selection was walked in pages of 200.
  expect(mockQueryDatasets).toHaveBeenCalledTimes(2);
});

it('per record with saveAs: one answer a record, kept as a derived dataset, and the digest folded from them', async () => {
  serve([{ _ordinal: 1, body: 'a' }, { _ordinal: 2, body: 'b' }, { _ordinal: 3, body: 'c' }]);
  mockComplete
    .mockResolvedValueOnce({ content: '1\tprice\n#2: none\n3 - onboarding\nnoise line' })
    .mockResolvedValueOnce({ content: 'digest of answers' });
  mockCreateDataset.mockResolvedValue({ id: '3a6f2a2e-0d4c-4e0e-9a6e-2c6b7f3f1a22', recordCount: 2, added: 2, truncated: false, fields: [], run: 1 });
  const out = await extractFromDataset('t1', { datasetId: ID, instruction: 'Main complaint', saveAs: ' complaints ' }, ctx);
  expect(out).toEqual({ digest: 'digest of answers', records: 3, derived: { id: '3a6f2a2e-0d4c-4e0e-9a6e-2c6b7f3f1a22', recordCount: 2 } });
  expect(calls()[0].system).toContain('one line per record');
  expect(calls()[0].maxTokens).toBe(4000);
  expect(mockCreateDataset).toHaveBeenCalledWith('t1', {
    scope: ctx.scope, label: 'complaints', source: 'derived', sourceRef: `dataset:${ID}`,
    records: [{ ordinal: 1, answer: 'price' }, { ordinal: 3, answer: 'onboarding' }],
  });
  expect(calls()[1].user).toContain('[#1] price\n[#3] onboarding');
});

it('a long digest is cut at the bound', async () => {
  serve([{ _ordinal: 1, body: 'a' }]);
  mockComplete.mockResolvedValue({ content: 'd'.repeat(5000) });
  const out = await extractFromDataset('t1', { datasetId: ID, instruction: 'x' }, ctx);
  expect(out.digest).toHaveLength(3001);
  expect(out.digest.endsWith('…')).toBe(true);
});

it('refuses an over-wide selection before reading it, and a selection too large to read', async () => {
  mockQueryDatasets.mockResolvedValue({ rows: [], total: 5000, offset: 0, limit: 200 });
  await expect(extractFromDataset('t1', { datasetId: ID, instruction: 'x' }, ctx)).rejects.toThrow(/5000 records match, more than the 2000 one extraction reads/);
  expect(mockQueryDatasets).toHaveBeenCalledTimes(1);
  expect(mockComplete).not.toHaveBeenCalled();

  serve(Array.from({ length: 200 }, (_, i) => ({ _ordinal: i + 1, body: 'q'.repeat(11_000) })));
  await expect(extractFromDataset('t1', { datasetId: ID, instruction: 'x' }, ctx)).rejects.toThrow(/over 2000k characters/);
  expect(mockComplete).not.toHaveBeenCalled();
});

it('with a limit, reads the first records of a wide selection', async () => {
  serve(Array.from({ length: 5000 }, (_, i) => ({ _ordinal: i + 1, body: 'b' })));
  mockComplete.mockResolvedValue({ content: 'ok' });
  const out = await extractFromDataset('t1', { datasetId: ID, instruction: 'x', limit: 250 }, ctx);
  expect(out.records).toBe(250);
  expect(mockQueryDatasets).toHaveBeenNthCalledWith(1, 't1', expect.objectContaining({ limit: 200, offset: 0 }));
  expect(mockQueryDatasets).toHaveBeenNthCalledWith(2, 't1', expect.objectContaining({ limit: 50, offset: 200 }));
});

it('refuses a bad id or an empty instruction, and answers plainly when nothing matches', async () => {
  await expect(extractFromDataset('t1', { datasetId: 'cap_x', instruction: 'x' }, ctx)).rejects.toThrow(DatasetExtractError);
  await expect(extractFromDataset('t1', { datasetId: ID, instruction: '  ' }, ctx)).rejects.toThrow(/instruction is required/);
  serve([]);
  expect(await extractFromDataset('t1', { datasetId: ID, instruction: 'x' }, ctx)).toEqual({ digest: 'No records match the selection; nothing to extract from.', records: 0 });
  expect(mockComplete).not.toHaveBeenCalled();
});

describe('grouped mode: one answer per group in one call', () => {
  /** 275 records in 20 groups of unequal size (post 1 holds the most), as the
   *  comments under twenty posts would arrive. */
  function commentsOfTwentyPosts(): Array<Record<string, unknown>> {
    const records: Array<Record<string, unknown>> = [];
    let ordinal = 0;
    for (let post = 1; post <= 20; post++) {
      // 37 + 30 + 8 × 12 + 9 × 11 + 13 = 275.
      const count = post === 1 ? 37 : post === 2 ? 30 : post <= 10 ? 12 : post === 20 ? 13 : 11;
      for (let i = 0; i < count; i++) records.push({ _ordinal: ++ordinal, postId: `p${post}`, body: `comment ${i} on post ${post}` });
    }
    return records;
  }

  it('answers the instruction once per group, largest group first, keeps every answer as a derived dataset, and reports it', async () => {
    const records = commentsOfTwentyPosts();
    expect(records).toHaveLength(275);
    serve(records);
    mockComplete.mockImplementation(async (req: { messages: Array<{ content: string }> }) => {
      const m = /"postId":"(p\d+)"/.exec(req.messages[1].content);
      return { content: `summary of ${m?.[1]}` };
    });
    mockCreateDataset.mockResolvedValue({ id: 'derived-1', recordCount: 20, added: 20, truncated: false, fields: [], run: 1 });

    const out = await extractFromDataset('t1', { datasetId: ID, instruction: 'Summarise the discussion', groupBy: 'postId' }, ctx);

    // One small call per group, none folded: every group fits one chunk.
    expect(calls()).toHaveLength(20);
    expect(calls().every((c) => c.tier === 'small' && !c.system.startsWith('You are given partial answers'))).toBe(true);
    expect(out.records).toBe(275);
    expect(out.groups).toHaveLength(20);
    expect(out.groups![0]).toEqual({ group: 'p1', records: 37, answer: 'summary of p1' });
    expect(out.groups![1]).toEqual({ group: 'p2', records: 30, answer: 'summary of p2' });
    expect(out.groups!.map((g) => g.records).reduce((a, b) => a + b, 0)).toBe(275);
    // Every answer is kept, as {group, records, answer}, under the default label.
    expect(mockCreateDataset).toHaveBeenCalledTimes(1);
    const stored = mockCreateDataset.mock.calls[0][1] as { label: string; source: string; sourceRef: string; records: unknown[] };
    expect(stored.label).toBe('Summarise the discussion by postId');
    expect(stored.source).toBe('derived');
    expect(stored.sourceRef).toBe(`dataset:${ID}`);
    expect(stored.records).toHaveLength(20);
    expect(stored.records[0]).toEqual({ group: 'p1', records: 37, answer: 'summary of p1' });
    expect(out.derived).toEqual({ id: 'derived-1', recordCount: 20 });
  });

  it('saveAs only names the derived dataset in grouped mode; it never switches to per record', async () => {
    serve(commentsOfTwentyPosts());
    mockComplete.mockResolvedValue({ content: 'a summary' });
    mockCreateDataset.mockResolvedValue({ id: 'derived-2', recordCount: 20, added: 20, truncated: false, fields: [], run: 1 });

    const out = await extractFromDataset('t1', { datasetId: ID, instruction: 'Summarise', groupBy: 'postId', saveAs: 'thread summaries' }, ctx);

    expect(out.groups).toHaveLength(20);
    expect(calls()).toHaveLength(20);
    // The per-record system prompt was never used.
    expect(calls().every((c) => !c.system.includes('apply to EACH record'))).toBe(true);
    expect((mockCreateDataset.mock.calls[0][1] as { label: string }).label).toBe('thread summaries');
  });

  it('refuses more than fifty groups with the remedy, naming the first fifty by size', async () => {
    const records = Array.from({ length: 120 }, (_, i) => ({ _ordinal: i + 1, author: `user${i % 60}`, body: 'x' }));
    serve(records);
    await expect(extractFromDataset('t1', { datasetId: ID, instruction: 'Summarise', groupBy: 'author' }, ctx))
      .rejects.toThrow(DatasetExtractError);
    await expect(extractFromDataset('t1', { datasetId: ID, instruction: 'Summarise', groupBy: 'author' }, ctx))
      .rejects.toThrow(/60 groups of author, more than the 50 one extraction answers; narrow with where, or pass limit.*The first 50 groups by size are user0, /);
    expect(mockComplete).not.toHaveBeenCalled();
    expect(mockCreateDataset).not.toHaveBeenCalled();
  });

  it('a group larger than one chunk is mapped and folded within itself', async () => {
    const records = [
      ...Array.from({ length: 120 }, (_, i) => ({ _ordinal: i + 1, postId: 'big', body: `${i} ${'w'.repeat(600)}` })),
      { _ordinal: 121, postId: 'small', body: 'one comment' },
    ];
    serve(records);
    mockComplete.mockImplementation(async (req: { messages: Array<{ content: string }> }) => ({
      content: req.messages[0].content.startsWith('You are given partial answers') ? 'FOLDED big' : 'part',
    }));
    mockCreateDataset.mockResolvedValue({ id: 'derived-3', recordCount: 2, added: 2, truncated: false, fields: [], run: 1 });

    const out = await extractFromDataset('t1', { datasetId: ID, instruction: 'Summarise', groupBy: 'postId' }, ctx);

    expect(out.groups).toEqual([
      { group: 'big', records: 120, answer: 'FOLDED big' },
      { group: 'small', records: 1, answer: 'part' },
    ]);
    const reduces = calls().filter((c) => c.system.startsWith('You are given partial answers'));
    expect(reduces).toHaveLength(1);
  });

  it('reads the group field even when the selection did not name it, and files records without a value under (none)', async () => {
    serve([
      { _ordinal: 1, postId: 'p1', body: 'a' },
      { _ordinal: 2, body: 'no post' },
      { _ordinal: 3, postId: 'p1', body: 'b' },
    ]);
    mockComplete.mockResolvedValue({ content: 'ok' });
    mockCreateDataset.mockResolvedValue({ id: 'derived-4', recordCount: 2, added: 2, truncated: false, fields: [], run: 1 });

    const out = await extractFromDataset('t1', { datasetId: ID, instruction: 'Summarise', groupBy: 'postId', select: ['body'] }, ctx);

    // The query was asked for the group field beside the selection.
    expect(mockQueryDatasets.mock.calls[0][1]).toMatchObject({ select: ['body', 'postId'] });
    expect(out.groups!.map((g) => [g.group, g.records])).toEqual([['p1', 2], ['(none)', 1]]);
  });
});
