// Which table a driver's presence is read from, per surface, and what the
// read answers when no table here can say.
//
// Each chat surface keeps its heartbeat in its own table, so the SQL is
// per surface. `present` is three-valued: true and false are read from the
// surface's own table, null means this database cannot see the heartbeat;
// null is what the sweep must never act on, so the null cases are pinned as
// carefully as the false one.

const mockQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  withTenantScope: jest.fn(async (_tenantId: string, fn: (client: { query: typeof mockQuery }) => unknown) =>
    fn({ query: mockQuery })),
}));

const teamPlanDriverPresentMock = jest.fn();
jest.mock('../../workforce-plans/team-plan-thread-client', () => ({
  teamPlanDriverPresent: (...args: unknown[]) => teamPlanDriverPresentMock(...args),
}));

import { getDriver } from '../driver-repository';

const TENANT = 'tenant-1';
const SESSION = 'sess-1';

function driverRow(present: boolean | null) {
  return {
    account_id: 'acc-9', taken_at: new Date('2026-07-28T00:00:00.000Z'),
    first_name: 'Grace', last_name: 'Hopper', email: 'grace@example.com', avatar_url: null,
    present,
  };
}

function sqlOfLastQuery(): string {
  return (mockQuery.mock.calls.at(-1)?.[0] as string).replace(/\s+/g, ' ');
}

beforeEach(() => {
  mockQuery.mockReset();
  teamPlanDriverPresentMock.mockReset();
});

describe('getDriver: the presence table follows the surface', () => {
  it('agent chat reads agent_chat_presence', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [driverRow(true)] });
    const driver = await getDriver(TENANT, SESSION, { surface: 'agent', callerAccountId: 'acc-1' });
    expect(driver?.present).toBe(true);
    const sql = sqlOfLastQuery();
    expect(sql).toContain('FROM agent_chat_presence p');
    expect(sql).not.toContain('platform_chat_presence');
    expect(sql).not.toContain('p.surface');
  });

  it.each(['liftoff', 'insights'] as const)('%s reads platform_chat_presence on that surface only', async (surface) => {
    mockQuery.mockResolvedValueOnce({ rows: [driverRow(false)] });
    const driver = await getDriver(TENANT, SESSION, { surface, callerAccountId: 'acc-1' });
    expect(driver?.present).toBe(false);
    const sql = sqlOfLastQuery();
    expect(sql).toContain('FROM platform_chat_presence p');
    expect(sql).toContain(`p.surface = '${surface}'`);
    expect(sql).not.toContain('agent_chat_presence');
  });

  it('every surface with a table here binds the presence row to the driver and the window', async () => {
    for (const surface of ['agent', 'liftoff', 'insights'] as const) {
      mockQuery.mockResolvedValueOnce({ rows: [driverRow(true)] });
      await getDriver(TENANT, SESSION, { surface });
      const sql = sqlOfLastQuery();
      expect(sql).toContain('p.account_id = d.account_id');
      expect(sql).toContain("p.last_seen_at > NOW() - INTERVAL '45 seconds'");
    }
  });
});

describe('getDriver: when presence is not knowable here', () => {
  it('answers null without a presence source, and selects no presence table', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [driverRow(null)] });
    const driver = await getDriver(TENANT, SESSION);
    expect(driver?.present).toBeNull();
    const sql = sqlOfLastQuery();
    expect(sql).toContain('NULL::boolean AS present');
    expect(sql).not.toContain('_presence');
  });

  // The Chief AI Officer surface keeps its presence in workforce-service,
  // which is ASKED about the recorded driver on the thread: the same
  // 45-second window the other surfaces read from their own tables.
  it('team_plan asks workforce-service with the thread and the driver\'s account, and true passes through', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [driverRow(null)] });
    teamPlanDriverPresentMock.mockResolvedValueOnce(true);
    const driver = await getDriver(TENANT, SESSION, { surface: 'team_plan', callerAccountId: 'acc-1', threadId: 'th-1' });
    expect(teamPlanDriverPresentMock).toHaveBeenCalledWith({ tenantId: TENANT, threadId: 'th-1', accountId: 'acc-9' });
    expect(driver?.present).toBe(true);
    expect(sqlOfLastQuery()).toContain('NULL::boolean AS present');
  });

  it('team_plan: a driver whose tab is hidden reads absent, even when they are the caller', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [driverRow(null)] });
    teamPlanDriverPresentMock.mockResolvedValueOnce(false);
    const driver = await getDriver(TENANT, SESSION, { surface: 'team_plan', callerAccountId: 'acc-9', threadId: 'th-1' });
    expect(driver?.present).toBe(false);
  });

  it('team_plan: a failed call is null, which the sweep never acts on', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [driverRow(null)] });
    teamPlanDriverPresentMock.mockResolvedValueOnce(null);
    const driver = await getDriver(TENANT, SESSION, { surface: 'team_plan', callerAccountId: 'acc-9', threadId: 'th-1' });
    expect(driver?.present).toBeNull();
  });

  it('team_plan without a thread to ask about answers null and asks nothing', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [driverRow(null)] });
    const driver = await getDriver(TENANT, SESSION, { surface: 'team_plan', callerAccountId: 'acc-9' });
    expect(driver?.present).toBeNull();
    expect(teamPlanDriverPresentMock).not.toHaveBeenCalled();
  });

  // Where a table exists it is the authority: the driver's own read of a
  // stale row still answers false, and workforce-service is not asked.
  it('a surface with its own table never asks workforce-service', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [driverRow(false)] });
    const driver = await getDriver(TENANT, SESSION, { surface: 'liftoff', callerAccountId: 'acc-9', threadId: 'th-1' });
    expect(driver?.present).toBe(false);
    expect(teamPlanDriverPresentMock).not.toHaveBeenCalled();
  });

  it('answers null for a session nobody is driving', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await getDriver(TENANT, SESSION, { surface: 'liftoff', callerAccountId: 'acc-9' })).toBeNull();
  });
});
