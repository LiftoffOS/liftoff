import { withTenantScope } from '../../infrastructure/database';
import { log } from '../../infrastructure/logging';
import { slackApiFetch } from './slack-api';
import {
  approveApprovalAsService,
  rejectApprovalAsService,
} from '../../internal-agent-oversight/service-internal';
import { chatUpdateAllSiblingCards, reviewDashboardUrl } from './review-dm-notifier';

type Intent =
  | { kind: 'approve' }
  | { kind: 'reject'; reason?: string }
  | { kind: 'unknown' };

export function parseReplyIntent(text: string): Intent {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  if (['approve', 'yes', 'send', 'ok'].includes(lower)) return { kind: 'approve' };
  if (['reject', 'no', 'cancel', 'discard'].includes(lower)) return { kind: 'reject' };
  const m = trimmed.match(/^(?:reject|no)\s*:\s*([\s\S]+)$/i);
  if (m) return { kind: 'reject', reason: m[1].trim().slice(0, 2048) };
  return { kind: 'unknown' };
}

export async function handleReviewThreadReply(opts: {
  tenantId: string;
  slackTeamId: string;
  channelId: string;
  rootTs: string;
  slackUserId: string;
  text: string;
  botToken: string;
  /** Where to post the confirmation. Defaults to the card's thread. Pass null
   *  when the person replied at the top level of the DM (the common Slack
   *  habit) so the answer lands where they were actually looking. */
  ackThreadTs?: string | null;
}): Promise<boolean> {
  const review = await withTenantScope(opts.tenantId, async (c) => {
    const res = await c.query<{ review_id: string; assignee_account_id: string }>(
      `SELECT review_id, assignee_account_id FROM review_slack_messages
        WHERE slack_team_id = $1 AND slack_dm_channel_id = $2 AND slack_dm_root_ts = $3`,
      [opts.slackTeamId, opts.channelId, opts.rootTs],
    );
    return res.rows[0];
  });
  if (!review) return false;

  const intent = parseReplyIntent(opts.text);
  const ackTs = opts.ackThreadTs === undefined ? opts.rootTs : opts.ackThreadTs;
  const ackThread = ackTs ? { thread_ts: ackTs } : {};

  const dashUrl = reviewDashboardUrl(review.review_id);
  // Slack mrkdwn: <url|text>. Only "Liftoff Dashboard" is the link text;
  // surrounding prose is not part of the link.
  const dashLink = `<${dashUrl}|Liftoff Dashboard>`;
  const viewSuffix = ` View in ${dashLink}.`;
  const handledAck = `⚠️ Already handled. No change made.${viewSuffix}`;

  // Unknown intent: don't touch the approval row. Just tell the user to use
  // the Dashboard. Editing isn't supported in Slack because the Claude Agent
  // SDK resumes from cached session_data (sdk-hooks.ts:140-174), not from
  // hitl_approval_requests.pending_tool_calls — rewriting that JSONB would
  // be silently dropped on resume.
  if (intent.kind === 'unknown') {
    await slackApiFetch('chat.postMessage', {
      authToken: opts.botToken,
      body: { kind: 'json', value: {
        channel: opts.channelId, ...ackThread,
        text: `❌ To change the message, please edit in ${dashLink}.`,
      }},
    }).catch((err) => log.warn({ err: (err as Error).message }, 'reply confirmation failed'));
    return true;
  }

  let result: { alreadyActioned: boolean } = { alreadyActioned: false };
  let ack: string;
  let backendError = false;
  try {
    if (intent.kind === 'approve') {
      result = await approveApprovalAsService({
        tenantId: opts.tenantId, approvalId: review.review_id,
        slackTeamId: opts.slackTeamId, slackUserId: opts.slackUserId,
        alwaysApply: false,
      });
      ack = result.alreadyActioned ? handledAck : `✅ Sent.${viewSuffix}`;
    } else {
      result = await rejectApprovalAsService({
        tenantId: opts.tenantId, approvalId: review.review_id,
        slackTeamId: opts.slackTeamId, slackUserId: opts.slackUserId,
        reason: intent.reason, alwaysApply: false,
      });
      ack = result.alreadyActioned ? handledAck : `🚫 Rejected.${viewSuffix}`;
    }
  } catch (err) {
    log.error({ reviewId: review.review_id, err: (err as Error).message }, 'review reply dispatch failed');
    ack = `⚠️ Something went wrong. Please review in ${dashLink}.`;
    result = { alreadyActioned: false };
    backendError = true;
  }

  await slackApiFetch('chat.postMessage', {
    authToken: opts.botToken,
    body: { kind: 'json', value: {
      channel: opts.channelId, ...ackThread, text: ack,
    }},
  }).catch((err) => log.warn({ err: (err as Error).message }, 'reply confirmation failed'));

  if (!result.alreadyActioned && !backendError) {
    const footer = intent.kind === 'approve'
      ? `:white_check_mark: *Approved* by <@${opts.slackUserId}>`
      : `:no_entry: *Rejected* by <@${opts.slackUserId}>${intent.reason ? ` — ${intent.reason.slice(0, 80)}` : ''}`;
    // await — caller (webhook-router) now defers res.sendStatus until after
    // this returns, so we're still inside Slack's 3s budget and have CPU.
    await chatUpdateAllSiblingCards({
      reviewId: review.review_id, tenantId: opts.tenantId, footer,
    }).catch((err) => log.warn({ err: (err as Error).message }, 'chatUpdate sibling failed'));
  }
  return true;
}
