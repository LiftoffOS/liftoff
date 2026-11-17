// The dual-site publish contract for the per-agent AI vendor override.
//
// Two things are pinned here that a single-payload test cannot see:
//
//   1. `runtime_config_updated` FIRES on an override-only save. Without the
//      field in `runtimeConfigChanged` the override would persist and the
//      runtime would keep re-resolving the old route — a dead switch one layer
//      below the one this feature exists to fix.
//   2. BOTH events carry the SAME resolved modelConfig. The primary envelope
//      and the secondary runtime_config_updated payload both write TR's
//      `agents.model_config` and both fire on the same save, so translating at
//      only one site would have them race with different values.
//
// Mock shape follows runtime-config-publish.test.ts.

import type { PoolClient } from 'pg';

const queries: Array<{ sql: string; params?: unknown[]; client: 'pool' | 'tx' }> = [];

type EnqueueArgs = { tenantId: string; internalAgentId: string; eventType: string; entityVersion: number | null; payload: Record<string, unknown> };
const enqueueCalls: EnqueueArgs[] = [];

const AGENT_ID = '00000000-0000-0000-0000-000000000001';

const BASE_ROW = {
  id: AGENT_ID,
  tenant_id: 't1',
  role: 'reviewer',
  status: 'active',
  current_version: 4,
  agent_type: 'agent',
  model_config: JSON.stringify({ tier: 'medium' }),
  memory_scope: JSON.stringify({ readableLayers: ['individual'], writableLayers: ['individual'] }),
  exec_config: '{}',
  delegates: '[]',
  integrations: '[]',
  pending_integrations: '[]',
  temperature: '0.3',
  tasks_completed: 0,
  last_active: null,
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
  responsibilities: null,
  additional_context: null,
  summary: null,
  system_prompt: null,
  user_instructions: null,
  instructions_md: null,
  workflow_steps: null,
  trigger_config: null,
  workforce_plan_id: null,
  reviewed_at: null,
  reviewed_by: null,
  workflow_steps_hash: null,
  messaging_nickname: null,
  workflow_visualization_steps: null,
  autonomy_override: null,
  ai_vendor_override: null,
};

// Set per test: the row the pre-update read returns, and the row the UPDATE
// returns. Mutable because the interesting cases differ only in these two.
let currentRow: Record<string, unknown> = { ...BASE_ROW };
let updatedRow: Record<string, unknown> = { ...BASE_ROW };

/** Point the mocks at a save that moves the override from `before` to `after`. */
function stageSave(before: string | null, after: string | null, modelConfig?: string) {
  currentRow = { ...BASE_ROW, ai_vendor_override: before, ...(modelConfig ? { model_config: modelConfig } : {}) };
  updatedRow = { ...currentRow, current_version: 5, ai_vendor_override: after };
}

jest.mock('../../infrastructure/database', () => {
  const poolQuery = jest.fn(async (sql: string, params?: unknown[]) => {
    queries.push({ sql, params, client: 'pool' });
    if (/SELECT \* FROM internal_agents WHERE id = \$1 AND tenant_id = \$2/i.test(sql)) {
      return { rows: [{ ...currentRow, id: params?.[0], tenant_id: params?.[1] }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  return {
    withTenantScope: (_t: unknown, fn: (c: unknown) => unknown) => fn({ query: poolQuery }),
    pool: {
      query: poolQuery,
      connect: jest.fn(async () => ({ query: jest.fn(), release: jest.fn() })),
    },
    withAdminScope: jest.fn(async (_ctx: unknown, fn: (c: PoolClient) => Promise<unknown>) => {
      const txClient = {
        query: jest.fn(async (sql: string, params?: unknown[]) => {
          queries.push({ sql, params, client: 'tx' });
          if (/UPDATE internal_agents/i.test(sql) && /RETURNING \*/i.test(sql)) {
            return { rows: [updatedRow], rowCount: 1 };
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
    return { outboxId: `o-${enqueueCalls.length}`, eventId: `e-${enqueueCalls.length}`, ...args };
  }),
  publishOutboxRowInline: jest.fn(async () => ({ inlinePublished: true })),
}));

jest.mock('../../events/outbox', () => ({
  enqueueControlPlaneOutbox: jest.fn(),
  publishControlPlaneOutboxRowInline: jest.fn(),
}));

// event-payload is NOT mocked — the primary payload's modelConfig is half of
// what is under test. Its two I/O-bound helpers are.
jest.mock('../effective-instructions-md', () => ({
  buildEffectiveInstructionsMd: jest.fn(async () => 'effective-md'),
}));
jest.mock('../integration-enrichment', () => ({
  enrichIntegrationsWithType: jest.fn(async (_t: string, i: unknown) => i),
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
import { WORKSPACE_AI_VENDORS } from '../../model-registry/workspace-ai-vendors';

// Provider + tier, and no model id: the override names a vendor, and which
// model that vendor's tier means is resolved by the runtime when it runs.
const QWEN_MEDIUM = {
  tier: 'medium',
  provider: WORKSPACE_AI_VENDORS.qwen.provider,
};
const ANTHROPIC_MEDIUM = {
  tier: 'medium',
  provider: 'anthropic',
};
const RAW = { tier: 'medium' };

const primary = () => enqueueCalls.find((c) => c.eventType === 'tenant.internal_agent.updated');
const secondary = () =>
  enqueueCalls.find((c) => c.eventType === 'tenant.internal_agent.runtime_config_updated');

beforeEach(() => {
  queries.length = 0;
  enqueueCalls.length = 0;
  currentRow = { ...BASE_ROW };
  updatedRow = { ...BASE_ROW };
});

describe('service.update — vendor override', () => {
  it('writes the column, bumps the version, and fires runtime_config_updated', async () => {
    stageSave(null, 'qwen');
    await new InternalAgentService().update(AGENT_ID, 't1', { aiVendorOverride: 'qwen' }, 'actor-1');

    const update = queries.find((q) => /UPDATE internal_agents/i.test(q.sql) && /RETURNING \*/i.test(q.sql));
    expect(update).toBeDefined();
    expect(update!.sql).toContain('ai_vendor_override =');
    expect(update!.params).toContain('qwen');
    // versionedFieldsChanged → a lone override edit bumps the version, which is
    // also what lets the secondary event fire (it needs BOTH predicates).
    expect(update!.sql).toContain('current_version =');
    expect(secondary()).toBeDefined();
  });

  it('snapshots the override into the version row so rollback can restore it', async () => {
    stageSave(null, 'qwen');
    await new InternalAgentService().update(AGENT_ID, 't1', { aiVendorOverride: 'qwen' }, 'actor-1');

    const versionInsert = queries.find((q) => /INSERT INTO internal_agent_versions/i.test(q.sql));
    expect(versionInsert).toBeDefined();
    expect(versionInsert!.sql).toContain('ai_vendor_override');
    expect(versionInsert!.params).toContain('qwen');
  });

  it('carries the SAME translated modelConfig on BOTH events', async () => {
    stageSave(null, 'qwen');
    await new InternalAgentService().update(AGENT_ID, 't1', { aiVendorOverride: 'qwen' }, 'actor-1');

    expect(primary()!.payload.modelConfig).toEqual(QWEN_MEDIUM);
    expect(secondary()!.payload.modelConfig).toEqual(QWEN_MEDIUM);
  });

  it("stamps anthropic-medium on BOTH events for 'default', never the workspace vendor", async () => {
    stageSave(null, 'default');
    await new InternalAgentService().update(AGENT_ID, 't1', { aiVendorOverride: 'default' }, 'actor-1');

    expect(primary()!.payload.modelConfig).toEqual(ANTHROPIC_MEDIUM);
    expect(secondary()!.payload.modelConfig).toEqual(ANTHROPIC_MEDIUM);
  });

  it('reverts BOTH payloads to the raw config when the override is cleared', async () => {
    stageSave('qwen', null);
    await new InternalAgentService().update(AGENT_ID, 't1', { aiVendorOverride: null }, 'actor-1');

    const update = queries.find((q) => /UPDATE internal_agents/i.test(q.sql) && /RETURNING \*/i.test(q.sql));
    expect(update!.sql).toContain('ai_vendor_override =');
    expect(update!.params).toContain(null);

    expect(primary()!.payload.modelConfig).toEqual(RAW);
    expect(secondary()!.payload.modelConfig).toEqual(RAW);
  });

  it('leaves a tuned config untouched on BOTH events', async () => {
    const tuned = { tier: 'medium', modelId: 'ft:acme-42', provider: 'openai' };
    // The service layer does not gate this — the PUT handler does (A5). What
    // matters here is that if the column somehow holds an override, the tuned
    // config still wins on the wire.
    stageSave('kimi', 'kimi', JSON.stringify(tuned));
    updatedRow = { ...updatedRow, agent_type: 'workflow' };
    await new InternalAgentService().update(AGENT_ID, 't1', { agentType: 'workflow' }, 'actor-1');

    expect(primary()!.payload.modelConfig).toEqual(tuned);
    expect(secondary()!.payload.modelConfig).toEqual(tuned);
  });

  it('does not fire runtime_config_updated when the override is unchanged', async () => {
    stageSave(null, null);
    await new InternalAgentService().update(AGENT_ID, 't1', { aiVendorOverride: null }, 'actor-1');
    expect(secondary()).toBeUndefined();
  });
});
