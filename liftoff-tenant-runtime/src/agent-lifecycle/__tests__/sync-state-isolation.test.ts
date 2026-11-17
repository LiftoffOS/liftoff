// Behavioural cross-tenant isolation test for sync-state-router (plan §7.6.1).
//
// Exercises the actual Express handlers (not a regex on the source) by
// mounting the router on a supertest app and feeding canned DB rows that
// model cross-tenant data. If the SQL ever drops the tenant_id filter the
// /sync-state endpoint will leak a different tenant's mapping into the
// response and these assertions fail.

import express from 'express';
import request from 'supertest';

// Capture all DB queries so we can both seed responses and assert correctness.
type QueryRecord = { sql: string; params?: unknown[] };
const queries: QueryRecord[] = [];
type Responder = (sql: string, params: unknown[] | undefined) => { rows: unknown[] };
let responder: Responder = () => ({ rows: [] });

jest.mock('../../infrastructure/database', () => {
  const pool = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      return responder(sql, params);
    }),
  };
  return { getPoolForService: () => pool };
});

jest.mock('../../infrastructure/logging', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { logger, log: logger };
});

// Bypass service-auth so we can exercise the handler logic directly.
jest.mock('../../security/service-auth', () => ({
  requireServiceAuth: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// runtime-env.getTenantRuntimeUrl is only called by the requireServiceAuth
// audience-resolver, which we bypass. Stub anyway to keep imports happy.
jest.mock('../../infrastructure/runtime-env', () => ({
  getTenantRuntimeUrl: () => 'https://test.example',
}));

import { syncStateRouter } from '../sync-state-router';

const app = express();
app.use(express.json());
app.use('/internal/agents', syncStateRouter);

const TENANT_A = '00000000-0000-0000-0000-00000000000a';
const TENANT_B = '00000000-0000-0000-0000-00000000000b';
const AGENT_X = '00000000-0000-0000-0000-0000000000a1';
const AGENT_Y = '00000000-0000-0000-0000-0000000000a2';
const RUNTIME_A_X = 'aa000000-0000-0000-0000-000000000001';
const RUNTIME_A_Y = 'aa000000-0000-0000-0000-000000000002';
const RUNTIME_B_Z = 'bb000000-0000-0000-0000-000000000001';

beforeEach(() => {
  queries.length = 0;
});

describe('GET /internal/agents/sync-state — tenant isolation', () => {
  it('returns the mapping when (tenantId, internalAgentId) belong to the same tenant', async () => {
    responder = (sql, params) => {
      const [tenantId, internalAgentId] = (params ?? []) as string[];
      if (tenantId === TENANT_A && internalAgentId === AGENT_X) {
        return {
          rows: [{
            agent_id: RUNTIME_A_X,
            lifecycle: 'ACTIVE',
            cached_entity_version: 1,
            cached_status: 'active',
            has_active_instruction: true,
            trigger_config: { type: 'event', eventTopic: 'email.received' },
            instructions_md: '# instructions',
            compiled_system_prompt: 'You are a support agent.',
            compiled_user_instructions: 'Respond to inbound mail.',
            compiled_capability_tier: 'connector_only',
          }],
        };
      }
      return { rows: [] };
    };
    const res = await request(app).get(`/internal/agents/sync-state?tenantId=${TENANT_A}&internalAgentId=${AGENT_X}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      hasMapping: true,
      runtimeAgentId: RUNTIME_A_X,
      lifecycle: 'ACTIVE',
      hasActiveInstruction: true,
      cachedEntityVersion: 1,
      cachedStatus: 'active',
      capabilityTier: 'connector_only',
    });
    // sha256 hex digest of a non-empty canonicalized object — 64 chars.
    expect(res.body.triggerConfigHash).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.instructionsHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns hasMapping=false when internalAgentId belongs to a DIFFERENT tenant (cross-tenant leak guard)', async () => {
    // Storage: only TENANT_A owns AGENT_X. Caller asks for AGENT_X scoped to
    // TENANT_B. The SQL's WHERE m.tenant_id = $1 AND m.internal_agent_id = $2
    // must exclude the row and return zero rows.
    responder = (sql, params) => {
      const [tenantId, internalAgentId] = (params ?? []) as string[];
      if (tenantId === TENANT_A && internalAgentId === AGENT_X) {
        return {
          rows: [{
            agent_id: RUNTIME_A_X,
            lifecycle: 'ACTIVE',
            cached_entity_version: 1,
            cached_status: 'active',
            has_active_instruction: true,
            trigger_config: { type: 'event', eventTopic: 'email.received' },
            instructions_md: '# instructions',
            compiled_system_prompt: 'You are a support agent.',
            compiled_user_instructions: 'Respond to inbound mail.',
            compiled_capability_tier: 'connector_only',
          }],
        };
      }
      return { rows: [] };
    };
    const res = await request(app).get(`/internal/agents/sync-state?tenantId=${TENANT_B}&internalAgentId=${AGENT_X}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hasMapping: false });
    // Confirm the SQL was bound with TENANT_B as $1 — proves the filter is in
    // place rather than us just relying on storage being empty.
    expect(queries.length).toBe(1);
    expect(queries[0].params).toEqual([TENANT_B, AGENT_X]);
    expect(queries[0].sql).toMatch(/WHERE m\.tenant_id\s*=\s*\$1\s+AND\s+m\.internal_agent_id\s*=\s*\$2/i);
  });

  it('rejects requests missing tenantId with 400', async () => {
    const res = await request(app).get(`/internal/agents/sync-state?internalAgentId=${AGENT_X}`);
    expect(res.status).toBe(400);
  });

  it('rejects requests missing internalAgentId with 400', async () => {
    const res = await request(app).get(`/internal/agents/sync-state?tenantId=${TENANT_A}`);
    expect(res.status).toBe(400);
  });
});

describe('GET /internal/agents/list-mappings — tenant isolation', () => {
  it('returns ONLY the mappings for the requested tenant', async () => {
    responder = (sql, params) => {
      const [tenantId] = (params ?? []) as string[];
      if (tenantId === TENANT_A) {
        return {
          rows: [
            { internal_agent_id: AGENT_X, agent_id: RUNTIME_A_X },
            { internal_agent_id: AGENT_Y, agent_id: RUNTIME_A_Y },
          ],
        };
      }
      if (tenantId === TENANT_B) {
        return { rows: [{ internal_agent_id: 'agent-z', agent_id: RUNTIME_B_Z }] };
      }
      return { rows: [] };
    };

    const a = await request(app).get(`/internal/agents/list-mappings?tenantId=${TENANT_A}`);
    expect(a.status).toBe(200);
    expect(a.body).toEqual([
      { internalAgentId: AGENT_X, runtimeAgentId: RUNTIME_A_X },
      { internalAgentId: AGENT_Y, runtimeAgentId: RUNTIME_A_Y },
    ]);
    // The tenant-B mapping must NOT appear in the tenant-A response.
    expect(JSON.stringify(a.body)).not.toContain(RUNTIME_B_Z);

    const b = await request(app).get(`/internal/agents/list-mappings?tenantId=${TENANT_B}`);
    expect(b.status).toBe(200);
    expect(b.body).toEqual([{ internalAgentId: 'agent-z', runtimeAgentId: RUNTIME_B_Z }]);
    // Verify each query bound the right tenantId.
    expect(queries[0].params).toEqual([TENANT_A]);
    expect(queries[1].params).toEqual([TENANT_B]);
  });

  it('returns [] when tenant has no mappings (does NOT leak other tenants)', async () => {
    responder = (sql, params) => {
      const [tenantId] = (params ?? []) as string[];
      // Tenant B is empty; tenant A has mappings — if the filter is dropped
      // we'd see TENANT_A's rows in the response.
      if (tenantId === TENANT_B) return { rows: [] };
      return { rows: [{ internal_agent_id: AGENT_X, agent_id: RUNTIME_A_X }] };
    };
    const res = await request(app).get(`/internal/agents/list-mappings?tenantId=${TENANT_B}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('rejects requests missing tenantId with 400', async () => {
    const res = await request(app).get('/internal/agents/list-mappings');
    expect(res.status).toBe(400);
  });
});
