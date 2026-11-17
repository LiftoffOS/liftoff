// The data-landscape route.
//
// This exists because the unit tests all passed while the route was broken.
// `getDataLandscape` treats an explicit `knowledgeItems: null` as authoritative
// — the control plane owns that table and its null means "I looked and could
// not establish it". The route was turning an ABSENT query param into that
// explicit null, so the runtime's own cached count was never consulted and
// every caller that omitted the param was told the knowledge base was unknown,
// permanently. Unit tests of either half alone miss it, because both halves
// were individually correct.

const mockGetDataLandscape = jest.fn();
const mockRenderLandscapeBlock = jest.fn().mockReturnValue('RENDERED');
jest.mock('../landscape-service', () => ({
  getDataLandscape: (...a: unknown[]) => mockGetDataLandscape(...a),
  renderLandscapeBlock: (...a: unknown[]) => mockRenderLandscapeBlock(...a),
}));

const mockPrune = jest.fn().mockResolvedValue(3);
jest.mock('../../agent-execution/blast-radius-store', () => ({
  pruneOldRunTotals: (...a: unknown[]) => mockPrune(...a),
}));

jest.mock('../../security/service-auth', () => ({
  requireServiceAuth: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import express from 'express';
import request from 'supertest';
import { dataLandscapeRouter } from '../router';

const TENANT = '11111111-1111-4111-8111-111111111111';

const LANDSCAPE = {
  connectors: [],
  indexedContext: { items: 0, oldest: null, newest: null },
  knowledgeItems: null,
  truncated: false,
};

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/internal/data-landscape', dataLandscapeRouter);
  return a;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetDataLandscape.mockResolvedValue(LANDSCAPE);
  mockRenderLandscapeBlock.mockReturnValue('RENDERED');
});

describe('knowledgeItems forwarding', () => {
  it('does NOT pass the key at all when the caller omits it', async () => {
    // The whole bug: `?? null` here reads as "the caller established it is
    // unknown", which is authoritative, so the cache is never consulted.
    await request(app()).get(`/api/internal/data-landscape?tenantId=${TENANT}`).expect(200);

    const arg = mockGetDataLandscape.mock.calls[0][0] as Record<string, unknown>;
    expect(arg).toEqual({ tenantId: TENANT });
    expect(arg).not.toHaveProperty('knowledgeItems');
  });

  it('passes the count through when the caller sends one', async () => {
    await request(app())
      .get(`/api/internal/data-landscape?tenantId=${TENANT}&knowledgeItems=42`)
      .expect(200);
    expect(mockGetDataLandscape).toHaveBeenCalledWith({ tenantId: TENANT, knowledgeItems: 42 });
  });

  it('passes a genuine zero rather than dropping it as falsy', async () => {
    await request(app())
      .get(`/api/internal/data-landscape?tenantId=${TENANT}&knowledgeItems=0`)
      .expect(200);
    expect(mockGetDataLandscape).toHaveBeenCalledWith({ tenantId: TENANT, knowledgeItems: 0 });
  });
});

describe('the response', () => {
  it('returns the structured landscape', async () => {
    const res = await request(app())
      .get(`/api/internal/data-landscape?tenantId=${TENANT}`)
      .expect(200);
    expect(res.body).toMatchObject({ truncated: false });
    expect(res.body).not.toHaveProperty('rendered');
  });

  it('adds the prompt rendering only when asked', async () => {
    const res = await request(app())
      .get(`/api/internal/data-landscape?tenantId=${TENANT}&render=true`)
      .expect(200);
    expect(res.body.rendered).toBe('RENDERED');
  });

  it('rejects a non-UUID tenant', async () => {
    await request(app()).get('/api/internal/data-landscape?tenantId=nope').expect(400);
    expect(mockGetDataLandscape).not.toHaveBeenCalled();
  });

  it('rejects a negative knowledge count', async () => {
    await request(app())
      .get(`/api/internal/data-landscape?tenantId=${TENANT}&knowledgeItems=-1`)
      .expect(400);
  });
});

describe('the blast-radius prune', () => {
  it('prunes counters for finished runs', async () => {
    const res = await request(app())
      .post('/api/internal/data-landscape/maintenance/prune-blast-radius')
      .send({ tenantId: TENANT })
      .expect(200);
    expect(res.body).toEqual({ deletedCount: 3 });
    expect(mockPrune).toHaveBeenCalledWith(TENANT, undefined);
  });

  it('honours an explicit age', async () => {
    await request(app())
      .post('/api/internal/data-landscape/maintenance/prune-blast-radius')
      .send({ tenantId: TENANT, olderThanHours: 12 })
      .expect(200);
    expect(mockPrune).toHaveBeenCalledWith(TENANT, 12);
  });

  it('rejects a non-UUID tenant', async () => {
    await request(app())
      .post('/api/internal/data-landscape/maintenance/prune-blast-radius')
      .send({ tenantId: 'nope' })
      .expect(400);
    expect(mockPrune).not.toHaveBeenCalled();
  });
});
