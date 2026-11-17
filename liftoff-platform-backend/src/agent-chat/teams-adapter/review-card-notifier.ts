// Teams HITL review-card fan-out.
//
// Posts an Adaptive Card review request proactively to each assignee:
//   - if the assignee has a personal conversation bound to the agent (mapped by
//     account_id), post the card now and record review_teams_messages.
//   - otherwise best-effort proactively install the Liftoff app for them
//     (email → aadObjectId via Graph → installedApps) so the bot becomes
//     available; the card reaches them on next interaction. Reported as
//     unreachable for this round (no conversation reference to post to yet).

import type { ConversationReference, TurnContext } from 'botbuilder';
import { partitionLiveTargets, recordFanoutOutcome } from '../dead-targets';
import { getPool, withTenantScope } from '../../infrastructure/database';
import { log } from '../../infrastructure/logging';
import { getTeamsAdapter, getBotAppId } from './teams-bot-adapter';
import {
  listPersonalConversationsByAccount,
  getTenantInstall,
  listReviewCardsByReview,
  getConversationReferenceById,
} from './repository';
import { buildReviewCard, buildResolvedReviewCard } from './cards';
import { resolveAadUserByEmail, proactiveInstallForUser } from './teams-app-service';

export interface PostReviewCardInput {
  reviewId: string;
  tenantId: string;
  agentId: string;
  /** Messaging specialization: the draft to preview. */
  draftText?: string;
  assigneeAccountIds: string[];
  /** Generic gated-tool card content (hitl-card-content.ts). Present instead of draftText. */
  action?: string;
  why?: string | null;
  detail?: string | null;
  /** Escalation notice (see cards.ts buildReviewCard): informational card with a
   *  link, no Approve/Reject. */
  notice?: { reason: string; linkUrl: string };
}

export interface PostReviewCardResult {
  totalAssignees: number;
  delivered: number;
  unreachable: string[];
}

async function getAgentName(tenantId: string, agentId: string): Promise<string> {
  const row = await withTenantScope(tenantId, async (c) => {
    const res = await c.query<{ messaging_nickname: string | null; role: string }>(
      'SELECT messaging_nickname, role FROM internal_agents WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL',
      [agentId, tenantId],
    );
    return res.rows[0];
  });
  return (row?.messaging_nickname || row?.role || 'Your agent').trim();
}

async function getAccountEmail(accountId: string): Promise<string | null> {
  const res = await getPool().query<{ email: string }>('SELECT email FROM accounts WHERE id = $1', [accountId]);
  return res.rows[0]?.email ?? null;
}

export async function postReviewCardFanout(
  input: PostReviewCardInput,
): Promise<PostReviewCardResult> {
  const { reviewId, tenantId, agentId, draftText, assigneeAccountIds, action, why, detail, notice } = input;
  const agentName = await getAgentName(tenantId, agentId);
  const adapter = getTeamsAdapter();
  const appId = getBotAppId();
  const install = await getTenantInstall(tenantId);

  // Map assignee accountId → their personal conversation with the bot.
  //
  // The agent's own conversations come first, so a person who has been talking
  // to THIS agent is answered in the thread they already have with it. But a
  // 1:1 Teams chat belongs to the USER and the BOT, not to an agent — there is
  // one Liftoff app, so one such chat per person, which is why
  // `conversation_id` is UNIQUE on that table. `agent_id` records who last
  // spoke there.
  //
  // Filtering on it made the fan-out reachable only to people whose most recent
  // Teams interaction happened to involve the agent now asking for approval,
  // and left every newly created agent unable to reach anyone at all. An
  // assignee whose personal conversation is bound to two OTHER agents would be
  // reported as having "no teams conversation reference" while sitting in a
  // chat with the very bot that needs to reach them.
  //
  // So the agent-scoped rows are a PREFERENCE and the tenant's personal
  // conversations are the fallback. Slack does not have this problem because it
  // resolves the person by email and opens a DM, with no agent in the lookup.
  const byAccount = new Map<string, { conversationId: string; conversationReference: Record<string, unknown> }>();
  // Ordered agent-first by the query, so the first row seen per account is the
  // best one: this agent's own thread where it exists, any personal chat with
  // the bot otherwise.
  for (const c of await listPersonalConversationsByAccount(tenantId, agentId)) {
    if (!byAccount.has(c.accountId)) {
      byAccount.set(c.accountId, {
        conversationId: c.conversationId,
        conversationReference: c.conversationReference,
      });
    }
  }

  // Skip targets already confirmed dead. Teams computed an `unreachable` list
  // from the very beginning and then discarded it, so the same person with no
  // conversation reference was retried on every single review — the exact
  // failure the dead-target registry exists to stop, which until now only Slack
  // was protected from.
  const { live: liveTargets, skipped } = await partitionLiveTargets(
    tenantId, 'review', assigneeAccountIds, 'teams',
  );

  let delivered = 0;
  const unreachable: string[] = [];

  for (const accountId of liveTargets) {
    const conv = byAccount.get(accountId);
    if (conv) {
      try {
        let activityId: string | undefined;
        await adapter.continueConversationAsync(
          appId,
          conv.conversationReference as Partial<ConversationReference>,
          async (ctx: TurnContext) => {
            const res = await ctx.sendActivity({
              attachments: [buildReviewCard({ agentName, reviewId, draftText, action, why, detail, notice })],
            });
            activityId = res?.id;
          },
        );
        if (activityId) {
          await withTenantScope(tenantId, (c) =>
            c.query(
              `INSERT INTO review_teams_messages (review_id, tenant_id, assignee_account_id, conversation_id, activity_id)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (conversation_id, activity_id) DO NOTHING`,
              [reviewId, tenantId, accountId, conv.conversationId, activityId],
            ),
          );
          delivered += 1;
          continue;
        }
      } catch (err) {
        log.warn({ reviewId, accountId, err: (err as Error).message }, 'Teams review card post failed');
      }
      unreachable.push(accountId);
      continue;
    }

    // No conversation yet — best-effort proactive install so the bot appears.
    unreachable.push(accountId);
    if (install?.consentState === 'published' && install.catalogTeamsAppId) {
      try {
        const email = await getAccountEmail(accountId);
        if (email) {
          const aadUserId = await resolveAadUserByEmail(install.azureAdTenantId, email);
          if (aadUserId) {
            await proactiveInstallForUser(install.azureAdTenantId, aadUserId, install.catalogTeamsAppId);
          }
        }
      } catch (err) {
        log.warn({ reviewId, accountId, err: (err as Error).message }, 'Teams proactive install failed');
      }
    }
  }

  // Record what was ACTUALLY attempted. Counting the skipped targets as fresh
  // failures would deepen the latch every round, so a target that came back
  // could never recover.
  const attemptedUnreachable = [...unreachable];
  await recordFanoutOutcome({
    tenantId,
    kind: 'review',
    channel: 'teams',
    deliveredAccountIds: liveTargets.filter((id) => !attemptedUnreachable.includes(id)),
    unreachableAccountIds: attemptedUnreachable,
    failureReason: 'no teams conversation reference',
  });

  // The caller's totals still include the skipped targets — they genuinely were
  // not reached, and a count that quietly omitted them would make a silenced
  // audience look like a small one.
  return {
    totalAssignees: assigneeAccountIds.length,
    delivered,
    unreachable: [...attemptedUnreachable, ...skipped],
  };
}

/**
 * After a HITL decision, replace EVERY posted review card for the review with a
 * resolved (action-less) card so no assignee can act on it twice. Analog of the
 * Slack path's chatUpdateAllSiblingCards.
 */
export async function updateAllReviewCards(
  tenantId: string,
  reviewId: string,
  agentId: string,
  footer: string,
): Promise<void> {
  const agentName = await getAgentName(tenantId, agentId);
  const adapter = getTeamsAdapter();
  const appId = getBotAppId();
  const cards = await listReviewCardsByReview(tenantId, reviewId);

  for (const card of cards) {
    try {
      const ref = await getConversationReferenceById(tenantId, card.conversationId);
      if (!ref) continue;
      await adapter.continueConversationAsync(
        appId,
        ref as Partial<ConversationReference>,
        async (ctx: TurnContext) => {
          await ctx.updateActivity({
            id: card.activityId,
            type: 'message',
            attachments: [buildResolvedReviewCard({ agentName, footer })],
          });
        },
      );
    } catch (err) {
      log.warn({ reviewId, conversationId: card.conversationId, err: (err as Error).message }, 'Teams review card update failed');
    }
  }
}
