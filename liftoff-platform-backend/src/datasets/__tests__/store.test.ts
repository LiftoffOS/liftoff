// The dataset store: a result parked whole under the tenant's scope, profiled
// for the model, bounded; a later run appended with its run number; the
// job's datasets listed.

const mockQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  withTenantScope: jest.fn(async (_tenantId: string, fn: (client: { query: typeof mockQuery }) => Promise<unknown>) => fn({ query: mockQuery })),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { withTenantScope } from '../../infrastructure/database';
import { appendRecords, createDataset, isDatasetId, listDatasets } from '../store';

const ID = '2f6f2a2e-0d4c-4e0e-9a6e-2c6b7f3f1a11';
const scope = { kind: 'liftoff_thread' as const, id: 'thread-1' };

function sqlCalls(): Array<{ sql: string; params: unknown[] }> {
  return mockQuery.mock.calls.map(([sql, params]) => ({ sql: String(sql).replace(/\s+/g, ' ').trim(), params }));
}

beforeEach(() => {
  mockQuery.mockReset();
});

describe('createDataset', () => {
  it('sweeps expired rows, inserts the dataset under the tenant and scope, and the records in order', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: ID }] })
      .mockResolvedValueOnce({ rows: [] });
    const records = [
      { title: 'A', score: 10, body: 'x'.repeat(400), tags: ['a', 'b'], empty: '' },
      { title: 'B', score: 3, body: '', tags: [], extra: { k: 1 } },
    ];
    const stored = await createDataset('t1', { scope, label: 'posts: sub founder', source: 'apify_store', sourceRef: 'x/y', records });
    expect(stored).toMatchObject({ id: ID, recordCount: 2, added: 2, truncated: false, run: 1 });
    expect(withTenantScope).toHaveBeenCalledWith('t1', expect.any(Function));

    const calls = sqlCalls();
    expect(calls[0].sql).toContain('DELETE FROM datasets WHERE tenant_id = $1 AND expires_at < NOW()');
    expect(calls[1].sql).toContain('INSERT INTO datasets (tenant_id, scope_kind, scope_id, label, source, source_ref, record_count, bytes, fields)');
    expect(calls[1].params.slice(0, 7)).toEqual(['t1', 'liftoff_thread', 'thread-1', 'posts: sub founder', 'apify_store', 'x/y', 2]);
    expect(calls[2].sql).toContain('INSERT INTO dataset_records (dataset_id, tenant_id, ordinal, record)');
    expect(calls[2].params[0]).toBe(ID);
    expect(calls[2].params[1]).toBe('t1');
    expect(calls[2].params[2]).toEqual([1, 2]);
    expect((calls[2].params[3] as string[]).map((r) => JSON.parse(r).title)).toEqual(['A', 'B']);
  });

  it('profiles the fields: type, presence, average length, a sample; most-present first', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: ID }] })
      .mockResolvedValueOnce({ rows: [] });
    const records = [
      { title: 'A', score: 10, body: 'x'.repeat(400), tags: ['a', 'b'], empty: '' },
      { title: 'B', score: 3, body: '', tags: [], flag: true },
    ];
    const stored = await createDataset('t1', { scope, label: 'l', source: 's', sourceRef: 'r', records });
    const byName = Object.fromEntries(stored!.fields.map((f) => [f.name, f]));
    expect(byName.title).toEqual({ name: 'title', type: 'text', present: 1, avgChars: 1, sample: 'A' });
    expect(byName.score).toEqual({ name: 'score', type: 'number', present: 1, sample: '10' });
    expect(byName.body).toEqual({ name: 'body', type: 'text', present: 0.5, avgChars: 400, sample: `${'x'.repeat(60)}…` });
    expect(byName.tags).toEqual({ name: 'tags', type: 'list', present: 0.5, avgItems: 2, sample: '["a","b"]' });
    expect(byName.empty).toEqual({ name: 'empty', type: 'text', present: 0 });
    expect(byName.flag).toEqual({ name: 'flag', type: 'boolean', present: 0.5, sample: 'true' });
    expect(stored!.fields.map((f) => f.name).slice(0, 2)).toEqual(['title', 'score']);
    expect(stored!.fields[stored!.fields.length - 1].name).toBe('empty');
  });

  it('wraps a non-object record so it has a field, and writes records in batches', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: ID }] });
    const stored = await createDataset('t1', { scope, label: 'l', source: 's', sourceRef: 'r', records: Array.from({ length: 1201 }, (_, i) => i) });
    expect(stored!.recordCount).toBe(1201);
    const inserts = sqlCalls().filter((c) => c.sql.startsWith('INSERT INTO dataset_records'));
    expect(inserts).toHaveLength(3);
    expect((inserts[0].params[2] as number[]).length).toBe(500);
    expect((inserts[2].params[2] as number[])).toEqual(expect.arrayContaining([1201]));
    expect(JSON.parse((inserts[0].params[3] as string[])[0])).toEqual({ value: 0 });
    expect(stored!.fields).toEqual([{ name: 'value', type: 'number', present: 1, sample: '0' }]);
  });

  it('keeps nothing of an empty result, and reports a store failure as nothing kept', async () => {
    expect(await createDataset('t1', { scope, label: 'l', source: 's', sourceRef: 'r', records: [] })).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
    mockQuery.mockRejectedValue(new Error('db down'));
    expect(await createDataset('t1', { scope, label: 'l', source: 's', sourceRef: 'r', records: [{ a: 1 }] })).toBeNull();
  });
});

describe('appendRecords', () => {
  it('locks the dataset, tags the records with the next run number, extends the counts and merges the profile', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ record_count: 27, bytes: '5000', fields: [{ name: 'title', type: 'text', present: 1, avgChars: 6, sample: 'Post 0' }], runs: 1 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const out = await appendRecords('t1', ID, [{ title: 'C', comments: [1, 2, 3] }]);
    expect(out).toMatchObject({ id: ID, recordCount: 28, added: 1, truncated: false, run: 2 });
    const calls = sqlCalls();
    expect(calls[0].sql).toContain('FOR UPDATE');
    expect(calls[0].sql).toContain("MAX((record->>'_run')::int)");
    expect(calls[1].sql).toContain('INSERT INTO dataset_records');
    expect(calls[1].params[2]).toEqual([28]);
    expect(JSON.parse((calls[1].params[3] as string[])[0])).toEqual({ title: 'C', comments: [1, 2, 3], _run: 2 });
    expect(calls[2].sql).toContain('SET record_count = record_count + $3');
    expect(calls[2].params.slice(0, 4)).toEqual(['t1', ID, 1, JSON.stringify({ title: 'C', comments: [1, 2, 3], _run: 2 }).length]);
    const names = out!.fields.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(['title', 'comments', '_run']));
    expect(out!.fields.find((f) => f.name === 'title')).toEqual({ name: 'title', type: 'text', present: 1, avgChars: 4, sample: 'Post 0' });
  });

  it('answers null for an id that is not a dataset id, an expired or foreign dataset, or a failure', async () => {
    expect(await appendRecords('t1', 'nope', [{ a: 1 }])).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await appendRecords('t1', ID, [{ a: 1 }])).toBeNull();
    mockQuery.mockRejectedValueOnce(new Error('db down'));
    expect(await appendRecords('t1', ID, [{ a: 1 }])).toBeNull();
  });
});

describe('listDatasets', () => {
  it('lists the job\'s live datasets, oldest first, as summaries', async () => {
    const created = new Date('2026-09-22T05:54:38Z');
    mockQuery.mockResolvedValueOnce({ rows: [{ id: ID, label: 'posts', source: 'apify_store', source_ref: 'x/y', record_count: 92, bytes: '192186', fields: [{ name: 'title', type: 'text', present: 1 }], created_at: created, runs: '1' }] });
    const list = await listDatasets('t1', scope);
    expect(list).toEqual([{ id: ID, label: 'posts', source: 'apify_store', sourceRef: 'x/y', recordCount: 92, bytes: 192186, fields: [{ name: 'title', type: 'text', present: 1 }], createdAt: created, runs: 1 }]);
    const [call] = sqlCalls();
    expect(call.sql).toContain('WHERE tenant_id = $1 AND scope_kind = $2 AND scope_id = $3 AND expires_at > NOW() ORDER BY created_at ASC LIMIT 50');
    // The run count rides the summary: the highest _run a record carries.
    expect(call.sql).toContain("(SELECT COALESCE(MAX((record->>'_run')::int), 1) FROM dataset_records dr WHERE dr.dataset_id = d.id AND dr.tenant_id = $1) AS runs");
    expect(call.params).toEqual(['t1', 'liftoff_thread', 'thread-1']);
  });

  it('lists newest first for the inventory a turn is shown, and reads the run count', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: ID, label: 'comments', source: 'apify_store', source_ref: 'x/z', record_count: 275, bytes: '9', fields: [], created_at: new Date(), runs: 3 }] });
    const list = await listDatasets('t1', scope, { order: 'newest' });
    expect(list[0].runs).toBe(3);
    const [call] = sqlCalls();
    expect(call.sql).toContain('ORDER BY created_at DESC LIMIT 50');
  });

  it('answers an empty list on failure', async () => {
    mockQuery.mockRejectedValueOnce(new Error('db down'));
    expect(await listDatasets('t1', scope)).toEqual([]);
  });
});

it('isDatasetId accepts a uuid and nothing else', () => {
  expect(isDatasetId(ID)).toBe(true);
  expect(isDatasetId('cap_abc')).toBe(false);
  expect(isDatasetId(42)).toBe(false);
});
