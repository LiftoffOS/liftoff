// Behavioral test for the publisher-side fix to runtime_config_updated.
//
// Pre-fix: service.update enqueued runtime_config_updated with
//   entityVersion: agent.currentVersion (envelope)
// which collided with the primary `updated` event's version at the runtime's
// version gate, dropping the secondary event in half the race outcomes.
//
// Post-fix: service.update enqueues with
//   entityVersion: null (envelope — skips runtime version gate)
//   payload.entityVersion: agent.currentVersion (handler reads this)
//
// This test asserts the publisher contract that pairs with the runtime test
// in liftoff-tenant-runtime/src/events/__tests__/runtime-config-updated.test.ts.

import type { PoolClient } from 'pg';

const queries: Array<{ sql: string; params?: unknown[]; client: 'pool' | 'tx' }> = [];

type EnqueueArgs = { tenantId: string; internalAgentId: string; eventType: string; entityVersion: number | null; payload: Record<string, unknown> };
const enqueueCalls: EnqueueArgs[] = [];

jest.mock('../../infrastructure/database', () => {
  const poolQuery = jest.fn(async (sql: string, params?: unknown[]) => {
    queries.push({ sql, params, client: 'pool' });
    if (/SELECT \* FROM internal_agents WHERE id = \$1 AND tenant_id = \$2/i.test(sql)) {
      return {
        rows: [{
          id: params?.[0],
          tenant_id: params?.[1],
          role: 'reviewer',
          status: 'active',
          current_version: 4,
          agent_type: 'agent',
          model_config: JSON.stringify({ tier: 'medium' }),
          memory_scope: JSON.stringify({ readableLayers: ['individual'], writableLayers: ['individual'] }),
          exec_config: '{}',
          engine_config: JSON.stringify({ type: 'custom-loop' }),
          delegates: '[]',
          integrations: '[]',
          pending_integrations: '[]',
          temperature: '0.3',
          tasks_completed: 0,
          last_active: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          responsibilities: null,
          additional_context: null,
          summary: null,
          system_prompt: null,
          user_instructions: null,
          instructions_md: null,
          instructions: null,
          workflow_steps: null,
          trigger_config: null,
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
      connect: jest.fn(async () => ({ query: jest.fn(), release: jest.fn() })),
    },
    withAdminScope: jest.fn(async (_ctx: unknown, fn: (c: PoolClient) => Promise<unknown>) => {
      const txClient = {
        query: jest.fn(async (sql: string, params?: unknown[]) => {
          queries.push({ sql, params, client: 'tx' });
          if (/UPDATE internal_agents/i.test(sql) && /RETURNING \*/i.test(sql)) {
            // Bump version to 5; reflect post-update modelConfig.tier='large'
            // so the secondary runtime_config_updated payload carries the
            // mutated value (the runtimeConfigChanged check fires on the
            // diff at update() time, not on the mocked returned row).
            return {
              rows: [{
                id: '00000000-0000-0000-0000-000000000001',
                tenant_id: 't1',
                role: 'reviewer',
                status: 'active',
                current_version: 5,
                agent_type: 'agent',
                model_config: JSON.stringify({ tier: 'large' }),
                memory_scope: JSON.stringify({}),
                exec_config: '{}',
                delegates: '[]',
                integrations: '[]',
                pending_integrations: '[]',
                temperature: '0.3',
                tasks_completed: 0,
                last_active: null,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                responsibilities: null,
                additional_context: null,
                summary: null,
                system_prompt: null,
                user_instructions: null,
                instructions_md: null,
                instructions: null,
                workflow_steps: null,
                trigger_config: null,
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
      return fn(txClient as unknown as PoolClient);
    }),
  };
});

jest.mock('../outbox', () => ({
  enqueueInternalAgentOutbox: jest.fn(async (_c: unknown, args: EnqueueArgs) => {
    enqueueCalls.push(args);
    return {
      outboxId: `o-${enqueueCalls.length}`,
      eventId: `e-${enqueueCalls.length}`,
      tenantId: args.tenantId,
      internalAgentId: args.internalAgentId,
      eventType: args.eventType,
      entityVersion: args.entityVersion,
      payload: args.payload,
    };
  }),
  publishOutboxRowInline: jest.fn(async () => ({ inlinePublished: true })),
}));

jest.mock('../../events/outbox', () => ({
  enqueueControlPlaneOutbox: jest.fn(),
  publishControlPlaneOutboxRowInline: jest.fn(),
}));

jest.mock('../event-payload', () => ({
  buildInternalAgentEventPayload: jest.fn(async () => ({ id: '00000000-0000-0000-0000-000000000001', name: 'reviewer' })),
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
  getAgentCostSummary: jest.fn(async () => ({ totalCostUsd: 0, totalInvocations: 0 })),
}));

jest.mock('../workflow-visualization-steps-service', () => ({
  generateWorkflowVisualizationSteps: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../infrastructure/logging', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { logger, log: logger, logAudit: jest.fn() };
});

import { InternalAgentService } from '../service';

beforeEach(() => {
  queries.length = 0;
  enqueueCalls.length = 0;
});

describe('service.update — runtime_config_updated envelope contract', () => {
  it('REGRESSION: emits runtime_config_updated with entityVersion=null in envelope AND payload.entityVersion=N', async () => {
    const service = new InternalAgentService();
    await service.update(
      '00000000-0000-0000-0000-000000000001',
      't1',
      // modelConfig change triggers runtimeConfigChanged=true (versionedFieldsChanged also true).
      { modelConfig: { tier: 'large' } },
      'actor-1',
    );

    // Two enqueues expected: primary `updated` + secondary `runtime_config_updated`.
    expect(enqueueCalls).toHaveLength(2);

    const primary = enqueueCalls.find((c) => c.eventType === 'tenant.internal_agent.updated');
    const secondary = enqueueCalls.find((c) => c.eventType === 'tenant.internal_agent.runtime_config_updated');

    expect(primary).toBeDefined();
    expect(secondary).toBeDefined();

    // Primary keeps envelope entityVersion=currentVersion (gate validates ordering)
    expect(primary!.entityVersion).toBe(5);

    // Secondary MUST have envelope entityVersion=null (gate bypass) and
    // payload.entityVersion=N so the runtime handler can write it via COALESCE.
    expect(secondary!.entityVersion).toBeNull();
    expect(secondary!.payload.entityVersion).toBe(5);

    // Sanity: payload still carries the runtime config fields.
    expect(secondary!.payload).toMatchObject({
      agentType: 'agent',
      modelConfig: { tier: 'large' },
    });
  });

  // An autonomy-only save is the common shape of the Autonomy Override control
  // on /dashboard/agents/update: an operator tightens one team and touches
  // nothing else. Before the fix, autonomyOverride was in versionedFieldsChanged
  // but NOT in runtimeConfigChanged, so `runtimeConfigChanged && versioned...`
  // was false, the secondary event was never enqueued, and the runtime's
  // agents.hitl_level stayed at whatever it was until some unrelated later edit
  // happened to touch agentType/modelConfig/memoryScope/execConfig/
  // aiVendorOverride/capabilityTier. That publish is the ONLY carrier of the
  // override into the runtime, which never reads autonomy_override itself.
  it('REGRESSION: an autonomy-only update still emits runtime_config_updated', async () => {
    const service = new InternalAgentService();
    await service.update(
      '00000000-0000-0000-0000-000000000001',
      't1',
      // Current row has autonomy_override: null, so this is a real diff — and
      // it is the ONLY field being changed.
      { autonomyOverride: 'controlled' } as never,
      'actor-1',
    );

    const secondary = enqueueCalls.find(
      (c) => c.eventType === 'tenant.internal_agent.runtime_config_updated',
    );

    expect(secondary).toBeDefined();
    // The payload must carry a resolved hitlLevel — that field is the whole
    // point of the event, and the runtime subscriber writes it straight into
    // agents.hitl_level.
    expect(secondary!.payload.hitlLevel).toEqual(expect.any(Number));
  });
});
