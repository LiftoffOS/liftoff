// Tests for POST /api/internal-agents/backfill-deleted-events
//
// Covers the symmetric counterpart of backfill-created-events: drains runtime
// orphans by republishing tenant.internal_agent.deleted for every soft-deleted
// agent on a tenant. Designed to recover state when a delete event was lost in
// transit or when the agent was deleted before delete-event publishing existed.

import express from 'express';
import request from 'supertest';

jest.mock('../../infrastructure/database', () => {
  const __db: any = {
  pool: { query: jest.fn() },
};
  const __mkc = () => (__db.getPool ? __db.getPool() : (__db.pool || { query: jest.fn() }));
  __db.withTenantScope = (_t: string, fn: (c: any) => any) => fn(__mkc());
  __db.withAdminScope = (_c: any, fn: (c: any) => any) => fn(__mkc());
  return __db;
});

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  logAudit: jest.fn(),
}));

jest.mock('../events', () => ({
  publishInternalAgentEvent: jest.fn().mockResolvedValue(undefined),
}));

// Minimal stubs for unrelated imports pulled in by router.ts side-effects.
jest.mock('../service', () => ({ internalAgentService: {} }));
jest.mock('../distill-service', () => ({ distillInternalAgent: jest.fn() }));
jest.mock('../../accounts/service', () => ({ AccountService: jest.fn() }));
jest.mock('../../accounts/repository', () => ({ AccountRepository: jest.fn() }));
jest.mock('../../tenant-members/service', () => ({ tenantMembersService: {} }));
jest.mock('../../tenant-members/types', () => ({ TenantMemberRole: {}, ROLE_HIERARCHY: {} }));
jest.mock('../../llm/usage-tracker', () => ({ attributeSessionToAgent: jest.fn() }));
jest.mock('../../connectors/tenant-runtime-client', () => ({ tenantRuntimeClient: {} }));
jest.mock('../../billing/execution-guard', () => ({ checkExecutionAllowed: jest.fn() }));
jest.mock('../../billing/subscription-items-service', () => ({ updateAgentQuantity: jest.fn() }));
jest.mock('../integration-enrichment', () => ({ enrichIntegrationsWithType: jest.fn() }));
jest.mock('../../knowledge/repository', () => ({}));
jest.mock('../effective-instructions-md', () => ({ buildEffectiveInstructionsMd: jest.fn() }));
jest.mock('../../infrastructure/idempotency', () => ({ withIdempotency: jest.fn() }));
jest.mock('../../infrastructure/idempotency-middleware', () => ({ withIdempotencyMiddleware: jest.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()) }));

import { pool } from '../../infrastructure/database';
import { publishInternalAgentEvent } from '../events';
import { internalAgentsServiceRouter } from '../router';

const SERVICE_TOKEN = 'test-tenant-runtime-service-token';
const TENANT_ID = '11111111-1111-1111-1111-111111111111';

function buildApp() {
  process.env.TENANT_RUNTIME_SERVICE_TOKEN = SERVICE_TOKEN;
  const app = express();
  app.use(express.json());
  app.use('/api/internal-agents', internalAgentsServiceRouter);
  return app;
}

describe('POST /api/internal-agents/backfill-deleted-events', () => {
  const mockPoolQuery = (pool as unknown as { query: jest.Mock }).query;
  const mockPublish = publishInternalAgentEvent as jest.Mock;

  beforeEach(() => {
    mockPoolQuery.mockReset();
    mockPublish.mockReset();
    mockPublish.mockResolvedValue(undefined);
  });

  it('returns 401 without X-Service-Auth header', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/internal-agents/backfill-deleted-events')
      .query({ tenantId: TENANT_ID });
    expect(res.status).toBe(401);
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it('returns 400 when tenantId is missing', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/internal-agents/backfill-deleted-events')
      .set('X-Service-Auth', SERVICE_TOKEN);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/tenantId/);
  });

  it('publishes deleted event for every soft-deleted agent on the tenant', async () => {
    mockPoolQuery.mockResolvedValue({
      rows: [
        { id: 'agent-a', deleted_at: new Date('2026-04-01T00:00:00Z') },
        { id: 'agent-b', deleted_at: new Date('2026-04-02T00:00:00Z') },
      ],
    });
    const app = buildApp();

    const res = await request(app)
      .post('/api/internal-agents/backfill-deleted-events')
      .set('X-Service-Auth', SERVICE_TOKEN)
      .query({ tenantId: TENANT_ID });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      dryRun: false,
      published: 2,
      errors: [],
      agentIds: ['agent-a', 'agent-b'],
    });
    expect(mockPublish).toHaveBeenCalledTimes(2);
    // entity_version MUST be null so the runtime version gate is bypassed —
    // backfill events must always process regardless of stored version state.
    expect(mockPublish).toHaveBeenNthCalledWith(1, 'tenant.internal_agent.deleted', 'agent-a', TENANT_ID, null, {});
    expect(mockPublish).toHaveBeenNthCalledWith(2, 'tenant.internal_agent.deleted', 'agent-b', TENANT_ID, null, {});
  });

  it('only iterates rows where deleted_at IS NOT NULL', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    const app = buildApp();

    await request(app)
      .post('/api/internal-agents/backfill-deleted-events')
      .set('X-Service-Auth', SERVICE_TOKEN)
      .query({ tenantId: TENANT_ID });

    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockPoolQuery.mock.calls[0];
    expect(sql).toMatch(/deleted_at IS NOT NULL/);
    expect(params).toEqual([TENANT_ID]);
  });

  it('honours dryRun by enumerating without publishing', async () => {
    mockPoolQuery.mockResolvedValue({
      rows: [{ id: 'agent-a', deleted_at: new Date() }],
    });
    const app = buildApp();

    const res = await request(app)
      .post('/api/internal-agents/backfill-deleted-events')
      .set('X-Service-Auth', SERVICE_TOKEN)
      .query({ tenantId: TENANT_ID, dryRun: 'true' });

    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.published).toBe(1);
    expect(res.body.agentIds).toEqual(['agent-a']);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('continues the batch when one publish fails and reports the per-row error', async () => {
    mockPoolQuery.mockResolvedValue({
      rows: [
        { id: 'agent-a', deleted_at: new Date() },
        { id: 'agent-b', deleted_at: new Date() },
        { id: 'agent-c', deleted_at: new Date() },
      ],
    });
    mockPublish
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('pubsub unavailable'))
      .mockResolvedValueOnce(undefined);

    const app = buildApp();
    const res = await request(app)
      .post('/api/internal-agents/backfill-deleted-events')
      .set('X-Service-Auth', SERVICE_TOKEN)
      .query({ tenantId: TENANT_ID });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    expect(res.body.published).toBe(2);
    expect(res.body.errors).toEqual([{ id: 'agent-b', error: 'pubsub unavailable' }]);
    expect(res.body.agentIds).toEqual(['agent-a', 'agent-c']);
  });
});
