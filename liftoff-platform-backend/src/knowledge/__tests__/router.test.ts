// Tests for the user-facing knowledge router. Focused on the new
// GET /:id/pinning-agents admin endpoint that backs the
// "what agents will break if I delete this article?" warning.

import express from 'express'
import request from 'supertest'

const mockPoolQuery = jest.fn()

jest.mock('../../infrastructure/database', () => {
  const __db: any = {
  pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
};
  const __mkc = () => (__db.getPool ? __db.getPool() : (__db.pool || { query: jest.fn() }));
  __db.withTenantScope = (_t: string, fn: (c: any) => any) => fn(__mkc());
  __db.withAdminScope = (_c: any, fn: (c: any) => any) => fn(__mkc());
  return __db;
})

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  logAudit: jest.fn(),
}))

jest.mock('../../infrastructure/middleware', () => ({
  tenantAuthMiddleware: () => (req: any, _res: unknown, next: () => void) => {
    req.ctx = req.ctx ?? { tenantId: 'tenant-1' }
    next()
  },
}))

jest.mock('../../infrastructure/audit-context', () => ({ auditCtx: () => ({}) }))

jest.mock('../service', () => ({
  list: jest.fn(),
  getById: jest.fn(),
  createItem: jest.fn(),
  updateItem: jest.fn(),
  deleteItem: jest.fn(),
  batchCreateItems: jest.fn(),
  importFromConnector: jest.fn(),
  browseConnector: jest.fn(),
  syncItems: jest.fn(),
  resyncItem: jest.fn(),
  notifyExtractionDone: jest.fn(),
}))

import { knowledgeRouter } from '../router'

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/knowledge', knowledgeRouter)
  return app
}

beforeEach(() => jest.clearAllMocks())

describe('GET /api/knowledge/:id/pinning-agents', () => {
  it('returns the agents currently pinning the item', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { id: 'agent-1', role: 'Support Tier 1' },
        { id: 'agent-2', role: 'Refund Coordinator' },
      ],
    })
    const app = buildApp()
    const res = await request(app)
      .get('/api/knowledge/00000000-0000-0000-0000-000000000001/pinning-agents?tenantId=tenant-1')
      .expect(200)
    expect(res.body).toEqual({
      agents: [
        { id: 'agent-1', role: 'Support Tier 1' },
        { id: 'agent-2', role: 'Refund Coordinator' },
      ],
    })

    // Verify the query uses the GIN-friendly && operator and the partial
    // index's deleted_at filter so admin lookups don't scan the heap.
    const [sql, params] = mockPoolQuery.mock.calls[0]
    expect(sql).toMatch(/pinned_knowledge_ids && ARRAY\[\$2::uuid\]/)
    expect(sql).toMatch(/deleted_at IS NULL/)
    expect(params).toEqual(['tenant-1', '00000000-0000-0000-0000-000000000001'])
  })

  it('returns empty list when no agents pin the item', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] })
    const app = buildApp()
    const res = await request(app)
      .get('/api/knowledge/00000000-0000-0000-0000-000000000001/pinning-agents?tenantId=tenant-1')
      .expect(200)
    expect(res.body).toEqual({ agents: [] })
  })
})
