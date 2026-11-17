// Tests for /api/internal/knowledge/search attribution forwarding (Phase 2.8).

import express from 'express';
import request from 'supertest';

const mockEmbedQuery = jest.fn();
const mockSearchByTenantAndConnectors = jest.fn().mockResolvedValue([]);
const mockCountByTenantAndConnectors = jest.fn().mockResolvedValue(0);

jest.mock('../embedding-service', () => ({
  embedQuery: (...args: unknown[]) => mockEmbedQuery(...args),
}));
jest.mock('../repository', () => ({
  searchByTenantAndConnectors: (...args: unknown[]) => mockSearchByTenantAndConnectors(...args),
  countByTenantAndConnectors: (...args: unknown[]) => mockCountByTenantAndConnectors(...args),
}));

import { knowledgeInternalRouter } from '../internal-router';

const ORIG_ENV = { ...process.env };
function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/internal/knowledge', knowledgeInternalRouter);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ORIG_ENV, PLATFORM_CALLBACK_TOKEN: 'service-token', KNOWLEDGE_HYBRID_RETRIEVAL_ENABLED: 'true' };
  mockEmbedQuery.mockResolvedValue([0.1, 0.2, 0.3]);
});
afterAll(() => { process.env = ORIG_ENV; });

describe('POST /api/internal/knowledge/search', () => {
  it('forwards full attribution into embedQuery', async () => {
    const app = buildApp();
    await request(app)
      .post('/api/internal/knowledge/search')
      .set('X-Service-Auth', 'service-token')
      .send({
        tenantId: 't-1', connectorIds: [], includeManual: true, query: 'q', limit: 5,
        agentId: 'a-1', sessionId: 's-1', threadId: 'th-1', invocationId: 'iv-1',
      })
      .expect(200);

    expect(mockEmbedQuery).toHaveBeenCalledTimes(1);
    const [q, attribution] = mockEmbedQuery.mock.calls[0];
    expect(q).toBe('q');
    expect(attribution).toEqual({
      tenantId: 't-1', agentId: 'a-1', sessionId: 's-1', threadId: 'th-1', invocationId: 'iv-1',
    });
  });

  it('still works without attribution (legacy admin/script callers)', async () => {
    const app = buildApp();
    await request(app)
      .post('/api/internal/knowledge/search')
      .set('X-Service-Auth', 'service-token')
      .send({ tenantId: 't-1', query: 'q' })
      .expect(200);

    const [, attribution] = mockEmbedQuery.mock.calls[0];
    expect(attribution.tenantId).toBe('t-1');
    expect(attribution.agentId).toBeUndefined();
  });

  it('rejects with 401 when service auth missing', async () => {
    const app = buildApp();
    await request(app)
      .post('/api/internal/knowledge/search')
      .send({ tenantId: 't', query: 'q' })
      .expect(401);
  });

  it('skips embedQuery when hybrid retrieval disabled', async () => {
    process.env.KNOWLEDGE_HYBRID_RETRIEVAL_ENABLED = 'false';
    const app = buildApp();
    await request(app)
      .post('/api/internal/knowledge/search')
      .set('X-Service-Auth', 'service-token')
      .send({ tenantId: 't', query: 'q', agentId: 'a' })
      .expect(200);
    expect(mockEmbedQuery).not.toHaveBeenCalled();
  });

  it('forwards pinnedKnowledgeIds to repo as the 7th positional arg', async () => {
    const app = buildApp();
    const pinId = '00000000-0000-0000-0000-000000000001';
    await request(app)
      .post('/api/internal/knowledge/search')
      .set('X-Service-Auth', 'service-token')
      .send({
        tenantId: 't-1', query: 'q', limit: 5,
        pinnedKnowledgeIds: [pinId],
      })
      .expect(200);

    const args = mockSearchByTenantAndConnectors.mock.calls[0];
    expect(args[6]).toEqual([pinId]);
  });

  it('defaults pinnedKnowledgeIds to empty array when omitted', async () => {
    const app = buildApp();
    await request(app)
      .post('/api/internal/knowledge/search')
      .set('X-Service-Auth', 'service-token')
      .send({ tenantId: 't-1', query: 'q', limit: 5 })
      .expect(200);

    const args = mockSearchByTenantAndConnectors.mock.calls[0];
    expect(args[6]).toEqual([]);
  });
});
