// get_human_activity tool tests.
//
// Critical assertion: when the caller's role is 'member', the per-member
// list is filtered to ONLY their own row. The aggregate HITL/correction
// stats remain visible (so a member can see "I did 5 of 30 total approvals")
// but they don't see other members' names or counts.

jest.mock('../../data-providers', () => ({
  getHitlApprovalStats: jest.fn(),
  getCorrectionStats: jest.fn(),
  getMemberActivity: jest.fn(),
}));

import { getHitlApprovalStats, getCorrectionStats, getMemberActivity } from '../../data-providers';
import { getHumanActivityTool } from '../human-activity';
import type { InsightsToolContext } from '../types';
import type { MemberActivity } from '../../types';

const FAKE_MEMBERS: MemberActivity[] = [
  { accountId: 'account-1', displayName: 'Alice', approvalCount: 10, correctionCount: 2 },
  { accountId: 'account-2', displayName: 'Bob', approvalCount: 5, correctionCount: 0 },
  { accountId: 'account-3', displayName: 'Carol', approvalCount: 20, correctionCount: 1 },
];

beforeEach(() => {
  jest.clearAllMocks();
  (getHitlApprovalStats as jest.Mock).mockResolvedValue({
    totalApprovals: 35,
    approvedCount: 30,
    rejectedCount: 5,
    pendingCount: 0,
    expiredCount: 0,
    avgDecisionTimeMs: 12000,
  });
  (getCorrectionStats as jest.Mock).mockResolvedValue({
    totalCorrections: 3,
    byAgent: [{ agentId: 'a1', agentName: 'Salesforce Sync', correctionCount: 3 }],
  });
  (getMemberActivity as jest.Mock).mockResolvedValue(FAKE_MEMBERS);
});

const ownerCtx: InsightsToolContext = {
  tenantId: 'tenant-1',
  accountId: 'account-1',
  role: 'owner',
};

const adminCtx: InsightsToolContext = {
  tenantId: 'tenant-1',
  accountId: 'account-2',
  role: 'admin',
};

const memberCtx: InsightsToolContext = {
  tenantId: 'tenant-1',
  accountId: 'account-1', // Alice
  role: 'member',
};

describe('get_human_activity tool — owner sees everyone', () => {
  it('returns all members when caller is owner', async () => {
    const result = await getHumanActivityTool.execute({ time_range: { preset: 'this_week' } }, ownerCtx);
    expect(result.current.members).toEqual(FAKE_MEMBERS);
    expect(result.current.scopedToCaller).toBe(false);
  });

  it('returns all members when caller is admin', async () => {
    const result = await getHumanActivityTool.execute({ time_range: { preset: 'this_week' } }, adminCtx);
    expect(result.current.members).toEqual(FAKE_MEMBERS);
    expect(result.current.scopedToCaller).toBe(false);
  });

  it('passes through full hitl + corrections aggregates', async () => {
    const result = await getHumanActivityTool.execute({ time_range: { preset: 'this_week' } }, ownerCtx);
    expect(result.current.hitl?.totalApprovals).toBe(35);
    expect(result.current.corrections?.totalCorrections).toBe(3);
  });
});

describe('get_human_activity tool — member sees only own row', () => {
  it('filters per-member list to caller account only', async () => {
    const result = await getHumanActivityTool.execute({ time_range: { preset: 'this_week' } }, memberCtx);
    expect(result.current.members).toEqual([
      { accountId: 'account-1', displayName: 'Alice', approvalCount: 10, correctionCount: 2 },
    ]);
    expect(result.current.scopedToCaller).toBe(true);
  });

  it('still returns full HITL aggregate (member can see total context)', async () => {
    const result = await getHumanActivityTool.execute({ time_range: { preset: 'this_week' } }, memberCtx);
    expect(result.current.hitl?.totalApprovals).toBe(35); // Not filtered
    expect(result.current.corrections?.totalCorrections).toBe(3); // Not filtered
  });

  it('returns empty members[] when caller is not in the activity list', async () => {
    const orphanCtx: InsightsToolContext = {
      tenantId: 'tenant-1',
      accountId: 'account-999', // not in FAKE_MEMBERS
      role: 'member',
    };
    const result = await getHumanActivityTool.execute({ time_range: { preset: 'this_week' } }, orphanCtx);
    expect(result.current.members).toEqual([]);
    expect(result.current.scopedToCaller).toBe(true);
  });
});

describe('get_human_activity tool — comparison expansion', () => {
  it('preserves the same scoping rule for comparison period', async () => {
    const result = await getHumanActivityTool.execute(
      {
        time_range: { preset: 'this_week' },
        compare_to: { preset: 'last_week' },
      },
      memberCtx,
    );
    expect(result.comparison).toBeDefined();
    expect(result.comparison?.members).toEqual([
      { accountId: 'account-1', displayName: 'Alice', approvalCount: 10, correctionCount: 2 },
    ]);
    expect(result.comparison?.scopedToCaller).toBe(true);
  });

  it('admin sees full comparison too', async () => {
    const result = await getHumanActivityTool.execute(
      {
        time_range: { preset: 'this_week' },
        compare_to: { preset: 'last_week' },
      },
      adminCtx,
    );
    expect(result.comparison?.members).toEqual(FAKE_MEMBERS);
    expect(result.comparison?.scopedToCaller).toBe(false);
  });
});

describe('get_human_activity tool — definition + null handling', () => {
  it('exposes definition with required schema', () => {
    expect(getHumanActivityTool.definition.name).toBe('get_human_activity');
    expect(getHumanActivityTool.definition.input_schema.properties).toHaveProperty('time_range');
  });

  it('handles null hitl + corrections gracefully', async () => {
    (getHitlApprovalStats as jest.Mock).mockResolvedValue(null);
    (getCorrectionStats as jest.Mock).mockResolvedValue(null);
    const result = await getHumanActivityTool.execute({ time_range: { preset: 'this_week' } }, ownerCtx);
    expect(result.current.hitl).toBeNull();
    expect(result.current.corrections).toBeNull();
    expect(result.current.members).toEqual(FAKE_MEMBERS); // still works
  });
});
