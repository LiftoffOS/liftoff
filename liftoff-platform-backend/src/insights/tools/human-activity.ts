// get_human_activity Tool
//
// Answers questions like:
//   "Who's been doing the most HITL approvals this week?"
//   "How many corrections happened last month?"
//   "What did I personally work on?" (member role)
//
// Wraps:
//   - getHitlApprovalStats (DB — late HITL feedback aggregate)
//   - getCorrectionStats (DB — corrections from agent_audit_logs)
//   - getMemberActivity (DB — per-member approval + correction counts)
//
// Role narrowing:
//   - owner / admin: see everything (all members, full aggregates)
//   - member: ONLY their own row in members[], full aggregates still visible
//     so they can see "I did X out of Y total" without seeing other names
//   - viewer: tool not callable (filtered out by role matrix in dispatcher)

import {
  getHitlApprovalStats,
  getCorrectionStats,
  getMemberActivity,
} from '../data-providers';
import { COMPARE_TO_SCHEMA, TIME_RANGE_SCHEMA, formatTimeRangeForOutput, parseCompareToArg, parseTimeRangeArg } from './tool-helpers';
import type { InsightsTool, InsightsToolContext } from './types';
import type { CorrectionStats, HitlApprovalStats, MemberActivity, TimeRange } from '../types';

interface HumanActivityPeriod {
  period: { start: string; end: string };
  hitl: HitlApprovalStats | null;
  corrections: CorrectionStats | null;
  members: MemberActivity[];
  /** True when the members[] array was narrowed to the caller's own row only
   *  (because the caller's role is 'member'). */
  scopedToCaller: boolean;
}

interface HumanActivityOutput {
  current: HumanActivityPeriod;
  comparison?: HumanActivityPeriod;
}

async function loadPeriod(
  tenantId: string,
  range: TimeRange,
  callerAccountId: string,
  scopeToCaller: boolean,
): Promise<HumanActivityPeriod> {
  const [hitl, corrections, allMembers] = await Promise.all([
    getHitlApprovalStats(tenantId, range),
    getCorrectionStats(tenantId, range),
    getMemberActivity(tenantId, range),
  ]);

  const members = scopeToCaller
    ? allMembers.filter(m => m.accountId === callerAccountId)
    : allMembers;

  return {
    period: formatTimeRangeForOutput(range),
    hitl,
    corrections,
    members,
    scopedToCaller: scopeToCaller,
  };
}

export const getHumanActivityTool: InsightsTool = {
  definition: {
    name: 'get_human_activity',
    description:
      'Human-in-the-loop activity: HITL approval/rejection counts, corrections from human reviewers, and per-member activity (approvals + corrections per person). Use this when the user asks about human reviewer workload, who is making decisions, or correction volume. For users with the "member" role, the per-member list is automatically scoped to just the caller. Supports compare_to.',
    input_schema: {
      type: 'object',
      properties: {
        time_range: TIME_RANGE_SCHEMA,
        compare_to: COMPARE_TO_SCHEMA,
      },
      required: ['time_range'],
    },
  },
  async execute(input, ctx: InsightsToolContext): Promise<HumanActivityOutput> {
    const range = parseTimeRangeArg(input.time_range);
    const compareRange = parseCompareToArg(input.compare_to);

    // Member role gets scoped to "own only" for the per-person list, per the
    // role matrix entry `get_human_activity: { member: 'allow_own' }`.
    // Owners and admins see everyone.
    const scopeToCaller = ctx.role === 'member';

    const current = await loadPeriod(ctx.tenantId, range, ctx.accountId, scopeToCaller);

    if (compareRange) {
      const comparison = await loadPeriod(ctx.tenantId, compareRange, ctx.accountId, scopeToCaller);
      return { current, comparison };
    }

    return { current };
  },
};
