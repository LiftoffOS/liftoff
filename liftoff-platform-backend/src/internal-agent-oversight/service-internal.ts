import { withTenantScope, withAdminScope } from '../infrastructure/database';
import { reverseResolveSlackIdentity } from '../agent-chat/slack-adapter/identity-resolver';
import type { Actor } from '../workspace-actions/actor';
import { decideReview, type ReviewDecisionRefusal } from '../workspace-actions/review';

export interface SlackResolveInput {
  tenantId: string;
  approvalId: string;
  slackTeamId: string;
  slackUserId: string;
  alwaysApply: boolean;
}

export interface SlackRejectInput extends SlackResolveInput {
  reason?: string;
}

export interface SlackResolveResult {
  alreadyActioned: boolean;
  approvalId: string;
}

interface ResolvedActor { accountId: string; role: string; }

async function resolveSlackActor(opts: {
  tenantId: string;
  slackTeamId: string;
  slackUserId: string;
  approvalId: string;
}): Promise<ResolvedActor | { error: 'unknown_actor' | 'no_membership' }> {
  // 1. Cache reverse lookup.
  let accountId = await reverseResolveSlackIdentity({
    slackTeamId: opts.slackTeamId, slackUserId: opts.slackUserId,
  });

  // 2. Fallback: find any review_slack_messages row for this approval whose
  //    (slack_team_id, slack_user_id) matches via the assignee. We must verify
  //    via identity cache that the Slack user actually maps to the assignee.
  //    The simplest correct check: look up the review's assignees in this
  //    workspace and check whether one of them has an identity row matching
  //    this slack_user_id.
  if (!accountId) {
    const candidates = await withTenantScope(opts.tenantId, async (c) => {
      const res = await c.query<{ assignee_account_id: string }>(
        `SELECT DISTINCT assignee_account_id FROM review_slack_messages
          WHERE review_id = $1 AND tenant_id = $2 AND slack_team_id = $3`,
        [opts.approvalId, opts.tenantId, opts.slackTeamId],
      );
      return res.rows.map((r) => r.assignee_account_id);
    });
    if (candidates.length > 0) {
      const match = await withAdminScope(
        { caller: 'slack-service-internal', reason: 'actor cross-check' },
        (c) => c.query<{ account_id: string }>(
          `SELECT account_id FROM account_slack_identities
            WHERE slack_team_id = $1 AND slack_user_id = $2
              AND account_id = ANY($3::uuid[])
            LIMIT 1`,
          [opts.slackTeamId, opts.slackUserId, candidates],
        ),
      );
      accountId = match.rows[0]?.account_id ?? null;
    }
  }

  if (!accountId) return { error: 'unknown_actor' };

  // 3. Membership + role.
  const membership = await withTenantScope(opts.tenantId, async (c) => {
    const res = await c.query<{ role: string }>(
      `SELECT role FROM tenant_members
        WHERE tenant_id = $1 AND account_id = $2`,
      [opts.tenantId, accountId],
    );
    return res.rows[0];
  });
  if (!membership) return { error: 'no_membership' };

  return { accountId, role: membership.role };
}

// ── Channel-agnostic core ───────────────────────────────────────────────────
// The approve/reject decision logic is identical regardless of which channel
// the actor came from (Slack button, Teams Adaptive Card, future surfaces).
// The only channel-specific concern is resolving the actor (accountId + tenant
// role); once resolved, both channels call decideReview, the same function the
// dashboard's routes and the assistants call — so a Slack-origin decision now
// emits approval.decided, greys the sibling cards and posts the outcome into
// the thread, exactly as a dashboard decision does. The callers keep their own
// card update; it is idempotent with the shared one.

export interface ResolvedActorInput {
  tenantId: string;
  approvalId: string;
  accountId: string;
  role: string;
  alwaysApply: boolean;
  /** Audit operation label, e.g. 'slack_approve' / 'teams_approve'. Names the
   *  surface the decision came from. */
  operation?: string;
}

function surfaceFromOperation(operation: string | undefined): 'slack' | 'teams' {
  return operation?.startsWith('teams') ? 'teams' : 'slack';
}

function actorFromInput(input: ResolvedActorInput): Actor {
  return {
    tenantId: input.tenantId,
    accountId: input.accountId,
    role: input.role as Actor['role'],
    displayName: '',
    surface: surfaceFromOperation(input.operation),
  };
}

/** The refusals that mean "somebody else got there first, or the window
 *  closed": the card is updated as already actioned rather than failed. */
function isTerminalRefusal(refused: ReviewDecisionRefusal['refused']): boolean {
  return refused === 'expired' || refused === 'already_decided'
    || refused === 'tamper_detected' || refused === 'not_found';
}

export async function approveApprovalForActor(input: ResolvedActorInput): Promise<SlackResolveResult> {
  const result = await decideReview(actorFromInput(input), input.approvalId, 'approve', {
    alwaysApply: input.alwaysApply,
  });
  if ('refused' in result) {
    if (result.refused === 'forbidden') {
      throw new Error(`approveApprovalForActor: role '${input.role}' cannot approve this review: ${result.message}`);
    }
    if (isTerminalRefusal(result.refused)) return { alreadyActioned: true, approvalId: input.approvalId };
    throw new Error(`approveApprovalForActor: ${result.message}`);
  }
  return { alreadyActioned: false, approvalId: input.approvalId };
}

export interface ResolvedActorRejectInput extends ResolvedActorInput {
  reason?: string;
}

export async function rejectApprovalForActor(input: ResolvedActorRejectInput): Promise<SlackResolveResult> {
  const result = await decideReview(actorFromInput(input), input.approvalId, 'reject', {
    alwaysApply: input.alwaysApply,
    reason: input.reason,
  });
  if ('refused' in result) {
    if (result.refused === 'forbidden') {
      throw new Error(`rejectApprovalForActor: role '${input.role}' cannot reject this review: ${result.message}`);
    }
    if (isTerminalRefusal(result.refused)) return { alreadyActioned: true, approvalId: input.approvalId };
    throw new Error(`rejectApprovalForActor: ${result.message}`);
  }
  return { alreadyActioned: false, approvalId: input.approvalId };
}

// ── Slack wrappers — resolve the Slack actor, then delegate to the core ──────

export async function approveApprovalAsService(input: SlackResolveInput): Promise<SlackResolveResult> {
  const actor = await resolveSlackActor(input);
  if ('error' in actor) {
    throw new Error(`approveApprovalAsService failed: ${actor.error}`);
  }
  return approveApprovalForActor({
    tenantId: input.tenantId,
    approvalId: input.approvalId,
    accountId: actor.accountId,
    role: actor.role,
    alwaysApply: input.alwaysApply,
    operation: 'slack_approve',
  });
}

export async function rejectApprovalAsService(input: SlackRejectInput): Promise<SlackResolveResult> {
  const actor = await resolveSlackActor(input);
  if ('error' in actor) {
    throw new Error(`rejectApprovalAsService failed: ${actor.error}`);
  }
  return rejectApprovalForActor({
    tenantId: input.tenantId,
    approvalId: input.approvalId,
    accountId: actor.accountId,
    role: actor.role,
    alwaysApply: input.alwaysApply,
    reason: input.reason,
    operation: 'slack_reject',
  });
}
