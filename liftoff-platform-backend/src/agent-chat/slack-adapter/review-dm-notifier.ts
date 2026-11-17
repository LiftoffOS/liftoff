// Posts the Block-Kit review card (one per assignee) or the final-form draft
// delivery (one per assignee) for outbound Slack tool calls.
//
// Multi-assignee fan-out is handled here. Channel-name resolution is done
// here too (the caller passes channel id; we resolve to name via
// conversations.info using the first available bot token; fall back to id
// on failure).
//
// On success, persists one review_slack_messages row per assignee.

import { withTenantScope } from '../../infrastructure/database';
import { partitionLiveTargets, recordFanoutOutcome } from '../dead-targets';
import { log } from '../../infrastructure/logging';
import { resolveWorkspaceBotToken } from './bot-token-service';
import { resolveSlackIdentity } from './identity-resolver';
import { slackApiFetch } from './slack-api';
import {
  getInstalledWorkspaceInstall,
  bindAgent,
  type WorkspaceInstallRow,
} from './workspace-repository';

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://app.example.com';

/** Deep link to the /dashboard/review queue page with the specific approval
 *  highlighted. Carried in every assignee-facing card + ack message. */
export function reviewDashboardUrl(reviewId: string): string {
  return `${FRONTEND_URL}/dashboard/review?approvalId=${reviewId}`;
}

// Agent display name is resolved INSIDE this module by querying
// internal_agents.messaging_nickname/role; callers (tenant-runtime) cannot
// be relied on to know it because ExecutionContext does not carry it.
export interface ReviewDmPayload {
  reviewId: string;
  tenantId: string;
  agentId: string;
  /** Messaging specialization (outbound Slack tool): destination channel + draft. */
  channelId?: string;          // channel name resolved here too
  draftText?: string;
  assigneeAccountIds: string[];
  /** Generic gated-tool card (non-messaging). Present instead of channelId/draftText;
   *  the summary is generated at the gate in TR (hitl-card-content.ts). */
  action?: string;
  why?: string | null;
  detail?: string | null;
  /** Escalation notice: informational, no Approve/Reject. An escalation is not
   *  a decision — it is resolved from the dashboard review queue — so the card
   *  carries the reason and a link instead of buttons that would post a
   *  decision against an id the approval store does not hold. */
  notice?: boolean;
  noticeReason?: string;
  /** The review queue URL, and ONLY when a queue item exists for this notice.
   *  Absent means the run ended and left a record, so there is nowhere to send
   *  the reader and the card says so by omitting the line entirely. */
  noticeLinkUrl?: string;
  /** What `noticeLinkUrl` points AT, so this module can word its own sentence.
   *  A terminal escalation links to the chat thread it opened, and describing
   *  that as the review queue would send the reader to a page that will never
   *  list it. */
  noticeLinkKind?: 'review' | 'chat';
}

export interface DraftDmPayload {
  tenantId: string;
  agentId: string;
  channelId: string;
  draftText: string;
  assigneeAccountIds: string[];
}

export interface DmFanoutResult {
  totalAssignees: number;
  delivered: number;
  unreachable: string[];
}

interface AssigneeRow {
  account_id: string;
  email: string;
}

const TRUNCATE_AT = 800;
const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const escapeQuote = (s: string) => s.replace(/\r/g, '').replace(/\n/g, '\n> ');

/** The team's name for the approval card, from EITHER id space.
 *
 *  internal_agents.id and the runtime's agents.id are disjoint (INV-TR-010).
 *  Approvals raised by the runtime carry the RUNTIME id — it comes straight off
 *  ExecutionContext.agentId — so looking it up in internal_agents found nothing
 *  and every one of those cards fell through to the literal 'Agent'. The card
 *  then read "Agent: Agent": an approval request that never said which team
 *  was asking, which is unusable the moment a workspace has more than one.
 *
 *  Tried as an internal id first because control-plane callers pass that one,
 *  then translated through the provisioning map for runtime callers. The
 *  fallback survives for genuinely unresolvable ids, but now says so in the
 *  log rather than quietly rendering a generic name. */
async function loadAgentDisplayName(tenantId: string, agentId: string): Promise<string> {
  const lookup = (id: string): Promise<string | null> =>
    withTenantScope(tenantId, async (c) => {
      const res = await c.query<{ display_name: string | null }>(
        `SELECT COALESCE(messaging_nickname, role) AS display_name
           FROM internal_agents
          WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
        [id, tenantId],
      );
      return res.rows[0]?.display_name ?? null;
    });

  const direct = await lookup(agentId);
  if (direct) return direct;

  try {
    const { getRuntimeToInternalMap } = await import('../../internal-agents/runtime-agent-id-map');
    const internalId = (await getRuntimeToInternalMap(tenantId)).get(agentId);
    if (internalId) {
      const translated = await lookup(internalId);
      if (translated) return translated;
    }
  } catch (err) {
    log.warn('review dm: runtime agent id translation failed', {
      tenantId, agentId, error: (err as Error).message,
    });
  }

  log.warn('review dm: could not name the team for an approval card', { tenantId, agentId });
  return 'Agent';
}

/** Test seam. The resolution spans two id spaces and a network-backed map, and
 *  the failure it guards renders a card nobody can act on — worth testing
 *  directly rather than only through the whole fan-out. */
export const __loadAgentDisplayNameForTest = loadAgentDisplayName;

async function loadAssigneeEmails(tenantId: string, ids: string[]): Promise<AssigneeRow[]> {
  if (ids.length === 0) return [];
  // accounts is tenant-agnostic; the join through tenant_members narrows to tenant.
  // Both tables are accessed under withTenantScope (tenant_members is RLS-scoped via migration 095).
  return withTenantScope(tenantId, async (c) => {
    const res = await c.query<AssigneeRow>(
      `SELECT a.id AS account_id, a.email
         FROM accounts a
         JOIN tenant_members tm ON tm.account_id = a.id AND tm.tenant_id = $1
        WHERE a.id = ANY($2::uuid[])`,
      [tenantId, ids],
    );
    return res.rows;
  });
}

/** Best-effort channel name from id. Falls back to id on any failure. */
async function resolveChannelName(channelId: string, botToken: string): Promise<string> {
  try {
    const res = await slackApiFetch('conversations.info', {
      authToken: botToken,
      body: { kind: 'form', value: { channel: channelId } },
    });
    if (res.ok && typeof (res.channel as { name?: string })?.name === 'string') {
      return (res.channel as { name: string }).name;
    }
  } catch { /* fall through */ }
  return channelId;
}

export function buildReviewBlocks(p: ReviewDmPayload, channelName: string, agentName: string): unknown[] {
  const actions = { type: 'actions', block_id: `review_${p.reviewId}`, elements: [
      { type: 'button', action_id: 'review_approve', style: 'primary',
        text: { type: 'plain_text', text: 'Approve' }, value: p.reviewId },
      { type: 'button', action_id: 'review_open_reject_modal', style: 'danger',
        text: { type: 'plain_text', text: 'Reject' }, value: p.reviewId },
  ]};
  // Reply instructions stay thread-agnostic on purpose: people answer a card
  // both in its thread and straight below it, and the workspace app resolves
  // either (workspace-event-handler step 6).
  const footer = { type: 'context', elements: [{ type: 'mrkdwn',
      text: `Or reply with \`approve\` or \`reject\`, or open in ` +
            `<${reviewDashboardUrl(p.reviewId)}|Liftoff Dashboard>.` }] };

  // Escalation notice: reason + link, deliberately buttonless. Approve/Reject
  // here would post decisions against an id the approval store does not hold.
  if (p.notice) {
    return [
      { type: 'header', text: { type: 'plain_text', text: 'Needs your attention' } },
      { type: 'section', fields: [
          { type: 'mrkdwn', text: `*Agent:*\n${agentName}` },
      ]},
      { type: 'section', text: { type: 'mrkdwn',
          text: escapeQuote(truncate(p.noticeReason ?? '', TRUNCATE_AT)) } },
      // A pointer only when there is somewhere real to go, worded for where
      // that is. A parked run has a queue row and answering it resumes the
      // work. A terminal escalation has no queue row — sending anyone there
      // promises an item that is not there — but it does open a chat thread,
      // which is where its blocker can actually be read. `linkUrl` empty still
      // means there is nowhere to send them at all.
      ...(p.noticeLinkUrl
        ? [{ type: 'context', elements: [{ type: 'mrkdwn',
            text: p.noticeLinkKind === 'chat'
              ? `Read it in <${p.noticeLinkUrl}|the conversation>.`
              : `Answer it in the <${p.noticeLinkUrl}|review queue>.` }] }]
        : []),
    ];
  }

  // Generic gated-tool card: Agent / Action / Why / Details (no emoji; Why and Details
  // omitted when absent). The messaging specialization below is unchanged.
  if (p.action) {
    const blocks: unknown[] = [
      { type: 'header', text: { type: 'plain_text', text: 'Approval needed' } },
      { type: 'section', fields: [
          { type: 'mrkdwn', text: `*Agent:*\n${agentName}` },
          { type: 'mrkdwn', text: `*Action:*\n${escapeQuote(truncate(p.action, TRUNCATE_AT))}` },
      ]},
    ];
    if (p.why) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn',
        text: `*Why:* ${escapeQuote(truncate(p.why, TRUNCATE_AT))}` } });
    }
    if (p.detail) {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn',
        text: escapeQuote(truncate(p.detail, TRUNCATE_AT)) }] });
    }
    blocks.push(actions, footer);
    return blocks;
  }

  // Messaging specialization (unchanged): Destination + quoted draft.
  return [
    { type: 'header', text: { type: 'plain_text', text: '🔔 Approval needed' } },
    { type: 'section', fields: [
        { type: 'mrkdwn', text: `*Agent:*\n${agentName}` },
        { type: 'mrkdwn', text: `*Destination:*\n#${channelName}` },
    ]},
    { type: 'section', text: { type: 'mrkdwn',
        text: `> ${escapeQuote(truncate(p.draftText ?? '', TRUNCATE_AT))}` } },
    actions,
    footer,
  ];
}

/**
 * The tenant's workspace-app install + token, or null when the workspace app
 * isn't installed (fall back to per-agent installs).
 */
async function loadWorkspaceDelivery(
  tenantId: string,
): Promise<{ install: WorkspaceInstallRow; botToken: string } | null> {
  const install = await getInstalledWorkspaceInstall(tenantId).catch(() => null);
  if (!install) return null;
  const botToken = await resolveWorkspaceBotToken(install);
  return botToken ? { install, botToken } : null;
}

/**
 * Workspace-app fan-out: one bot DMs every assignee, the card names the agent
 * in its body, and each card's thread is bound to the
 * owning agent. While the review_slack_messages row lives (14-day GC),
 * thread replies resolve the approval (review-reply-handler runs before
 * chat routing); afterwards the thread binding keeps routing replies to the
 * owning agent as normal chat.
 */
async function postReviewDmFanoutViaWorkspace(
  p: ReviewDmPayload,
  ws: { install: WorkspaceInstallRow; botToken: string },
  emails: AssigneeRow[],
  agentName: string,
): Promise<DmFanoutResult> {
  const { install, botToken } = ws;

  let channelName = p.channelId ?? '';
  if (p.channelId) {
    channelName = await resolveChannelName(p.channelId, botToken);
  }

  const blocks = buildReviewBlocks(p, channelName, agentName);
  const fallbackText = p.action
    ? `Approval needed. ${agentName}: ${p.action}`
    : `Approval needed. ${agentName} wants to send to #${channelName}`;
  const unreachable: string[] = [];
  let delivered = 0;

  for (const assignee of emails) {
    const identity = await resolveSlackIdentity({
      accountId: assignee.account_id, accountEmail: assignee.email,
      slackTeamId: install.slackTeamId, botToken,
    });
    if (!identity) { unreachable.push(assignee.account_id); continue; }

    const im = await slackApiFetch('conversations.open', {
      authToken: botToken,
      body: { kind: 'json', value: { users: identity.slackUserId } },
    });
    if (!im.ok || typeof (im.channel as { id?: string })?.id !== 'string') {
      unreachable.push(assignee.account_id);
      continue;
    }
    const dmChannelId = (im.channel as { id: string }).id;

    const post = await slackApiFetch('chat.postMessage', {
      authToken: botToken,
      body: { kind: 'json', value: {
        channel: dmChannelId, text: fallbackText, blocks,
        unfurl_links: false, unfurl_media: false,
      }},
    });
    if (!post.ok || typeof post.ts !== 'string') {
      unreachable.push(assignee.account_id);
      continue;
    }

    await withTenantScope(p.tenantId, (c) => c.query(
      `INSERT INTO review_slack_messages
         (review_id, tenant_id, agent_id, assignee_account_id, slack_team_id,
          slack_dm_channel_id, slack_dm_root_ts)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (slack_team_id, slack_dm_channel_id, slack_dm_root_ts)
       DO NOTHING`,
      [p.reviewId, p.tenantId, p.agentId, assignee.account_id, install.slackTeamId, dmChannelId, post.ts],
    ));

    // The card's thread belongs to this agent: replies route there.
    await bindAgent({
      tenantId: p.tenantId,
      agentId: p.agentId,
      slackTeamId: install.slackTeamId,
      channelId: dmChannelId,
      threadRootTs: post.ts as string,
      scope: 'dm',
      slackUserId: identity.slackUserId,
      accountId: assignee.account_id,
    }).catch((err) => log.warn(
      { reviewId: p.reviewId, err: (err as Error).message },
      'workspace review card thread bind failed',
    ));

    delivered++;
  }

  for (const id of p.assigneeAccountIds) {
    if (!emails.find((e) => e.account_id === id) && !unreachable.includes(id)) {
      unreachable.push(id);
    }
  }
  return { totalAssignees: p.assigneeAccountIds.length, delivered, unreachable };
}

/**
 * Record who a DM fan-out reached and who it did not.
 *
 * The unreachable list was previously returned to the caller and thrown away,
 * so the same undeliverable person was retried on every notification forever
 * and nobody could see it happening. Self-healing: a success clears the failure
 * count, so someone who installs Slack later just starts working again.
 *
 * Best-effort — bookkeeping never costs a notification.
 */
async function recordDmFanoutOutcome(
  tenantId: string,
  kind: 'review' | 'draft',
  deliveredAccountIds: string[],
  unreachableAccountIds: string[],
): Promise<void> {
  // Delegates to the shared recorder so Slack and Teams cannot drift on how a
  // failure is counted — a threshold means nothing if the write side and the
  // read side disagree.
  await recordFanoutOutcome({
    tenantId,
    kind,
    channel: 'slack',
    deliveredAccountIds,
    unreachableAccountIds,
    failureReason: 'dm unreachable',
  });
}

export async function postReviewDmFanout(p: ReviewDmPayload): Promise<DmFanoutResult> {
  // Skip recipients that have failed repeatedly. The fan-out has always
  // recorded them; nothing read it back, so the same unreachable account was
  // retried on every notification, burning flood-control budget on a message
  // that cannot arrive. Any successful send un-latches them again.
  const { live, skipped } = await partitionLiveTargets(p.tenantId, 'review', p.assigneeAccountIds, 'slack');
  const targets = live;

  const [emails, agentName, ws] = await Promise.all([
    loadAssigneeEmails(p.tenantId, targets),
    loadAgentDisplayName(p.tenantId, p.agentId),
    loadWorkspaceDelivery(p.tenantId),
  ]);
  // No workspace install means Slack is not connected for this tenant.
  if (!ws) {
    return { totalAssignees: p.assigneeAccountIds.length, delivered: 0, unreachable: p.assigneeAccountIds };
  }
  // The fan-out works from the live list; a skipped target is reported as
  // unreachable so the caller's count still adds up.
  const result = await postReviewDmFanoutViaWorkspace(
    { ...p, assigneeAccountIds: targets }, ws, emails, agentName,
  );
  // Record ONLY what was actually attempted. A skipped target never got an
  // attempt, so counting it as another failure would deepen a latch nothing
  // tested — the count would climb forever on its own.
  const attemptedUnreachable = [...result.unreachable];
  await recordDmFanoutOutcome(
    p.tenantId,
    'review',
    targets.filter((id) => !attemptedUnreachable.includes(id)),
    attemptedUnreachable,
  );
  // Reported after recording, so the caller's totals still add up.
  result.unreachable = [...attemptedUnreachable, ...skipped];
  return result;
}

export async function postDraftDmFanout(p: DraftDmPayload): Promise<DmFanoutResult> {
  // Same latch as the review fan-out above.
  const { live: targets, skipped } = await partitionLiveTargets(p.tenantId, 'draft', p.assigneeAccountIds, 'slack');

  const [emails, agentName, ws] = await Promise.all([
    loadAssigneeEmails(p.tenantId, targets),
    loadAgentDisplayName(p.tenantId, p.agentId),
    loadWorkspaceDelivery(p.tenantId),
  ]);
  if (!ws) {
    return { totalAssignees: p.assigneeAccountIds.length, delivered: 0, unreachable: p.assigneeAccountIds };
  }

  const channelName = await resolveChannelName(p.channelId, ws.botToken);
  const text = `📝 Draft from *${agentName}* (would have gone to *#${channelName}*):\n\n${p.draftText}`;
  const unreachable: string[] = [];
  let delivered = 0;
  for (const assignee of emails) {
    const identity = await resolveSlackIdentity({
      accountId: assignee.account_id, accountEmail: assignee.email,
      slackTeamId: ws.install.slackTeamId, botToken: ws.botToken,
    });
    if (!identity) { unreachable.push(assignee.account_id); continue; }
    const im = await slackApiFetch('conversations.open', {
      authToken: ws.botToken,
      body: { kind: 'json', value: { users: identity.slackUserId } },
    });
    if (!im.ok || typeof (im.channel as { id?: string })?.id !== 'string') {
      unreachable.push(assignee.account_id);
      continue;
    }
    const post = await slackApiFetch('chat.postMessage', {
      authToken: ws.botToken,
      body: { kind: 'json', value: {
        channel: (im.channel as { id: string }).id, text,
        unfurl_links: false, unfurl_media: false,
      }},
    });
    if (!post.ok) { unreachable.push(assignee.account_id); continue; }
    delivered++;
  }
  for (const id of targets) {
    if (!emails.find((e) => e.account_id === id) && !unreachable.includes(id)) {
      unreachable.push(id);
    }
  }
  // A skipped target is reported unreachable so the caller's count adds up, but
  // is NOT re-recorded as a failure — it never got an attempt, and counting it
  // would deepen a latch nothing tested.
  const reportedUnreachable = [...unreachable, ...skipped];
  await recordDmFanoutOutcome(
    p.tenantId,
    'draft',
    targets.filter((id) => !unreachable.includes(id)),
    unreachable,
  );
  return { totalAssignees: p.assigneeAccountIds.length, delivered, unreachable: reportedUnreachable };
}

export async function chatUpdateAllSiblingCards(opts: {
  reviewId: string;
  tenantId: string;
  footer: string;
}): Promise<void> {
  const rows = await withTenantScope(opts.tenantId, async (c) => {
    const res = await c.query<{
      slack_dm_channel_id: string;
      slack_dm_root_ts: string;
      slack_team_id: string;
    }>(
      `SELECT slack_team_id, slack_dm_channel_id, slack_dm_root_ts
         FROM review_slack_messages
        WHERE review_id = $1 AND tenant_id = $2`,
      [opts.reviewId, opts.tenantId],
    );
    return res.rows;
  });
  if (rows.length === 0) return;

  // One bot posted every card, so one token updates them all.
  const ws = await loadWorkspaceDelivery(opts.tenantId);
  if (!ws) {
    log.warn({ reviewId: opts.reviewId }, 'chat.update siblings: no workspace install');
    return;
  }

  for (const row of rows) {
    try {
      const res = await slackApiFetch('chat.update', {
        authToken: ws.botToken,
        body: { kind: 'json', value: {
          channel: row.slack_dm_channel_id,
          ts: row.slack_dm_root_ts,
          blocks: [{ type: 'context', elements: [{ type: 'mrkdwn', text: opts.footer }] }],
          text: opts.footer,
        }},
      });
      if (!res.ok) {
        log.warn(
          { reviewId: opts.reviewId, channel: row.slack_dm_channel_id,
            ts: row.slack_dm_root_ts, slackError: res.error },
          'chat.update sibling returned ok=false',
        );
      }
    } catch (err) {
      log.warn(
        { reviewId: opts.reviewId, err: (err as Error).message },
        'chat.update for sibling card failed',
      );
    }
  }
}
