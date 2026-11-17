// Connector Content Search Service Tests

jest.mock('../../memory/embedding', () => ({
  generateEmbedding: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
}));
jest.mock('../../memory/hyde', () => ({
  generateHypotheticalDocument: jest.fn().mockImplementation(async (q: string) => q),
}));

import { connectorContentCoverage, searchConnectorContent } from '../search-service';
import { generateEmbedding } from '../../memory/embedding';
import { generateHypotheticalDocument } from '../../memory/hyde';

// ---------------------------------------------------------------------------
// Mock pool factory
// ---------------------------------------------------------------------------

function makeMockPool(queryFn: (sql: string, params: unknown[]) => { rows: unknown[]; rowCount: number }) {
  return { query: jest.fn().mockImplementation((...args: [string, unknown[]]) => Promise.resolve(queryFn(...args))) } as any;
}

const TENANT = 'tenant-uuid';

const baseRow = (id: string, content: string, connectorType = 'slack') => ({
  id,
  content,
  connector_type: connectorType,
  entity_type: 'message',
  tags: [],
  vector_distance: 0.1,
  bm25_rank: 0.9,
});

describe('searchConnectorContent', () => {
  describe('RRF merge', () => {
    it('item appearing in both vector and BM25 results ranks higher than either alone', async () => {
      const sharedRow = baseRow('shared-id', 'shared content about widgets', 'slack');
      const vectorOnlyRow = baseRow('vector-only', 'vector only result about things');
      const bm25OnlyRow = baseRow('bm25-only', 'bm25 only result about stuff');

      const mockPool = makeMockPool((sql, _params) => {
        if (sql.includes('expires_at > NOW()') && sql.includes('COUNT')) {
          // hasConnectorContent check
          return { rows: [{ '1': 1 }], rowCount: 1 };
        }
        if (sql.includes('embedding IS NOT NULL')) {
          // Vector query
          return { rows: [sharedRow, vectorOnlyRow], rowCount: 2 };
        }
        if (sql.includes('to_tsquery')) {
          // BM25 query
          return { rows: [sharedRow, bm25OnlyRow], rowCount: 2 };
        }
        return { rows: [{ '1': 1 }], rowCount: 1 };
      });

      const results = await searchConnectorContent(
        { tenantId: TENANT, query: 'test query' },
        mockPool,
      );

      const ids = results.map(r => r.id);
      const sharedIdx = ids.indexOf('shared-id');
      const vectorIdx = ids.indexOf('vector-only');
      const bm25Idx = ids.indexOf('bm25-only');

      // Shared item should rank above either solo item
      expect(sharedIdx).toBeLessThan(vectorIdx);
      expect(sharedIdx).toBeLessThan(bm25Idx);
    });
  });

  describe('connectorType filter', () => {
    it('passes connector type to SQL queries and only returns that connector', async () => {
      const mockPool = makeMockPool((sql, params) => {
        if (sql.includes('COUNT')) return { rows: [{ '1': 1 }], rowCount: 1 };
        // Both queries should receive connectorType as a parameter
        const paramList = params as unknown[];
        const hasConnectorFilter = paramList.some(p => p === 'jira');
        if (!hasConnectorFilter && sql.includes('connector_type')) {
          throw new Error('connectorType filter not passed');
        }
        return {
          rows: [baseRow('jira-1', 'jira content about tickets', 'jira')],
          rowCount: 1,
        };
      });

      const results = await searchConnectorContent(
        { tenantId: TENANT, query: 'test', connectorType: 'jira' },
        mockPool,
      );

      expect(results.every(r => r.connectorType === 'jira')).toBe(true);
    });
  });

  describe('Cold-start fallback', () => {
    it('falls back to harvest-tagged memories when no connector_content rows exist', async () => {
      const mockPool = makeMockPool((sql, _params) => {
        if (sql.includes('COUNT') || (sql.includes('LIMIT 1') && sql.includes('connector_content'))) {
          // hasConnectorContent returns 0 rows
          return { rows: [], rowCount: 0 };
        }
        // Fallback query against memories with harvest: tags
        if (sql.includes('harvest:%')) {
          return {
            rows: [
              {
                id: 'mem-1',
                content: 'harvest memory content',
                connector_type: 'memory',
                entity_type: 'memory',
                tags: ['harvest:slack'],
                vector_distance: 0.2,
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      });

      const results = await searchConnectorContent(
        { tenantId: TENANT, query: 'test query' },
        mockPool,
      );

      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe('Filter consistency', () => {
    it('BM25 and vector queries share all WHERE conditions', async () => {
      const capturedSQLs: string[] = [];
      const capturedParams: unknown[][] = [];

      const mockPool = makeMockPool((sql, params) => {
        capturedSQLs.push(sql);
        capturedParams.push(params as unknown[]);
        if (sql.includes('LIMIT 1') && sql.includes('connector_content')) {
          return { rows: [{ '1': 1 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      });

      await searchConnectorContent(
        { tenantId: TENANT, query: 'hello world', connectorType: 'slack' },
        mockPool,
      );

      const vectorSQL = capturedSQLs.find(s => s.includes('embedding IS NOT NULL'));
      const bm25SQL = capturedSQLs.find(s => s.includes('to_tsquery'));

      expect(vectorSQL).toBeDefined();
      expect(bm25SQL).toBeDefined();

      // Both must filter on tenant_id
      expect(vectorSQL).toContain('tenant_id');
      expect(bm25SQL).toContain('tenant_id');

      // Both must filter on expiry
      expect(vectorSQL).toContain('expires_at > NOW()');
      expect(bm25SQL).toContain('expires_at > NOW()');

      // Both must accept connector_type filter
      expect(vectorSQL).toContain('connector_type');
      expect(bm25SQL).toContain('connector_type');

      // Vector has embedding guard; BM25 has tsquery guard — not the other way round
      expect(vectorSQL).toContain('embedding IS NOT NULL');
      expect(vectorSQL).not.toContain('to_tsquery');
      expect(bm25SQL).toContain('to_tsquery');
      expect(bm25SQL).not.toContain('embedding IS NOT NULL');

      // Both receive the same tenantId param
      const vectorParams = capturedParams[capturedSQLs.indexOf(vectorSQL!)];
      const bm25Params = capturedParams[capturedSQLs.indexOf(bm25SQL!)];
      expect(vectorParams).toContain(TENANT);
      expect(bm25Params).toContain(TENANT);
    });
  });

  describe('agentId conditional spread in generateEmbedding', () => {
    it('does NOT include agentId key in embedding options when agentId is omitted', async () => {
      const { generateEmbedding } = jest.requireMock('../../memory/embedding') as { generateEmbedding: jest.Mock };
      generateEmbedding.mockClear();
      generateEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);

      const mockPool = makeMockPool((sql) => {
        if (sql.includes('LIMIT 1') && sql.includes('connector_content')) return { rows: [{ '1': 1 }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      });

      await searchConnectorContent({ tenantId: TENANT, query: 'test' }, mockPool);

      const embeddingCall = generateEmbedding.mock.calls[0];
      const embeddingOptions = embeddingCall[1] as Record<string, unknown>;
      expect(Object.keys(embeddingOptions)).not.toContain('agentId');
    });

    it('includes agentId key in embedding options when agentId is provided', async () => {
      const { generateEmbedding } = jest.requireMock('../../memory/embedding') as { generateEmbedding: jest.Mock };
      generateEmbedding.mockClear();
      generateEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);

      const mockPool = makeMockPool((sql) => {
        if (sql.includes('LIMIT 1') && sql.includes('connector_content')) return { rows: [{ '1': 1 }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      });

      const agentId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      await searchConnectorContent({ tenantId: TENANT, query: 'test', agentId }, mockPool);

      const embeddingCall = generateEmbedding.mock.calls[0];
      const embeddingOptions = embeddingCall[1] as Record<string, unknown>;
      expect(embeddingOptions.agentId).toBe(agentId);
    });
  });

  describe('BM25 uses raw query — not hypothetical document', () => {
    it('BM25 SQL receives toTsQuery(rawQuery) while vector receives HyDE embedding', async () => {
      const { generateHypotheticalDocument } = jest.requireMock('../../memory/hyde') as { generateHypotheticalDocument: jest.Mock };
      const { generateEmbedding } = jest.requireMock('../../memory/embedding') as { generateEmbedding: jest.Mock };

      generateHypotheticalDocument.mockResolvedValue('A hypothetical document about widgets in Q3.');
      generateEmbedding.mockResolvedValue([0.9, 0.8, 0.7]);

      const capturedBM25Params: unknown[][] = [];

      const mockPool = makeMockPool((sql, params) => {
        if (sql.includes('LIMIT 1') && sql.includes('connector_content')) {
          return { rows: [{ '1': 1 }], rowCount: 1 };
        }
        if (sql.includes('to_tsquery')) {
          capturedBM25Params.push(params as unknown[]);
        }
        return { rows: [], rowCount: 0 };
      });

      await searchConnectorContent(
        { tenantId: TENANT, query: 'widgets Q3' },
        mockPool,
      );

      // generateEmbedding should have received the hypothetical doc, not the raw query
      expect(generateEmbedding).toHaveBeenCalledWith(
        'A hypothetical document about widgets in Q3.',
        expect.any(Object),
      );

      // BM25 should have received toTsQuery of the raw query: "widgets & Q3"
      expect(capturedBM25Params.length).toBeGreaterThan(0);
      const bm25QueryParam = capturedBM25Params[0][0] as string;
      expect(bm25QueryParam).toBe('widgets & Q3');
      expect(bm25QueryParam).not.toContain('hypothetical');
    });
  });
});

describe('precomputed embedding', () => {
  beforeEach(() => {
    (generateHypotheticalDocument as jest.Mock).mockClear();
    (generateEmbedding as jest.Mock).mockClear();
  });

  it('skips HyDE and the embedding call when the caller supplies a vector', async () => {
    const mockPool = makeMockPool((sql) => {
      if (sql.includes('expires_at > NOW()') && sql.includes('SELECT 1')) {
        return { rows: [{ '1': 1 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    await searchConnectorContent(
      { tenantId: TENANT, query: 'widgets', embeddingJson: '[0.9,0.8,0.7]' },
      mockPool,
    );

    expect(generateHypotheticalDocument).not.toHaveBeenCalled();
    expect(generateEmbedding).not.toHaveBeenCalled();
  });

  it('binds the caller vector to the query, not a freshly generated one', async () => {
    const seen: unknown[][] = [];
    const mockPool = makeMockPool((sql, params) => {
      seen.push(params);
      if (sql.includes('expires_at > NOW()') && sql.includes('SELECT 1')) {
        return { rows: [{ '1': 1 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    await searchConnectorContent(
      { tenantId: TENANT, query: 'widgets', embeddingJson: '[0.9,0.8,0.7]' },
      mockPool,
    );

    expect(seen.some((p) => p.includes('[0.9,0.8,0.7]'))).toBe(true);
  });

  it('still runs HyDE for callers that pass no vector', async () => {
    const mockPool = makeMockPool((sql) => {
      if (sql.includes('expires_at > NOW()') && sql.includes('SELECT 1')) {
        return { rows: [{ '1': 1 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    await searchConnectorContent({ tenantId: TENANT, query: 'widgets' }, mockPool);

    expect(generateHypotheticalDocument).toHaveBeenCalledTimes(1);
    expect(generateEmbedding).toHaveBeenCalledTimes(1);
  });
});


describe('coverage counts only what a search could return', () => {
  // Both search arms filter `expires_at > NOW()`. Coverage did not, so it
  // reported rows the search can never return — "N items indexed" printed
  // beside an empty result. A confident number that is wrong in the one
  // direction this whole source exists to prevent.
  it('applies the same expiry filter the search arms apply', async () => {
    const q = jest.fn().mockResolvedValue({ rows: [{ n: 3, oldest: null, newest: null }] });
    await connectorContentCoverage('t-1', undefined, { query: q } as never);
    const sql = q.mock.calls[0][0] as string;
    expect(sql).toMatch(/expires_at > NOW\(\)/);
  });

  it('keeps the expiry filter when a connector type narrows it', async () => {
    const q = jest.fn().mockResolvedValue({ rows: [{ n: 1, oldest: null, newest: null }] });
    await connectorContentCoverage('t-1', 'slack', { query: q } as never);
    const sql = q.mock.calls[0][0] as string;
    expect(sql).toMatch(/expires_at > NOW\(\)/);
    expect(sql).toMatch(/connector_type = \$2/);
    expect(q.mock.calls[0][1]).toEqual(['t-1', 'slack']);
  });
});

describe('no pooled connection is held across an LLM call', () => {
  // connector_content is FORCE RLS, so the queries run inside withTenantScope.
  // If HyDE and the embedding ran inside that scope too, every search would
  // hold a database connection for the length of two network round trips and
  // the pool would exhaust under concurrency.
  it('resolves the retrieval vector before the first query runs', async () => {
    const order: string[] = [];
    (generateHypotheticalDocument as jest.Mock).mockImplementation(async () => {
      order.push('hyde');
      return 'doc';
    });
    (generateEmbedding as jest.Mock).mockImplementation(async () => {
      order.push('embed');
      return [0.1, 0.2];
    });
    const q = jest.fn().mockImplementation(async () => {
      order.push('query');
      return { rows: [] };
    });

    await searchConnectorContent({ tenantId: 't-1', query: 'refunds' }, { query: q } as never);

    expect(order.indexOf('hyde')).toBeLessThan(order.indexOf('query'));
    expect(order.indexOf('embed')).toBeLessThan(order.indexOf('query'));
  });
});
