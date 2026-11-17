// Change A A.8: peer-window orders by (influence * source_trust) DESC.

jest.mock('../../infrastructure/database', () => {
  const query = jest.fn();
  return {
    pool: { query, connect: jest.fn() },
    __query: query,
    getPoolForService: jest.fn(() => ({ query })),
  };
});

jest.mock('../hyde', () => ({
  generateHypotheticalDocument: jest.fn().mockResolvedValue('hyde-doc'),
}));
jest.mock('../embedding', () => ({
  generateEmbedding: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
  generateEmbeddingDetailed: jest.fn().mockResolvedValue({
    embedding: [0.1, 0.2, 0.3], model: 'text-embedding-004', provider: 'google', dim: 3,
  }),
  getDefaultProvider: () => 'google',
  getProviderModel: () => 'text-embedding-004',
}));

import { memoryService } from '../service';
import * as db from '../../infrastructure/database';

describe('peer-window ranking', () => {
  const query = (db as any).__query as jest.Mock;

  beforeEach(() => {
    query.mockReset();
  });

  it('SQL ORDER BY combines influence_score and source_trust', async () => {
    // Default for calls past the ordered queue below (the retrieval path's
    // fire-and-forget last-used stamp lands here). An exhausted mock queue
    // returns undefined, which reads as the pool failing mid-retrieval.
    query.mockResolvedValue({ rows: [], rowCount: 0 });
    // 1st query: tenant strategy
    query.mockResolvedValueOnce({ rows: [{ memory_layer_strategy: 'narrow_with_peer' }], rowCount: 1 });
    // 2nd: SET hnsw.ef_search
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // 3rd: vector
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // 4th: bm25
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // 5th: peer-window
    query.mockResolvedValueOnce({
      rows: [
        { id: 'high', content: 'h', layer: 'role', scope_key: 'r', tags: [], created_at: new Date(), agent_id: null, usefulness_score: 5, importance_score: 3, influence_score: '0.9', source_trust: '0.9', summary_level: '0', agent_name: null },
        { id: 'low', content: 'l', layer: 'role', scope_key: 'r', tags: [], created_at: new Date(), agent_id: null, usefulness_score: 5, importance_score: 3, influence_score: '0.1', source_trust: '0.4', summary_level: '0', agent_name: null },
      ],
      rowCount: 2,
    });

    await memoryService.retrieveMemories({ tenantId: 't1', query: 'hello' });

    // Find the peer-window query — should match ORDER BY (influence_score * source_trust)
    const peerQuery = query.mock.calls.find((c: any[]) =>
      typeof c[0] === 'string' && c[0].includes('m.layer IN (\'role\', \'global\')') && c[0].includes('influence_score'),
    );
    expect(peerQuery).toBeDefined();
    expect(peerQuery![0]).toMatch(/ORDER BY[\s\S]*influence_score[\s\S]*\*[\s\S]*source_trust[\s\S]*DESC/);
  });
});
