// Change B: assert memory_retrieval_events row is written with correct retrieved_ids.

jest.mock('../../infrastructure/database', () => {
  const query = jest.fn();
  return {
    pool: { query, connect: jest.fn() },
    __query: query,
    getPoolForService: jest.fn(() => ({ query })),
  };
});

jest.mock('../hyde', () => ({
  generateHypotheticalDocument: jest.fn().mockResolvedValue('hyde'),
}));
jest.mock('../embedding', () => ({
  generateEmbedding: jest.fn().mockResolvedValue([0.1, 0.2]),
  generateEmbeddingDetailed: jest.fn().mockResolvedValue({
    embedding: [0.1, 0.2], model: 'text-embedding-004', provider: 'google', dim: 2,
  }),
  getDefaultProvider: () => 'google',
  getProviderModel: () => 'text-embedding-004',
}));
jest.mock('../metrics', () => ({
  incCounter: jest.fn(),
}));

import { memoryService } from '../service';
import * as db from '../../infrastructure/database';

describe('memory retrieval event log', () => {
  const query = (db as any).__query as jest.Mock;

  beforeEach(() => {
    query.mockReset();
    delete process.env.MEM_EVENT_LOG_DISABLED;
  });

  it('inserts a memory_retrieval_events row when invocationId is supplied AND retrieval is non-empty', async () => {
    // Default-resolve for any auxiliary call we don't explicitly model
    // (telemetry, recordOrigin, audit, etc.).
    query.mockResolvedValue({ rows: [], rowCount: 0 });
    // Pretend strategy='all' so peer-window doesn't fire.
    query.mockResolvedValueOnce({ rows: [{ memory_layer_strategy: 'all' }], rowCount: 1 });
    // Change 4: decodeAliases() SELECT runs right after strategy resolution — no aliases.
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // SET ef_search
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // vector
    query.mockResolvedValueOnce({
      rows: [{
        id: 'mem-1', content: 'c', layer: 'individual', scope_key: 's', tags: [],
        content_classification: 'internal', created_at: new Date(),
        usefulness_score: '0', importance_score: '3',
        influence_score: '0.5', source_trust: '0.5', summary_level: '0',
        agent_id: null, agent_name: null, similarity: 0.7,
      }], rowCount: 1,
    });
    // bm25
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // memory_retrieval_events INSERT
    query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await memoryService.retrieveMemories({
      tenantId: 't1',
      query: 'q',
      invocationId: '00000000-0000-0000-0000-000000000001',
    });

    const insertCall = query.mock.calls.find((c: any[]) =>
      typeof c[0] === 'string' && c[0].includes('INSERT INTO memory_retrieval_events'),
    );
    expect(insertCall).toBeDefined();
    // Partition-aware ON CONFLICT
    expect(insertCall![0]).toMatch(/ON CONFLICT \(tenant_id, invocation_id\)/);
    // Params: tenantId, agentId, invocationId, threadId, retrievedIds
    const params = insertCall![1] as any[];
    expect(params[0]).toBe('t1');
    expect(params[2]).toBe('00000000-0000-0000-0000-000000000001');
    expect(params[4]).toEqual(['mem-1']);
  });

  it('does NOT insert when invocationId is absent', async () => {
    query.mockResolvedValueOnce({ rows: [{ memory_layer_strategy: 'all' }], rowCount: 1 });
    // Change 4: decodeAliases() SELECT runs right after strategy resolution — no aliases.
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await memoryService.retrieveMemories({ tenantId: 't1', query: 'q' });

    const insertCall = query.mock.calls.find((c: any[]) =>
      typeof c[0] === 'string' && c[0].includes('INSERT INTO memory_retrieval_events'),
    );
    expect(insertCall).toBeUndefined();
  });

  it('does NOT insert when MEM_EVENT_LOG_DISABLED=1', async () => {
    process.env.MEM_EVENT_LOG_DISABLED = '1';
    query.mockResolvedValueOnce({ rows: [{ memory_layer_strategy: 'all' }], rowCount: 1 });
    // Change 4: decodeAliases() SELECT runs right after strategy resolution — no aliases.
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    query.mockResolvedValueOnce({
      rows: [{
        id: 'mem-1', content: 'c', layer: 'individual', scope_key: 's', tags: [],
        content_classification: 'internal', created_at: new Date(),
        usefulness_score: '0', importance_score: '3',
        influence_score: '0.5', source_trust: '0.5', summary_level: '0',
        agent_id: null, agent_name: null, similarity: 0.7,
      }], rowCount: 1,
    });
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await memoryService.retrieveMemories({
      tenantId: 't1', query: 'q', invocationId: '00000000-0000-0000-0000-000000000001',
    });

    const insertCall = query.mock.calls.find((c: any[]) =>
      typeof c[0] === 'string' && c[0].includes('INSERT INTO memory_retrieval_events'),
    );
    expect(insertCall).toBeUndefined();
  });
});
