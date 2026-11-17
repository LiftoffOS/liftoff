import { jest } from '@jest/globals';

// Every reconcile-time SQL query now runs on the dedicated PoolClient
// (the one that also holds the advisory lock + the RLS tenant-context GUC).
// The tests model that by routing ALL queries through clientQueryMock.

const clientQueryMock = jest.fn<(sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>>();
const clientReleaseMock = jest.fn();
let lockAcquired = true;

const poolConnectMock = jest.fn(async () => ({
  query: clientQueryMock,
  release: clientReleaseMock,
}));

const fakePool = {
  // pool.query is no longer used by the reconciler — keep a stub that throws
  // so any regression that reintroduces a raw pool.query (bypassing the
  // RLS-bound client) fails loudly in tests.
  query: jest.fn(async () => { throw new Error('reconciler must use the RLS-bound client, not pool.query'); }),
  connect: poolConnectMock,
};

jest.mock('../../infrastructure/database', () => ({
  getPoolForService: () => fakePool,
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../infrastructure/runtime-env', () => ({
  getTenantRuntimeUrl: () => 'https://tr.example',
}));

const listCanonicalAgentsMock = jest.fn<(tenantId: string) => Promise<unknown[]>>();
const fetchCanonicalAgentFullMock = jest.fn<(tenantId: string, agentId: string) => Promise<Record<string, unknown> | null>>();
jest.mock('../../clients/platform-backend-client', () => ({
  listCanonicalAgents: (...args: [string]) => listCanonicalAgentsMock(...args),
  fetchCanonicalAgentFull: (...args: [string, string]) => fetchCanonicalAgentFullMock(...args),
}));

const handleInternalAgentCreatedMock = jest.fn<(event: unknown) => Promise<void>>();
jest.mock('../../events/subscriber', () => ({
  handleInternalAgentCreated: (event: unknown) => handleInternalAgentCreatedMock(event),
}));

const createOrUnpauseJobMock = jest.fn(async () => 'jobpath');
const resumeJobMock = jest.fn(async () => undefined);
const pauseJobMock = jest.fn(async () => undefined);
const deleteJobMock = jest.fn(async () => undefined);
const getJobStatusMock = jest.fn<() => Promise<unknown>>();

jest.mock('../../scheduling/cloud-scheduler', () => ({
  createOrUnpauseJob: (...args: unknown[]) => createOrUnpauseJobMock(...(args as [])),
  resumeJob: (...args: unknown[]) => resumeJobMock(...(args as [])),
  pauseJob: (...args: unknown[]) => pauseJobMock(...(args as [])),
  deleteJob: (...args: unknown[]) => deleteJobMock(...(args as [])),
  getJobStatus: (...args: unknown[]) => getJobStatusMock(...(args as [])),
}));

const createTimeSeriesMock = jest.fn(async () => undefined);
jest.mock('@google-cloud/monitoring', () => ({
  MetricServiceClient: jest.fn().mockImplementation(() => ({
    createTimeSeries: createTimeSeriesMock,
  })),
}));

// Routing helper for the dedicated-client query mock. The reconciler issues
// (in order): pg_try_advisory_lock → set_config('app.tenant_id',...) →
// listCanonicalAgents (out-of-band HTTP) → per-agent UPSERT/SELECT/UPDATE →
// orphan scan → emitMetrics queries → set_config(reset) → pg_advisory_unlock.
type ClientBehavior = {
  changed?: boolean;            // value returned by the cache UPSERT
  mappingAgentId?: string | null;
  localAgent?: { id: string; lifecycle: string; trigger_config: unknown; name: string } | null;
  orphans?: Array<{ agent_id: string; internal_agent_id: string; canonical_miss_count?: number }>;
};

function routeClient(behavior: ClientBehavior) {
  clientQueryMock.mockImplementation(async (sql: string) => {
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: lockAcquired }] };
    if (sql.includes('pg_advisory_unlock')) return { rows: [{}] };
    if (sql.includes("set_config('app.tenant_id'")) return { rows: [{}] };
    if (sql.includes('WITH prior AS') && sql.includes('INSERT INTO cached_internal_agents')) {
      return { rows: [{ changed: behavior.changed ?? false }] };
    }
    if (sql.includes('FROM internal_agent_runtime_mapping') && sql.includes('JOIN agents a')) {
      // Normalize: tests can omit canonical_miss_count; default to 0 so the
      // shape matches what the reconciler's new orphan-gate query selects.
      return {
        rows: (behavior.orphans ?? []).map((o) => ({ canonical_miss_count: 0, ...o })),
      };
    }
    if (sql.includes('FROM internal_agent_runtime_mapping')) {
      return { rows: behavior.mappingAgentId ? [{ agent_id: behavior.mappingAgentId }] : [] };
    }
    if (sql.includes('FROM agents WHERE id')) {
      return { rows: behavior.localAgent ? [behavior.localAgent] : [] };
    }
    if (sql.startsWith('UPDATE agents')) {
      return { rows: [] };
    }
    return { rows: [] };
  });
}

beforeEach(() => {
  clientQueryMock.mockReset();
  clientReleaseMock.mockReset();
  poolConnectMock.mockClear();
  fakePool.query.mockClear();
  listCanonicalAgentsMock.mockReset();
  fetchCanonicalAgentFullMock.mockReset();
  handleInternalAgentCreatedMock.mockReset();
  createOrUnpauseJobMock.mockClear();
  resumeJobMock.mockClear();
  pauseJobMock.mockClear();
  deleteJobMock.mockClear();
  getJobStatusMock.mockReset();
  createTimeSeriesMock.mockClear();
  lockAcquired = true;
  process.env.GCP_PROJECT_ID = 'test-project';
});

afterEach(() => {
  delete process.env.GCP_PROJECT_ID;
  jest.resetModules();
});

const TENANT = '11111111-1111-1111-1111-111111111111';
const AGENT_INTERNAL = '22222222-2222-2222-2222-222222222222';
const AGENT_LOCAL = '33333333-3333-3333-3333-333333333333';

function activeCronAgent(overrides: Partial<{ status: string; cronExpr: string; integrations: unknown[]; currentVersion: number }> = {}) {
  return {
    id: AGENT_INTERNAL,
    role: 'role',
    messagingNickname: null,
    status: overrides.status ?? 'active',
    currentVersion: overrides.currentVersion ?? 1,
    triggerConfig: { type: 'cron', cronExpr: overrides.cronExpr ?? '*/1 * * * *' },
    integrations: overrides.integrations ?? [],
  };
}

describe('reconcileTenant', () => {
  it('cache UPSERT with identical row does NOT bump cacheUpdated', async () => {
    listCanonicalAgentsMock.mockResolvedValueOnce([activeCronAgent()]);
    routeClient({
      changed: false,
      mappingAgentId: AGENT_LOCAL,
      localAgent: { id: AGENT_LOCAL, lifecycle: 'ACTIVE', trigger_config: {}, name: 'n' },
    });
    getJobStatusMock.mockResolvedValue({ exists: true, state: 'ENABLED' });
    const { reconcileTenant } = await import('../canonical-reconciler');
    const summary = await reconcileTenant(TENANT);
    expect(summary.cacheUpdated).toBe(0);
  });

  it('cache UPSERT with different status bumps cacheUpdated', async () => {
    listCanonicalAgentsMock.mockResolvedValueOnce([activeCronAgent()]);
    routeClient({
      changed: true,
      mappingAgentId: AGENT_LOCAL,
      localAgent: { id: AGENT_LOCAL, lifecycle: 'ACTIVE', trigger_config: {}, name: 'n' },
    });
    getJobStatusMock.mockResolvedValue({ exists: true, state: 'ENABLED' });
    const { reconcileTenant } = await import('../canonical-reconciler');
    const summary = await reconcileTenant(TENANT);
    expect(summary.cacheUpdated).toBe(1);
  });

  it('cacheUpdated does NOT count first-time INSERT (prior row missing)', async () => {
    listCanonicalAgentsMock.mockResolvedValueOnce([activeCronAgent()]);
    // The SQL uses EXISTS(SELECT 1 FROM prior) to suppress changed=true on
    // first-insert. We model that with the mock by returning changed=false.
    routeClient({
      changed: false,
      mappingAgentId: AGENT_LOCAL,
      localAgent: { id: AGENT_LOCAL, lifecycle: 'ACTIVE', trigger_config: {}, name: 'n' },
    });
    getJobStatusMock.mockResolvedValue({ exists: true, state: 'ENABLED' });
    const { reconcileTenant } = await import('../canonical-reconciler');
    const summary = await reconcileTenant(TENANT);
    expect(summary.cacheUpdated).toBe(0);

    // And the SQL itself must contain the EXISTS guard.
    const upsertSql = clientQueryMock.mock.calls.find((c) => String(c[0]).includes('INSERT INTO cached_internal_agents'))?.[0] as string;
    expect(upsertSql).toContain('EXISTS(SELECT 1 FROM prior)');
  });

  it('no-op tick still refreshes synced_at (SQL always sets synced_at = NOW())', async () => {
    listCanonicalAgentsMock.mockResolvedValueOnce([activeCronAgent()]);
    routeClient({
      changed: false,
      mappingAgentId: AGENT_LOCAL,
      localAgent: { id: AGENT_LOCAL, lifecycle: 'ACTIVE', trigger_config: {}, name: 'n' },
    });
    getJobStatusMock.mockResolvedValue({ exists: true, state: 'ENABLED' });
    const { reconcileTenant } = await import('../canonical-reconciler');
    await reconcileTenant(TENANT);
    const upsertCalled = clientQueryMock.mock.calls.some((c) => String(c[0]).includes('synced_at = NOW()'));
    expect(upsertCalled).toBe(true);
  });

  it('entity_version uses GREATEST to prevent rewind from stale canonical', async () => {
    listCanonicalAgentsMock.mockResolvedValueOnce([activeCronAgent()]);
    routeClient({
      changed: false,
      mappingAgentId: AGENT_LOCAL,
      localAgent: { id: AGENT_LOCAL, lifecycle: 'ACTIVE', trigger_config: {}, name: 'n' },
    });
    getJobStatusMock.mockResolvedValue({ exists: true, state: 'ENABLED' });
    const { reconcileTenant } = await import('../canonical-reconciler');
    await reconcileTenant(TENANT);
    const upsertSql = clientQueryMock.mock.calls.find((c) => String(c[0]).includes('INSERT INTO cached_internal_agents'))?.[0] as string;
    expect(upsertSql).toContain('GREATEST(cached_internal_agents.entity_version');
  });

  it('reconciler binds tenant session via set_config before any tenant-scoped query', async () => {
    listCanonicalAgentsMock.mockResolvedValueOnce([]);
    routeClient({});
    const { reconcileTenant } = await import('../canonical-reconciler');
    await reconcileTenant(TENANT);
    const calls = clientQueryMock.mock.calls.map((c) => String(c[0]));
    const lockIdx = calls.findIndex((s) => s.includes('pg_try_advisory_lock'));
    const setIdx = calls.findIndex((s) => s.includes("set_config('app.tenant_id'"));
    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(setIdx).toBeGreaterThan(lockIdx);

    // The set_config call passes the actual tenantId.
    const setCall = clientQueryMock.mock.calls.find((c) => String(c[0]).includes("set_config('app.tenant_id'"));
    expect(setCall?.[1]).toEqual([TENANT]);
  });

  it('concurrent reconcileTenant: second sees acquired=false and skips real work', async () => {
    lockAcquired = false;
    routeClient({});
    const { reconcileTenant } = await import('../canonical-reconciler');
    const summary = await reconcileTenant(TENANT);
    expect(summary.checked).toBe(0);
    expect(listCanonicalAgentsMock).not.toHaveBeenCalled();

    // When the lock is NOT acquired, pg_advisory_unlock must NOT be called
    // (the if (lockHeld) guard) — otherwise we'd release someone else's lock.
    const unlockCalled = clientQueryMock.mock.calls.some((c) => String(c[0]).includes('pg_advisory_unlock'));
    expect(unlockCalled).toBe(false);

    // The client must still be released to the pool.
    expect(clientReleaseMock).toHaveBeenCalledTimes(1);
  });

  it('lock-held path calls pg_advisory_unlock AND release()', async () => {
    listCanonicalAgentsMock.mockResolvedValueOnce([]);
    routeClient({});
    const { reconcileTenant } = await import('../canonical-reconciler');
    await reconcileTenant(TENANT);
    const unlockCalled = clientQueryMock.mock.calls.some((c) => String(c[0]).includes('pg_advisory_unlock'));
    expect(unlockCalled).toBe(true);
    expect(clientReleaseMock).toHaveBeenCalledTimes(1);
  });

  it('clears the tenant-session GUC before releasing the client', async () => {
    listCanonicalAgentsMock.mockResolvedValueOnce([]);
    routeClient({});
    const { reconcileTenant } = await import('../canonical-reconciler');
    await reconcileTenant(TENANT);
    // Two set_config calls: one binding the tenantId, one resetting to ''.
    const setConfigCalls = clientQueryMock.mock.calls.filter((c) => String(c[0]).includes("set_config('app.tenant_id'"));
    expect(setConfigCalls).toHaveLength(2);
    expect(setConfigCalls[0][1]).toEqual([TENANT]);   // bind
    // The reset call has no params; we only validate the SQL was issued.
    expect(String(setConfigCalls[1][0])).toContain("set_config('app.tenant_id', ''");
  });

  it('error in one agent reconcile does not prevent later agents from being reconciled', async () => {
    const a = { ...activeCronAgent(), id: 'a1' };
    const b = { ...activeCronAgent(), id: 'b1' };
    listCanonicalAgentsMock.mockResolvedValueOnce([a, b]);
    let firstAgentSeen = false;
    clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
      if (sql.includes('pg_advisory_unlock')) return { rows: [{}] };
      if (sql.includes("set_config('app.tenant_id'")) return { rows: [{}] };
      if (sql.includes('INSERT INTO cached_internal_agents')) {
        if (!firstAgentSeen) { firstAgentSeen = true; throw new Error('boom on first'); }
        return { rows: [{ changed: false }] };
      }
      if (sql.includes('FROM internal_agent_runtime_mapping') && sql.includes('JOIN agents a')) return { rows: [] };
      if (sql.includes('FROM internal_agent_runtime_mapping')) return { rows: [{ agent_id: AGENT_LOCAL }] };
      if (sql.includes('FROM agents WHERE id')) return { rows: [{ id: AGENT_LOCAL, lifecycle: 'ACTIVE', trigger_config: {}, name: 'n' }] };
      return { rows: [] };
    });
    getJobStatusMock.mockResolvedValue({ exists: true, state: 'ENABLED' });
    const { reconcileTenant } = await import('../canonical-reconciler');
    const summary = await reconcileTenant(TENANT);
    expect(summary.errors).toBe(1);
    expect(summary.checked).toBe(2);
  });

  it('reconcileSingleAgent acquires its own client, sets tenant session, no lock', async () => {
    listCanonicalAgentsMock.mockResolvedValueOnce([activeCronAgent()]);
    routeClient({
      changed: false,
      mappingAgentId: AGENT_LOCAL,
      localAgent: { id: AGENT_LOCAL, lifecycle: 'ACTIVE', trigger_config: {}, name: 'n' },
    });
    getJobStatusMock.mockResolvedValue({ exists: true, state: 'ENABLED' });
    const { reconcileSingleAgent } = await import('../canonical-reconciler');
    const ok = await reconcileSingleAgent({ tenantId: TENANT, internalAgentId: AGENT_INTERNAL });
    expect(ok).toBe(true);
    // Client checked out + released (no second connect for lock).
    expect(poolConnectMock).toHaveBeenCalledTimes(1);
    expect(clientReleaseMock).toHaveBeenCalledTimes(1);
    // No lock SQL issued.
    const lockCalled = clientQueryMock.mock.calls.some((c) => String(c[0]).includes('pg_try_advisory_lock'));
    expect(lockCalled).toBe(false);
    // But tenant session WAS bound.
    const setIdx = clientQueryMock.mock.calls.findIndex((c) => String(c[0]).includes("set_config('app.tenant_id'"));
    expect(setIdx).toBe(0);
  });

  it('lifecycle drift heals DRAFT → ACTIVE on canonical change', async () => {
    listCanonicalAgentsMock.mockResolvedValueOnce([activeCronAgent({ status: 'active' })]);
    routeClient({
      changed: false,
      mappingAgentId: AGENT_LOCAL,
      localAgent: { id: AGENT_LOCAL, lifecycle: 'DRAFT', trigger_config: {}, name: 'n' },
    });
    getJobStatusMock.mockResolvedValue({ exists: true, state: 'ENABLED' });
    const { reconcileTenant } = await import('../canonical-reconciler');
    const summary = await reconcileTenant(TENANT);
    expect(summary.lifecycleUpdated).toBe(1);
    const updateCall = clientQueryMock.mock.calls.find((c) => String(c[0]).startsWith('UPDATE agents'));
    expect(updateCall?.[1]).toEqual([AGENT_LOCAL, 'ACTIVE']);
  });

  it('missing scheduler is created when canonical = active + cron', async () => {
    listCanonicalAgentsMock.mockResolvedValueOnce([activeCronAgent()]);
    routeClient({
      mappingAgentId: AGENT_LOCAL,
      localAgent: { id: AGENT_LOCAL, lifecycle: 'ACTIVE', trigger_config: {}, name: 'n' },
    });
    getJobStatusMock.mockResolvedValue({ exists: false });
    const { reconcileTenant } = await import('../canonical-reconciler');
    const summary = await reconcileTenant(TENANT);
    expect(createOrUnpauseJobMock).toHaveBeenCalledTimes(1);
    expect(summary.schedulerCreated).toBe(1);
  });

  it('paused scheduler is RESUMED via fast-path resumeJob (not createOrUnpauseJob)', async () => {
    listCanonicalAgentsMock.mockResolvedValueOnce([activeCronAgent()]);
    routeClient({
      mappingAgentId: AGENT_LOCAL,
      localAgent: { id: AGENT_LOCAL, lifecycle: 'ACTIVE', trigger_config: {}, name: 'n' },
    });
    getJobStatusMock.mockResolvedValue({ exists: true, state: 'PAUSED' });
    const { reconcileTenant } = await import('../canonical-reconciler');
    const summary = await reconcileTenant(TENANT);
    expect(resumeJobMock).toHaveBeenCalledTimes(1);
    expect(createOrUnpauseJobMock).not.toHaveBeenCalled();
    expect(summary.schedulerResumed).toBe(1);
  });

  it('enabled scheduler is paused when canonical ≠ active', async () => {
    listCanonicalAgentsMock.mockResolvedValueOnce([activeCronAgent({ status: 'draft' })]);
    routeClient({
      mappingAgentId: AGENT_LOCAL,
      localAgent: { id: AGENT_LOCAL, lifecycle: 'DRAFT', trigger_config: {}, name: 'n' },
    });
    getJobStatusMock.mockResolvedValue({ exists: true, state: 'ENABLED' });
    const { reconcileTenant } = await import('../canonical-reconciler');
    const summary = await reconcileTenant(TENANT);
    expect(pauseJobMock).toHaveBeenCalledTimes(1);
    expect(summary.schedulerPaused).toBe(1);
  });

  it('enabled scheduler is paused when canonical = active but trigger type is event', async () => {
    const eventAgent = {
      ...activeCronAgent(),
      triggerConfig: { type: 'event', eventTopic: 'foo' },
    };
    listCanonicalAgentsMock.mockResolvedValueOnce([eventAgent]);
    routeClient({
      mappingAgentId: AGENT_LOCAL,
      localAgent: { id: AGENT_LOCAL, lifecycle: 'ACTIVE', trigger_config: {}, name: 'n' },
    });
    getJobStatusMock.mockResolvedValue({ exists: true, state: 'ENABLED' });
    const { reconcileTenant } = await import('../canonical-reconciler');
    const summary = await reconcileTenant(TENANT);
    expect(pauseJobMock).toHaveBeenCalledTimes(1);
    expect(summary.schedulerPaused).toBe(1);
  });

  it('orphan cleanup: deleteJob runs BEFORE the UPDATE to lifecycle=DELETED', async () => {
    listCanonicalAgentsMock.mockResolvedValueOnce([]); // no canonical
    const callOrder: string[] = [];
    deleteJobMock.mockImplementation(async () => { callOrder.push('deleteJob'); });
    clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
      if (sql.includes('pg_advisory_unlock')) return { rows: [{}] };
      if (sql.includes("set_config('app.tenant_id'")) return { rows: [{}] };
      if (sql.includes('FROM internal_agent_runtime_mapping') && sql.includes('JOIN agents a')) {
        return { rows: [{ agent_id: AGENT_LOCAL, internal_agent_id: AGENT_INTERNAL }] };
      }
      if (sql.startsWith('UPDATE agents')) { callOrder.push('UPDATE'); return { rows: [] }; }
      return { rows: [] };
    });
    const { reconcileTenant } = await import('../canonical-reconciler');
    const summary = await reconcileTenant(TENANT);
    expect(callOrder).toEqual(['deleteJob', 'UPDATE']);
    expect(summary.schedulerDeleted).toBe(1);
  });

  it('orphan cleanup: deleteJob failure leaves lifecycle unchanged so next tick retries', async () => {
    listCanonicalAgentsMock.mockResolvedValueOnce([]);
    deleteJobMock.mockImplementation(async () => { throw new Error('scheduler-api-down'); });
    let updateCalled = false;
    clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
      if (sql.includes('pg_advisory_unlock')) return { rows: [{}] };
      if (sql.includes("set_config('app.tenant_id'")) return { rows: [{}] };
      if (sql.includes('FROM internal_agent_runtime_mapping') && sql.includes('JOIN agents a')) {
        return { rows: [{ agent_id: AGENT_LOCAL, internal_agent_id: AGENT_INTERNAL }] };
      }
      if (sql.startsWith('UPDATE agents')) { updateCalled = true; return { rows: [] }; }
      return { rows: [] };
    });
    const { reconcileTenant } = await import('../canonical-reconciler');
    const summary = await reconcileTenant(TENANT);
    expect(updateCalled).toBe(false);
    expect(summary.schedulerDeleted).toBe(0);
    expect(summary.errors).toBe(1);
  });

  it('listCanonicalAgents 5xx → summary.errors > 0, no partial heal, client still released', async () => {
    listCanonicalAgentsMock.mockRejectedValueOnce(new Error('HTTP 500'));
    routeClient({});
    const { reconcileTenant } = await import('../canonical-reconciler');
    const summary = await reconcileTenant(TENANT);
    expect(summary.errors).toBe(1);
    expect(summary.checked).toBe(0);
    expect(createOrUnpauseJobMock).not.toHaveBeenCalled();
    expect(pauseJobMock).not.toHaveBeenCalled();
    expect(clientReleaseMock).toHaveBeenCalledTimes(1);
  });

  it('emitMetrics writes {tenant_id, source: reconciler} labels per kind', async () => {
    listCanonicalAgentsMock.mockResolvedValueOnce([activeCronAgent()]);
    routeClient({
      mappingAgentId: AGENT_LOCAL,
      localAgent: { id: AGENT_LOCAL, lifecycle: 'ACTIVE', trigger_config: {}, name: 'n' },
    });
    getJobStatusMock.mockResolvedValue({ exists: true, state: 'PAUSED' });
    const { reconcileTenant } = await import('../canonical-reconciler');
    await reconcileTenant(TENANT);
    expect(createTimeSeriesMock).toHaveBeenCalledTimes(1);
    const arg = createTimeSeriesMock.mock.calls[0][0] as { timeSeries: Array<{ metric: { type: string; labels: Record<string, string> } }> };
    const kinds = arg.timeSeries.map((s) => s.metric.type);
    expect(kinds).toEqual([
      'custom.googleapis.com/agent_scheduler/missing_count',
      'custom.googleapis.com/agent_scheduler/paused_count',
      'custom.googleapis.com/agent_scheduler/failing_count',
    ]);
    for (const s of arg.timeSeries) {
      expect(s.metric.labels.tenant_id).toBe(TENANT);
      expect(s.metric.labels.source).toBe('reconciler');
    }
  });

  it('emitMetrics skips failing-count for never-fired jobs (lastAttemptTime undefined)', async () => {
    listCanonicalAgentsMock.mockResolvedValueOnce([activeCronAgent()]);
    routeClient({
      mappingAgentId: AGENT_LOCAL,
      localAgent: { id: AGENT_LOCAL, lifecycle: 'ACTIVE', trigger_config: {}, name: 'n' },
    });
    // Fresh job: ENABLED but no lastAttemptTime. cloud-scheduler.ts:469
    // returns lastAttemptResult='failed' by default (code === 0 ? success : failed,
    // code is undefined on fresh) — emitMetrics MUST NOT count this as failing.
    getJobStatusMock.mockResolvedValue({
      exists: true, state: 'ENABLED',
      lastAttemptTime: undefined, lastAttemptResult: 'failed',
    });
    const { reconcileTenant } = await import('../canonical-reconciler');
    await reconcileTenant(TENANT);
    const arg = createTimeSeriesMock.mock.calls[0][0] as { timeSeries: Array<{ metric: { type: string }; points: Array<{ value: { int64Value: string } }> }> };
    const failing = arg.timeSeries.find((s) => s.metric.type.endsWith('failing_count'));
    expect(failing?.points[0].value.int64Value).toBe('0');
  });

  it('emitMetrics counts ENABLED+failed+lastAttemptTime as failing', async () => {
    listCanonicalAgentsMock.mockResolvedValueOnce([activeCronAgent()]);
    routeClient({
      mappingAgentId: AGENT_LOCAL,
      localAgent: { id: AGENT_LOCAL, lifecycle: 'ACTIVE', trigger_config: {}, name: 'n' },
    });
    getJobStatusMock.mockResolvedValue({
      exists: true, state: 'ENABLED',
      lastAttemptTime: new Date(), lastAttemptResult: 'failed',
    });
    const { reconcileTenant } = await import('../canonical-reconciler');
    await reconcileTenant(TENANT);
    const arg = createTimeSeriesMock.mock.calls[0][0] as { timeSeries: Array<{ metric: { type: string }; points: Array<{ value: { int64Value: string } }> }> };
    const failing = arg.timeSeries.find((s) => s.metric.type.endsWith('failing_count'));
    expect(failing?.points[0].value.int64Value).toBe('1');
  });

  it('emitMetrics no-op when GCP_PROJECT_ID is unset', async () => {
    delete process.env.GCP_PROJECT_ID;
    listCanonicalAgentsMock.mockResolvedValueOnce([activeCronAgent()]);
    routeClient({
      mappingAgentId: AGENT_LOCAL,
      localAgent: { id: AGENT_LOCAL, lifecycle: 'ACTIVE', trigger_config: {}, name: 'n' },
    });
    getJobStatusMock.mockResolvedValue({ exists: true, state: 'ENABLED' });
    const { reconcileTenant } = await import('../canonical-reconciler');
    await reconcileTenant(TENANT);
    expect(createTimeSeriesMock).not.toHaveBeenCalled();
  });

  it('reconciler never falls back to pool.query — every query uses the RLS-bound client', async () => {
    listCanonicalAgentsMock.mockResolvedValueOnce([activeCronAgent()]);
    routeClient({
      changed: true,
      mappingAgentId: AGENT_LOCAL,
      localAgent: { id: AGENT_LOCAL, lifecycle: 'DRAFT', trigger_config: {}, name: 'n' },
    });
    getJobStatusMock.mockResolvedValue({ exists: true, state: 'PAUSED' });
    const { reconcileTenant } = await import('../canonical-reconciler');
    await reconcileTenant(TENANT);
    expect(fakePool.query).not.toHaveBeenCalled();
  });

  // ── Self-heal: missing mapping → fetch /full + replay handleInternalAgentCreated ──
  describe('self-heal: missing internal_agent_runtime_mapping', () => {
    it('fetches /canonical-agents/:id/full and calls handleInternalAgentCreated when mapping is absent', async () => {
      listCanonicalAgentsMock.mockResolvedValueOnce([activeCronAgent()]);
      fetchCanonicalAgentFullMock.mockResolvedValueOnce({
        id: AGENT_INTERNAL,
        name: 'Customer Support Representative',
        role: 'Customer Support Representative',
        status: 'active',
        triggerConfig: { type: 'cron', cronExpr: '*/1 * * * *' },
        integrations: [],
      });
      handleInternalAgentCreatedMock.mockResolvedValueOnce();
      let mappingExists = false;
      clientQueryMock.mockImplementation(async (sql: string) => {
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
        if (sql.includes('pg_advisory_unlock')) return { rows: [{}] };
        if (sql.includes("set_config('app.tenant_id'")) return { rows: [{}] };
        if (sql.includes('WITH prior AS') && sql.includes('INSERT INTO cached_internal_agents')) return { rows: [{ changed: false }] };
        if (sql.includes('FROM internal_agent_runtime_mapping') && sql.includes('JOIN agents a')) return { rows: [] };
        if (sql.includes('FROM internal_agent_runtime_mapping')) {
          // First call: empty (no mapping). After handler runs: re-read finds AGENT_LOCAL.
          const rows = mappingExists ? [{ agent_id: AGENT_LOCAL }] : [];
          mappingExists = true;
          return { rows };
        }
        if (sql.includes('FROM agents WHERE id')) {
          return { rows: [{ id: AGENT_LOCAL, lifecycle: 'ACTIVE', trigger_config: { type: 'cron', cronExpr: '*/1 * * * *' }, name: 'Support Agent' }] };
        }
        if (sql.startsWith('UPDATE agents')) return { rows: [] };
        return { rows: [] };
      });
      getJobStatusMock.mockResolvedValue({ exists: true, state: 'ENABLED' });
      const { reconcileTenant } = await import('../canonical-reconciler');
      const summary = await reconcileTenant(TENANT);
      expect(fetchCanonicalAgentFullMock).toHaveBeenCalledWith(TENANT, AGENT_INTERNAL);
      expect(handleInternalAgentCreatedMock).toHaveBeenCalledTimes(1);
      const evt = handleInternalAgentCreatedMock.mock.calls[0][0] as Record<string, unknown>;
      expect(evt.event_type).toBe('tenant.internal_agent.created');
      expect(evt.tenant_id).toBe(TENANT);
      expect(evt.entity_id).toBe(AGENT_INTERNAL);
      expect((evt.payload as Record<string, unknown>).role).toBe('Customer Support Representative');
      expect(summary.selfHealed).toBe(1);
      expect(summary.errors).toBe(0);
    });

    it('skips silently when /full returns 404 (agent deleted between list and fetch)', async () => {
      listCanonicalAgentsMock.mockResolvedValueOnce([activeCronAgent()]);
      fetchCanonicalAgentFullMock.mockResolvedValueOnce(null);
      routeClient({ mappingAgentId: null });
      const { reconcileTenant } = await import('../canonical-reconciler');
      const summary = await reconcileTenant(TENANT);
      expect(handleInternalAgentCreatedMock).not.toHaveBeenCalled();
      expect(summary.errors).toBe(0);
      expect(summary.selfHealed ?? 0).toBe(0);
    });

    it('increments summary.errors when handleInternalAgentCreated throws — next tick retries', async () => {
      listCanonicalAgentsMock.mockResolvedValueOnce([activeCronAgent()]);
      fetchCanonicalAgentFullMock.mockResolvedValueOnce({ id: AGENT_INTERNAL, status: 'active' });
      handleInternalAgentCreatedMock.mockRejectedValueOnce(new Error('compile failed'));
      routeClient({ mappingAgentId: null });
      const { reconcileTenant } = await import('../canonical-reconciler');
      const summary = await reconcileTenant(TENANT);
      expect(handleInternalAgentCreatedMock).toHaveBeenCalledTimes(1);
      expect(summary.errors).toBe(1);
      expect(summary.selfHealed ?? 0).toBe(0);
    });
  });

  // ── Orphan-delete N-consecutive-misses gate ──
  describe('orphan-delete N-consecutive-misses gate', () => {
    it('does NOT deleteJob on the first miss — increments canonical_miss_count to 1 instead', async () => {
      // Canonical returns no agents; orphan scan returns one row with miss_count=0.
      listCanonicalAgentsMock.mockResolvedValueOnce([]);
      const updateAgentCalls: Array<[string, unknown[]?]> = [];
      clientQueryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
        if (sql.includes('pg_advisory_unlock')) return { rows: [{}] };
        if (sql.includes("set_config('app.tenant_id'")) return { rows: [{}] };
        if (sql.includes('FROM internal_agent_runtime_mapping') && sql.includes('JOIN agents a')) {
          return { rows: [{ agent_id: AGENT_LOCAL, internal_agent_id: AGENT_INTERNAL, canonical_miss_count: 0 }] };
        }
        if (sql.startsWith('UPDATE agents')) {
          updateAgentCalls.push([sql, params]);
          return { rows: [] };
        }
        return { rows: [] };
      });
      const { reconcileTenant } = await import('../canonical-reconciler');
      const summary = await reconcileTenant(TENANT);
      expect(deleteJobMock).not.toHaveBeenCalled();
      expect(summary.schedulerDeleted).toBe(0);
      // canonical_miss_count was bumped to 1
      const bumpCall = updateAgentCalls.find(
        ([sql]) => sql.includes('canonical_miss_count = $2'),
      );
      expect(bumpCall).toBeDefined();
      expect(bumpCall![1]).toEqual([AGENT_LOCAL, 1]);
    });

    it('fires deleteJob only after canonical_miss_count reaches threshold (3)', async () => {
      // beforeEach only clears call history; reset the impl in case a prior
      // test (e.g. "deleteJob failure leaves lifecycle unchanged") configured
      // a throwing impl that leaks here.
      deleteJobMock.mockImplementation(async () => undefined);
      listCanonicalAgentsMock.mockResolvedValueOnce([]);
      clientQueryMock.mockImplementation(async (sql: string) => {
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
        if (sql.includes('pg_advisory_unlock')) return { rows: [{}] };
        if (sql.includes("set_config('app.tenant_id'")) return { rows: [{}] };
        if (sql.includes('FROM internal_agent_runtime_mapping') && sql.includes('JOIN agents a')) {
          // miss_count = 2 BEFORE this tick → bump to 3 → fire delete.
          return { rows: [{ agent_id: AGENT_LOCAL, internal_agent_id: AGENT_INTERNAL, canonical_miss_count: 2 }] };
        }
        return { rows: [] };
      });
      const { reconcileTenant } = await import('../canonical-reconciler');
      const summary = await reconcileTenant(TENANT);
      expect(deleteJobMock).toHaveBeenCalledTimes(1);
      expect(deleteJobMock).toHaveBeenCalledWith(TENANT, AGENT_LOCAL);
      expect(summary.schedulerDeleted).toBe(1);
    });

    it('resets canonical_miss_count to 0 when canonical reappears (transient miss self-heals)', async () => {
      // Canonical list includes the agent again. Orphan scan sees it with miss_count=2.
      listCanonicalAgentsMock.mockResolvedValueOnce([activeCronAgent()]);
      fetchCanonicalAgentFullMock.mockResolvedValue(null);
      const updateAgentCalls: Array<[string, unknown[]?]> = [];
      clientQueryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
        if (sql.includes('pg_advisory_unlock')) return { rows: [{}] };
        if (sql.includes("set_config('app.tenant_id'")) return { rows: [{}] };
        if (sql.includes('WITH prior AS') && sql.includes('INSERT INTO cached_internal_agents')) return { rows: [{ changed: false }] };
        if (sql.includes('FROM internal_agent_runtime_mapping') && sql.includes('JOIN agents a')) {
          return { rows: [{ agent_id: AGENT_LOCAL, internal_agent_id: AGENT_INTERNAL, canonical_miss_count: 2 }] };
        }
        if (sql.includes('FROM internal_agent_runtime_mapping')) {
          return { rows: [{ agent_id: AGENT_LOCAL }] };
        }
        if (sql.includes('FROM agents WHERE id')) {
          return { rows: [{ id: AGENT_LOCAL, lifecycle: 'ACTIVE', trigger_config: { type: 'cron', cronExpr: '*/1 * * * *' }, name: 'a' }] };
        }
        if (sql.startsWith('UPDATE agents')) {
          updateAgentCalls.push([sql, params]);
          return { rows: [] };
        }
        return { rows: [] };
      });
      getJobStatusMock.mockResolvedValue({ exists: true, state: 'ENABLED' });
      const { reconcileTenant } = await import('../canonical-reconciler');
      const summary = await reconcileTenant(TENANT);
      expect(deleteJobMock).not.toHaveBeenCalled();
      const resetCall = updateAgentCalls.find(
        ([sql]) => sql.includes('canonical_miss_count = 0'),
      );
      expect(resetCall).toBeDefined();
      expect(summary.schedulerDeleted).toBe(0);
    });
  });
});
