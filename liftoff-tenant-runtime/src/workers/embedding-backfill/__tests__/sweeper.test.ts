import { jest } from '@jest/globals';

const mockClient = { query: jest.fn(), release: jest.fn() };
const mockPool = { connect: jest.fn().mockResolvedValue(mockClient) };
jest.mock('../../../infrastructure/database', () => ({
  pool: mockPool,
  // connector_content is FORCE RLS (372): its pass runs inside a scope, and
  // the scope owns the client's lifetime.
  withTenantScope: (_t: string, fn: (c: unknown) => Promise<unknown>) => fn(mockClient),
}));

const mockEmbed = jest.fn();
jest.mock('../../../memory/embedding', () => {
  class EmbeddingDimMismatchError extends Error {
    constructor() { super('dim mismatch'); this.name = 'EmbeddingDimMismatchError'; }
  }
  return {
    generateEmbeddingsBatchDetailed: (...args: unknown[]) => mockEmbed(...args),
    EmbeddingDimMismatchError,
  };
});

jest.mock('../../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { sweepOnePass, DEFAULT_SOURCES } from '../sweeper';

const memSrc = DEFAULT_SOURCES.find(s => s.name === 'memories')!;
const connectorSrc = DEFAULT_SOURCES.find(s => s.name === 'connector_content')!;
const memoriesSrc = DEFAULT_SOURCES.find(s => s.name === 'memories')!;

beforeEach(() => {
  mockClient.query.mockReset();
  mockEmbed.mockReset();
});

it('returns done=true on empty SELECT', async () => {
  mockClient.query
    .mockResolvedValueOnce({})                  // BEGIN
    .mockResolvedValueOnce({ rows: [] })        // SELECT
    .mockResolvedValueOnce({});                 // COMMIT

  const r = await sweepOnePass(memSrc, { batchSize: 32 });
  expect(r.done).toBe(true);
  expect(r.attempted).toBe(0);
  expect(r.succeeded).toBe(0);
});

it('embeds + bulk-updates a successful batch with embedding_model', async () => {
  const rows = [
    { id: 'a', tenant_id: 't1', text: 'hello' },
    { id: 'b', tenant_id: 't1', text: 'world' },
  ];
  mockClient.query
    .mockResolvedValueOnce({})                  // BEGIN
    .mockResolvedValueOnce({ rows })            // SELECT
    .mockResolvedValueOnce({})                  // UPDATE
    .mockResolvedValueOnce({});                 // COMMIT
  mockEmbed.mockResolvedValue({
    embeddings: [[0.1, 0.2], [0.3, 0.4]],
    model: 'gemini-embedding-001',
    provider: 'google',
    dim: 768,
  });

  const r = await sweepOnePass(memSrc, { batchSize: 32 });
  expect(r.attempted).toBe(2);
  expect(r.succeeded).toBe(2);
  expect(r.failed).toBe(0);
  expect(r.done).toBe(false);

  // RLS_EXEMPT: assertion-only substring match; not a runtime query.
  const updateCall = mockClient.query.mock.calls.find(c =>
    typeof c[0] === 'string' && c[0].includes('UPDATE memories'),
  );
  expect(updateCall).toBeDefined();
  expect(updateCall![0] as string).toMatch(/embedding_model = \$1/);
  expect(updateCall![0] as string).toMatch(/::vector/);
  expect(updateCall![1]).toEqual([
    'gemini-embedding-001',
    ['a', 'b'],
    ['[0.1,0.2]', '[0.3,0.4]'],
  ]);
});

it('omits embedding_model UPDATE for connector_content (no column)', async () => {
  const rows = [{ id: 'a', tenant_id: 't1', text: 'x' }];
  mockClient.query
    .mockResolvedValueOnce({})
    .mockResolvedValueOnce({ rows })
    .mockResolvedValueOnce({})
    .mockResolvedValueOnce({});
  mockEmbed.mockResolvedValue({
    embeddings: [[0.1, 0.2]], model: 'm', provider: 'google', dim: 2,
  });

  await sweepOnePass(connectorSrc, { batchSize: 32, tenantIdFilter: 't1' });

  const updateCall = mockClient.query.mock.calls.find(c =>
    typeof c[0] === 'string' && c[0].includes('UPDATE connector_content'),
  );
  expect(updateCall).toBeDefined();
  expect(updateCall![0] as string).not.toMatch(/embedding_model/);
  expect(updateCall![1]).toEqual([['a'], ['[0.1,0.2]']]);
});

it('groups claim rows by tenant_id and embeds each tenant separately', async () => {
  const rows = [
    { id: 'a', tenant_id: 't1', text: 'x' },
    { id: 'b', tenant_id: 't2', text: 'y' },
  ];
  mockClient.query
    .mockResolvedValueOnce({})
    .mockResolvedValueOnce({ rows })
    .mockResolvedValueOnce({})  // UPDATE t1
    .mockResolvedValueOnce({})  // UPDATE t2
    .mockResolvedValueOnce({}); // COMMIT
  mockEmbed.mockResolvedValue({
    embeddings: [[0.1]], model: 'm', provider: 'google', dim: 1,
  });

  await sweepOnePass(memSrc, { batchSize: 32 });

  expect(mockEmbed).toHaveBeenCalledTimes(2);
  expect((mockEmbed.mock.calls[0][1] as { tenantId: string }).tenantId).toBe('t1');
  expect((mockEmbed.mock.calls[1][1] as { tenantId: string }).tenantId).toBe('t2');
});

it('rethrows on EmbeddingDimMismatchError', async () => {
  const rows = [{ id: 'a', tenant_id: 't1', text: 'x' }];
  // Default-resolve for the ROLLBACK call that fires on catch.
  mockClient.query.mockResolvedValue({});
  mockClient.query
    .mockResolvedValueOnce({})                  // BEGIN
    .mockResolvedValueOnce({ rows });           // SELECT

  const { EmbeddingDimMismatchError } = require('../../../memory/embedding');
  mockEmbed.mockRejectedValue(new EmbeddingDimMismatchError());

  await expect(sweepOnePass(memSrc, { batchSize: 32 })).rejects.toThrow(/dim mismatch/);
});

it('non-dim-mismatch errors are logged as failures, not thrown', async () => {
  const rows = [{ id: 'a', tenant_id: 't1', text: 'x' }];
  mockClient.query
    .mockResolvedValueOnce({})
    .mockResolvedValueOnce({ rows })
    .mockResolvedValueOnce({});  // COMMIT
  mockEmbed.mockRejectedValue(new Error('rate limit'));

  const r = await sweepOnePass(memSrc, { batchSize: 32 });
  expect(r.attempted).toBe(1);
  expect(r.succeeded).toBe(0);
  expect(r.failed).toBe(1);
});

describe('a FORCE-RLS source cannot be swept fleet-wide', () => {
  it('refuses a pass with no tenant, rather than raising 42704 mid-batch', async () => {
    // Off a scope the fail-loud policy raises, so there is no fleet-wide pass
    // to run. Say so in the caller's terms instead of letting an opaque
    // database error abort the job halfway through.
    await expect(sweepOnePass(connectorSrc, { batchSize: 32 })).rejects.toThrow(/tenantIdFilter/);
  });

  it('still sweeps an unscoped source fleet-wide', async () => {
    mockClient.query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [] });
    const res = await sweepOnePass(memoriesSrc, { batchSize: 32 });
    expect(res.done).toBe(true);
  });
});
