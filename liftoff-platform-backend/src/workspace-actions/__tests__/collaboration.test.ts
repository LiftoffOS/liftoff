// wireCollaboration — a reconciler over two rows in two transactions, ordered
// so the only reachable half-state grants nothing.

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));
const mockGetTeam = jest.fn();
jest.mock('../../internal-agents/service', () => ({
  internalAgentService: { getById: (...a: unknown[]) => mockGetTeam(...a) },
}));
const mockGetCollaborator = jest.fn();
const mockUpdateCollaborator = jest.fn();
jest.mock('../../external-agents/service', () => ({
  externalAgentService: {
    get: (...a: unknown[]) => mockGetCollaborator(...a),
    update: (...a: unknown[]) => mockUpdateCollaborator(...a),
  },
}));
const mockApplyTeamUpdate = jest.fn();
jest.mock('../team-update', () => ({
  applyTeamUpdate: (...a: unknown[]) => mockApplyTeamUpdate(...a),
  isTeamUpdateRefusal: (r: { refused?: string }) => 'refused' in r,
}));
jest.mock('../collaborator', () => ({
  WIZARD_DEFAULT_PERMISSIONS: { read_summaries: 'allowed', run_analysis: 'allowed', draft_outputs: 'approval_required', propose_updates: 'approval_required' },
}));

import { unwireCollaboration, wireCollaboration } from '../collaboration';
import { PermissionDenied, type Actor } from '../actor';

const TENANT = '22222222-2222-2222-2222-222222222222';
const TEAM = '55555555-5555-4555-8555-555555555555';
const COLLAB = '66666666-6666-4666-8666-666666666666';
const CONNECTOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const actor = (role: Actor['role'] = 'admin'): Actor => ({ tenantId: TENANT, accountId: 'acct', role, displayName: 'Ada', surface: 'liftoff' });

function team(bound: boolean) {
  return {
    id: TEAM, role: 'Support', messagingNickname: null,
    integrations: [
      { id: CONNECTOR, type: 'google_mail', selectedObjects: ['inbox'] },
      ...(bound ? [{ id: COLLAB, type: 'external_agent', selectedObjects: [] }] : []),
    ],
  };
}
function collaborator(allows: boolean) {
  return {
    id: COLLAB, name: 'Partner Bot',
    allowedInternalAgentIds: allows ? [TEAM, 'other'] : ['other'],
    requestRules: allows
      ? [{ internalAgentId: TEAM, internalAgentName: 'Support', permissions: {} }, { internalAgentId: 'other', internalAgentName: 'Other', permissions: {} }]
      : [{ internalAgentId: 'other', internalAgentName: 'Other', permissions: {} }],
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUpdateCollaborator.mockResolvedValue({});
  mockApplyTeamUpdate.mockResolvedValue({ agent: team(true) });
});

describe('wireCollaboration', () => {
  it('collaborator side first (set-add with the wizard defaults), then the team side as a full-bindings server distil', async () => {
    mockGetTeam.mockResolvedValue(team(false));
    mockGetCollaborator.mockResolvedValue(collaborator(false));
    const result = await wireCollaboration(actor(), TEAM, COLLAB);
    expect(result).toEqual({ wired: true });
    // 1. The collaborator now allows the team, everyone else kept.
    expect(mockUpdateCollaborator).toHaveBeenCalledWith(COLLAB, TENANT, {
      allowedInternalAgentIds: ['other', TEAM],
      requestRules: [
        { internalAgentId: 'other', internalAgentName: 'Other', permissions: {} },
        { internalAgentId: TEAM, internalAgentName: 'Support', permissions: { read_summaries: 'allowed', run_analysis: 'allowed', draft_outputs: 'approval_required', propose_updates: 'approval_required' } },
      ],
    });
    // 2. The team is rebuilt with its current bindings plus the collaborator.
    expect(mockApplyTeamUpdate).toHaveBeenCalledWith(actor(), TEAM, {
      bindings: [
        { kind: 'connector', type: 'google_mail', connectorId: CONNECTOR, selectedObjects: ['inbox'] },
        { kind: 'collaborator', id: COLLAB },
      ],
    }, { distill: 'server' });
    const order = [mockUpdateCollaborator.mock.invocationCallOrder[0], mockApplyTeamUpdate.mock.invocationCallOrder[0]];
    expect(order[0]).toBeLessThan(order[1]);
  });

  it('team update throws → collaborator compensated (set-remove), and the failure is reported', async () => {
    mockGetTeam.mockResolvedValue(team(false));
    mockGetCollaborator.mockResolvedValue(collaborator(false));
    mockApplyTeamUpdate.mockResolvedValueOnce({ refused: 'distill_failed', message: 'did not converge' });
    // The compensation re-reads the collaborator, which now allows the team.
    mockGetCollaborator.mockResolvedValueOnce(collaborator(false)).mockResolvedValueOnce(collaborator(true));
    const result = await wireCollaboration(actor(), TEAM, COLLAB);
    expect(result).toEqual({ refused: 'team_update_failed', message: 'did not converge' });
    expect(mockUpdateCollaborator).toHaveBeenCalledTimes(2);
    expect(mockUpdateCollaborator.mock.calls[1][2]).toEqual({
      allowedInternalAgentIds: ['other'],
      requestRules: [{ internalAgentId: 'other', internalAgentName: 'Other', permissions: {} }],
    });
  });

  it('compensation throws → partial result; a second call converges to fully wired', async () => {
    mockGetTeam.mockResolvedValue(team(false));
    mockGetCollaborator
      .mockResolvedValueOnce(collaborator(false))   // first call: state read
      .mockResolvedValueOnce(collaborator(true));   // first call: compensation read
    mockApplyTeamUpdate.mockRejectedValueOnce(new Error('runtime unreachable'));
    mockUpdateCollaborator
      .mockResolvedValueOnce({})                     // set-add
      .mockRejectedValueOnce(new Error('db down'));  // compensation fails
    const first = await wireCollaboration(actor(), TEAM, COLLAB);
    expect(first).toMatchObject({ partial: 'collaborator_side_only', retry: true });

    // Second call: the collaborator side already holds; only the team side runs.
    mockGetCollaborator.mockResolvedValueOnce(collaborator(true));
    mockApplyTeamUpdate.mockResolvedValueOnce({ agent: team(true) });
    const second = await wireCollaboration(actor(), TEAM, COLLAB);
    expect(second).toEqual({ wired: true });
    expect(mockUpdateCollaborator).toHaveBeenCalledTimes(2); // no third collaborator write
    expect(mockApplyTeamUpdate).toHaveBeenCalledTimes(2);
  });

  it('already wired → no writes', async () => {
    mockGetTeam.mockResolvedValue(team(true));
    mockGetCollaborator.mockResolvedValue(collaborator(true));
    expect(await wireCollaboration(actor(), TEAM, COLLAB)).toEqual({ wired: true, alreadyWired: true });
    expect(mockUpdateCollaborator).not.toHaveBeenCalled();
    expect(mockApplyTeamUpdate).not.toHaveBeenCalled();
  });

  it('member → 403 (collaborators are owner/admin)', async () => {
    await expect(wireCollaboration(actor('member'), TEAM, COLLAB)).rejects.toBeInstanceOf(PermissionDenied);
  });
});

describe('unwireCollaboration', () => {
  it('team side first (the binding comes off), then the collaborator stops allowing the team', async () => {
    mockGetTeam.mockResolvedValue(team(true));
    mockGetCollaborator.mockResolvedValue(collaborator(true));
    mockApplyTeamUpdate.mockResolvedValueOnce({ agent: team(false) });
    const result = await unwireCollaboration(actor(), TEAM, COLLAB);
    expect(result).toEqual({ unwired: true });
    expect(mockApplyTeamUpdate).toHaveBeenCalledWith(actor(), TEAM, {
      bindings: [{ kind: 'connector', type: 'google_mail', connectorId: CONNECTOR, selectedObjects: ['inbox'] }],
    }, { distill: 'server' });
    expect(mockUpdateCollaborator).toHaveBeenCalledWith(COLLAB, TENANT, {
      allowedInternalAgentIds: ['other'],
      requestRules: [{ internalAgentId: 'other', internalAgentName: 'Other', permissions: {} }],
    });
    expect(mockApplyTeamUpdate.mock.invocationCallOrder[0]).toBeLessThan(mockUpdateCollaborator.mock.invocationCallOrder[0]);
  });

  it('a failed team update leaves the permission in place', async () => {
    mockGetTeam.mockResolvedValue(team(true));
    mockGetCollaborator.mockResolvedValue(collaborator(true));
    mockApplyTeamUpdate.mockResolvedValueOnce({ refused: 'distill_failed', message: 'no' });
    expect(await unwireCollaboration(actor(), TEAM, COLLAB)).toEqual({ refused: 'team_update_failed', message: 'no' });
    expect(mockUpdateCollaborator).not.toHaveBeenCalled();
  });
});
