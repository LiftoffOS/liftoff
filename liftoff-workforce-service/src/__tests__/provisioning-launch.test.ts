// Starting the teams a plan built, as the approver, through the same action a
// click uses: preview, then confirm with the handle; every refusal kept in the
// workspace's own words; nothing retried; never a throw.

jest.mock('../infrastructure/logging.js', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockDispatch = jest.fn();
jest.mock('../workforce-plans/tools/remote-workspace-actions.js', () => ({
  dispatchWorkspaceActionAs: (...a: unknown[]) => mockDispatch(...a),
}));

import { startProvisionedTeams } from '../workforce-plans/provisioning-launch.js';

const TENANT = 'dd7d80bd-3b77-4677-817c-053fdb8668cd';
const APPROVER = 'acct-approver';

beforeEach(() => {
  jest.clearAllMocks();
});

it('previews then confirms team_status active for each built team, as the approver', async () => {
  mockDispatch
    .mockResolvedValueOnce({ preview: { from: 'draft', to: 'active' }, confirmationId: 'conf-1', note: 'x' })
    .mockResolvedValueOnce({ updated: true, team: { id: 'a1', name: 'Lead Research', status: 'active' } });
  const out = await startProvisionedTeams({
    tenantId: TENANT,
    planId: 'plan-1',
    approvedBy: APPROVER,
    specs: [
      { specId: 's1', name: 'Lead Research', provisioningStatus: 'completed', internalAgentId: 'a1' },
      { specId: 's2', name: 'Outreach', provisioningStatus: 'failed' },
      { specId: 's3', name: 'Old', provisioningStatus: 'skipped', internalAgentId: 'a3' },
    ],
  });
  expect([...out.entries()]).toEqual([['s1', { started: true }]]);
  expect(mockDispatch).toHaveBeenCalledTimes(2);
  const as = { tenantId: TENANT, accountId: APPROVER, role: 'member' };
  expect(mockDispatch).toHaveBeenNthCalledWith(1, 'team_status', { teamId: 'a1', status: 'active' }, as);
  expect(mockDispatch).toHaveBeenNthCalledWith(2, 'team_status', { teamId: 'a1', status: 'active', confirmationId: 'conf-1' }, as);
});

// The execution guard's 402 and the connector guard's 409 arrive as the
// dispatcher's refusal, reason and message intact.
it('keeps a refusal in the workspace\'s own words and does not confirm', async () => {
  mockDispatch
    .mockResolvedValueOnce({ preview: {}, confirmationId: 'conf-1', note: 'x' })
    .mockResolvedValueOnce({ refused: true, reason: 'payment_required', message: 'Your credit balance is $0. Please add credit to continue.' });
  const out = await startProvisionedTeams({
    tenantId: TENANT, planId: 'plan-1', approvedBy: APPROVER,
    specs: [{ specId: 's1', name: 'Lead Research', provisioningStatus: 'completed', internalAgentId: 'a1' }],
  });
  expect(out.get('s1')).toEqual({ started: false, reason: 'payment_required', message: 'Your credit balance is $0. Please add credit to continue.' });
  expect(mockDispatch).toHaveBeenCalledTimes(2);
});

it('stops at a refused preview (the approver is no longer a member, or may not start teams)', async () => {
  mockDispatch.mockResolvedValueOnce({ refused: true, reason: 'forbidden', message: 'This action is not available to the viewer role.' });
  const out = await startProvisionedTeams({
    tenantId: TENANT, planId: 'plan-1', approvedBy: APPROVER,
    specs: [{ specId: 's1', name: 'Lead Research', provisioningStatus: 'completed', internalAgentId: 'a1' }],
  });
  expect(out.get('s1')).toEqual({ started: false, reason: 'forbidden', message: 'This action is not available to the viewer role.' });
  expect(mockDispatch).toHaveBeenCalledTimes(1);
});

it('never throws and never retries when the workspace cannot be reached', async () => {
  mockDispatch.mockRejectedValueOnce(new Error('ECONNRESET'));
  const out = await startProvisionedTeams({
    tenantId: TENANT, planId: 'plan-1', approvedBy: APPROVER,
    specs: [{ specId: 's1', name: 'Lead Research', provisioningStatus: 'completed', internalAgentId: 'a1' }],
  });
  expect(out.get('s1')).toEqual({ started: false, reason: 'unavailable', message: 'The workspace could not be reached to start it.' });
  expect(mockDispatch).toHaveBeenCalledTimes(1);
});
