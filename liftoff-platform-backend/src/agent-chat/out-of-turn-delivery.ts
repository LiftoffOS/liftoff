// Getting an out-of-turn message onto the surface the thread actually lives on.
//
// Several things now speak outside a turn: a learning confirmation ("I have
// saved that as a skill"), a routine proposal, an oversight decision. All of
// them are written with `appendMessage`, which puts a row in the transcript —
// and for a web thread that IS delivery, because the client reads the
// transcript.
//
// On Slack and Teams it is not. Those workers stream one turn reply and stop
// listening, so an out-of-turn row lands in the database and nobody ever sees
// it. That made chat learning and proposals web-only in practice, and worse: an
// unseen proposal still occupied the one-open-proposal budget, so the team
// member went quiet about everything else while waiting for an answer to a
// question it never managed to ask.
//
// This is the same active-push the wake-settlement fan-out does, factored out
// so anything speaking out of turn can reach the person it is speaking to.

import { log } from '../infrastructure/logging';
import { withTenantScope } from '../infrastructure/database';
import { enqueueNotification } from '../notifications';
import { findOrCreateLink } from '../notification-links';
import { frontendUrl } from '../infrastructure/frontend-url';
import { isAccountPresent } from './presence-repository';

interface ThreadRow {
  channel: 'web' | 'slack' | 'teams' | 'mcp';
  external_thread_ref: string | null;
  slack_channel_id: string | null;
  agent_id: string | null;
  account_id: string;
}

export interface OutOfTurnDeliveryResult {
  /** The surface the thread belongs to. */
  channel: 'web' | 'slack' | 'teams' | 'mcp' | null;
  /** True when an active push happened. Null for mcp, where the transcript row
   *  IS the delivery and there is nothing to push.
   *
   *  Web used to be null for that same reason, and it only ever held while the
   *  tab was open. It now answers the same question Slack and Teams answer:
   *  did a notification actually reach this person, not did we try. */
  pushed: boolean | null;
}

/** Post into a Slack thread as the Liftoff app (ADR-040), opening with the
 *  agent's name so it is clear who is speaking. */
async function postToSlack(
  tenantId: string,
  agentId: string | null,
  channelId: string | null,
  threadTs: string | null,
  text: string,
): Promise<boolean> {
  if (!agentId || !channelId || !threadTs) return false;
  try {
    const { getInstalledWorkspaceInstall } = await import('./slack-adapter/workspace-repository');
    const install = await getInstalledWorkspaceInstall(tenantId);
    if (!install) return false;

    const { resolveWorkspaceBotToken } = await import('./slack-adapter/bot-token-service');
    const token = await resolveWorkspaceBotToken(install);
    if (!token) return false;

    // Name the speaker: one Liftoff app serves every agent (ADR-040), so
    // without this the message arrives from "Liftoff" with no indication of
    // which team member is talking.
    const agentName = agentId
      ? await withTenantScope(tenantId, async (c) => {
          const r = await c.query<{ display_name: string | null }>(
            `SELECT display_name FROM internal_agents WHERE id = $1 AND tenant_id = $2`,
            [agentId, tenantId],
          );
          return r.rows[0]?.display_name ?? null;
        }).catch(() => null)
      : null;

    const { slackApiFetch } = await import('./slack-adapter/slack-api');
    const res = await slackApiFetch('chat.postMessage', {
      authToken: token,
      body: { kind: 'json', value: {
        channel: channelId,
        thread_ts: threadTs,
        text: agentName ? `${agentName}: ${text}` : text,
      } },
    });
    return Boolean(res.ok);
  } catch (err) {
    log.warn({ tenantId, error: (err as Error).message }, 'out-of-turn: slack push failed');
    return false;
  }
}

async function postToTeams(
  tenantId: string,
  conversationId: string | null,
  text: string,
): Promise<boolean> {
  if (!conversationId) return false;
  try {
    const { sendToConversation } = await import('./teams-adapter/teams-sender');
    const r = await sendToConversation({ tenantId, conversationId, text, kind: 'message' });
    return Boolean(r.activityId);
  } catch (err) {
    log.warn({ tenantId, error: (err as Error).message }, 'out-of-turn: teams push failed');
    return false;
  }
}

/**
 * Push a message that was written outside a turn to the thread's own surface.
 *
 * The caller has already persisted the transcript row — this is only the active
 * push that Slack and Teams need. Best-effort and never throws: failing to
 * deliver a confirmation must not fail the turn that produced it.
 */
export async function pushOutOfTurnMessage(params: {
  tenantId: string;
  threadId: string;
  agentId?: string | null;
  text: string;
}): Promise<OutOfTurnDeliveryResult> {
  const { tenantId, threadId, text } = params;
  try {
    const thread = (await withTenantScope(tenantId, (c) => c.query<ThreadRow>(
      `SELECT ct.channel, ct.external_thread_ref, ct.slack_channel_id, ct.account_id,
              (SELECT agent_id FROM agent_chat_thread_participants
                WHERE thread_id = ct.id AND deleted_at IS NULL LIMIT 1) AS agent_id
         FROM agent_chat_threads ct
        WHERE ct.id = $1 AND ct.tenant_id = $2 AND ct.deleted_at IS NULL`,
      [threadId, tenantId],
    ))).rows[0];

    if (!thread) return { channel: null, pushed: null };

    const agentId = params.agentId ?? thread.agent_id;

    if (thread.channel === 'slack') {
      const pushed = await postToSlack(
        tenantId, agentId, thread.slack_channel_id, thread.external_thread_ref, text,
      );
      return { channel: 'slack', pushed };
    }
    if (thread.channel === 'teams') {
      const pushed = await postToTeams(tenantId, thread.external_thread_ref, text);
      return { channel: 'teams', pushed };
    }
    if (thread.channel === 'web') {
      // The transcript row the caller already wrote is the delivery for anyone
      // with the tab open. This closes the case it never covered: the reader
      // who is not looking.
      const pushed = await notifyWebReader({
        tenantId,
        threadId,
        agentId,
        accountId: thread.account_id,
        text,
      });
      return { channel: 'web', pushed };
    }
    // mcp — the transcript row the caller already wrote is the delivery.
    return { channel: thread.channel, pushed: null };
  } catch (err) {
    log.warn(
      { tenantId, threadId, error: (err as Error).message },
      'out-of-turn: delivery lookup failed',
    );
    return { channel: null, pushed: null };
  }
}

/**
 * Tell a web thread's reader that something was said while they were away.
 *
 * Goes through enqueueNotification rather than calling push directly, so it
 * inherits every rule the other channels already obey: the kill switch, the
 * account's type toggles, and their choice of delivery channels. A person who
 * turned task updates off does not start receiving them because the message
 * arrived out of turn.
 *
 * Best effort throughout. This runs after the transcript row is already
 * committed, so nothing here can cost the caller their message.
 */
async function notifyWebReader(params: {
  tenantId: string;
  threadId: string;
  agentId: string | null;
  accountId: string;
  text: string;
}): Promise<boolean> {
  const { tenantId, threadId, agentId, accountId, text } = params;
  try {
    // Watching the message arrive is the same as having been told.
    if (await isAccountPresent(tenantId, threadId, accountId)) return false;

    if (!agentId) return false;
    const appBaseUrl = frontendUrl();

    // Opaque link, never the ids. Same rule as every other notification
    // destination: the URL is the only public artifact.
    const linkId = await findOrCreateLink({
      tenantId,
      destination: 'chat',
      agentId,
      threadId,
      recordId: null,
    });

    // Name the speaker. Without it the notification arrives from "Liftoff" with
    // no indication of which agent is talking, which is the same problem the
    // Slack push above solves by prefixing the agent name.
    const agentName = await withTenantScope(tenantId, async (c) => {
      const r = await c.query<{ display_name: string | null }>(
        `SELECT display_name FROM internal_agents WHERE id = $1 AND tenant_id = $2`,
        [agentId, tenantId],
      );
      return r.rows[0]?.display_name ?? null;
    }).catch(() => null);

    const result = await enqueueNotification({
      accountId,
      tenantId,
      type: 'task_update',
      payload: {
        internalAgentName: agentName ?? 'Your agent',
        eventTitle: agentName ?? 'Your agent',
        eventSummary: text,
        eventLink: `${appBaseUrl}/notification/${linkId}`,
        // Read by the push builder as the collapse key, so several replies in
        // one thread land as one notification rather than a stack.
        threadId,
      },
    });

    // The account's own rules can still stop this: the kill switch, task
    // updates turned off, browser delivery off. Reporting `true` in those cases
    // would tell the caller somebody was notified when nobody was.
    return result.pushedDevices > 0;
  } catch (err) {
    log.warn(
      { tenantId, threadId, error: (err as Error).message },
      'out-of-turn: web reader notification failed',
    );
    return false;
  }
}

/**
 * Tell a web thread's owner that a reply landed while they were away.
 *
 * This is the ordinary case — somebody asks a question, the agent answers —
 * and it was the one case push did not cover. pushOutOfTurnMessage only ever
 * ran for messages written OUTSIDE a turn (a learning confirmation, a routine
 * proposal), so a normal reply reached the transcript and nothing else.
 *
 * Called from both places a reply can be persisted, which are mutually
 * exclusive by the turn-keyed unique index: the live SSE path, and
 * tenant-runtime's settle callback. The settle path is the one that matters
 * most here, because it is what runs when the stream has already died and the
 * person has no other way of learning the answer arrived.
 *
 * Web threads only. Slack and Teams deliver into their own surface, and a
 * browser notification about a Slack reply would be a second interruption for
 * something the person has already been told.
 *
 * Best-effort and never throws: the reply is committed before this runs, so
 * nothing here can cost somebody their message.
 */
export async function notifyReplyPersisted(params: {
  tenantId: string;
  threadId: string;
  agentId: string | null;
  text: string;
}): Promise<void> {
  const { tenantId, threadId, agentId, text } = params;
  try {
    const thread = (await withTenantScope(tenantId, (c) => c.query<{
      channel: string;
      account_id: string;
    }>(
      `SELECT channel, account_id FROM agent_chat_threads
        WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
      [threadId, tenantId],
    ))).rows[0];

    if (!thread || thread.channel !== 'web') return;

    await notifyWebReader({
      tenantId,
      threadId,
      agentId,
      accountId: thread.account_id,
      text,
    });
  } catch (err) {
    log.warn(
      { tenantId, threadId, error: (err as Error).message },
      'reply notification failed',
    );
  }
}
