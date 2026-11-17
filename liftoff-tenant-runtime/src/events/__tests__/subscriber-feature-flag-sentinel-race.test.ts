/**
 * Feature-flag sentinel-row atomic-merge regression test (A1).
 *
 * The previous read-modify-write handler lost concurrent writes: parallel
 * events for keys A and B both read the same `flags`, each wrote back
 * `flags ∪ {their_key}` — last-writer-wins dropped one.
 *
 * The replacement uses a single atomic `INSERT ... ON CONFLICT DO UPDATE
 * SET flags = cached_feature_flags.flags || EXCLUDED.flags` statement. We
 * verify that handler invocations issue that statement (not the old
 * SELECT-then-INSERT pair) and that delete branch issues a `flags - $key`
 * UPDATE.
 *
 * Full integration coverage (multiple concurrent invocations against a real
 * Postgres) lives in the dev-smoke verification step described in the plan.
 */

const mockPool = {
  query: jest.fn(),
  connect: jest.fn(),
};

jest.mock('../../infrastructure/database', () => ({
  getPool: jest.fn(() => mockPool),
  getPoolForService: jest.fn(() => mockPool),
  pool: new Proxy({} as any, {
    get(_, prop) { return (mockPool as any)[prop]; },
  }),
}));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../instruction-compiler/internal-agent-instruction-service', () => ({
  internalAgentInstructionService: { createAndActivateForInternalAgent: jest.fn() },
}));
jest.mock('../../agent-lifecycle/service', () => ({
  AgentLifecycleService: jest.fn().mockImplementation(() => ({
    activate: jest.fn(), pause: jest.fn(), archive: jest.fn(), ensureSchedulerJob: jest.fn(),
  })),
}));
jest.mock('../../connectors/tool-schema-cache', () => ({ getToolSchemas: jest.fn().mockReturnValue([]) }));
jest.mock('../../tool-gateway/external-agent-handler', () => ({ externalAgentHandler: { clearConfigCache: jest.fn() } }));

const mockInvalidateFlagsCache = jest.fn();
jest.mock('../../integrations/web-fetch/limits-config', () => ({
  invalidateFlagsCache: () => mockInvalidateFlagsCache(),
}));

import { handleFeatureFlagUpdated } from '../subscriber';

const SENTINEL = '00000000-0000-0000-0000-000000000000';

beforeEach(() => {
  mockPool.query.mockReset();
  mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });
  mockInvalidateFlagsCache.mockReset();
});

function evUpdated(key: string, enabled: boolean, valueNum?: number): any {
  return {
    event_id: `e-${key}`, event_type: 'tenant.feature_flag.updated',
    entity_type: 'feature_flag', entity_id: `f-${key}`, entity_version: 1, event_version: 1,
    occurred_at: new Date().toISOString(),
    payload: { key, enabled, ...(valueNum !== undefined ? { value_num: valueNum } : {}) },
  };
}
function evDeleted(key: string): any {
  return {
    event_id: `e-${key}-del`, event_type: 'tenant.feature_flag.deleted',
    entity_type: 'feature_flag', entity_id: `f-${key}`, entity_version: 1, event_version: 1,
    occurred_at: new Date().toISOString(),
    payload: { key },
  };
}

describe('feature-flag sentinel — atomic JSONB merge (A1)', () => {
  it('issues a single atomic INSERT...ON CONFLICT DO UPDATE with `flags || EXCLUDED.flags`', async () => {
    await handleFeatureFlagUpdated(evUpdated('flag_a', true));
    // Old code did two queries: SELECT then INSERT. New code does ONE.
    expect(mockPool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = mockPool.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO cached_feature_flags/);
    expect(sql).toMatch(/cached_feature_flags\.flags \|\| EXCLUDED\.flags/);
    expect(params[0]).toBe(SENTINEL);
    expect(JSON.parse(params[1])).toEqual({ flag_a: true });
  });

  it('three parallel updates for three different keys each issue their own atomic merge', async () => {
    await Promise.all([
      handleFeatureFlagUpdated(evUpdated('flag_a', true)),
      handleFeatureFlagUpdated(evUpdated('flag_b', false)),
      handleFeatureFlagUpdated(evUpdated('flag_c', true)),
    ]);
    expect(mockPool.query).toHaveBeenCalledTimes(3);
    const partials = mockPool.query.mock.calls.map(c => JSON.parse(c[1][1]));
    expect(partials).toEqual(expect.arrayContaining([
      { flag_a: true }, { flag_b: false }, { flag_c: true },
    ]));
  });

  it('updated event with value_num also merges the `<key>_value` suffix', async () => {
    await handleFeatureFlagUpdated(evUpdated('web_fetch_anchor_max_concurrent_global', true, 30));
    const [, params] = mockPool.query.mock.calls[0];
    expect(JSON.parse(params[1])).toEqual({
      web_fetch_anchor_max_concurrent_global: true,
      web_fetch_anchor_max_concurrent_global_value: 30,
    });
  });

  it('delete branch removes both the key and its `_value` sibling via JSONB `-` operators', async () => {
    await handleFeatureFlagUpdated(evDeleted('drop_me'));
    expect(mockPool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = mockPool.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE cached_feature_flags/);
    expect(sql).toMatch(/flags - \$2::text/);
    expect(sql).toMatch(/\|\| '_value'/);
    expect(params).toEqual([SENTINEL, 'drop_me']);
  });

  it('invalidates the limits-config in-memory cache after a sentinel UPDATE so operator PUTs propagate at event-delivery latency', async () => {
    await handleFeatureFlagUpdated(evUpdated('web_fetch_anchor_max_concurrent_global', true, 40));
    expect(mockInvalidateFlagsCache).toHaveBeenCalledTimes(1);
  });

  it('invalidates the limits-config cache after a sentinel DELETE', async () => {
    await handleFeatureFlagUpdated(evDeleted('web_fetch_anchor_max_concurrent_global'));
    expect(mockInvalidateFlagsCache).toHaveBeenCalledTimes(1);
  });

  it('does NOT invalidate the cache when a delete event arrives without payload.key (back-compat path is a no-op)', async () => {
    await handleFeatureFlagUpdated({
      event_id: 'e-old', event_type: 'tenant.feature_flag.deleted',
      entity_type: 'feature_flag', entity_id: 'f-old', entity_version: 1, event_version: 1,
      occurred_at: new Date().toISOString(),
    } as any);
    expect(mockInvalidateFlagsCache).not.toHaveBeenCalled();
  });

  it('delete branch tolerates events that pre-date A1a (payload.key missing) without throwing', async () => {
    await handleFeatureFlagUpdated({
      event_id: 'e-old', event_type: 'tenant.feature_flag.deleted',
      entity_type: 'feature_flag', entity_id: 'f-old', entity_version: 1, event_version: 1,
      occurred_at: new Date().toISOString(),
    } as any);
    expect(mockPool.query).not.toHaveBeenCalled();
  });
});
