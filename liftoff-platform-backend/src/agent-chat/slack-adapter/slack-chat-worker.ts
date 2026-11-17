// Slack Chat Task Worker
//
// Processes a single Slack message end-to-end for the workspace app. The
// multi-agent co-mention path is gone with the per-agent apps (ADR-040): one
// bot cannot be @mentioned as several agents, so a message routes to exactly
// one agent.
//
// Steps:
//
//   1. React with :eyes: to acknowledge receipt
//   2. Resolve Slack user → platform account (via email match)
//   3. Find or create a chat thread (keyed on slack thread_ts)
//   4. Post an initial hourglass placeholder message
//   5. Run the agent chat turn, streaming updates via SlackStreamer
//   6. Finalize the streamer (flush remaining buffer)
//   7. Remove the :eyes: reaction
//
// Called fire-and-forget from the webhook router.  In production this will
// be dispatched via Cloud Tasks; the fire-and-forget pattern is the interim
// implementation.

import { SlackStreamer } from './slack-streamer';
import { uploadSlackAudio } from './slack-files';
import { speakReply } from '../../voice/chat-audio';
import {
  markDelivered,
  markFailed,
  recordObligation,
  RECOVERED_REPLY_MARKER,
} from '../delivery-obligations';
import { stallNoticeText, withStallStatus } from '../stall-status';
import { runAgentChatTurn } from '../chat-service';
import * as chatRepo from '../chat-repository';
import { getPool, withTenantScope } from '../../infrastructure/database';
import { log } from '../../infrastructure/logging';
import { checkExecutionAllowed } from '../../billing/execution-guard';
import { slackApiFetch } from './slack-api';
import { liftoffifyString } from '../../branding/registry';
import { assistantByKind, isAssistantKind } from '../assistant-targets';
import { AssistantUnreachableError, createAssistantThread, runAssistantTurn } from '../assistant-turn';
import { resolveActor } from '../../workspace-actions/actor';
import { getBinding } from './workspace-repository';
import { rememberAssistantThread, rememberedAssistantThread } from '../assistant-conversation-threads';

// ── Task payload ────────────────────────────────────────────────────────

export interface SlackChatTask {
  /** Turn identity, minted at ENQUEUE time (C1).
   *
   *  Carried on the Cloud Tasks payload so a retry addresses the same turn.
   *  That is what lets the worker notice the turn already ran and re-deliver
   *  the stored reply instead of re-invoking the runtime and paying for the
   *  whole turn a second time. */
  turnId?: string;
  tenantId: string;
  agentId: string;
  slackAppId: string;
  slackTeamId: string;
  slackUserId: string;
  slackChannelId: string;
  /**
   * Where the reply belongs. A ts threads the reply under that message; null
   * posts it flat. DMs pass null so the conversation reads like a normal
   * chat: people answer at the top level far more than in threads, and a
   * one-to-one DM has no channel noise to protect.
   */
  slackThreadTs: string | null;
  /**
   * The person spoke this message rather than typing it.
   *
   * Drives reply-in-kind: a spoken question gets a spoken answer beside the
   * written one, and a typed question does not. Speaking every reply aloud would
   * be noise in a channel nobody asked to be read to.
   */
  spokenInput?: boolean;
  text: string;
  eventTs: string;
  botToken: string;
  /**
   * Which agent is speaking. Its name opens the message text
   * ("Code Reviewer: …"). The SENDER stays the Liftoff app: one app reads as
   * one app, and renaming the bot per message would make an agent carrying a
   * human nickname look like a colleague. Same choice as the Teams adapter,
   * which puts the agent name in the card body and never renames the bot.
   */
  postAs?: { username: string };
}

// ── Main handler ────────────────────────────────────────────────────────

/**
 * Process a Slack chat message asynchronously.
 *
 * 1. React with :eyes: to acknowledge
 * 2. Resolve Slack user -> platform account
 * 3. Find or create chat thread
 * 4. Post initial placeholder message
 * 5. Run the chat turn, streaming updates via SlackStreamer
 * 6. Remove :eyes: reaction
 */
export async function handleSlackChatTask(task: SlackChatTask): Promise<void> {
  if (isAssistantKind(task.agentId)) {
    await handleSlackAssistantTask(task);
    return;
  }
  const {
    tenantId,
    agentId,
    slackChannelId,
    slackThreadTs,
    text,
    eventTs,
    botToken,
    turnId,
  } = task;

  // 1. React with :eyes: to acknowledge (immediate, non-intrusive)
  await slackApiCall('reactions.add', botToken, {
    channel: slackChannelId,
    timestamp: eventTs,
    name: 'eyes',
  }).catch(() => {
    /* Non-fatal */
  });

  // 1b. Execution guard — check subscription authorization and suspension state.
  const guardResult = await checkExecutionAllowed(tenantId);
  if (!guardResult.allowed) {
    await slackApiCall('reactions.remove', botToken, { channel: slackChannelId, timestamp: eventTs, name: 'eyes' }).catch(() => {});
    await slackApiCall('chat.postMessage', botToken, {
      channel: slackChannelId,
      ...(slackThreadTs ? { thread_ts: slackThreadTs } : {}),
      text: `_I'm not available right now. A workspace admin can check Liftoff for details._`,
    });
    return;
  }

  // 2. Resolve Slack user — try to match to a platform account, but
  //    don't gate on it. Anyone in the Slack workspace should be able
  //    to DM an agent without needing a Liftoff account.
  const resolved = await resolveSlackUser(
    task.slackTeamId,
    task.slackUserId,
    botToken,
    tenantId,
  );

  // 3. Find or create chat thread (account_id is nullable for guest users)
  // Thread identity for cross-channel history. A flat DM reply has no Slack
  // thread, so the originating message ts keys the Liftoff thread instead.
  const thread = await chatRepo.findOrCreateThread(
    tenantId,
    resolved.accountId,
    agentId,
    'slack',
    slackThreadTs ?? eventTs,
  );
  // Persist the channel so a self-wake continuation can be posted back to this thread.
  await chatRepo.setSlackChannel(tenantId, thread.id, slackChannelId).catch(() => {});

  // 4. Post initial placeholder message.
  const initialMsg = await slackApiCall('chat.postMessage', botToken, {
    channel: slackChannelId,
    ...(slackThreadTs ? { thread_ts: slackThreadTs } : {}),
    text: ':hourglass_flowing_sand:',
  });

  if (!initialMsg?.ts) {
    log.error({ tenantId, agentId }, 'Failed to post initial Slack message');
    return;
  }

  // 5. Run the chat turn with streaming via SlackStreamer
  const streamer = new SlackStreamer({
    botToken,
    channel: slackChannelId,
    messageTs: initialMsg.ts as string,
    debounceMs: 200,
    // CC-5: a revoked token marks the workspace install, so the dashboard
    // shows Set Up again and the fix is a reconnect.
    onTokenRevoked: () => {
      import('./workspace-repository')
        .then(({ markWorkspaceInstallRevoked }) => markWorkspaceInstallRevoked(task.tenantId, task.slackTeamId))
        .catch((err) => log.error({ error: (err as Error).message }, 'Failed to mark workspace Slack install as revoked'));
    },
  });

  // One bot posts for every agent, so every agent-authored message opens by
  // saying who is speaking.
  if (task.postAs) streamer.append(`${task.postAs.username}: `);

  /** Has any of the agent's answer reached the person yet? Decides whether a
   *  transient failure can be retried invisibly or has to be admitted. */
  let streamedAny = false;
  /** Set when the turn died on something worth another delivery attempt and
   *  nothing had been said. Acted on after the streaming block so the throw is
   *  not swallowed by the catch that turns errors into an apology. */
  let retryableFailure: string | null = null;

  try {
    // C1: has this turn already run? A Cloud Tasks retry after a failed post
    // arrives with the same turn id, and re-running would re-invoke the runtime
    // and bill the whole turn again for a reply we already have. Deliver the
    // stored one instead, marked as recovered because we cannot know whether
    // the first attempt landed.
    if (turnId) {
      const alreadyRun = await chatRepo.getAssistantMessageByTurnId(tenantId, turnId);
      if (alreadyRun?.content) {
        await recordObligation({
          tenantId, agentId, threadId: thread.id, turnId, channel: 'slack', targetRef: slackChannelId,
        });
        try {
          streamer.append(RECOVERED_REPLY_MARKER + alreadyRun.content);
          await streamer.finalize(alreadyRun.citations ?? null);
          await markDelivered(tenantId, turnId);
        } catch (err) {
          await markFailed(tenantId, turnId, (err as Error).message);
          throw err;
        }
        return;
      }
      await recordObligation({
        tenantId, agentId, threadId: thread.id, turnId, channel: 'slack', targetRef: slackChannelId,
      });
    }

    // C4: a long tool call emits no events, so the thread would otherwise sit
    // silent for minutes. The wrapper passes events through untouched and only
    // speaks up during genuine dead air.
    const turnEvents = withStallStatus(
      runAgentChatTurn({
        tenantId,
        agentId,
        threadId: thread.id,
        userId: resolved.userId,
        senderAccountId: resolved.accountId ?? undefined,
        userDisplayName: resolved.displayName,
        content: normalizeSlackMessage(text),
        channelHint: 'slack',
        ...(turnId ? { turnId } : {}),
      }),
      { onStall: (lastTool) => streamer.append(stallNoticeText(lastTool)) },
    );

    for await (const event of turnEvents) {
      if (event.type === 'text_delta') {
        // Once ANY text has reached the person, a retry would re-answer a
        // question they can already see part of. From here on a failure keeps
        // today's behaviour: say so, and leave the partial reply standing.
        streamedAny = true;
        streamer.append(event.text);
      } else if (event.type === 'tool_call') {
        streamer.addToolCall(event.tool);
      } else if (event.type === 'hitl_required') {
        streamer.append(
          '\n_I need approval to proceed. Review pending approvals in Liftoff._',
        );
      } else if (
        event.type === 'interrupt_delivered'
        || event.type === 'clarification_accepted'
      ) {
        // The message was folded into the thread's in-flight run — replace the
        // placeholder instead of streaming a reply that will never come.
        streamer.append('_Got it — passing this along to the current run._');
      } else if (event.type === 'stop_acknowledged') {
        streamer.append('_Stopping the current run._');
      } else if (event.type === 'error') {
        // A transient provider failure on a turn that has said NOTHING yet is
        // recoverable without the person ever seeing it: hand the task back to
        // the queue instead of apologising. The bound is the chat queue's own
        // maxAttempts — markFailed additionally flips the obligation row to
        // 'abandoned' past MAX_DELIVERY_ATTEMPTS, so a turn that never lands is
        // visible in the data rather than merely absent.
        if (event.retryable === true && !streamedAny) {
          retryableFailure = event.message;
          break;
        }
        streamer.append(
          `\n_Sorry, something went wrong: ${liftoffifyString(event.message)}_`,
        );
      }
    }
  } catch (err) {
    streamer.append(
      '\n_Sorry, I encountered an error processing your message._',
    );
    log.error(
      { tenantId, agentId, error: (err as Error).message },
      'Slack chat turn failed',
    );
  }

  // Nothing was said and the runtime called the failure retryable: fail this
  // request so Cloud Tasks delivers the task again. Deliberately outside the
  // catch above — that catch exists to turn an error into an apology, which is
  // exactly what a retryable failure must NOT do.
  if (retryableFailure) {
    log.warn(
      { tenantId, agentId, turnId, error: retryableFailure },
      'Slack chat turn failed before saying anything; handing back to the queue',
    );
    // Take the placeholder down before handing back. Step 4 posts a fresh
    // hourglass on EVERY delivery, so without this each retry would leave a
    // permanent ":hourglass_flowing_sand:" behind it in the customer's channel —
    // which is the opposite of the invisible recovery this path exists for. A
    // failed delete is not worth failing over: a stray hourglass is untidy, a
    // lost turn is not.
    await slackApiCall('chat.delete', botToken, {
      channel: slackChannelId,
      ts: initialMsg.ts as string,
    });
    if (turnId) await markFailed(tenantId, turnId, retryableFailure);
    throw new Error(`retryable chat turn failure: ${retryableFailure}`);
  }

  // C1: the delivery is only settled once the final flush has actually gone
  // out. A failure here re-throws so Cloud Tasks retries — and the retry now
  // finds the completed turn and re-delivers the stored reply instead of
  // re-running the whole thing.
  try {
    await streamer.finalize();
    if (turnId) await markDelivered(tenantId, turnId);
  } catch (err) {
    if (turnId) await markFailed(tenantId, turnId, (err as Error).message);
    throw err;
  }

  // 5b. Say it out loud, alongside the written reply that just landed.
  //
  // AFTER the delivery is marked, and never inside that try. Audio is additive:
  // if synthesis fails, or the workspace has not re-consented to the file scopes,
  // the person still has their answer and the turn is still complete. Making it
  // part of delivery would mean a vendor hiccup could fail a turn that already
  // succeeded, and Cloud Tasks would retry a reply the person has already read.
  if (task.spokenInput) {
    const spoken = await speakReply({
      tenantId,
      surface: 'slack',
      agentId,
      text: streamer.getBuffer(),
      sourceId: `slack:${slackChannelId}:${eventTs}`,
    });
    if (spoken) {
      await uploadSlackAudio({
        botToken,
        channel: slackChannelId,
        threadTs: slackThreadTs ?? undefined,
        filename: spoken.filename,
        audio: spoken.audio,
        title: 'Spoken reply',
      });
    }
  }

  // 6. Remove :eyes: reaction
  await slackApiCall('reactions.remove', botToken, {
    channel: slackChannelId,
    timestamp: eventTs,
    name: 'eyes',
  }).catch(() => {
    /* Non-fatal */
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Resolved Slack user identity.
 *
 * `accountId` is non-null when the Slack user's email matches a row in
 * the `accounts` table — this gives full attribution (thread ownership,
 * audit trail, cross-channel history).  When null, the user is a "guest":
 * someone in the Slack workspace who doesn't have a Liftoff account.
 * The agent still responds; we just have less metadata.
 */
interface ResolvedSlackUser {
  userId: string;         // account ID or `slack:<slackUserId>`
  accountId: string | null; // null for guest users (no Liftoff account)
  displayName: string;
}


/**
 * A platform assistant answering in Slack: the Liftoff assistant, the Chief AI
 * Officer or the Insights Manager, addressed the way a team is.
 *
 * Runs AS the person who wrote, on the assistant's own surface, through the
 * same runner the MCP surface uses — so a shared workspace's assistant always
 * knows whom it is talking to, and every workspace action it takes is
 * attributed to that person, from Slack. Someone the workspace cannot resolve
 * gets told so; the turn never runs anonymously.
 *
 * Thread continuity follows the binding: a DM bound to an assistant keeps one
 * thread across messages, remembered on the binding row after the first turn.
 * An assistant reached by name without a binding answers in a fresh thread,
 * as an addressed team does. The reply is posted as one message under the
 * assistant's name; the delivery-obligation ledger is not used because it
 * replays from agent_chat_messages, which an assistant's reply never enters —
 * a retry after a crash re-runs the turn instead.
 */
async function handleSlackAssistantTask(task: SlackChatTask): Promise<void> {
  const { tenantId, slackChannelId, slackThreadTs, text, eventTs, botToken } = task;
  const assistant = assistantByKind(task.agentId);
  if (!assistant) return;
  const say = (body: string) => slackApiCall('chat.postMessage', botToken, {
    channel: slackChannelId,
    ...(slackThreadTs ? { thread_ts: slackThreadTs } : {}),
    text: body,
  });
  const removeEyes = () => slackApiCall('reactions.remove', botToken, {
    channel: slackChannelId, timestamp: eventTs, name: 'eyes',
  }).catch(() => {});

  await slackApiCall('reactions.add', botToken, { channel: slackChannelId, timestamp: eventTs, name: 'eyes' })
    .catch(() => { /* Non-fatal */ });

  const guardResult = await checkExecutionAllowed(tenantId);
  if (!guardResult.allowed) {
    await removeEyes();
    await say(`_I'm not available right now. A workspace admin can check Liftoff for details._`);
    return;
  }

  const resolved = await resolveSlackUser(task.slackTeamId, task.slackUserId, botToken, tenantId);
  const actor = resolved.accountId
    ? await resolveActor({
      tenantId,
      accountId: resolved.accountId,
      surface: 'slack',
      via: 'slack',
      client: task.slackTeamId,
      displayName: resolved.displayName,
    })
    : null;
  if (!actor) {
    await removeEyes();
    await say(
      `${assistant.name}: I can only answer members of this workspace, and I could not match your `
      + `Slack account to one. Sign in to Liftoff with the email your Slack account uses, then message me again.`,
    );
    return;
  }

  // The thread: this conversation's own thread with this assistant, whatever
  // the conversation is bound to, so a person whose DM is bound to a team can
  // still hold a conversation with an assistant they address by name. Created
  // on the first message and remembered.
  const conversation = { surface: 'slack' as const, slackTeamId: task.slackTeamId, channelId: slackChannelId, threadRootTs: slackThreadTs };
  let threadId = await rememberedAssistantThread(tenantId, conversation, assistant.kind).catch(() => null);
  try {
    if (!threadId) {
      threadId = await createAssistantThread(assistant.kind, { tenantId, accountId: actor.accountId, role: actor.role });
      await rememberAssistantThread(tenantId, conversation, assistant.kind, threadId).catch((err) =>
        log.warn({ err: (err as Error).message, tenantId }, 'assistant thread could not be remembered for the conversation'));
    }
  } catch (err) {
    await removeEyes();
    if (err instanceof AssistantUnreachableError) {
      await say(`${assistant.name}: I cannot be reached right now. Please try again in a moment.`);
      return;
    }
    throw err;
  }

  const initialMsg = await say(':hourglass_flowing_sand:');
  if (!initialMsg?.ts) {
    log.error({ tenantId, assistant: assistant.kind }, 'Failed to post initial Slack message');
    return;
  }
  const streamer = new SlackStreamer({
    botToken,
    channel: slackChannelId,
    messageTs: initialMsg.ts as string,
    debounceMs: 200,
    onTokenRevoked: () => {
      import('./workspace-repository')
        .then(({ markWorkspaceInstallRevoked }) => markWorkspaceInstallRevoked(task.tenantId, task.slackTeamId))
        .catch((err) => log.error({ error: (err as Error).message }, 'Failed to mark workspace Slack install as revoked'));
    },
  });

  try {
    const outcome = await runAssistantTurn(assistant.kind, {
      tenantId,
      threadId,
      userMessage: normalizeSlackMessage(text),
      accountId: actor.accountId,
      displayName: actor.displayName,
      role: actor.role,
      origin: { via: 'slack', client: task.slackTeamId, credentialId: '' },
    });
    // Liftoff may hand the answer to a colleague; the words are then theirs.
    const speaker = outcome.answeredBy ?? assistant.name;
    if (outcome.terminal === 'completed' && outcome.replyContent) {
      streamer.append(`${speaker}: ${outcome.replyContent}`);
    } else if (outcome.errorCode === 'busy') {
      streamer.append(`${assistant.name}: I'm in the middle of answering you somewhere else. Give me a moment and try again.`);
    } else {
      streamer.append(`${assistant.name}: Sorry, I could not answer that just now.`);
      log.warn({ tenantId, assistant: assistant.kind, errorCode: outcome.errorCode }, 'Slack assistant turn did not complete');
    }
  } catch (err) {
    streamer.append(`${assistant.name}: Sorry, I encountered an error processing your message.`);
    log.error({ tenantId, assistant: assistant.kind, error: (err as Error).message }, 'Slack assistant turn failed');
  }
  await streamer.finalize();
  await removeEyes();
}

/**
 * Resolve a Slack user's identity.
 *
 * Always returns a usable identity so the agent can respond to anyone in
 * the workspace.  Tries to match the Slack user's email to a platform
 * account for richer attribution; falls back to the Slack profile name
 * when there's no match.
 */
async function resolveSlackUser(
  slackTeamId: string,
  slackUserId: string,
  botToken: string,
  tenantId: string,
): Promise<ResolvedSlackUser> {
  const pool = getPool();

  // Check cache — fast path for returning users. slack_user_mappings is
  // RLS-scoped by tenant_id; query within tenant scope so RLS lets the row
  // through. accounts is platform-global (no RLS) and lookup is by primary key.
  const cached = await withTenantScope(tenantId, (client) =>
    client.query(
      'SELECT account_id FROM slack_user_mappings WHERE slack_team_id = $1 AND slack_user_id = $2',
      [slackTeamId, slackUserId],
    ),
  );
  if (cached.rows.length > 0 && cached.rows[0].account_id) {
    const acct = await pool.query(
      "SELECT id, COALESCE(first_name || ' ' || last_name, email) as name FROM accounts WHERE id = $1",
      [cached.rows[0].account_id],
    );
    if (acct.rows.length > 0) {
      return {
        userId: acct.rows[0].id as string,
        accountId: acct.rows[0].id as string,
        displayName: acct.rows[0].name as string,
      };
    }
  }

  // Call Slack users.info to get the user's profile
  const userInfo = await slackApiCall('users.info', botToken, {
    user: slackUserId,
  });
  const slackUser = userInfo.user as Record<string, unknown> | undefined;
  const profile = slackUser?.profile as Record<string, unknown> | undefined;

  // Build a display name from whatever Slack gives us
  const displayName =
    (profile?.display_name as string) ||
    (profile?.real_name as string) ||
    (slackUser?.real_name as string) ||
    slackUserId;

  const email = profile?.email as string | undefined;
  if (!email) {
    // No email available (private profile or bot) — guest identity
    return { userId: `slack:${slackUserId}`, accountId: null, displayName };
  }

  // Try to match the email to a platform account
  const acctResult = await pool.query(
    "SELECT id, COALESCE(first_name || ' ' || last_name, email) as name FROM accounts WHERE email = $1",
    [email],
  );

  if (acctResult.rows.length > 0) {
    const accountId = acctResult.rows[0].id as string;
    const accountName = acctResult.rows[0].name as string;

    // Cache the mapping for faster resolution next time. slack_user_mappings
    // is RLS-scoped; write within tenant scope.
    await withTenantScope(tenantId, (client) =>
      client.query(
        `INSERT INTO slack_user_mappings (slack_team_id, slack_user_id, account_id, tenant_id, slack_email)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (slack_team_id, slack_user_id)
         DO UPDATE SET account_id = $3, slack_email = $5, cached_at = NOW()`,
        [slackTeamId, slackUserId, accountId, tenantId, email],
      ),
    );

    return { userId: accountId, accountId, displayName: accountName };
  }

  // No matching account — cache the email (with NULL account_id) so we
  // don't re-call users.info every message from this person
  await withTenantScope(tenantId, (client) =>
    client.query(
      `INSERT INTO slack_user_mappings (slack_team_id, slack_user_id, account_id, tenant_id, slack_email)
       VALUES ($1, $2, NULL, $3, $4) ON CONFLICT (slack_team_id, slack_user_id)
       DO UPDATE SET slack_email = $4, cached_at = NOW()`,
      [slackTeamId, slackUserId, tenantId, email],
    ),
  ).catch(() => { /* best-effort cache */ });

  return { userId: `slack:${slackUserId}`, accountId: null, displayName };
}

/**
 * Normalize Slack-formatted message text for the LLM.
 *
 * Strips Slack-specific formatting:
 *  - User mentions: <@U1234> → removed
 *  - Channel mentions: <#C123|general> → #general
 *  - Labeled URLs: <https://example.com|Example> → Example (https://example.com)
 *  - Bare URLs: <https://example.com> → https://example.com
 */
function normalizeSlackMessage(text: string): string {
  return text
    .replace(/<@\w+>/g, '') // Remove user mentions
    .replace(/<#\w+\|([^>]+)>/g, '#$1') // Channel mentions
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '$2 ($1)') // URLs with labels
    .replace(/<(https?:\/\/[^>]+)>/g, '$1') // Bare URLs
    .trim();
}

/**
 * Generic Slack Web API call helper.
 *
 * Wraps the shared slackApiFetch (timeout + rate-limit retry). On any
 * transport error (timeout, network, non-JSON), returns
 * `{ ok: false, error: 'transport_error' }` so callers don't need to
 * try/catch — the existing `if (!data.ok)` branches handle it uniformly.
 */
async function slackApiCall(
  method: string,
  token: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  try {
    const data = await slackApiFetch(method, {
      authToken: token,
      body: { kind: 'json', value: params },
    });
    if (!data.ok) {
      log.warn({ method, error: data.error }, `Slack API call ${method} failed`);
    }
    return data;
  } catch (err) {
    log.warn({ method, error: (err as Error).message }, `Slack API call ${method} threw`);
    return { ok: false, error: 'transport_error' };
  }
}
