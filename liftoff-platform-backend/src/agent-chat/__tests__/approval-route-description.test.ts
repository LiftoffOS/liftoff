// The chat used to stop with no explanation of who could unstick it, and told
// whoever triggered the gate it was "waiting on your review" even when it had
// routed to somebody else. These pin what the thread is now able to say.

const resolveApprovalAudienceMock = jest.fn();
jest.mock('../../person-assignments/approval-audience', () => ({
  resolveApprovalAudience: (...a: unknown[]) => resolveApprovalAudienceMock(...a),
}));

const queryMock = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  withTenantScope: async (_t: string, fn: (c: { query: typeof queryMock }) => Promise<unknown>) =>
    fn({ query: queryMock }),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { describeApprovalRoute } from '../approval-route-description';

const TENANT = '00000000-0000-0000-0000-000000000001';
const AGENT = '00000000-0000-0000-0000-000000000002';

beforeEach(() => jest.clearAllMocks());

describe('agent-chat / describeApprovalRoute', () => {
  it('names the people it routed to, in audience order', async () => {
    resolveApprovalAudienceMock.mockResolvedValue({
      notifyAccountIds: ['a2', 'a1'], fellBackToAdmins: false,
      visibility: 'assignees', assigneeAccountIds: ['a2', 'a1'],
    });
    // Deliberately returned in the opposite order to prove we reorder.
    queryMock.mockResolvedValue({
      rows: [
        { id: 'a1', first_name: 'Ada', last_name: 'Lovelace', email: 'ada@x.com' },
        { id: 'a2', first_name: 'Grace', last_name: 'Hopper', email: 'grace@x.com' },
      ],
    });

    const route = await describeApprovalRoute(TENANT, AGENT);

    expect(route.names).toEqual(['Grace Hopper', 'Ada Lovelace']);
    expect(route.toAdmins).toBe(false);
  });

  it('falls back to the email address when someone has no name', async () => {
    resolveApprovalAudienceMock.mockResolvedValue({
      notifyAccountIds: ['a1'], fellBackToAdmins: false,
      visibility: 'assignees', assigneeAccountIds: ['a1'],
    });
    queryMock.mockResolvedValue({
      rows: [{ id: 'a1', first_name: null, last_name: null, email: 'ada@x.com' }],
    });

    expect((await describeApprovalRoute(TENANT, AGENT)).names).toEqual(['ada@x.com']);
  });

  // Describing the admin fallback by role is shorter and more honest than
  // listing everyone — it is a role, not a chosen person.
  it('describes an admin fallback by role, without looking up names', async () => {
    resolveApprovalAudienceMock.mockResolvedValue({
      notifyAccountIds: ['admin1', 'admin2'], fellBackToAdmins: true,
      visibility: 'workspace', assigneeAccountIds: [],
    });

    const route = await describeApprovalRoute(TENANT, AGENT);

    expect(route.toAdmins).toBe(true);
    expect(route.names).toEqual([]);
    expect(queryMock).not.toHaveBeenCalled();
    // Nobody assigned: open to the workspace, not escalated past anyone.
    expect(route.unassigned).toBe(true);
  });

  // The two admin cases read differently. Escalated past assignees who could
  // not act is not the same as never having been assigned, and the copy says so.
  it('separates escalated-past-assignees from never-assigned', () => {
    resolveApprovalAudienceMock.mockResolvedValue({
      notifyAccountIds: ['admin1'], fellBackToAdmins: true,
      visibility: 'assignees', assigneeAccountIds: ['viewer1'],
    });
    return describeApprovalRoute(TENANT, AGENT).then((route) => {
      expect(route.toAdmins).toBe(true);
      expect(route.unassigned).toBe(false);
    });
  });

  it('says nothing when there is nobody to route to', async () => {
    resolveApprovalAudienceMock.mockResolvedValue({
      notifyAccountIds: [], fellBackToAdmins: true,
      visibility: 'workspace', assigneeAccountIds: [],
    });
    expect(await describeApprovalRoute(TENANT, AGENT)).toEqual({
      names: [], accountIds: [], toAdmins: false, unassigned: false,
    });
  });

  // A gate that cannot describe its route still has to work.
  it('never breaks the turn when resolution fails', async () => {
    resolveApprovalAudienceMock.mockRejectedValue(new Error('db down'));
    await expect(describeApprovalRoute(TENANT, AGENT)).resolves.toEqual({
      names: [], accountIds: [], toAdmins: false, unassigned: false,
    });
  });
});
