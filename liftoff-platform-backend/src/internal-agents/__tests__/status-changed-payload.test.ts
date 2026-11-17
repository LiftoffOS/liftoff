// Regression test for the status_changed payload leak.
//
// service.updateStatus enriches the activation payload via
// buildInternalAgentEventPayload(agent, 'tenant.internal_agent.created', ...)
// because the tenant-runtime needs the full agent config to bring the agent up
// in one shot. The 'created' payload shape includes createdAt/createdBy — which
// would mis-attribute the activation actor as the creator when leaked into a
// status_changed event. The fix strips those keys before merging.

import type { PoolClient } from 'pg';

const ENRICHED_PAYLOAD = {
  id: '00000000-0000-0000-0000-000000000001',
  name: 'reviewer',
  systemPrompt: 'do good',
  // The two fields the leak previously included:
  createdAt: '2020-01-01T00:00:00.000Z',
  createdBy: 'original-creator',
};

jest.mock('../../infrastructure/database', () => {
  const poolQuery = jest.fn(async (sql: string, params?: unknown[]) => {
    if (/SELECT \* FROM internal_agents WHERE id = \$1 AND tenant_id = \$2/i.test(sql)) {
      return {
        rows: [{
          id: params?.[0],
          tenant_id: params?.[1],
          role: 'reviewer',
          status: 'paused',
          current_version: 1,
          agent_type: 'agent',
          model_config: '{}',
          memory_scope: '{}',
          exec_config: '{}',
          engine_config: '{}',
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
    pool: { query: poolQuery, connect: jest.fn(async () => ({ query: jest.fn(), release: jest.fn() })) },
    withAdminScope: jest.fn(async (_ctx: unknown, fn: (c: PoolClient) => Promise<unknown>) => {
      const txClient = {
        query: jest.fn(async (sql: string, params?: unknown[]) => {
          if (/UPDATE internal_agents/i.test(sql) && /RETURNING \*/i.test(sql)) {
            return {
              rows: [{
                id: '00000000-0000-0000-0000-000000000001',
                tenant_id: 't1',
                role: 'reviewer',
                // Echo the status the caller asked for ($1), so a pause is
                // distinguishable from an activation in the published payload.
                status: (params?.[0] as string) ?? 'active',
                current_version: 2,
                agent_type: 'agent',
                model_config: '{}',
                memory_scope: '{}',
                exec_config: '{}',
                engine_config: '{}',
                delegates: '[]',
                integrations: '[]',
                pending_integrations: '[]',
                temperature: '0.3',
                tasks_completed: 0,
                last_active: new Date().toISOString(),
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

let lastEnqueuedPayload: Record<string, unknown> | null = null;
jest.mock('../outbox', () => ({
  enqueueInternalAgentOutbox: jest.fn(async (_client: unknown, input: { payload: Record<string, unknown> }) => {
    lastEnqueuedPayload = input.payload;
    return {
      outboxId: 'o1',
      eventId: 'e1',
      tenantId: 't1',
      internalAgentId: '00000000-0000-0000-0000-000000000001',
      eventType: 'tenant.internal_agent.status_changed',
      entityVersion: 2,
      payload: input.payload,
    };
  }),
  publishOutboxRowInline: jest.fn(async () => ({ inlinePublished: true })),
}));

jest.mock('../../events/outbox', () => ({
  enqueueControlPlaneOutbox: jest.fn(),
  publishControlPlaneOutboxRowInline: jest.fn(),
}));

jest.mock('../event-payload', () => ({
  buildInternalAgentEventPayload: jest.fn(async () => ({ ...ENRICHED_PAYLOAD })),
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
  lastEnqueuedPayload = null;
});

describe('status_changed activation payload', () => {
  it('REGRESSION: enriched activation payload does NOT carry createdAt/createdBy from the create-shape helper', async () => {
    const service = new InternalAgentService();
    await service.updateStatus(
      '00000000-0000-0000-0000-000000000001',
      't1',
      'active',
      'activator-account-id',
    );
    expect(lastEnqueuedPayload).not.toBeNull();
    // The status_changed event must carry changedAt/changedBy, NOT
    // createdAt/createdBy (which would mis-attribute creation to the activator).
    expect(lastEnqueuedPayload).not.toHaveProperty('createdAt');
    expect(lastEnqueuedPayload).not.toHaveProperty('createdBy');
    expect(lastEnqueuedPayload).toHaveProperty('changedAt');
    expect(lastEnqueuedPayload).toHaveProperty('changedBy', 'activator-account-id');
    // Sanity: the rest of the enriched payload still flowed through.
    expect(lastEnqueuedPayload).toMatchObject({
      id: '00000000-0000-0000-0000-000000000001',
      systemPrompt: 'do good',
    });
  });

  // The tenant-runtime's status_changed handler branches on `newStatus`. When
  // this publish moved out of the router and into the service, the status came
  // across as `status` only, and the runtime silently stopped acting on pause
  // and resume — its agents.lifecycle then lagged the dashboard by up to the
  // canonical reconciler's five-minute tick, refusing chat with "This team
  // member is paused" the whole time. Both names, always, same value.
  it('REGRESSION: activation payload names the status under BOTH newStatus and status', async () => {
    const service = new InternalAgentService();
    await service.updateStatus(
      '00000000-0000-0000-0000-000000000001',
      't1',
      'active',
      'activator-account-id',
    );
    expect(lastEnqueuedPayload).toMatchObject({ newStatus: 'active', status: 'active' });
  });

  it('REGRESSION: pause payload names the status under BOTH newStatus and status', async () => {
    const service = new InternalAgentService();
    await service.updateStatus(
      '00000000-0000-0000-0000-000000000001',
      't1',
      'paused',
      'pauser-account-id',
    );
    expect(lastEnqueuedPayload).toMatchObject({ newStatus: 'paused', status: 'paused' });
  });
});
