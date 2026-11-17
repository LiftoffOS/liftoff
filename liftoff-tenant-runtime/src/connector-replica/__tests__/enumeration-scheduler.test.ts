// The census loop.
//
// A background job that never runs and a background job that runs and finds
// nothing look identical from the outside, so what is pinned here is that the
// scheduler says which one it is, and that it stays off until somebody decides
// to spend vendor quota on bookkeeping.

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../../infrastructure/logging', () => ({ logger: mockLogger }));

const mockQuery = jest.fn();
const mockWithTenantScope = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  getPoolForService: () => ({ query: mockQuery }),
  withTenantScope: (...a: unknown[]) => mockWithTenantScope(...a),
}));

jest.mock('../../tool-gateway/router', () => ({ toolGatewayService: { execute: jest.fn() } }));

const mockEnumerableFunctions = jest.fn();
jest.mock('../connector-enumeration-source', () => ({
  enumerableFunctions: (...a: unknown[]) => mockEnumerableFunctions(...a),
  buildConnectorEnumerationSource: jest.fn().mockReturnValue(jest.fn()),
}));

const mockClaimDueJobs = jest.fn();
const mockRunEnumerationJob = jest.fn();
jest.mock('../enumerate-worker', () => ({
  claimDueJobs: (...a: unknown[]) => mockClaimDueJobs(...a),
  runEnumerationJob: (...a: unknown[]) => mockRunEnumerationJob(...a),
}));

import {
  ensureEnumerationJobs,
  isCensusEnabled,
  isEnumerableConnector,
  runEnumerationTick,
  startEnumerationScheduler,
  stopEnumerationScheduler,
} from '../enumeration-scheduler';

const TENANT = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.CENSUS_ENABLED;
  delete process.env.CENSUS_INCLUDE_COMPOSIO;
  stopEnumerationScheduler();
  mockWithTenantScope.mockImplementation(async (_t: string, fn: (c: unknown) => Promise<unknown>) =>
    fn({ query: jest.fn().mockResolvedValue({ rowCount: 1 }) }));
});

afterEach(() => stopEnumerationScheduler());

describe('the switch', () => {
  it('is off by default — enumeration spends the same quota agents do', () => {
    expect(isCensusEnabled()).toBe(false);
  });

  it('does not start when off, and says so rather than going quiet', () => {
    startEnumerationScheduler();
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'census_scheduler_disabled' }),
      expect.any(String),
    );
  });

  it('starts when explicitly enabled, and says that too', () => {
    process.env.CENSUS_ENABLED = '1';
    startEnumerationScheduler();
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'census_scheduler_started' }),
      expect.any(String),
    );
  });

  it('is idempotent — a second start does not add a second timer', () => {
    process.env.CENSUS_ENABLED = '1';
    startEnumerationScheduler();
    startEnumerationScheduler();
    const starts = mockLogger.info.mock.calls.filter(
      ([ctx]) => (ctx as { event?: string }).event === 'census_scheduler_started',
    );
    expect(starts).toHaveLength(1);
  });
});

describe('the Composio exclusion', () => {
  it.each(['google_mail', 'airtable', 'pipedrive'])(
    'refuses to enumerate %s, which Composio routes',
    (type) => {
      // Composio bills ONE organization-wide meter — 20,000 calls a month
      // across every tenant. Enumerating ~90 Composio connectors would spend
      // the platform's month on bookkeeping.
      expect(isEnumerableConnector(type)).toBe(false);
    },
  );

  it('enumerates a connector Composio does not route', () => {
    // Slack dispatches natively; hubspot and github are native REST. All three have their own
    // vendor limits rather than sharing the org meter.
    expect(isEnumerableConnector('slack')).toBe(true);
    expect(isEnumerableConnector('github')).toBe(true);
    expect(isEnumerableConnector('hubspot')).toBe(true);
  });

  it('allows Composio only on an explicit operator decision', () => {
    expect(isEnumerableConnector('google_mail')).toBe(false);
    process.env.CENSUS_INCLUDE_COMPOSIO = '1';
    expect(isEnumerableConnector('google_mail')).toBe(true);
  });

  it('creates no job for a Composio-routed connector, and says why', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: 'c1', connector_type: 'google_mail' }] });
    mockEnumerableFunctions.mockReturnValue([{ name: 'list_messages' }]);

    expect(await ensureEnumerationJobs(TENANT)).toBe(0);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ metric: 'census.composio_connectors_skipped', skipped: 1 }),
      expect.any(String),
    );
  });

  it('still creates jobs for the non-Composio connectors alongside them', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { id: 'c1', connector_type: 'google_mail' },
        { id: 'c2', connector_type: 'slack' },
      ],
    });
    mockEnumerableFunctions.mockReturnValue([{ name: 'list_things' }]);
    expect(await ensureEnumerationJobs(TENANT)).toBe(1);
  });
});

describe('job creation', () => {
  it('creates one job per enumerable function per connector', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { id: 'c1', connector_type: 'slack' },
        { id: 'c2', connector_type: 'github' },
      ],
    });
    mockEnumerableFunctions.mockImplementation((type: string) =>
      type === 'slack' ? [{ name: 'list_channels' }, { name: 'list_users' }] : [{ name: 'list_issues' }]);

    const created = await ensureEnumerationJobs(TENANT);
    expect(created).toBe(3);
  });

  it('creates nothing for a connector that enumerates nothing', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: 'c1', connector_type: 'custom_thing' }] });
    mockEnumerableFunctions.mockReturnValue([]);
    expect(await ensureEnumerationJobs(TENANT)).toBe(0);
  });
});

describe('a tick', () => {
  it('does nothing when nothing is due', async () => {
    mockClaimDueJobs.mockResolvedValue([]);
    const out = await runEnumerationTick(TENANT);
    expect(out).toEqual({ jobsRun: 0, entities: 0 });
    expect(mockRunEnumerationJob).not.toHaveBeenCalled();
  });

  it('runs each claimed job and reports what it wrote', async () => {
    mockClaimDueJobs.mockResolvedValue([
      { id: 'j1', tenantId: TENANT, connectorId: 'c1', connectorType: 'slack', scope: 'list_channels', cursor: null },
      { id: 'j2', tenantId: TENANT, connectorId: 'c1', connectorType: 'slack', scope: 'list_users', cursor: null },
    ]);
    mockRunEnumerationJob
      .mockResolvedValueOnce({ entitiesUpserted: 12, entitiesMarkedDeleted: 0, batchKind: 'complete' })
      .mockResolvedValueOnce({ entitiesUpserted: 40, entitiesMarkedDeleted: 1, batchKind: 'complete' });

    const out = await runEnumerationTick(TENANT);
    expect(out).toEqual({ jobsRun: 2, entities: 52 });
  });

  it('logs each job outcome, including a parked one', async () => {
    mockClaimDueJobs.mockResolvedValue([
      { id: 'j1', tenantId: TENANT, connectorId: 'c1', connectorType: 'slack', scope: 'list_channels', cursor: null },
    ]);
    mockRunEnumerationJob.mockResolvedValue({
      entitiesUpserted: 0, entitiesMarkedDeleted: 0, batchKind: 'incremental', parkedForMs: 65_000,
    });

    await runEnumerationTick(TENANT);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ metric: 'census.job_complete', parkedForMs: 65_000 }),
      expect.any(String),
    );
  });
});
