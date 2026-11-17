// §8 service-level tests for the v5 redistill-parity sweep.
//
// Verifies that the two new column-backed distill output fields
// (`skills`, `capability_tier`) are correctly threaded through:
//   - service.create INSERT (column list + binds)
//   - service.update presence-block (UPDATE column list + binds)
//   - runtimeConfigChanged predicate (fires secondary runtime_config_updated)
//   - createVersion snapshot (INSERT column list + binds)
//
// Mocks the DB pool and publisher transactions so we can assert on the
// exact SQL fragments and bind values the service emits.

const mockClientQuery = jest.fn();
const mockPoolQuery = jest.fn();
const mockMutateAndPublish = jest.fn();
const mockEnqueueOutbox = jest.fn();
const mockPublishOutboxRow = jest.fn();

jest.mock('../../infrastructure/database', () => {
  const __db: any = {
  pool: { query: (...args: unknown[]) => mockPoolQuery(...args), connect: jest.fn() },
};
  const __mkc = () => (__db.getPool ? __db.getPool() : (__db.pool || { query: jest.fn() }));
  __db.withTenantScope = (_t: string, fn: (c: any) => any) => fn(__mkc());
  __db.withAdminScope = (_c: any, fn: (c: any) => any) => fn(__mkc());
  return __db;
});

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

jest.mock('../../events/publisher', () => ({
  mutateAndPublishEvent: (...args: unknown[]) => mockMutateAndPublish(...args),
}));

jest.mock('../outbox', () => ({
  enqueueInternalAgentOutbox: (...args: unknown[]) => mockEnqueueOutbox(...args),
  publishOutboxRowInline: (...args: unknown[]) => mockPublishOutboxRow(...args),
}));

jest.mock('../event-payload', () => ({
  buildInternalAgentEventPayload: jest.fn(async () => ({})),
}));

function mapRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id ?? 'a1',
    tenantId: row.tenant_id ?? 't1',
    role: row.role ?? 'r',
    responsibilities: row.responsibilities ?? null,
    integrations: Array.isArray(row.integrations) ? row.integrations : [],
    pendingIntegrations: [],
    additionalContext: null,
    summary: null,
    systemPrompt: null,
    userInstructions: null,
    instructionsMd: null,
    instructions: null,
    temperature: 0.3,
    status: 'active',
    currentVersion: (row.current_version as number) ?? 1,
    tasksCompleted: 0,
    tasks30d: 0,
    monthlyCost: 0,
    lastActive: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    agentType: row.agent_type ?? 'agent',
    modelConfig: {},
    memoryScope: {},
    execConfig: {},
    workflowSteps: null,
    triggerConfig: null,
    delegates: [],
    workforcePlanId: null,
    pinnedKnowledgeIds: [],
    reviewedAt: null,
    reviewedBy: null,
    workflowStepsHash: null,
    messagingNickname: null,
    lastActivity: null,
    lastActivityAction: null,
    workflowVisualizationSteps: null,
    autonomyOverride: null,
    skills: row.skills ?? [],
    capabilityTier: row.capability_tier ?? 'connector_only',
  };
}

jest.mock('../row-mapper', () => ({
  mapInternalAgentRow: (row: Record<string, unknown>) => mapRow(row),
}));

jest.mock('../../tenants/repository', () => ({
  TenantRepository: jest.fn().mockImplementation(() => ({
    markHasCreatedInternalAgent: jest.fn(async () => {}),
  })),
}));

jest.mock('../../connectors/tenant-runtime-client', () => ({
  tenantRuntimeClient: { getTenantManifests: jest.fn(), getToolCatalog: jest.fn() },
}));

jest.mock('../../cost-attribution/attribution-service', () => ({
  getAllAgentsCosts: jest.fn(async () => []),
  getAgentCostSummary: jest.fn(async () => null),
}));

jest.mock('../workflow-visualization-steps-service', () => ({
  generateWorkflowVisualizationSteps: jest.fn(async () => {}),
}));

jest.mock('../embedding-service', () => ({
  generateAndStoreEmbedding: jest.fn(async () => {}),
}));

import { internalAgentService } from '../service';

const TENANT = '00000000-0000-0000-0000-0000000000aa';

interface Capture {
  inserts: Array<{ sql: string; params: unknown[] }>;
  updates: Array<{ sql: string; params: unknown[] }>;
  versionInserts: Array<{ sql: string; params: unknown[] }>;
}

function freshCapture(): Capture {
  return { inserts: [], updates: [], versionInserts: [] };
}

function wireDb(cap: Capture, returnRow: Record<string, unknown>) {
  mockClientQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (/^INSERT INTO internal_agents\b/.test(sql)) {
      cap.inserts.push({ sql, params });
      return { rows: [returnRow] };
    }
    if (/^INSERT INTO internal_agent_versions\b/.test(sql)) {
      cap.versionInserts.push({ sql, params });
      return { rows: [] };
    }
    if (/^UPDATE internal_agents SET\b/.test(sql)) {
      cap.updates.push({ sql, params });
      return { rows: [{ ...returnRow, current_version: 2 }] };
    }
    if (/^SELECT \* FROM internal_agents\b/.test(sql)) {
      return { rows: [{ ...returnRow, current_version: 2 }] };
    }
    return { rows: [] };
  });
}

function wireMutate() {
  // Returns the unwrapped `entity` field — matches the real
  // mutateAndPublishEvent contract.
  mockMutateAndPublish.mockImplementation(
    async (
      _meta: unknown,
      fn: (c: { query: typeof mockClientQuery }) => Promise<{ entity: unknown; eventInput: unknown }>,
    ) => {
      const { entity } = await fn({ query: mockClientQuery });
      return entity;
    },
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockEnqueueOutbox.mockResolvedValue({ id: 'outbox-1' });
  mockPublishOutboxRow.mockResolvedValue(undefined);
  wireMutate();
});

describe('service.create — skills + capability_tier persistence', () => {
  it('includes skills + capability_tier in the INSERT column list and binds them with safe defaults', async () => {
    const cap = freshCapture();
    wireDb(cap, { id: 'a1', tenant_id: TENANT, role: 'r', current_version: 1, integrations: [] });

    await internalAgentService.create(TENANT, { role: 'r' }, undefined, undefined);

    expect(cap.inserts).toHaveLength(1);
    expect(cap.inserts[0].sql).toMatch(/skills,\s*capability_tier/);
    expect(cap.inserts[0].params).toContain(JSON.stringify([]));
    expect(cap.inserts[0].params).toContain('connector_only');
  });

  it('passes caller-supplied skills + capabilityTier through to the INSERT binds', async () => {
    const cap = freshCapture();
    wireDb(cap, { id: 'a1', tenant_id: TENANT, role: 'r', current_version: 1, integrations: [] });

    const skills = [{ name: 'sk1', description: 'd', instruction: 'i' }];
    await internalAgentService.create(
      TENANT,
      { role: 'r', skills, capabilityTier: 'execution_enabled' },
      undefined,
      undefined,
    );

    expect(cap.inserts[0].params).toContain(JSON.stringify(skills));
    expect(cap.inserts[0].params).toContain('execution_enabled');
  });
});

describe('createVersion — snapshot includes skills + capability_tier', () => {
  it('includes skills + capability_tier in the version INSERT column list and binds', async () => {
    const cap = freshCapture();
    const skills = [{ name: 'sk', description: 'd', instruction: 'i' }];
    // Returned row from the agents INSERT carries skills/capability_tier;
    // mapInternalAgentRow surfaces them on the typed agent that createVersion
    // snapshots from.
    wireDb(cap, {
      id: 'a1', tenant_id: TENANT, role: 'r', current_version: 1, integrations: [],
      skills, capability_tier: 'execution_enabled',
    });

    await internalAgentService.create(
      TENANT,
      { role: 'r', skills, capabilityTier: 'execution_enabled' },
      undefined,
      undefined,
    );

    expect(cap.versionInserts).toHaveLength(1);
    expect(cap.versionInserts[0].sql).toMatch(/skills,\s*capability_tier/);
    expect(cap.versionInserts[0].params).toContain(JSON.stringify(skills));
    expect(cap.versionInserts[0].params).toContain('execution_enabled');
  });
});

describe('service.update — presence-block + runtimeConfigChanged', () => {
  function setupUpdate(currentRow: Record<string, unknown>): Capture {
    const cap = freshCapture();
    wireDb(cap, currentRow);
    // service.update calls this.getById which uses pool.query (not client.query).
    // Return the current row so the diff predicates have something to compare.
    mockPoolQuery.mockImplementation(async (sql: string) => {
      if (/^SELECT.*FROM internal_agents/.test(sql)) {
        return { rows: [currentRow] };
      }
      return { rows: [] };
    });
    return cap;
  }

  const baseRow = {
    id: 'a1', tenant_id: TENANT, role: 'r', integrations: [], current_version: 1,
    agent_type: 'agent', engine_config: { type: 'custom-loop' }, delegates: [],
    skills: [], capability_tier: 'connector_only',
  };

  it('writes skills to the UPDATE column list when provided', async () => {
    const cap = setupUpdate(baseRow);
    const skills = [{ name: 'sk', description: 'd', instruction: 'i' }];

    await internalAgentService.update('a1', TENANT, { skills });

    expect(cap.updates).toHaveLength(1);
    expect(cap.updates[0].sql).toMatch(/\bskills\s*=\s*\$\d+/);

    // P1.0: what lands is the MERGED set, not the incoming array verbatim.
    // A caller that is not the distiller is an operator, so its skills are
    // stamped operator-owned and protected — that stamp is what takes them out
    // of the reflection flywheel's reach.
    const written = JSON.parse(
      cap.updates[0].params.find((p: unknown) => typeof p === 'string' && p.startsWith('[{')) as string,
    );
    // The merge also assigns a stable id to a skill that arrives without one,
    // so the runtime reactivates one row per identity instead of inserting a
    // fresh one on every publish.
    expect(written).toEqual([
      {
        id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
        name: 'sk',
        description: 'd',
        instruction: 'i',
        provenance: 'operator',
        protected: true,
      },
    ]);
  });

  it('writes capability_tier to the UPDATE column list when provided', async () => {
    const cap = setupUpdate(baseRow);

    await internalAgentService.update('a1', TENANT, { capabilityTier: 'execution_enabled' });

    expect(cap.updates).toHaveLength(1);
    expect(cap.updates[0].sql).toMatch(/\bcapability_tier\s*=\s*\$\d+/);
    expect(cap.updates[0].params).toContain('execution_enabled');
  });

  it('fires the secondary runtime_config_updated event when capability_tier changes (carries capabilityTier in the payload)', async () => {
    setupUpdate(baseRow);

    await internalAgentService.update('a1', TENANT, { capabilityTier: 'execution_enabled' });

    expect(mockEnqueueOutbox).toHaveBeenCalledTimes(1);
    const enqueuedRow = mockEnqueueOutbox.mock.calls[0][1] as { eventType: string; payload: Record<string, unknown> };
    expect(enqueuedRow.eventType).toBe('tenant.internal_agent.runtime_config_updated');
    expect(enqueuedRow.payload).toHaveProperty('capabilityTier');
  });

  it('does NOT fire the secondary runtime_config_updated event when only skills changes', async () => {
    setupUpdate(baseRow);

    await internalAgentService.update('a1', TENANT, {
      skills: [{ name: 'sk', description: 'd', instruction: 'i' }],
    });

    expect(mockEnqueueOutbox).not.toHaveBeenCalled();
  });
});
