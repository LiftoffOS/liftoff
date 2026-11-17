/* eslint-disable @typescript-eslint/no-var-requires */

const mockQuery = jest.fn();
jest.mock('../infrastructure/database', () => ({
  getPool: jest.fn(() => ({ query: mockQuery })),
  closePool: jest.fn(),
}));

jest.mock('../infrastructure/logging', () => ({
  log: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('../memory-client', () => ({
  resolveRuntimeUrl: jest.fn().mockResolvedValue('https://runtime.example.com'),
}));

jest.mock('@liftoffos/service-client', () => ({
  buildOidcAuthHeader: jest.fn().mockResolvedValue({}),
}));

const mockFetch = jest.fn();
(global as unknown as { fetch: jest.Mock }).fetch = mockFetch;

import { handleConnectorDeleted } from '../disconnect-handler';

// Helper: successful provenance response (Path 1)
const provenanceOk = (deleted = 0) => ({
  ok: true,
  status: 200,
  json: async () => ({ deleted }),
});

beforeEach(() => {
  jest.clearAllMocks();
  mockFetch.mockResolvedValue({ ok: true, status: 200 });
});

describe('handleConnectorDeleted', () => {
  it('calls provenance erasure then DELETE for each non-null memory_id', async () => {
    // Path 1: provenance endpoint deletes synthesized descendants
    mockFetch.mockResolvedValueOnce(provenanceOk(0));
    // Path 2: harvest_entities fallback (SQL already filters nulls via AND memory_id IS NOT NULL)
    mockQuery
      .mockResolvedValueOnce({ rows: [{ memory_id: 'mem-1' }, { memory_id: 'mem-2' }] }) // SELECT
      .mockResolvedValueOnce({ rowCount: 2 }); // DELETE harvest_entities
    await handleConnectorDeleted('conn-1', 'tenant-1');
    expect(mockFetch).toHaveBeenCalledTimes(3); // provenance + mem-1 + mem-2
    expect(mockFetch.mock.calls[0][0]).toContain('/api/internal/provenance/connector/conn-1');
    expect(mockFetch.mock.calls[1][0]).toContain('/api/memory/mem-1');
    expect(mockFetch.mock.calls[2][0]).toContain('/api/memory/mem-2');
  });

  it('treats 404 from tenant-runtime fallback deletes as success', async () => {
    mockFetch.mockResolvedValueOnce(provenanceOk(0)); // Path 1 succeeds
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 }); // Path 2: mem-1 returns 404
    mockQuery
      .mockResolvedValueOnce({ rows: [{ memory_id: 'mem-1' }] })
      .mockResolvedValueOnce({ rowCount: 1 });
    await expect(handleConnectorDeleted('conn-1', 'tenant-1')).resolves.toBeUndefined();
  });

  it('deletes harvest_entities rows for connector', async () => {
    mockFetch.mockResolvedValueOnce(provenanceOk(0));
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 0 });
    await handleConnectorDeleted('conn-1', 'tenant-1');
    const deleteSql = mockQuery.mock.calls[mockQuery.mock.calls.length - 1][0] as string;
    expect(deleteSql).toContain('DELETE FROM harvest_entities');
    expect(mockQuery.mock.calls[mockQuery.mock.calls.length - 1][1]).toEqual(['conn-1']);
  });

  it('makes provenance erasure call even when connector has no tracked entities', async () => {
    mockFetch.mockResolvedValueOnce(provenanceOk(0));
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 0 });
    await expect(handleConnectorDeleted('conn-1', 'tenant-1')).resolves.toBeUndefined();
    // Path 1 always fires — provenance graph may have synthesized descendants not in harvest_entities
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toContain('/api/internal/provenance/connector/conn-1');
  });
});
