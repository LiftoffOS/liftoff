// overview.ts — the per-person overview a coding tool receives at connect:
// each section is a separate read, a failed one is left out, a viewer is not
// told about the review queue, an un-onboarded owner is told what remains,
// and the standing instructions always follow.

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockPoolQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  pool: { query: (...a: unknown[]) => mockPoolQuery(...a) },
}));
const mockListAiWorkforce = jest.fn();
jest.mock('../../workspace-actions/teams', () => ({
  listAiWorkforce: (...a: unknown[]) => mockListAiWorkforce(...a),
  teamDisplayName: (t: { role: string; messagingNickname: string | null }) => t.messagingNickname || t.role,
}));
const mockPendingCount = jest.fn();
jest.mock('../../connectors/tenant-runtime-client', () => ({
  tenantRuntimeClient: { getPendingApprovalCount: (...a: unknown[]) => mockPendingCount(...a) },
}));
const mockListConversations = jest.fn();
jest.mock('../service', () => ({
  listConversations: (...a: unknown[]) => mockListConversations(...a),
}));

import { buildInstructions } from '../overview';
import { SERVER_INSTRUCTIONS } from '../server-instructions';
import type { McpActor } from '../actor';

const actor = (role: McpActor['role']): McpActor => ({
  tenantId: '11111111-1111-1111-1111-111111111111', accountId: 'acct', keyId: 'key', keyType: 'collab',
  role, displayName: 'Ada Lovelace', client: 'Claude Code',
});

beforeEach(() => {
  jest.clearAllMocks();
  mockPoolQuery.mockResolvedValue({ rows: [{ name: 'Acme', onboarding_completed_at: new Date(), onboarding_step_id: 'invite' }] });
  mockListAiWorkforce.mockResolvedValue({
    teams: [{ id: 'a1', role: 'Marketing', messagingNickname: 'Marketing Team', status: 'active' }, { id: 'a2', role: 'Support', messagingNickname: null, status: 'paused' }],
    collaborators: [{ id: 'c1', name: 'Partner Bot' }],
  });
  mockPendingCount.mockResolvedValue({ total: 2, approvalsStandard: 2, approvalsCritical: 0, approvalsOther: 0, clarifications: 0 });
  mockListConversations.mockResolvedValue({
    conversations: [
      { conversationId: 's1', link: 'https://example.com/share/s1', team: { agentId: 'a1', name: 'Marketing Team' }, title: 'Launch plan', lastActivityAt: 'x', waitingOnHuman: true },
      { conversationId: 's2', link: 'https://example.com/share/s2', assistant: { agentId: 'liftoff', name: 'Liftoff' }, title: 'Cost question', lastActivityAt: 'y', waitingOnHuman: false },
    ],
    total: 2,
  });
});

describe('buildInstructions', () => {
  it('names the workspace, the AI workforce, what waits, and the recent conversations with links, then the standing text', async () => {
    const text = await buildInstructions(actor('member'));
    expect(text).toContain('Ada Lovelace (member) is connected to the Liftoff workspace "Acme" through Claude Code.');
    expect(text).toContain('agents: Marketing Team (active), Support (paused).');
    expect(text).toContain('External agents');
    expect(text).toContain('Partner Bot');
    expect(text).toContain('2 items in the review queue are waiting on a person.');
    expect(text).toContain('Launch plan (Marketing Team, waiting on a person) https://example.com/share/s1');
    expect(text).toContain('Cost question (Liftoff) https://example.com/share/s2');
    expect(text.endsWith(SERVER_INSTRUCTIONS)).toBe(true);
    // No ids.
    expect(text).not.toContain('a1');
    expect(text).not.toContain('11111111-1111');
    expect(mockListConversations).toHaveBeenCalledWith({ limit: 4 }, actor('member'));
  });

  it('omits the review queue for a viewer, who cannot act', async () => {
    const text = await buildInstructions(actor('viewer'));
    expect(text).not.toContain('review queue');
    expect(mockPendingCount).not.toHaveBeenCalled();
  });

  it('tells an owner whose workspace is not set up what remains and where', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [{ name: 'Acme', onboarding_completed_at: null, onboarding_step_id: 'plan' }] });
    const text = await buildInstructions(actor('owner'));
    expect(text).toContain('This workspace is not set up yet. Remaining: choose a plan, add a payment method, invite colleagues.');
    expect(text).toContain('/onboarding');
    // A member of the same incomplete workspace is not told.
    const member = await buildInstructions(actor('member'));
    expect(member).not.toContain('not set up yet');
  });

  it('leaves a failed section out and keeps the rest', async () => {
    mockListAiWorkforce.mockRejectedValue(new Error('runtime down'));
    mockListConversations.mockRejectedValue(new Error('db down'));
    const text = await buildInstructions(actor('member'));
    expect(text).toContain('"Acme"');
    expect(text).not.toContain('agents:');
    expect(text).not.toContain('Recent conversations');
    expect(text).toContain('review queue');
    expect(text.endsWith(SERVER_INSTRUCTIONS)).toBe(true);
  });

  it('points a brand-new workspace at Liftoff', async () => {
    mockListAiWorkforce.mockResolvedValue({ teams: [], collaborators: [] });
    mockPendingCount.mockResolvedValue({ total: 0 });
    mockListConversations.mockResolvedValue({ conversations: [], total: 0 });
    const text = await buildInstructions(actor('owner'));
    expect(text).toContain('No agents yet. "Liftoff" is the place to start');
  });

  it('keeps the overview within 1,500 characters', async () => {
    mockListAiWorkforce.mockResolvedValue({
      teams: Array.from({ length: 40 }, (_, i) => ({ id: `t${i}`, role: `A very long team role name number ${i}`, messagingNickname: null, status: 'active' })),
      collaborators: [],
    });
    const text = await buildInstructions(actor('member'));
    const overview = text.slice(0, text.length - SERVER_INSTRUCTIONS.length);
    expect(overview.length).toBeLessThanOrEqual(1502);
    expect(text).toContain('and 28 more');
  });
});
