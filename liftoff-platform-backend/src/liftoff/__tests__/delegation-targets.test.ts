// Who Liftoff can bring in, read live and re-checked on the way in.
//
// The roster is the reason these tests exist. Teams are created, renamed, paused
// and deleted while people are mid-conversation, so nothing about it can be
// cached in a prompt, and nothing that was listed a moment ago can be trusted
// when the delegation actually fires.

jest.mock('../../internal-agents/service', () => ({
  internalAgentService: {
    listAllByTenant: jest.fn(),
    getById: jest.fn(),
  },
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { internalAgentService } from '../../internal-agents/service';
import {
  bringInColleagueTool,
  describeTargetsForModel,
  listColleaguesTool,
  listDelegationTargets,
  resolveDelegationTarget,
} from '../delegation-targets';

const mockListAll = internalAgentService.listAllByTenant as jest.Mock;
const mockGetById = internalAgentService.getById as jest.Mock;

const TENANT = 'tenant-1';
const TEAM_ID = '11111111-2222-3333-4444-555555555555';

const team = (overrides: Record<string, unknown> = {}) => ({
  id: TEAM_ID,
  tenantId: TENANT,
  role: 'Payroll Operations',
  summary: 'Runs payroll end to end.',
  responsibilities: 'Payroll',
  status: 'active',
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockListAll.mockResolvedValue([]);
  mockGetById.mockResolvedValue(null);
});

describe('listDelegationTargets', () => {
  it('always offers the two colleagues every workspace has', async () => {
    const targets = await listDelegationTargets(TENANT);

    expect(targets.map(t => t.id)).toEqual(['caio', 'insights']);
    expect(targets.map(t => t.label)).toEqual(['Chief AI Officer', 'Insights Manager']);
  });

  it('adds the workspace teams, reading them at call time', async () => {
    mockListAll.mockResolvedValue([team()]);

    const targets = await listDelegationTargets(TENANT);

    expect(mockListAll).toHaveBeenCalledWith(TENANT, { includeCosts: false });
    expect(targets.map(t => t.id)).toEqual(['caio', 'insights', TEAM_ID]);
    expect(targets[2]).toMatchObject({
      kind: 'team',
      label: 'Payroll Operations',
      description: 'Runs payroll end to end.',
    });
  });

  it('leaves out teams that are not active', async () => {
    // A draft team has nothing to run yet and a paused one was deliberately
    // taken out of service. Offering either offers something that cannot answer.
    mockListAll.mockResolvedValue([
      team({ id: 'draft-id', status: 'draft' }),
      team({ id: 'paused-id', status: 'paused' }),
      team(),
    ]);

    const targets = await listDelegationTargets(TENANT);

    expect(targets.map(t => t.id)).toEqual(['caio', 'insights', TEAM_ID]);
  });

  it('still offers the two system colleagues when the team lookup fails', async () => {
    mockListAll.mockRejectedValue(new Error('database is having a moment'));

    const targets = await listDelegationTargets(TENANT);

    expect(targets.map(t => t.id)).toEqual(['caio', 'insights']);
  });
});

describe('resolveDelegationTarget', () => {
  it('resolves the two singletons without touching the database', async () => {
    await expect(resolveDelegationTarget(TENANT, 'caio')).resolves.toMatchObject({
      kind: 'caio',
      label: 'Chief AI Officer',
    });
    await expect(resolveDelegationTarget(TENANT, 'insights')).resolves.toMatchObject({
      kind: 'insights',
      label: 'Insights Manager',
    });
    expect(mockGetById).not.toHaveBeenCalled();
  });

  it('re-reads a team, scoped to this tenant', async () => {
    mockGetById.mockResolvedValue(team());

    const target = await resolveDelegationTarget(TENANT, TEAM_ID);

    // getById carries `tenant_id = $2 AND deleted_at IS NULL` in its own SQL, so
    // a team in another tenant and a soft-deleted one both come back as null
    // rather than as a row with a promising status.
    expect(mockGetById).toHaveBeenCalledWith(TEAM_ID, TENANT);
    expect(target).toMatchObject({ kind: 'team', id: TEAM_ID, label: 'Payroll Operations' });
  });

  it('refuses a team that was deleted since it was listed', async () => {
    mockGetById.mockResolvedValue(null);

    await expect(resolveDelegationTarget(TENANT, TEAM_ID)).resolves.toBeNull();
  });

  it.each(['draft', 'paused'])('refuses a team that is %s', async (status) => {
    mockGetById.mockResolvedValue(team({ status }));

    await expect(resolveDelegationTarget(TENANT, TEAM_ID)).resolves.toBeNull();
  });

  it('refuses an id the model invented, without letting the cast throw', async () => {
    // A non-uuid reaches Postgres as a bad cast. That is the model guessing, not
    // a fault, so it resolves to nothing like any other miss.
    mockGetById.mockRejectedValue(new Error('invalid input syntax for type uuid'));

    await expect(resolveDelegationTarget(TENANT, 'the payroll one')).resolves.toBeNull();
  });

  it('refuses an empty target', async () => {
    await expect(resolveDelegationTarget(TENANT, '   ')).resolves.toBeNull();
    expect(mockGetById).not.toHaveBeenCalled();
  });
});

describe('what the model is told', () => {
  it('describes each colleague by id, name and job', async () => {
    mockListAll.mockResolvedValue([team()]);
    const targets = await listDelegationTargets(TENANT);

    const described = JSON.parse(describeTargetsForModel(targets));

    expect(described.colleagues).toHaveLength(3);
    expect(described.colleagues[2]).toEqual({
      id: TEAM_ID,
      name: 'Payroll Operations',
      kind: 'team',
      whatItDoes: 'Runs payroll end to end.',
    });
    expect(described.error).toBeUndefined();
  });

  it('sends the roster along with the error, so one turn can recover', async () => {
    const targets = await listDelegationTargets(TENANT);

    const described = JSON.parse(describeTargetsForModel(targets, { error: 'no such colleague' }));

    expect(described.error).toBe('no such colleague');
    expect(described.colleagues.map((c: { id: string }) => c.id)).toEqual(['caio', 'insights']);
  });

  it('tells the model the delegation tool hands the reply over', async () => {
    // A model that expects a result back writes a preamble and then a summary,
    // and the person reads the same answer twice in two voices.
    expect(bringInColleagueTool.description).toContain('you will not get a result back');
    expect(bringInColleagueTool.input_schema.required).toEqual(['target', 'task']);
    // No enum: it would have to be built per request from a roster that is stale
    // by the time the model answers, and it would put every team id in every
    // prompt.
    expect(bringInColleagueTool.input_schema.properties['target']?.enum).toBeUndefined();
    expect(listColleaguesTool.input_schema.properties).toEqual({});
  });
});
