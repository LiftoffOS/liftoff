// The facts a surface reads before asking "launch now or leave as drafts":
// the guard's own answer, the active count, and the connectors still missing.

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

const mockGuard = jest.fn();
jest.mock('../../billing/execution-guard', () => ({ checkExecutionAllowed: (...a: unknown[]) => mockGuard(...a) }));
const mockAgents = { listAllByTenant: jest.fn() };
jest.mock('../../internal-agents/service', () => ({ internalAgentService: mockAgents }));
const mockConnectors = jest.fn();
jest.mock('../../connectors/connector-service-client', () => ({ listConnectorsForTenant: (...a: unknown[]) => mockConnectors(...a) }));
const mockSlackInstall = jest.fn();
jest.mock('../../agent-chat/slack-adapter/workspace-repository', () => ({ getInstalledWorkspaceInstall: (...a: unknown[]) => mockSlackInstall(...a) }));
const mockTeamsCount = jest.fn();
jest.mock('../../agent-chat/teams-adapter/repository', () => ({ getInstalledTeamsCount: (...a: unknown[]) => mockTeamsCount(...a) }));

import { teamStartReadiness } from '../team-start-readiness';
import type { Actor } from '../actor';

const TENANT = '22222222-2222-2222-2222-222222222222';
const actor: Actor = { tenantId: TENANT, accountId: 'acct-1', role: 'member', displayName: 'Ada', surface: 'caio' };

beforeEach(() => {
  jest.clearAllMocks();
  mockGuard.mockResolvedValue({ allowed: true });
  mockAgents.listAllByTenant.mockResolvedValue([{ status: 'active' }, { status: 'draft' }, { status: 'active' }]);
  mockConnectors.mockResolvedValue([
    { id: 'c1', type: 'gmail', status: 'connected' },
    { id: 'c2', type: 'google_sheets', status: 'reconnect_required' },
  ]);
  mockSlackInstall.mockResolvedValue({ slackTeamId: 'T1' });
  mockTeamsCount.mockResolvedValue(0);
});

it('answers the facts, including which chat workspaces the app is installed in', async () => {
  const out = await teamStartReadiness(actor, ['gmail', 'google_sheets', 'slack']);
  expect(out).toEqual({
    canRun: true,
    activeTeams: 2,
    notConnected: ['google_sheets', 'slack'],
    chatWorkspaces: { slack: true, teams: false },
  });
  expect(mockConnectors).toHaveBeenCalledWith(TENANT, 'acct-1');
});

// An install read that fails answers "not installed", never a throw: the
// person is offered less, not nothing.
it('reports no chat workspace when the install reads fail', async () => {
  mockSlackInstall.mockRejectedValueOnce(new Error('db'));
  mockTeamsCount.mockRejectedValueOnce(new Error('db'));
  const out = await teamStartReadiness(actor);
  expect(out.chatWorkspaces).toEqual({ slack: false, teams: false });
});

// The guard's sentence is the one the payment gate shows; the surface relays
// it rather than paraphrasing a billing state.
it('carries the guard\'s own reason when the workspace cannot run', async () => {
  mockGuard.mockResolvedValueOnce({ allowed: false, reason: 'Your credit balance is $0. Please add credit to continue.' });
  const out = await teamStartReadiness(actor);
  expect(out.canRun).toBe(false);
  expect(out.reason).toBe('Your credit balance is $0. Please add credit to continue.');
  expect(out.notConnected).toEqual([]);
  expect(mockConnectors).not.toHaveBeenCalled();
});

it('does not read connections when none were asked about', async () => {
  await teamStartReadiness(actor, []);
  expect(mockConnectors).not.toHaveBeenCalled();
});

// Only a positively connected row counts, the same rule execution applies.
it('treats a reconnect-required connector as not connected', async () => {
  const out = await teamStartReadiness(actor, ['google_sheets']);
  expect(out.notConnected).toEqual(['google_sheets']);
});

// A failed connections read must not report every connector missing.
it('reports nothing missing when the connections read fails', async () => {
  mockConnectors.mockRejectedValueOnce(new Error('connector-service down'));
  const out = await teamStartReadiness(actor, ['gmail']);
  expect(out.notConnected).toEqual([]);
  expect(out.canRun).toBe(true);
});
