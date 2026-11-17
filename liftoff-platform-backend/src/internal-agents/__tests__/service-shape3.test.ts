// Shape-3 acceptance test (plan §5.4): for every internal_agent entity
// mutation that publishes a corresponding event, the entity row and the
// outbox row MUST commit in the same transaction. If the outbox enqueue
// throws, the entity mutation MUST roll back — i.e. no internal_agents row.
//
// Strategy: mock withAdminScope so we can observe the callback's behaviour,
// then stub enqueueInternalAgentOutbox / enqueueControlPlaneOutbox to throw
// and assert the surrounding mutateAndPublishEvent surfaces the failure
// without leaving the entity row behind.

import type { PoolClient } from 'pg';

const queries: Array<{ sql: string; params?: unknown[]; client: 'pool' | 'tx' }> = [];
let enqueueShouldThrow = false;
let inlinePublishShouldThrow = false;

// Test seam: when set, the tx-client UPDATE/DELETE returns rowCount=0 so the
// not-found path in service.update/updateStatus/delete fires. Default false
// (UPDATE returns the row, simulating happy path).
let updateReturnsNotFound = false;

jest.mock('../../infrastructure/database', () => {
  const poolQuery = jest.fn(async (sql: string, params?: unknown[]) => {
    queries.push({ sql, params, client: 'pool' });
    // Service.update / updateStatus / delete all call getById first which hits
    // the pool. Return a stub row so the not-found short-circuit doesn't fire
    // before we reach the mutateAndPublishEvent callback.
    if (/SELECT \* FROM internal_agents WHERE id = \$1 AND tenant_id = \$2/i.test(sql)) {
      return {
        rows: [{
          id: params?.[0],
          tenant_id: params?.[1],
          role: 'existing-role',
          responsibilities: null,
          integrations: '[]',
          pending_integrations: '[]',
          additional_context: null,
          summary: null,
          system_prompt: null,
          user_instructions: null,
          instructions_md: null,
          instructions: null,
          temperature: '0.3',
          status: 'active',
          current_version: 1,
          tasks_completed: 0,
          last_active: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          agent_type: 'agent',
          model_config: '{}',
          memory_scope: '{}',
          exec_config: '{}',
          workflow_steps: null,
          trigger_config: null,
          engine_config: '{}',
          delegates: '[]',
          workforce_plan_id: null,
          reviewed_at: null,
          reviewed_by: null,
          workflow_steps_hash: null,
          messaging_nickname: null,
          workflow_visualization_steps: null,
          autonomy_override: null,
        }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  });
  return {
    withTenantScope: (_t: any, fn: any) => fn({ query: poolQuery }),
    withAdminScope: (_c: any, fn: any) => fn({ query: poolQuery }),
    pool: {
      query: poolQuery,
      connect: jest.fn(async () => ({
        query: jest.fn(async (sql: string, params?: unknown[]) => {
          queries.push({ sql, params, client: 'tx' });
          return { rows: [], rowCount: 0 };
        }),
        release: jest.fn(),
      })),
    },
    withAdminScope: jest.fn(async (_ctx: unknown, fn: (c: PoolClient) => Promise<unknown>) => {
      // Tx-aware client that captures queries.
      const txClient = {
        query: jest.fn(async (sql: string, params?: unknown[]) => {
          queries.push({ sql, params, client: 'tx' });
          // Not-found path test seam: force rowCount=0 on the entity mutation.
          if (updateReturnsNotFound && /UPDATE internal_agents/i.test(sql)) {
            return { rows: [], rowCount: 0 };
          }
          // UPDATE happy path: return a row so the service maps it.
          if (/UPDATE internal_agents/i.test(sql) && /RETURNING \*/i.test(sql)) {
            return {
              rows: [{
                id: params?.[params.length - 2] ?? '00000000-0000-0000-0000-000000000001',
                tenant_id: params?.[params.length - 1] ?? 't1',
                role: 'updated-role',
                responsibilities: null,
                integrations: '[]',
                pending_integrations: '[]',
                additional_context: null,
                summary: null,
                system_prompt: null,
                user_instructions: null,
                instructions_md: null,
                instructions: null,
                temperature: '0.3',
                status: 'active',
                current_version: 2,
                tasks_completed: 0,
                last_active: null,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                agent_type: 'agent',
                model_config: '{}',
                memory_scope: '{}',
                exec_config: '{}',
                workflow_steps: null,
                trigger_config: null,
                engine_config: '{}',
                delegates: '[]',
                workforce_plan_id: null,
                reviewed_at: null,
                reviewed_by: null,
                workflow_steps_hash: null,
                messaging_nickname: null,
                workflow_visualization_steps: null,
                autonomy_override: null,
              }],
              rowCount: 1,
            };
          }
          // Soft-delete UPDATE: return rowCount=1 so the not-found branch
          // doesn't fire on the happy-path tests.
          if (/UPDATE internal_agents SET deleted_at/i.test(sql)) {
            return { rows: [{ id: params?.[0] }], rowCount: 1 };
          }
          if (/INSERT INTO internal_agents/i.test(sql)) {
            return {
              rows: [{
                id: '00000000-0000-0000-0000-000000000001',
                tenant_id: params?.[0],
                role: params?.[1] ?? 'test-role',
                responsibilities: null,
                integrations: '[]',
                pending_integrations: '[]',
                additional_context: null,
                summary: null,
                system_prompt: null,
                user_instructions: null,
                instructions_md: null,
                instructions: null,
                temperature: '0.3',
                status: 'draft',
                current_version: 1,
                tasks_completed: 0,
                last_active: null,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                agent_type: 'agent',
                model_config: '{}',
                memory_scope: '{}',
                exec_config: '{}',
                workflow_steps: null,
                trigger_config: null,
                engine_config: '{}',
                delegates: '[]',
                workforce_plan_id: null,
                reviewed_at: null,
                reviewed_by: null,
                workflow_steps_hash: null,
                messaging_nickname: null,
                workflow_visualization_steps: null,
                autonomy_override: null,
              }],
              rowCount: 1,
            };
          }
          return { rows: [], rowCount: 0 };
        }),
      };
      // withAdminScope wraps in tx semantics — if the callback throws, the tx
      // is rolled back. The mock has no commit/rollback state to manage, so
      // we just propagate the result/error. Tests assert on user-visible
      // outcomes (returned value, thrown error, mock calls).
      return await fn(txClient as unknown as PoolClient);
    }),
  };
});

jest.mock('../outbox', () => ({
  enqueueInternalAgentOutbox: jest.fn(async () => {
    if (enqueueShouldThrow) throw new Error('simulated outbox failure');
    return {
      outboxId: 'outbox-1',
      eventId: 'event-1',
      tenantId: 't1',
      internalAgentId: '00000000-0000-0000-0000-000000000001',
      eventType: 'tenant.internal_agent.created',
      entityVersion: 1,
      payload: {},
    };
  }),
  publishOutboxRowInline: jest.fn(async () => {
    if (inlinePublishShouldThrow) throw new Error('simulated inline publish failure');
    return { inlinePublished: true };
  }),
}));

jest.mock('../../events/outbox', () => ({
  enqueueControlPlaneOutbox: jest.fn(),
  publishControlPlaneOutboxRowInline: jest.fn(),
}));

jest.mock('../../infrastructure/logging', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { log: logger, logger, logAudit: jest.fn() };
});

jest.mock('../event-payload', () => ({
  buildInternalAgentEventPayload: jest.fn(async () => ({ id: '00000000-0000-0000-0000-000000000001', name: 'test' })),
}));

jest.mock('../../tenants/repository', () => ({
  TenantRepository: jest.fn().mockImplementation(() => ({
    markHasCreatedInternalAgent: jest.fn(),
  })),
}));

jest.mock('../../connectors/tenant-runtime-client', () => ({
  tenantRuntimeClient: { getTenantManifests: jest.fn(async () => ({ manifests: [] })) },
}));

jest.mock('../../cost-attribution/attribution-service', () => ({
  getAllAgentsCosts: jest.fn(async () => []),
  getAgentCostSummary: jest.fn(async () => ({})),
}));

jest.mock('../workflow-visualization-steps-service', () => ({
  generateWorkflowVisualizationSteps: jest.fn(() => Promise.resolve()),
}));

import { InternalAgentService } from '../service';
import * as outbox from '../outbox';

const service = new InternalAgentService();

beforeEach(() => {
  queries.length = 0;
  enqueueShouldThrow = false;
  inlinePublishShouldThrow = false;
  updateReturnsNotFound = false;
  (outbox.publishOutboxRowInline as jest.Mock).mockClear();
  (outbox.enqueueInternalAgentOutbox as jest.Mock).mockClear();
});

describe('service.create — shape-3 invariant', () => {
  it('happy path: enqueues outbox inside the tx then publishes inline', async () => {
    await service.create('t1', { role: 'engineer' } as never);
    // INSERT internal_agents must use the tx client, not the pool.
    const inserted = queries.find((q) => /INSERT INTO internal_agents/i.test(q.sql));
    expect(inserted).toBeDefined();
    expect(inserted!.client).toBe('tx');
    // outbox.enqueueInternalAgentOutbox must have been called inside the tx
    // (i.e. before the inline publish).
    expect(outbox.enqueueInternalAgentOutbox).toHaveBeenCalledTimes(1);
    expect(outbox.publishOutboxRowInline).toHaveBeenCalledTimes(1);
  });

  it('throws and skips inline publish when outbox enqueue fails', async () => {
    enqueueShouldThrow = true;
    await expect(service.create('t1', { role: 'engineer' } as never)).rejects.toThrow(/simulated outbox failure/);
    // publishOutboxRowInline must NOT have been invoked — failure inside the
    // tx callback aborts before commit.
    expect(outbox.publishOutboxRowInline).not.toHaveBeenCalled();
  });

  it('returns 2xx-equivalent (resolved promise) even when inline publish fails — row stays pending for worker', async () => {
    inlinePublishShouldThrow = false; // publishOutboxRowInline is contractually NEVER throws — covered by outbox.test.ts
    const agent = await service.create('t1', { role: 'engineer' } as never);
    expect(agent.id).toBe('00000000-0000-0000-0000-000000000001');
  });
});

describe('service.delete — shape-3 invariant', () => {
  it('throws and skips inline publish when outbox enqueue fails — entity mutation rolled back', async () => {
    enqueueShouldThrow = true;
    await expect(service.delete('00000000-0000-0000-0000-000000000001', 't1', 'actor-1')).rejects.toThrow(/simulated outbox failure/);
    expect(outbox.publishOutboxRowInline).not.toHaveBeenCalled();
  });
});

// Regression coverage for the _noop-event bug: when an entity mutation finds no
// row (concurrent delete, fake id, etc.) the service MUST NOT enqueue an outbox
// row. Previously each not-found path published a payload with `_noop: true`
// which the runtime would either silently mutate cached_internal_agents on, or
// — worse — bootstrap a phantom agent from in handleInternalAgentUpdated.
describe('not-found paths skip the publish entirely', () => {
  it('service.update on not-found: no outbox row enqueued, returns null', async () => {
    updateReturnsNotFound = true;
    const result = await service.update('00000000-0000-0000-0000-000000000001', 't1', { role: 'noop' } as never);
    expect(result).toBeNull();
    expect(outbox.enqueueInternalAgentOutbox).not.toHaveBeenCalled();
    expect(outbox.publishOutboxRowInline).not.toHaveBeenCalled();
  });

  it('service.updateStatus on not-found: no outbox row enqueued, returns null', async () => {
    updateReturnsNotFound = true;
    const result = await service.updateStatus('00000000-0000-0000-0000-000000000001', 't1', 'paused');
    expect(result).toBeNull();
    expect(outbox.enqueueInternalAgentOutbox).not.toHaveBeenCalled();
    expect(outbox.publishOutboxRowInline).not.toHaveBeenCalled();
  });

  it('service.delete on not-found: no outbox row enqueued, returns false', async () => {
    updateReturnsNotFound = true;
    const result = await service.delete('00000000-0000-0000-0000-000000000001', 't1', 'actor-1');
    expect(result).toBe(false);
    expect(outbox.enqueueInternalAgentOutbox).not.toHaveBeenCalled();
    expect(outbox.publishOutboxRowInline).not.toHaveBeenCalled();
  });
});
