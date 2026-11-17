// The query: a fixed shape compiled to parameterised SQL over the records,
// nothing the model wrote in the statement text, the rows projected to the
// fields asked for.

const mockQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  withTenantScope: jest.fn(async (_tenantId: string, fn: (client: { query: typeof mockQuery }) => Promise<unknown>) => fn({ query: mockQuery })),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { DatasetQueryError, queryDatasets } from '../query';

const ID = '2f6f2a2e-0d4c-4e0e-9a6e-2c6b7f3f1a11';
const ID2 = '3a6f2a2e-0d4c-4e0e-9a6e-2c6b7f3f1a22';

function lastSql(): { sql: string; params: unknown[] } {
  const [sql, params] = mockQuery.mock.calls[mockQuery.mock.calls.length - 1];
  return { sql: String(sql).replace(/\s+/g, ' ').trim(), params };
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
});

it('reads the tenant\'s records of the named datasets, in fetch order, with the default page', async () => {
  mockQuery.mockResolvedValue({ rows: [
    { dataset_id: ID, ordinal: 1, record: { title: 'A', score: 10 }, total: '2' },
    { dataset_id: ID, ordinal: 2, record: { title: 'B', score: 3 }, total: '2' },
  ] });
  const out = await queryDatasets('t1', { datasetIds: [ID] });
  expect(out).toEqual({ rows: [{ _ordinal: 1, title: 'A', score: 10 }, { _ordinal: 2, title: 'B', score: 3 }], total: 2, offset: 0, limit: 50 });
  const { sql, params } = lastSql();
  expect(sql).toContain('FROM dataset_records r WHERE r.tenant_id = $1 AND r.dataset_id = ANY($2::uuid[]) ORDER BY r.dataset_id, r.ordinal LIMIT $3 OFFSET $4');
  expect(sql).toContain('COUNT(*) OVER () AS total');
  expect(params).toEqual(['t1', [ID], 50, 0]);
});

it('compiles every filter to a parameter, never into the statement', async () => {
  await queryDatasets('t1', {
    datasetIds: [ID],
    where: [
      { field: 'score', op: 'gte', value: 5 },
      { field: 'title', op: 'contains', value: "x' OR 1=1 --" },
      { field: 'author.name', op: 'eq', value: 'ada' },
      { field: 'pinned', op: 'eq', value: true },
      { field: 'deleted', op: 'eq', value: null },
      { field: 'kind', op: 'in', value: ['post', 'link'] },
      { field: 'comments', op: 'exists' },
      { field: 'score', op: 'ne', value: 0 },
    ],
  });
  const { sql, params } = lastSql();
  expect(sql).not.toContain('OR 1=1');
  expect(sql).toContain("(jsonb_typeof((record #> $3::text[])) = 'number' AND (record #>> $3::text[])::numeric >= $4)");
  expect(sql).toContain("((record #>> $5::text[]) ILIKE '%' || $6 || '%')");
  expect(sql).toContain('((record #>> $7::text[]) = $8)');
  expect(sql).toContain('((record #> $9::text[]) = to_jsonb($10::boolean))');
  expect(sql).toContain("((record #> $11::text[]) IS NULL OR jsonb_typeof((record #> $11::text[])) = 'null')");
  expect(sql).toContain('((record #>> $12::text[]) = ANY($13::text[]))');
  expect(sql).toContain("((record #> $14::text[]) IS NOT NULL AND jsonb_typeof((record #> $14::text[])) <> 'null'");
  expect(sql).toContain("NOT (jsonb_typeof((record #> $15::text[])) = 'number' AND (record #>> $15::text[])::numeric = $16)");
  expect(params).toEqual(['t1', [ID], ['score'], 5, ['title'], "x' OR 1=1 --", ['author', 'name'], 'ada', ['pinned'], true, ['deleted'], ['kind'], ['post', 'link'], ['comments'], ['score'], 0, 50, 0]);
});

it('sorts numbers as numbers and the rest as text, absent values last, and pages', async () => {
  mockQuery.mockResolvedValue({ rows: [{ dataset_id: ID, ordinal: 41, record: { score: 1 }, total: '60' }] });
  await queryDatasets('t1', { datasetIds: [ID], sort: { field: 'score' }, limit: 20, offset: 40 });
  const { sql, params } = lastSql();
  expect(sql).toContain("ORDER BY (CASE WHEN jsonb_typeof(record #> $3::text[]) = 'number' THEN (record #>> $3::text[])::numeric END) DESC NULLS LAST, (record #>> $3::text[]) DESC NULLS LAST, r.dataset_id, r.ordinal LIMIT $4 OFFSET $5");
  expect(params).toEqual(['t1', [ID], ['score'], 20, 40]);
  await queryDatasets('t1', { datasetIds: [ID], sort: { field: 'title', dir: 'asc' }, limit: 5000 });
  expect(lastSql().sql).toContain('ASC NULLS LAST');
  expect(lastSql().params).toEqual(['t1', [ID], ['title'], 200, 0]);
});

it('projects the selected fields, nested paths included, and names the dataset over several', async () => {
  mockQuery.mockResolvedValue({ rows: [
    { dataset_id: ID, ordinal: 3, record: { title: 'A', author: { name: 'ada' }, comments: [{ body: 'first' }] }, total: '1' },
    { dataset_id: ID2, ordinal: 1, record: { title: 'Z' }, total: '1' },
  ] });
  const out = await queryDatasets('t1', { datasetIds: [ID, ID2], select: ['title', 'author.name', 'comments.0.body', 'missing'] });
  expect(out.rows).toEqual([
    { _ordinal: 3, _dataset: ID, title: 'A', 'author.name': 'ada', 'comments.0.body': 'first', missing: undefined },
    { _ordinal: 1, _dataset: ID2, title: 'Z', 'author.name': undefined, 'comments.0.body': undefined, missing: undefined },
  ]);
});

it('counts the matches for a page past the end', async () => {
  mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ total: '92' }] });
  const out = await queryDatasets('t1', { datasetIds: [ID], where: [{ field: 'score', op: 'gt', value: 1 }], offset: 500 });
  expect(out).toEqual({ rows: [], total: 92, offset: 500, limit: 50 });
  const { sql, params } = lastSql();
  expect(sql).toContain('SELECT COUNT(*)::text AS total FROM dataset_records r WHERE r.tenant_id = $1 AND r.dataset_id = ANY($2::uuid[]) AND');
  expect(params).toEqual(['t1', [ID], ['score'], 1]);
});

it('refuses what it cannot compile, naming the fix, and never runs it', async () => {
  await expect(queryDatasets('t1', { datasetIds: ['cap_abc'] })).rejects.toThrow(DatasetQueryError);
  await expect(queryDatasets('t1', { datasetIds: [ID], where: [{ field: 'a;b', op: 'eq', value: 1 }] })).rejects.toThrow(/is not a field name/);
  await expect(queryDatasets('t1', { datasetIds: [ID], where: [{ field: 'a', op: 'like' as never, value: 1 }] })).rejects.toThrow(/is not a filter operator/);
  await expect(queryDatasets('t1', { datasetIds: [ID], where: [{ field: 'a', op: 'contains', value: 3 }] })).rejects.toThrow(/takes a text value/);
  await expect(queryDatasets('t1', { datasetIds: [ID], where: [{ field: 'a', op: 'in', value: [] }] })).rejects.toThrow(/takes a list/);
  await expect(queryDatasets('t1', { datasetIds: [ID], where: [{ field: 'a', op: 'gt', value: true }] })).rejects.toThrow(/takes a number or a text value/);
  await expect(queryDatasets('t1', { datasetIds: [ID], where: Array.from({ length: 11 }, () => ({ field: 'a', op: 'exists' as const })) })).rejects.toThrow(/at most 10 filters/);
  await expect(queryDatasets('t1', { datasetIds: [ID], select: Array.from({ length: 31 }, (_, i) => `f${i}`) })).rejects.toThrow(/at most 30 fields/);
  expect(mockQuery).not.toHaveBeenCalled();
});

it('turns a database failure into a query error the model can act on', async () => {
  mockQuery.mockRejectedValue(new Error('relation missing'));
  await expect(queryDatasets('t1', { datasetIds: [ID] })).rejects.toThrow(/could not be run/);
});

// The aggregates: one statement over the rows, no page and no model.
import { aggregateDatasets } from '../query';

describe('aggregateDatasets', () => {
  it('distinct: groups the field\'s text value and counts, most frequent first, at most 200 values', async () => {
    mockQuery.mockResolvedValue({ rows: [{ k: 'alice', n: '12' }, { k: 'bob', n: '3' }, { k: null, n: '1' }] });
    const out = await aggregateDatasets('t1', { datasetIds: [ID], where: [{ field: 'score', op: 'gt', value: 100 }] }, { distinct: 'author' });
    expect(out).toEqual({ distinct: { field: 'author', values: [{ value: 'alice', count: 12 }, { value: 'bob', count: 3 }, { value: null, count: 1 }] } });
    const { sql, params } = lastSql();
    expect(sql).toContain('SELECT (record #>> $5::text[]) AS k, COUNT(*)::text AS n FROM dataset_records r');
    expect(sql).toContain('WHERE r.tenant_id = $1 AND r.dataset_id = ANY($2::uuid[]) AND (jsonb_typeof((record #> $3::text[])) = \'number\' AND (record #>> $3::text[])::numeric > $4)');
    expect(sql).toContain('GROUP BY k ORDER BY 2 DESC, k ASC NULLS LAST LIMIT $6');
    expect(params).toEqual(['t1', [ID], ['score'], 100, ['author'], 200]);
  });

  it('count: the matching count alone, with the filters', async () => {
    mockQuery.mockResolvedValue({ rows: [{ total: '17' }] });
    const out = await aggregateDatasets('t1', { datasetIds: [ID], where: [{ field: 'comments', op: 'gt', value: 100 }] }, { count: true });
    expect(out).toEqual({ count: 17 });
    const { sql } = lastSql();
    expect(sql).toContain('SELECT COUNT(*)::text AS total FROM dataset_records r WHERE r.tenant_id = $1 AND r.dataset_id = ANY($2::uuid[]) AND');
  });

  it('both at once, and refuses an aggregate that asks for neither, a bad field, or a bad id', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ k: 'x', n: '2' }] }).mockResolvedValueOnce({ rows: [{ total: '2' }] });
    const out = await aggregateDatasets('t1', { datasetIds: [ID] }, { distinct: 'kind', count: true });
    expect(out).toEqual({ distinct: { field: 'kind', values: [{ value: 'x', count: 2 }] }, count: 2 });
    await expect(aggregateDatasets('t1', { datasetIds: [ID] }, {})).rejects.toThrow(DatasetQueryError);
    await expect(aggregateDatasets('t1', { datasetIds: [ID] }, { distinct: 'a;b' })).rejects.toThrow(/is not a field name/);
    await expect(aggregateDatasets('t1', { datasetIds: ['nope'] }, { count: true })).rejects.toThrow(/datasetId must be/);
  });
});
