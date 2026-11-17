// Approving a plan must actually provision it — from every entry point.
//
// A plan can be approved over HTTP or from the CAIO's workforce_plan__approve
// tool, which calls the service directly. Anything that must happen on every
// approval therefore belongs to the service: put the run row and the Cloud
// Tasks fan-out in the route and a chat approval transitions the plan, reports
// that provisioning has started, and enqueues nothing.

const enqueueHrbpSpec = jest.fn();
const poolQuery = jest.fn();

jest.mock('../infrastructure/cloud-tasks.js', () => ({ enqueueHrbpSpec }));
jest.mock('../infrastructure/database.js', () => ({
  getPool: () => ({ query: poolQuery }),
}));
jest.mock('../infrastructure/logging.js', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../workforce-plans/events.js', () => ({
  publishWorkforcePlanEvent: jest.fn(),
}));

const transitionStatus = jest.fn();
const getPlanRow = jest.fn();
jest.mock('../workforce-plans/repository.js', () => ({
  transitionStatus,
  getPlan: getPlanRow,
  findById: getPlanRow,
}));

const TENANT = 'dd7d80bd-3b77-4677-817c-053fdb8668cd';
const PLAN_ID = '1aa21ef1-65d2-4d15-931a-bb9312a63f35';
const APPROVER = 'acct-1';

const SPECS = [
  { specId: 'campaign-tracker', name: 'Campaign Tracker', agentType: 'workflow', roleSummary: 'tracks campaigns' },
  { specId: 'second-spec', name: 'Second', agentType: 'agent', roleSummary: 'other' },
];

function planAt(status: string) {
  return {
    id: PLAN_ID,
    tenantId: TENANT,
    status,
    agents: SPECS,
    revision: 1,
    approvedBy: APPROVER,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  poolQuery.mockResolvedValue({ rows: [{ id: 'run-new' }] });
  getPlanRow.mockResolvedValue(planAt('pending_approval'));
  transitionStatus
    .mockResolvedValueOnce(planAt('approved'))
    .mockResolvedValueOnce(planAt('provisioning'));
});

async function approve() {
  const { workforcePlanService } = await import('../workforce-plans/service.js');
  return workforcePlanService.approve(PLAN_ID, TENANT, APPROVER);
}

describe('workforcePlanService.approve', () => {
  it('opens a run row so the per-spec event log has an FK target', async () => {
    await approve();

    const insert = poolQuery.mock.calls.find(c => /INSERT INTO hrbp_provisioning_runs/.test(c[0]));
    expect(insert).toBeDefined();
    expect(insert![1]).toEqual([PLAN_ID, TENANT, SPECS.length]);
  });

  it('enqueues one Cloud Task per spec — the whole point, and what was missing', async () => {
    await approve();

    expect(enqueueHrbpSpec).toHaveBeenCalledTimes(SPECS.length);
    expect(enqueueHrbpSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        planId: PLAN_ID,
        runId: 'run-new',
        approverAccountId: APPROVER,
        spec: SPECS[0],
      }),
    );
  });

  it('keeps going when one spec fails to enqueue', async () => {
    enqueueHrbpSpec.mockRejectedValueOnce(new Error('RESOURCE_EXHAUSTED'));

    await expect(approve()).resolves.toBeDefined();
    expect(enqueueHrbpSpec).toHaveBeenCalledTimes(SPECS.length);
  });

  it('still returns the provisioning plan to the caller', async () => {
    const result = await approve();
    expect(result.status).toBe('provisioning');
  });
});

describe('the chat approval path', () => {
  it('provisions, because the tool calls the service and never the router', async () => {
    const { workforcePlanApproveTool } = await import(
      '../workforce-plans/tools/workforce-plan-approve.js'
    );

    const result = (await workforcePlanApproveTool.execute(
      {},
      { tenantId: TENANT, accountId: APPROVER, role: 'owner', workforcePlanId: PLAN_ID },
    )) as { status: string; agentCount: number; message: string };

    // The tool has always claimed this. Now it is true.
    expect(result.message).toMatch(/being set up/i);
    expect(result.agentCount).toBe(SPECS.length);
    expect(enqueueHrbpSpec).toHaveBeenCalledTimes(SPECS.length);
  });

  // The builder's question, answered with the approval and kept on the plan
  // for the task that finishes last.
  it('records Launch Now on the plan and says the teams will be started', async () => {
    const { workforcePlanApproveTool } = await import(
      '../workforce-plans/tools/workforce-plan-approve.js'
    );
    const result = (await workforcePlanApproveTool.execute(
      { launch: true },
      { tenantId: TENANT, accountId: APPROVER, role: 'owner', workforcePlanId: PLAN_ID },
    )) as { message: string };
    expect(transitionStatus).toHaveBeenNthCalledWith(
      1, PLAN_ID, TENANT, ['draft', 'pending_approval'], 'approved',
      { approvedBy: APPROVER, launchOnCompletion: true },
    );
    expect(result.message).toMatch(/will be started for the person as soon as they are ready/);
  });

  it('records Maybe Later when the person chose drafts, and when the answer is missing', async () => {
    const { workforcePlanApproveTool } = await import(
      '../workforce-plans/tools/workforce-plan-approve.js'
    );
    const result = (await workforcePlanApproveTool.execute(
      { launch: false },
      { tenantId: TENANT, accountId: APPROVER, role: 'owner', workforcePlanId: PLAN_ID },
    )) as { message: string };
    expect(transitionStatus).toHaveBeenNthCalledWith(
      1, PLAN_ID, TENANT, ['draft', 'pending_approval'], 'approved',
      { approvedBy: APPROVER, launchOnCompletion: false },
    );
    expect(result.message).toMatch(/Teams page in draft status/);
  });
});
