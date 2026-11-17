const mockPoolQuery = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  pool: { query: (...args: any[]) => mockPoolQuery(...args) },
}));

import {
  recordMemoryOrigin,
  recordSynthesis,
  recordAmendment,
  findMemoriesByConnector,
  getProvenanceChain,
} from '../provenance-service';

const makeClient = () => ({
  query: jest.fn().mockResolvedValue({ rows: [{ id: 'node-uuid' }] }),
});

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── recordMemoryOrigin ───────────────────────────────────────────────────────

describe('recordMemoryOrigin', () => {
  it('upserts source node, memory node, and produced edge', async () => {
    const client = makeClient();
    await recordMemoryOrigin(client as any, 'tenant-1', 'mem-1', {
      nodeType: 'connector_event',
      refId: 'entity-abc',
      connectorId: 'conn-1',
      confidence: 0.9,
      metadata: { connectorType: 'slack' },
    });
    // 3 queries: upsert source node, upsert memory node, insert edge
    expect(client.query).toHaveBeenCalledTimes(3);
    const [q1, q2, q3] = client.query.mock.calls;
    expect(q1[0]).toContain('provenance_nodes');
    expect(q1[1]).toEqual(expect.arrayContaining(['tenant-1', 'connector_event', 'entity-abc']));
    expect(q2[0]).toContain('provenance_nodes');
    expect(q2[1]).toEqual(expect.arrayContaining(['tenant-1', 'memory', 'mem-1']));
    expect(q3[0]).toContain('provenance_edges');
    expect(q3[1]).toEqual(expect.arrayContaining(['produced']));
  });

  it.each([
    ['agent_action', { nodeType: 'agent_action' as const, refId: 'trace-1', agentId: 'agent-1' }],
    ['system_event', { nodeType: 'system_event' as const, refId: 'inv-1', agentId: 'agent-1', metadata: { triggerType: 'outcome_extract' } }],
    ['hitl_event', { nodeType: 'hitl_event' as const, refId: 'action-1', agentId: 'agent-1', metadata: { correctionType: 'hitl-rejection' } }],
    ['chat_feedback', { nodeType: 'chat_feedback' as const, refId: 'batch-1', agentId: 'agent-1', metadata: { feedbackItemIds: ['f1'], learningCategory: 'correction' } }],
  ])('accepts nodeType %s', async (_, source) => {
    const client = makeClient();
    await expect(recordMemoryOrigin(client as any, 'tenant-1', 'mem-1', source)).resolves.toBeUndefined();
    expect(client.query).toHaveBeenCalledTimes(3);
  });

  it('is idempotent — ON CONFLICT DO NOTHING means re-running does not error', async () => {
    const client = makeClient();
    await recordMemoryOrigin(client as any, 'tenant-1', 'mem-1', { nodeType: 'agent_action', refId: 'trace-1' });
    await recordMemoryOrigin(client as any, 'tenant-1', 'mem-1', { nodeType: 'agent_action', refId: 'trace-1' });
    expect(client.query).toHaveBeenCalledTimes(6); // 3 per call
  });

  it('passes connectorId and agentId as null when absent', async () => {
    const client = makeClient();
    await recordMemoryOrigin(client as any, 'tenant-1', 'mem-1', { nodeType: 'agent_action', refId: 'trace-1' });
    const params = client.query.mock.calls[0][1] as unknown[];
    expect(params).toContain(null); // connectorId → null
  });
});

// ─── recordSynthesis ──────────────────────────────────────────────────────────

describe('recordSynthesis', () => {
  it('returns immediately without DB calls when sourceMemoryIds is empty', async () => {
    const client = makeClient();
    await recordSynthesis(client as any, 'tenant-1', [], 'derived-1');
    expect(client.query).not.toHaveBeenCalled();
  });

  it('upserts derived node + N source nodes + N synthesized_into edges for N sources', async () => {
    const client = makeClient();
    await recordSynthesis(client as any, 'tenant-1', ['src-1', 'src-2', 'src-3'], 'derived-1');
    // 1 derived node + 3 × (source node + edge) = 7 queries
    expect(client.query).toHaveBeenCalledTimes(7);
    const edgeCalls = client.query.mock.calls.filter((c: any[]) =>
      (c[0] as string).includes('provenance_edges')
    );
    expect(edgeCalls).toHaveLength(3);
    for (const call of edgeCalls) {
      expect(call[1]).toContain('synthesized_into');
    }
  });

  it('handles single source without error', async () => {
    const client = makeClient();
    await expect(recordSynthesis(client as any, 'tenant-1', ['src-1'], 'derived-1')).resolves.toBeUndefined();
    expect(client.query).toHaveBeenCalledTimes(3); // derived + src + edge
  });
});

// ─── recordAmendment ─────────────────────────────────────────────────────────

describe('recordAmendment', () => {
  it('upserts instruction_amendment node + N contributed_to edges', async () => {
    const client = makeClient();
    await recordAmendment(client as any, 'tenant-1', ['mem-1', 'mem-2'], 'amendment-uuid');
    // 1 amendment node + 2 × (memory node + edge) = 5 queries
    expect(client.query).toHaveBeenCalledTimes(5);
    const edgeCalls = client.query.mock.calls.filter((c: any[]) =>
      (c[0] as string).includes('provenance_edges')
    );
    expect(edgeCalls).toHaveLength(2);
    for (const call of edgeCalls) {
      expect(call[1]).toContain('contributed_to');
    }
    const amendmentCall = client.query.mock.calls[0];
    expect(amendmentCall[1]).toContain('instruction_amendment');
    expect(amendmentCall[1]).toContain('amendment-uuid');
  });
});

// ─── findMemoriesByConnector ──────────────────────────────────────────────────

describe('findMemoriesByConnector', () => {
  it('runs recursive CTE with correct connector_id and tenant_id params', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ memory_id: 'mem-a' }, { memory_id: 'mem-b' }],
    });
    const result = await findMemoriesByConnector('tenant-1', 'conn-1');
    expect(result).toEqual(['mem-a', 'mem-b']);
    const [sql, params] = mockPoolQuery.mock.calls[0];
    expect(sql).toContain('WITH RECURSIVE');
    expect(sql).toContain('connector_event');
    expect(sql).toContain('synthesized_into');
    expect(sql).toContain('depth < 50');
    expect(params).toEqual(['conn-1', 'tenant-1']);
  });

  it('returns empty array when connector has no provenance nodes', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const result = await findMemoriesByConnector('tenant-1', 'conn-none');
    expect(result).toEqual([]);
  });
});

// ─── getProvenanceChain ───────────────────────────────────────────────────────

describe('getProvenanceChain', () => {
  it('returns upstream and downstream arrays from two parallel queries', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({
        rows: [
          { node_type: 'connector_event', ref_id: 'entity-1', connector_id: 'conn-1', agent_id: null, confidence: 0.9, edge_type: 'produced', depth: 1, metadata: {} },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { node_type: 'memory', ref_id: 'child-mem', edge_type: 'synthesized_into', depth: 1 },
        ],
      });

    const result = await getProvenanceChain('tenant-1', 'mem-1', 5);

    expect(result.upstream).toHaveLength(1);
    expect(result.upstream[0]).toMatchObject({
      nodeType: 'connector_event',
      refId: 'entity-1',
      connectorId: 'conn-1',
      confidence: 0.9,
      edgeType: 'produced',
      depth: 1,
    });
    expect(result.downstream).toHaveLength(1);
    expect(result.downstream[0]).toMatchObject({
      nodeType: 'memory',
      refId: 'child-mem',
      edgeType: 'synthesized_into',
      depth: 1,
    });
  });

  it('omits connectorId and agentId when null in DB row', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({
        rows: [{ node_type: 'agent_action', ref_id: 'trace-1', connector_id: null, agent_id: 'agent-1', confidence: null, edge_type: 'produced', depth: 1, metadata: {} }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const result = await getProvenanceChain('tenant-1', 'mem-1', 5);
    expect(result.upstream[0]).not.toHaveProperty('connectorId');
    expect(result.upstream[0]).toHaveProperty('agentId', 'agent-1');
    expect(result.upstream[0]).not.toHaveProperty('confidence');
  });

  it('returns empty arrays for a memory with no provenance', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    const result = await getProvenanceChain('tenant-1', 'pre-migration-mem', 10);
    expect(result.upstream).toEqual([]);
    expect(result.downstream).toEqual([]);
  });

  it('passes depth param to both queries', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    await getProvenanceChain('tenant-1', 'mem-1', 15);
    expect(mockPoolQuery).toHaveBeenCalledTimes(2);
    expect(mockPoolQuery.mock.calls[0][1]).toContain(15);
    expect(mockPoolQuery.mock.calls[1][1]).toContain(15);
  });
});
