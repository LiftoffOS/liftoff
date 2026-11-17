// Inbound event handling for the Liftoff workspace Slack app (ADR-040).
//
// The webhook router forks here when an event's api_app_id is the workspace
// app. One bot serves every agent, so routing to an agent happens via
// slack_conversation_agents bindings (thread binding first, then the
// channel/DM-level binding), with an external_select picker when nothing is
// bound. Mirrors the Teams bot handler's flow: resolve tenant → resolve or
// bind the agent → execution guard (inside the chat worker) → dispatch.
//
// Ordering with the 200 ack matters: Cloud Run cpu-throttling=true starves
// any work left running after the response, and minScale 0 lets the instance
// be reclaimed mid-work. So everything here is synchronous and pre-ack: fast
// checks (review-thread replies, picker posts) run inline, and the chat turn
// itself is enqueued as a durable Cloud Task BEFORE the 200 — the worker runs
// it inside its own request. An enqueue failure returns 500 so the upstream
// (connector-service / Slack) redelivers the event.

import type { Response } from 'express';
import { isDuplicateTaskError } from '../chat-turn-dispatch';
import { log } from '../../infrastructure/logging';
import { findAudioFile, downloadSlackFile } from './slack-files';
import { transcribeVoiceMemo, recordMemoCost } from '../../voice/chat-audio';
import {
  verifyWorkspaceSlackSignature,
  isDuplicateSlackEvent,
} from './webhook-router';
import { getLiftoffSlackAppId } from './workspace-app';
import {
  findWorkspaceInstallByTeam,
  getBinding,
  getWorkspaceDefaultAgent,
  findLatestReviewCardInDm,
  getAgentNameAndStatus,
  findAgentByName,
} from './workspace-repository';
import { resolveConversationAgent, switchIsAllowed } from './profile-routing';
import { isAssistantKind } from '../assistant-targets';
import { resolveWorkspaceBotToken } from './bot-token-service';
import { buildAgentPickerBlocks, type PickerContext } from './workspace-cards';
import { slackApiFetch } from './slack-api';

type Scope = 'dm' | 'channel' | 'group';

/** Strip <@U…> mention tokens (for switch-command detection and routing). */
function stripBotMentions(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, '').trim();
}

/** Same switch grammar as the Teams bot handler. */
function isSwitchCommand(text: string): boolean {
  return /^(switch|talk to)\b/i.test(text.trim());
}

function inferScope(event: Record<string, unknown>): Scope {
  const ct = event.channel_type as string | undefined;
  if (ct === 'im') return 'dm';
  if (ct === 'group') return 'group';
  if (ct === 'channel') return 'channel';
  // app_mention events carry no channel_type — infer from the channel id.
  const ch = String(event.channel ?? '');
  if (ch.startsWith('D')) return 'dm';
  if (ch.startsWith('G')) return 'group';
  return 'channel';
}

/** Where a reply belongs: flat in a DM, threaded under the summoning message
 *  in a channel. Shared by chat replies and the paused notice so both land in
 *  the same place. */
function replyPlacement(scope: Scope, threadTs: string | undefined, eventTs: string): string | null {
  return scope === 'dm' ? (threadTs ?? null) : (threadTs ?? eventTs);
}

/** The assistant speaking, once, in a channel: it answers in a DM. */
export async function postAssistantDmPointer(
  botToken: string, channelId: string, replyTs: string | null, assistantName: string,
): Promise<void> {
  await slackApiFetch('chat.postMessage', {
    authToken: botToken,
    body: { kind: 'json', value: {
      channel: channelId,
      ...(replyTs ? { thread_ts: replyTs } : {}),
      text: `${assistantName}: I answer in a direct message. Message me there and I will pick this up.`,
    } },
  });
}

/** Liftoff itself speaking, not the agent: a paused teammate cannot answer,
 *  so the app says so rather than leaving the person waiting. */
export async function postPausedNotice(
  botToken: string, channelId: string, replyTs: string | null, agentName: string,
): Promise<void> {
  await slackApiFetch('chat.postMessage', {
    authToken: botToken,
    body: { kind: 'json', value: {
      channel: channelId,
      ...(replyTs ? { thread_ts: replyTs } : {}),
      text: `Liftoff: ${agentName} is paused right now`,
    }},
  }).catch((err) => log.warn({ err: (err as Error).message, channelId }, 'paused notice post failed'));
}

/**
 * A bare "@Liftoff" inside a conversation that already belongs to someone.
 *
 * Opening with a mention and nothing else is how people start a conversation,
 * so the answer is a greeting, not a picker: choosing from the picker BINDS
 * (see interactivity-router), and an accidental mention must never offer to
 * rebind a thread somebody is working in. That is the same rule
 * switchIsAllowed applies to an explicit "switch", so the vaguer signal does
 * not end up with more power than the explicit one.
 *
 * Posted directly rather than run as a turn: there is no message to answer, so
 * a turn would reach the model with an empty string, and persist an empty user
 * message that replays as history forever after.
 */
async function postGreeting(
  botToken: string, channelId: string, replyTs: string | null, agentName: string,
): Promise<void> {
  await slackApiFetch('chat.postMessage', {
    authToken: botToken,
    body: { kind: 'json', value: {
      channel: channelId,
      ...(replyTs ? { thread_ts: replyTs } : {}),
      text: `Liftoff: ${agentName} here. What can I help with?`,
    }},
  }).catch((err) => log.warn({ err: (err as Error).message, channelId }, 'greeting post failed'));
}

/**
 * "Code Reviewer: take a look at PR 42" → that agent's id.
 *
 * Addressing someone by name is how people redirect a message in any group
 * conversation, so it works everywhere and costs nothing to discover. It
 * routes the single message; the conversation's own binding is untouched.
 */
async function resolveAddressedAgent(tenantId: string, text: string): Promise<string | null> {
  const m = text.match(/^\s*([^:,\n]{2,60})\s*[:,]\s*\S/);
  if (!m) return null;
  const agent = await findAgentByName(tenantId, m[1].trim()).catch(() => null);
  return agent?.agentId ?? null;
}

/** Drop a leading "Name:" / "Name," so the agent reads a clean message. */
function stripNamePrefix(text: string): string {
  return text.replace(/^\s*[^:,\n]{2,60}\s*[:,]\s*/, '');
}

async function postPicker(
  botToken: string,
  channelId: string,
  threadTs: string | undefined,
  ctx: PickerContext,
): Promise<void> {
  await slackApiFetch('chat.postMessage', {
    authToken: botToken,
    body: {
      kind: 'json',
      value: {
        channel: channelId,
        ...(threadTs ? { thread_ts: threadTs } : {}),
        text: 'Who would you like to talk to?',
        blocks: buildAgentPickerBlocks(ctx),
      },
    },
  }).catch((err) => log.warn({ err: (err as Error).message, channelId }, 'workspace picker post failed'));
}

/**
 * Slack-facing entry: verifies the signature, then routes.
 *
 * Only the LEGACY direct-to-PB wiring uses this. In the shipped topology the
 * app's one Events URL belongs to connector-service (it owns publishing to
 * connector-events for reactive subscriptions), and chat events arrive
 * pre-verified via handleVerifiedWorkspaceSlackEvent.
 */
export async function handleWorkspaceSlackEvent(opts: {
  rawBody: Buffer;
  body: Record<string, unknown>;
  timestamp: string | undefined;
  signature: string | undefined;
  res: Response;
}): Promise<void> {
  const { rawBody, body, timestamp, signature, res } = opts;
  if (!timestamp || !signature || !verifyWorkspaceSlackSignature(rawBody, timestamp, signature)) {
    log.warn({ apiAppId: body.api_app_id }, 'workspace Slack webhook: invalid signature');
    res.sendStatus(401);
    return;
  }
  await handleVerifiedWorkspaceSlackEvent({ body, res });
}

/**
 * Route an event whose Slack signature has ALREADY been verified upstream.
 *
 * connector-service owns the app's single Events URL (Slack allows exactly
 * one): it verifies the signature, dedups, publishes to connector-events for
 * reactive subscriptions, and forwards chat-relevant events here over
 * service auth. This handler therefore does NOT publish to connector-events —
 * doing so would double-fire every reactive subscription.
 */
export async function handleVerifiedWorkspaceSlackEvent(opts: {
  body: Record<string, unknown>;
  res: Response;
}): Promise<void> {
  // Express 4 does not catch async errors: a rejection here becomes an
  // unhandled rejection that takes the whole instance down, turning one bad
  // message into 503s for every concurrent request. Slack also retries any
  // non-200, so a thrown error would replay the failure. Contain both:
  // log it and ack.
  try {
    await routeWorkspaceSlackEvent(opts);
  } catch (err) {
    log.error(
      { err: (err as Error).message, teamId: opts.body.team_id },
      'workspace Slack event handling failed',
    );
    if (!opts.res.headersSent) opts.res.sendStatus(200);
  }
}

async function routeWorkspaceSlackEvent(opts: {
  body: Record<string, unknown>;
  res: Response;
}): Promise<void> {
  const { body, res } = opts;

  // 1. Resolve tenant from the workspace (team_id → slack_workspace_installs).
  const slackTeamId = (body as { team_id?: string }).team_id ?? '';
  const install = slackTeamId ? await findWorkspaceInstallByTeam(slackTeamId) : null;
  if (!install) {
    res.sendStatus(200); // Ack but ignore — workspace not connected.
    return;
  }

  // 2. Event guards — mirror the per-agent branch: ignore bot posts (our own
  //    customize-username messages carry bot_id), message edits, and anything
  //    without a human author + text.
  const event = (body as { event?: Record<string, unknown> }).event;
  // A voice memo arrives with files and NO text at all, so requiring text here
  // dropped it silently — the person spoke into Slack and got nothing back.
  const audioFile = event ? findAudioFile(event.files) : null;
  if (!event || event.bot_id || event.subtype === 'bot_message' || !event.user
      || (!event.text && !audioFile)) {
    res.sendStatus(200);
    return;
  }

  // 3. Dedup. connector-service dedups too; this also covers a retried
  //    forward, so a repeated delivery never double-answers.
  const eventId = (body as { event_id?: string }).event_id;
  if (eventId && (await isDuplicateSlackEvent(eventId))) {
    res.sendStatus(200);
    return;
  }

  // 4. In a CHANNEL, a message that @mentions the bot arrives twice — once as
  //    message.channels and once as app_mention, with different event_ids, so
  //    the dedup table cannot collapse the pair. Let the app_mention delivery
  //    own it.
  //
  //    DMs are exempt: Slack sends NO app_mention for a mention inside the
  //    app's own DM, so skipping there drops the message entirely and the
  //    person gets silence. Typing "@Liftoff" in the DM is a natural thing to
  //    do.
  const rawText = (event.text as string | undefined) ?? '';
  const isAppMention = event.type === 'app_mention';
  const scope = inferScope(event);
  if (
    scope !== 'dm'
    && !isAppMention
    && install.slackBotUserId
    && rawText.includes(`<@${install.slackBotUserId}>`)
  ) {
    res.sendStatus(200);
    return;
  }

  const botToken = await resolveWorkspaceBotToken(install);
  if (!botToken) {
    log.warn({ slackTeamId, installId: install.id }, 'workspace Slack event arrived but bot token could not be resolved');
    res.sendStatus(200);
    return;
  }

  const tenantId = install.tenantId;
  const channelId = event.channel as string;
  const eventTs = event.ts as string;
  const threadTs = typeof event.thread_ts === 'string' ? (event.thread_ts as string) : undefined;
  const slackUserId = event.user as string;

  // A spoken message becomes an ordinary one here, and nothing downstream can
  // tell the difference — same routing, same turn, same durability.
  let spokenText = '';
  // Held so the cost can be attributed to the agent this turns out to be for.
  // Billing at transcription time attributed every memo to no agent, and
  // classifyChargeability will not honour a customer purpose without one — so
  // every Slack memo was absorbed by Liftoff instead of charged.
  let memo: Awaited<ReturnType<typeof transcribeVoiceMemo>> = null;
  const memoSourceId = `slack:${slackTeamId}:${eventTs}`;
  if (audioFile) {
    const downloaded = await downloadSlackFile(audioFile, botToken);
    if (downloaded) {
      memo = await transcribeVoiceMemo({
        tenantId,
        surface: 'slack',
        audio: downloaded.audio,
        mimeType: downloaded.mimeType,
        sourceId: memoSourceId,
      });
      spokenText = memo?.transcript ?? '';
    }
    // Nothing heard — a silent recording, a missing scope, a vendor failure.
    // There is no message to answer, but listening was still billed, so the row
    // is written before we walk away.
    if (!spokenText && !rawText.trim()) {
      if (memo) {
        await recordMemoCost({ tenantId, surface: 'slack', agentId: undefined, memo, sourceId: memoSourceId });
      }
      res.sendStatus(200);
      return;
    }
  }

  const text = stripBotMentions([rawText, spokenText].filter(Boolean).join(' ').trim());

  // 5. Approve/reject on an escalation card. People reply to a card BOTH
  //    ways in Slack — inside its thread and (more often) straight into the
  //    DM below it — so both resolve the approval:
  //      - in-thread: the thread root identifies the card exactly.
  //      - top-level: only an explicit approve/reject verb is intercepted,
  //        and it applies to the most recent card in this DM. Anything else
  //        is ordinary chat and falls through untouched.
  //    Must complete synchronously before the ack (Cloud Run cpu-throttling).
  if (scope === 'dm') {
    const { handleReviewThreadReply, parseReplyIntent } = await import('./review-reply-handler');
    if (threadTs) {
      const handled = await handleReviewThreadReply({
        tenantId, slackTeamId, channelId, rootTs: threadTs,
        slackUserId, text: rawText, botToken,
      });
      if (handled) {
        res.sendStatus(200);
        return;
      }
    } else if (parseReplyIntent(text).kind !== 'unknown') {
      const card = await findLatestReviewCardInDm(tenantId, slackTeamId, channelId)
        .catch((err) => {
          log.warn({ err: (err as Error).message, channelId }, 'review card lookup failed');
          return null;
        });
      if (card) {
        const handled = await handleReviewThreadReply({
          tenantId, slackTeamId, channelId, rootTs: card.rootTs,
          slackUserId, text: rawText, botToken,
          // Answer where they typed, not inside a thread they never opened.
          ackThreadTs: null,
        });
        if (handled) {
          res.sendStatus(200);
          return;
        }
      }
    }
  }

  // 6. Who is this message for?
  //    a) an explicit name prefix ("Code Reviewer: take a look") addresses
  //       that agent for this message only, without changing the binding —
  //       the way you'd turn to a specific person in a group.
  //    b) otherwise the thread binding, then the channel/DM-level binding.
  //    c) and finally the workspace default, for a workspace that talks
  //       overwhelmingly to one team member and should not be asked to choose
  //       in every new conversation.
  const addressed = await resolveAddressedAgent(tenantId, text);
  const threadAgentId = threadTs
    ? (await getBinding(tenantId, slackTeamId, channelId, threadTs))?.agentId ?? null
    : null;
  const channelAgentId = threadAgentId
    ? null
    : (await getBinding(tenantId, slackTeamId, channelId, null))?.agentId ?? null;
  // Read last, and only when the rungs above it came up empty — this is the
  // fallback, and looking it up eagerly would put a query on every message.
  //
  //    Failing to read it falls through to the picker rather than dropping the
  //    message: the fallback exists to save people a click, and a fallback that
  //    can swallow a turn when its lookup fails costs far more than the click
  //    it saves.
  const workspaceDefaultAgentId = (addressed || threadAgentId || channelAgentId)
    ? null
    : await getWorkspaceDefaultAgent(tenantId, slackTeamId).catch((err) => {
      log.warn(
        { err: (err as Error).message, tenantId, slackTeamId },
        'workspace default lookup failed — falling back to the picker',
      );
      return null;
    });

  let routing = resolveConversationAgent({
    addressedAgentId: addressed,
    threadAgentId,
    channelAgentId,
    workspaceDefaultAgentId,
  });
  const threadBound = routing.threadBound;

  // 7. Channels answer only when addressed: an @mention, a name prefix, or a
  //    reply inside a thread the bot already owns. A bound channel does NOT
  //    turn the bot into a participant in every conversation there.
  if (scope !== 'dm' && !isAppMention && !addressed && !threadBound) {
    res.sendStatus(200);
    return;
  }

  // 7b. The suggested rung (Phase 9), lazily and last: only when the four
  //     rungs above came up empty, on a message the bot is allowed to answer
  //     (so an un-addressed message is never answered from it), with
  //     something to answer, and not on a switch — a switch asks for the
  //     picker by name. The roster is read now, not eagerly, so a bound
  //     message costs no query and no request. The team answers WITHOUT
  //     binding the conversation; on `none`, sub-threshold, a failed call or
  //     a roster over the cap the picker is posted as today.
  let suggestedProbability: number | null = null;
  if (!routing.agentId && text && !isSwitchCommand(text)) {
    const { suggestAnswerer } = await import('../route-suggestion');
    const { listRouteCandidates } = await import('../teams-adapter/repository');
    const { ROUTE_CANDIDATE_CAP } = await import('../../typesafe/questions');
    const candidates = await listRouteCandidates(tenantId, ROUTE_CANDIDATE_CAP).catch((err) => {
      log.warn({ err: (err as Error).message, tenantId }, 'route candidate roster read failed — falling back to the picker');
      return [];
    });
    const suggestion = await suggestAnswerer({
      tenantId,
      message: addressed ? stripNamePrefix(text) : text,
      channel: { kind: threadTs ? 'thread' : scope === 'dm' ? 'dm' : 'channel' },
      candidates,
      surface: 'slack',
    });
    if (suggestion) {
      routing = resolveConversationAgent({
        addressedAgentId: addressed,
        threadAgentId,
        channelAgentId,
        workspaceDefaultAgentId,
        suggestedAgentId: suggestion.agentId,
      });
      suggestedProbability = suggestion.probability;
    }
  }
  // The audit line for the turn: which rung answered, and the probability
  // when the suggested one did.
  log.info({
    event: 'slack_turn_routed',
    tenantId,
    slackTeamId,
    channelId,
    rung: routing.rung,
    ...(suggestedProbability !== null ? { probability: suggestedProbability } : {}),
  }, 'slack turn routed');

  // 8. Picker when nobody is chosen yet, or on an explicit switch. The
  //    triggering message rides along in the picker context so the agent can
  //    answer it once chosen: asking a question should never cost you the
  //    question. Posted before the ack (see header note).
  //    A switch is honoured from the workspace default too: that rung is not a
  //    choice anyone made about THIS conversation, so re-asking does not throw
  //    away a decision the way it would inside a bound thread.
  // Bill the transcription now that routing has decided whose message this was.
  // Placed BEFORE the picker branch so both outcomes bill exactly once: an
  // unrouted memo lands as platform overhead, which is right when there is
  // nobody to charge, and a routed one is charged to the agent it reached.
  if (memo) {
    await recordMemoCost({
      tenantId,
      surface: 'slack',
      agentId: routing.agentId ?? undefined,
      memo,
      sourceId: memoSourceId,
    });
    memo = null;
  }

  const wantsSwitch = switchIsAllowed(routing) && isSwitchCommand(text);
  // A mention with nothing after it. `text` is the STRIPPED message, which is
  // the only string that answers "is there anything here to reply to" — rawText
  // still holds "<@U123>" and is therefore truthy for exactly this case. Reading
  // the wrong one of the two is what sent an empty message to the runtime and
  // told the person we could not reach the agent.
  const nothingToAnswer = !text;
  // Nobody is chosen, an explicit switch, or a bare mention in a conversation
  // where no deliberate choice has been made yet. The last one asks rather than
  // guesses: a mention alone says someone wants to talk, not who to.
  if (!routing.agentId || wantsSwitch || (nothingToAnswer && switchIsAllowed(routing))) {
    if (scope === 'dm' || isAppMention) {
      await postPicker(botToken, channelId, scope === 'dm' ? threadTs : (threadTs ?? eventTs), {
        scope,
        channelId,
        threadRootTs: threadTs ?? '',
        // Nothing to answer for a bare mention or a switch command.
        pendingTs: !text || wantsSwitch ? '' : eventTs,
      });
    }
    res.sendStatus(200);
    return;
  }

  const agentId = routing.agentId!;
  const agent = await getAgentNameAndStatus(tenantId, agentId);
  if (!agent || agent.status === 'draft') {
    res.sendStatus(200); // Missing/deleted/draft agent — silently ignore.
    return;
  }
  if (agent.status === 'paused') {
    // Answer where they typed, so the reason is where they're looking.
    await postPausedNotice(
      botToken, channelId, replyPlacement(scope, threadTs, eventTs), agent.displayName,
    );
    res.sendStatus(200);
    return;
  }
  const agentName = agent.displayName;

  // A platform assistant answers in a direct message only. It is a
  // conversation with the person who asked, not a teammate a channel can be
  // bound to, so in a channel it says where to find it and runs nothing.
  if (isAssistantKind(agentId) && scope !== 'dm') {
    await postAssistantDmPointer(
      botToken, channelId, replyPlacement(scope, threadTs, eventTs), agentName,
    );
    res.sendStatus(200);
    return;
  }

  // 8b. A bare mention that got this far is inside a thread its owner already
  //     chose (switchIsAllowed sent every other rung to the picker above). Greet
  //     as that teammate. Placed AFTER the paused check so a paused teammate
  //     still reports paused rather than greeting and then never answering.
  if (nothingToAnswer) {
    await postGreeting(
      botToken, channelId, replyPlacement(scope, threadTs, eventTs), agentName,
    );
    res.sendStatus(200);
    return;
  }

  // 9. Enqueue the turn as a Cloud Task, THEN ack. The service runs
  //    cpu-throttled at minScale 0, so detached post-ack compute is neither
  //    CPU-guaranteed nor safe from instance reclaim — the worker runs the
  //    turn inside its own request instead. Enqueue failure → 500 so
  //    connector-service / Slack redeliver the event. No connector-events
  //    publish: connector-service already published this event when it
  //    received it, and publishing again would double-fire every reactive
  //    subscription.
  try {
    await enqueueChatTurn({
      dedupeId: `slack:${eventId ?? `${channelId}:${eventTs}`}`,
      tenantId,
      agentId,
      agentName,
      slackTeamId,
      slackUserId,
      channelId,
      scope,
      threadTs,
      eventTs,
      // An addressed message reaches the agent as plain content: the routing
      // prefix is envelope, not something to answer.
      //
      // A spoken message has no rawText at all, so the transcript is the message
      // — falling back to rawText here would send the agent an empty string.
      //
      // The test is whether rawText has anything left once its mentions are
      // stripped, NOT whether it is non-empty: "<@U123>" is truthy and
      // normalizes to nothing downstream, which is how an empty message reached
      // the runtime. It cannot read the joined `text` either — that already
      // contains the transcript, so a memo would take the rawText branch and
      // send the empty string this line exists to avoid.
      //
      // Also covers a memo posted WITH a mention ("<@UBOT>" + audio), which
      // reaches here with a transcript and used to enqueue the mention instead.
      text: addressed ? stripNamePrefix(text) : (stripBotMentions(rawText) ? rawText : spokenText),
      spokenInput: Boolean(spokenText),
    });
  } catch (err) {
    if (!isDuplicateTaskError(err)) {
      log.error(
        { error: (err as Error).message, channelId, tenantId },
        'slack chat enqueue failed',
      );
      res.sendStatus(500);
      return;
    }
  }
  res.sendStatus(200);
}

/**
 * Enqueue a message for the chat engine as a durable Cloud Task. The worker
 * runs the turn inside its own request; callers ack their surface only AFTER
 * a successful enqueue.
 *
 * Reply placement follows how people actually read each surface: a DM answer
 * is flat, because a one-to-one conversation has no noise to contain and
 * nobody threads their own DMs; a channel answer goes in a thread under the
 * message that summoned it, which is the Slack norm for bots.
 */
export async function enqueueChatTurn(input: {
  /** The message was spoken, so the reply should be spoken back. */
  spokenInput?: boolean;
  dedupeId: string;
  tenantId: string;
  agentId: string;
  agentName: string;
  slackTeamId: string;
  slackUserId: string;
  channelId: string;
  scope: Scope;
  threadTs: string | undefined;
  eventTs: string;
  text: string;
}): Promise<void> {
  const replyTs = replyPlacement(input.scope, input.threadTs, input.eventTs);
  const { enqueueChatTurnTask } = await import('../chat-turn-dispatch');
  // C1: derive the turn id from the SAME dedupe key the task is named after, so
  // every redelivery and every Cloud Tasks retry of this inbound message
  // addresses one turn. Derived rather than random precisely because it has to
  // survive a process that died before it could write anything down.
  const { turnIdForDedupeKey } = await import('../turn-id');
  const turnId = turnIdForDedupeKey(input.dedupeId);
  await enqueueChatTurnTask(input.dedupeId, {
    surface: 'slack',
    task: {
      turnId,
      tenantId: input.tenantId,
      agentId: input.agentId,
      slackAppId: getLiftoffSlackAppId() ?? '',
      slackTeamId: input.slackTeamId,
      slackUserId: input.slackUserId,
      slackChannelId: input.channelId,
      slackThreadTs: replyTs,
      // Reply in kind: they spoke, so the answer is spoken too.
      spokenInput: input.spokenInput === true,
      text: input.text,
      eventTs: input.eventTs,
      postAs: { username: input.agentName },
    },
  });
}
