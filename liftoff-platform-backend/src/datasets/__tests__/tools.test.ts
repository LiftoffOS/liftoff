// The dispatcher: the model's input read into the query, the extraction or
// the list; a bad input answered with the fix; a failure with what to do.

const mockQueryDatasets = jest.fn();
const mockAggregate = jest.fn();
const mockExtract = jest.fn();
const mockList = jest.fn();
jest.mock('../query', () => ({
  ...jest.requireActual('../query'),
  queryDatasets: (...a: unknown[]) => mockQueryDatasets(...a),
  aggregateDatasets: (...a: unknown[]) => mockAggregate(...a),
}));
jest.mock('../extract', () => ({
  ...jest.requireActual('../extract'),
  extractFromDataset: (...a: unknown[]) => mockExtract(...a),
}));
jest.mock('../store', () => ({
  ...jest.requireActual('../store'),
  listDatasets: (...a: unknown[]) => mockList(...a),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { DatasetQueryError } from '../query';
import { DatasetExtractError } from '../extract';
import { datasetTools, isDatasetTool, runDatasetTool } from '../tools';

const ID = '2f6f2a2e-0d4c-4e0e-9a6e-2c6b7f3f1a11';
const ctx = { scope: { kind: 'liftoff_thread' as const, id: 'th-1' }, purpose: 'liftoff_dataset_extract' };

beforeEach(() => {
  mockQueryDatasets.mockReset();
  mockExtract.mockReset();
  mockList.mockReset();
});

it('offers three tools, named for the model, none of which names a vendor or an inner term', () => {
  expect(datasetTools.map((t) => t.name)).toEqual(['dataset_query', 'dataset_extract', 'dataset_list']);
  expect(isDatasetTool('dataset_query')).toBe(true);
  expect(isDatasetTool('run_capability')).toBe(false);
  for (const t of datasetTools) {
    expect(t.description.toLowerCase()).not.toMatch(/\b(agent|apify|vendor|tenant|jsonb|sql)\b/);
  }
});

it('dataset_query: reads the id(s), fields, filters, sort and page from the input and renders the rows', async () => {
  mockQueryDatasets.mockResolvedValue({ rows: [{ _ordinal: 1, title: 'A', score: 10 }], total: 1, offset: 0, limit: 20 });
  const text = await runDatasetTool('t1', 'dataset_query', {
    datasetId: ID, datasetIds: ['3a6f2a2e-0d4c-4e0e-9a6e-2c6b7f3f1a22'], select: ['title', ' score ', ''], where: [{ field: 'score', op: 'gte', value: 5 }, 'junk'],
    sort: { field: 'score', dir: 'asc' }, limit: '20', offset: 0,
  }, ctx);
  expect(mockQueryDatasets).toHaveBeenCalledWith('t1', {
    datasetIds: [ID, '3a6f2a2e-0d4c-4e0e-9a6e-2c6b7f3f1a22'],
    select: ['title', 'score'],
    where: [{ field: 'score', op: 'gte', value: 5 }],
    sort: { field: 'score', dir: 'asc' },
    limit: 20,
    offset: 0,
  });
  expect(text).toContain('{"_ordinal":1,"title":"A","score":10}');
  expect(text).toContain('Rows 1–1 of 1 matching records. That is every match.');
});

it('dataset_extract: passes the instruction and the selection through and renders the digest, with a derived dataset when kept', async () => {
  mockExtract.mockResolvedValue({ digest: 'Themes: price.', records: 40, derived: { id: '3a6f2a2e-0d4c-4e0e-9a6e-2c6b7f3f1a22', recordCount: 38 } });
  const text = await runDatasetTool('t1', 'dataset_extract', { datasetId: ID, instruction: 'Themes?', select: ['body'], limit: 40, saveAs: 'themes' }, ctx);
  expect(mockExtract).toHaveBeenCalledWith('t1', { datasetId: ID, instruction: 'Themes?', select: ['body'], where: undefined, limit: 40, saveAs: 'themes', groupBy: undefined }, ctx);
  expect(text).toBe('Themes: price.\n\n(Answered over 40 records.)\n\nThe per-record answers are kept as dataset 3a6f2a2e-0d4c-4e0e-9a6e-2c6b7f3f1a22 (38 records; fields ordinal, answer) — query it with dataset_query.');
});

it('dataset_list: lists the job\'s datasets', async () => {
  mockList.mockResolvedValue([]);
  const text = await runDatasetTool('t1', 'dataset_list', {}, ctx);
  expect(mockList).toHaveBeenCalledWith('t1', ctx.scope);
  expect(text).toMatch(/^No datasets are kept/);
});

it('a bad input is answered with the fix; a failure with what to do next; nothing throws', async () => {
  mockQueryDatasets.mockRejectedValue(new DatasetQueryError('"a;b" is not a field name; use the field names the dataset lists (a nested field as a.b).'));
  expect(await runDatasetTool('t1', 'dataset_query', { datasetId: ID }, ctx)).toBe('"a;b" is not a field name; use the field names the dataset lists (a nested field as a.b).');
  mockExtract.mockRejectedValue(new DatasetExtractError('instruction is required: what to answer or extract from the records.'));
  expect(await runDatasetTool('t1', 'dataset_extract', { datasetId: ID }, ctx)).toBe('instruction is required: what to answer or extract from the records.');
  mockExtract.mockRejectedValue(new Error('provider down'));
  expect(await runDatasetTool('t1', 'dataset_extract', { datasetId: ID, instruction: 'x' }, ctx)).toMatch(/could not be answered right now/);
});

// A filter value travels as text on the wire — a typed property every
// vendor's schema takes — and is read back as the value it names.
it('dataset_query: reads a text value back as a number, a boolean, null or text, and `values` for in', async () => {
  mockQueryDatasets.mockResolvedValue({ rows: [], total: 0, offset: 0, limit: 50 });
  await runDatasetTool('t1', 'dataset_query', {
    datasetId: ID,
    where: [
      { field: 'score', op: 'gte', value: '12' },
      { field: 'ratio', op: 'lt', value: '3.5' },
      { field: 'pinned', op: 'eq', value: 'true' },
      { field: 'deleted', op: 'eq', value: 'null' },
      { field: 'title', op: 'contains', value: '12 rules' },
      { field: 'kind', op: 'in', values: ['post', 'link'] },
      { field: 'flair', op: 'in', value: 'a, b' },
    ],
  }, ctx);
  expect(mockQueryDatasets.mock.calls[0][1].where).toEqual([
    { field: 'score', op: 'gte', value: 12 },
    { field: 'ratio', op: 'lt', value: 3.5 },
    { field: 'pinned', op: 'eq', value: true },
    { field: 'deleted', op: 'eq', value: null },
    { field: 'title', op: 'contains', value: '12 rules' },
    { field: 'kind', op: 'in', value: ['post', 'link'] },
    { field: 'flair', op: 'in', value: ['a', 'b'] },
  ]);
});

// The two shapes Fix 3 adds: one call per group, and an aggregate instead of a page.
it('dataset_extract: passes groupBy through and renders the groups with the dataset that keeps every answer', async () => {
  mockExtract.mockResolvedValue({
    digest: '', records: 275,
    groups: [{ group: 'p1', records: 37, answer: 'summary one' }, { group: 'p2', records: 30, answer: 'summary two' }],
    derived: { id: '3a6f2a2e-0d4c-4e0e-9a6e-2c6b7f3f1a22', recordCount: 2 },
  });
  const text = await runDatasetTool('t1', 'dataset_extract', { datasetId: ID, instruction: 'Summarise', groupBy: 'postId', saveAs: 'thread summaries' }, ctx);
  expect(mockExtract).toHaveBeenCalledWith('t1', { datasetId: ID, instruction: 'Summarise', select: undefined, where: undefined, limit: undefined, saveAs: 'thread summaries', groupBy: 'postId' }, ctx);
  expect(text).toContain('- p1 (37 records): summary one\n- p2 (30 records): summary two');
  expect(text).toContain('2 groups, answered over 275 records. Every group\'s answer is kept as dataset 3a6f2a2e-0d4c-4e0e-9a6e-2c6b7f3f1a22 (2 records; fields group, records, answer)');
});

it('dataset_query: an aggregate returns no rows — the distinct values with counts, or the count alone', async () => {
  mockAggregate.mockResolvedValue({ distinct: { field: 'author', values: [{ value: 'alice', count: 12 }] } });
  const text = await runDatasetTool('t1', 'dataset_query', { datasetId: ID, where: [{ field: 'score', op: 'gt', value: '100' }], aggregate: { distinct: 'author' } }, ctx);
  expect(mockAggregate).toHaveBeenCalledWith('t1', { datasetIds: [ID], where: [{ field: 'score', op: 'gt', value: 100 }] }, { distinct: 'author' });
  expect(mockQueryDatasets).not.toHaveBeenCalled();
  expect(text).toBe('Distinct values of author (1, most frequent first):\n"alice": 12');

  mockAggregate.mockResolvedValue({ count: 17 });
  expect(await runDatasetTool('t1', 'dataset_query', { datasetId: ID, aggregate: { count: true } }, ctx)).toBe('17 matching records.');
  expect(mockAggregate).toHaveBeenLastCalledWith('t1', { datasetIds: [ID], where: undefined }, { count: true });
});

it('the schemas carry the two shapes, every property typed', () => {
  const query = datasetTools.find((t) => t.name === 'dataset_query')!;
  const aggregate = query.input_schema.properties.aggregate as { type: string; properties: Record<string, { type: string }> };
  expect(aggregate.type).toBe('object');
  expect(aggregate.properties.distinct.type).toBe('string');
  expect(aggregate.properties.count.type).toBe('boolean');
  const extract = datasetTools.find((t) => t.name === 'dataset_extract')!;
  expect((extract.input_schema.properties.groupBy as { type: string }).type).toBe('string');
  expect(extract.description).toContain('groupBy');
  expect(query.description).toContain('aggregate');
});

it('dataset_list with inventory (the out-of-process surfaces): the inventory block, newest first, from the one renderer', async () => {
  mockList.mockResolvedValue([
    { id: ID, label: 'comments', source: 's', sourceRef: 'r', recordCount: 275, bytes: 1, fields: [{ name: 'body', type: 'text', present: 1 }], createdAt: new Date(), runs: 2 },
  ]);
  const text = await runDatasetTool('t1', 'dataset_list', { inventory: true }, ctx);
  expect(mockList).toHaveBeenCalledWith('t1', ctx.scope, { order: 'newest' });
  expect(text).toMatch(/^Datasets kept for this conversation\./);
  expect(text).toContain(`- ${ID} "comments" — 275 records, 2 runs; fields body (text)`);
  mockList.mockResolvedValue([]);
  expect(await runDatasetTool('t1', 'dataset_list', { inventory: true }, ctx)).toBe('');
});
