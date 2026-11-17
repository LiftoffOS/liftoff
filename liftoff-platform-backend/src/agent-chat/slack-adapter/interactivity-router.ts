import { Router, Request, Response } from 'express';
import { log } from '../../infrastructure/logging';
import { slackApiFetch } from './slack-api';
import { resolveWorkspaceBotToken } from './bot-token-service';
import { chatUpdateAllSiblingCards, reviewDashboardUrl } from './review-dm-notifier';
import { tenantRuntimeClient } from '../../connectors/tenant-runtime-client';
import {
  approveApprovalAsService,
  rejectApprovalAsService,
} from '../../internal-agent-oversight/service-internal';
import { isWorkspaceAppEvent } from './workspace-app';
import { verifyWorkspaceSlackSignature } from './webhook-router';
import { findWorkspaceInstallByTeam, bindAgent, getAgentNameAndStatus } from './workspace-repository';
import { searchAgents } from '../teams-adapter/repository';
import { assistantByKind, isAssistantKind } from '../assistant-targets';
import { PICK_AGENT_ACTION_ID, buildPickerOptions, decodePickerContext } from './workspace-cards';

export const slackInteractivityRouter = Router();

/**
 * Everything the action handlers need, independent of WHICH Slack app the
 * payload came from: the per-agent apps resolve a per-install bot token,
 * the workspace app (ADR-040) resolves the tenant-level workspace token.
 */
interface InteractivityCtx {
  tenantId: string;
  getBotToken: () => Promise<string | null>;
}

interface BlockActionsPayload {
  type: 'block_actions';
  api_app_id: string;
  team: { id: string };
  user: { id: string };
  trigger_id: string;
  channel: { id: string };
  message: { ts: string };
  // Slack-issued one-shot URL valid for 30 min / 5 posts. We use it to give
  // instant visual feedback ("Processing…") before the real work runs —
  // chat.update would also work but only with the SAME bot's token, and
  // response_url is Slack-side so it bypasses bot-identity ambiguity.
  response_url: string;
  actions: Array<{
    action_id: string;
    block_id?: string;
    value: string;
    // external_select selections (the workspace app's agent picker) carry
    // the choice here instead of in `value`.
    selected_option?: { value: string };
  }>;
}

// Slack POSTs this while a user types into an external_select — the response
// body (not an ack) is the option list. Only the workspace app uses it.
interface BlockSuggestionPayload {
  type: 'block_suggestion';
  api_app_id: string;
  team: { id: string };
  action_id: string;
  block_id: string;
  value: string;
}

async function postResponseUrl(url: string, body: Record<string, unknown>): Promise<void> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) {
      log.warn({ status: res.status }, 'response_url POST returned non-2xx');
    }
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'response_url POST failed');
  }
}

interface ViewSubmissionPayload {
  type: 'view_submission';
  api_app_id: string;
  team: { id: string };
  user: { id: string };
  view: {
    callback_id: string;
    private_metadata: string;
    state: {
      values: {
        reason_block?: { reason_input?: { value?: string | null } };
        always_apply_block?: {
          always_apply_input?: { selected_options?: Array<{ value: string }> };
        };
      };
    };
  };
}

type Payload = BlockActionsPayload | ViewSubmissionPayload | BlockSuggestionPayload;

slackInteractivityRouter.post('/', async (req: Request, res: Response) => {
  const rawBody = req.body as Buffer;
  const params = new URLSearchParams(rawBody.toString('utf8'));
  const payloadStr = params.get('payload');
  if (!payloadStr) { res.sendStatus(400); return; }

  let payload: Payload;
  try { payload = JSON.parse(payloadStr) as Payload; }
  catch { res.sendStatus(400); return; }

  const apiAppId = payload.api_app_id;
  const slackTeamId = payload.team.id;
  if (!apiAppId || !slackTeamId) { res.sendStatus(400); return; }

  const ts = req.headers['x-slack-request-timestamp'] as string | undefined;
  const sig = req.headers['x-slack-signature'] as string | undefined;

  // Workspace-app fork (ADR-040): env-held signing secret + tenant-level
  // workspace token; the picker's block_suggestion/selection only exists on
  // this branch. Review approve/reject flow into the same handlers below.
  if (isWorkspaceAppEvent(apiAppId)) {
    if (!ts || !sig || !verifyWorkspaceSlackSignature(rawBody, ts, sig)) {
      res.sendStatus(401);
      return;
    }
    const install = await findWorkspaceInstallByTeam(slackTeamId);
    if (!install) { res.sendStatus(200); return; }
    const ctx: InteractivityCtx = {
      tenantId: install.tenantId,
      getBotToken: () => resolveWorkspaceBotToken(install),
    };

    if (payload.type === 'block_suggestion') {
      return handlePickerOptions(res, payload, ctx);
    }
    if (payload.type === 'block_actions') {
      const action = payload.actions[0];
      if (action?.action_id === PICK_AGENT_ACTION_ID) {
        return handlePickAgent(res, payload, ctx, slackTeamId);
      }
      return handleBlockActions(res, payload, ctx, slackTeamId);
    }
    if (payload.type === 'view_submission') {
      return handleViewSubmission(res, payload, ctx, slackTeamId);
    }
    res.sendStatus(200);
    return;
  }

  // Not the Liftoff app: per-agent apps are gone (ADR-040).
  res.sendStatus(200);
});

/** Read back a single message's text by ts (the question held for the picker). */
async function fetchMessageText(
  botToken: string, channelId: string, ts: string,
): Promise<string | null> {
  try {
    const res = await slackApiFetch('conversations.history', {
      authToken: botToken,
      body: { kind: 'form', value: { channel: channelId, latest: ts, oldest: ts, inclusive: 'true', limit: '1' } },
    });
    const msg = (res.messages as Array<{ text?: string; ts?: string }> | undefined)?.[0];
    return msg?.ts === ts && msg.text ? msg.text : null;
  } catch (err) {
    log.warn({ err: (err as Error).message, channelId, ts }, 'pending message fetch failed');
    return null;
  }
}

// ── Workspace-app agent picker ────────────────────────────────────────────────

/** external_select options load — live agent search, any roster size. */
async function handlePickerOptions(
  res: Response, payload: BlockSuggestionPayload, ctx: InteractivityCtx,
): Promise<void> {
  if (payload.action_id !== PICK_AGENT_ACTION_ID) {
    res.json({ options: [] });
    return;
  }
  try {
    const agents = await searchAgents(ctx.tenantId, payload.value, 15);
    res.json(buildPickerOptions(agents));
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'picker options load failed');
    res.json({ options: [] });
  }
}

/** Picker selection → bind the encoded (channel, thread) context to the agent. */
async function handlePickAgent(
  res: Response, payload: BlockActionsPayload, ctx: InteractivityCtx, slackTeamId: string,
): Promise<void> {
  const action = payload.actions[0];
  const agentId = action?.selected_option?.value;
  const pickerCtx = action?.block_id ? decodePickerContext(action.block_id) : null;
  if (!agentId || !pickerCtx) { res.sendStatus(200); return; }

  // A platform assistant is a conversation with a person, not a teammate a
  // channel can be bound to: picked in a channel, it points at the DM and
  // binds nothing, so the channel stays free for a team.
  if (isAssistantKind(agentId) && pickerCtx.scope !== 'dm') {
    const name = assistantByKind(agentId)?.name ?? 'That assistant';
    await postResponseUrl(payload.response_url, {
      replace_original: true,
      text: `${name} answers in a direct message. Message ${name} there and they will pick this up.\n`
        + `To choose an agent for this channel, say \`@Liftoff switch\`.`,
    });
    res.sendStatus(200);
    return;
  }

  try {
    await bindAgent({
      tenantId: ctx.tenantId,
      agentId,
      slackTeamId,
      channelId: pickerCtx.channelId,
      threadRootTs: pickerCtx.threadRootTs || null,
      scope: pickerCtx.scope,
      slackUserId: pickerCtx.scope === 'dm' ? payload.user.id : null,
    });

    // Public channel: self-join (channels:join) so message.channels events for
    // the newly-bound channel actually reach us. Best-effort — private
    // channels need a human /invite regardless.
    if (pickerCtx.scope === 'channel') {
      const token = await ctx.getBotToken();
      if (token) {
        await slackApiFetch('conversations.join', {
          authToken: token,
          body: { kind: 'json', value: { channel: pickerCtx.channelId } },
        }).catch((err) => log.warn({ err: (err as Error).message }, 'conversations.join failed'));
      }
    }

    const agent = await getAgentNameAndStatus(ctx.tenantId, agentId).catch(() => null);
    const who = agent?.displayName ?? 'your agent';
    await postResponseUrl(payload.response_url, {
      replace_original: true,
      // This message replaces the picker, so it is the only place that can
      // say how to get the picker back. Point at switch and nothing else:
      // it reopens the picker, which is what actually shows who is available.
      // The Name: prefix still works but is not taught here — it is only
      // usable by someone who already knows the roster.
      //
      // The channel wording is not the DM wording with a mention bolted on.
      // A channel post is public and permanent, read mostly by people who
      // did not choose anything, so it drops "you" and says outright that
      // anyone can use it. In a channel the mention is required, because
      // channels only answer when addressed.
      text: pickerCtx.scope === 'dm'
        ? `You are now talking to ${who}. Send a message here anytime.\n`
          + `To talk to someone else, say \`switch\`.`
        : `${who} is now the agent for this channel. `
          + `Anyone here can mention @Liftoff to reach them.\n`
          + `To talk to another agent, say \`@Liftoff switch\`.`,
    });

    // A paused teammate cannot answer. Say so rather than dispatching into
    // silence — the binding still stands, so they work once resumed.
    if (agent?.status === 'paused') {
      const token = await ctx.getBotToken();
      if (token) {
        const { postPausedNotice } = await import('./workspace-event-handler');
        await postPausedNotice(
          token, pickerCtx.channelId,
          pickerCtx.scope === 'dm' ? (pickerCtx.threadRootTs || null) : (pickerCtx.threadRootTs || pickerCtx.pendingTs || null),
          agent.displayName,
        );
      }
      res.sendStatus(200);
      return;
    }

    // The question that opened the picker still deserves an answer. Fetch it
    // and hand it to the agent just chosen, so nobody has to ask twice.
    if (pickerCtx.pendingTs && agent) {
      const token = await ctx.getBotToken();
      const pendingText = token
        ? await fetchMessageText(token, pickerCtx.channelId, pickerCtx.pendingTs)
        : null;
      if (pendingText) {
        const { enqueueChatTurn } = await import('./workspace-event-handler');
        const { isDuplicateTaskError } = await import('../chat-turn-dispatch');
        try {
          await enqueueChatTurn({
            dedupeId: `slack:picker:${pickerCtx.channelId}:${pickerCtx.pendingTs}`,
            tenantId: ctx.tenantId,
            agentId,
            agentName: agent.displayName,
            slackTeamId,
            slackUserId: payload.user.id,
            channelId: pickerCtx.channelId,
            scope: pickerCtx.scope,
            threadTs: pickerCtx.threadRootTs || undefined,
            eventTs: pickerCtx.pendingTs,
            text: pendingText,
          });
        } catch (err) {
          if (!isDuplicateTaskError(err)) throw err;
        }
      }
    }
  } catch (err) {
    log.error({ agentId, err: (err as Error).message }, 'agent picker bind failed');
    await postResponseUrl(payload.response_url, {
      replace_original: true,
      text: '⚠️ Something went wrong. Please try again.',
    });
  }
  res.sendStatus(200);
}

async function handleBlockActions(
  res: Response, payload: BlockActionsPayload, ctx: InteractivityCtx, slackTeamId: string,
): Promise<void> {
  const action = payload.actions[0];
  if (!action) { res.sendStatus(200); return; }

  if (action.action_id === 'review_approve') {
    const reviewId = action.value;
    // Instant visual feedback via response_url (Slack-side, ~100ms) — the
    // approval + chat.update work below takes ~1s and the originating card
    // would otherwise look frozen.
    await postResponseUrl(payload.response_url, {
      replace_original: true,
      text: 'Processing your decision…',
      blocks: [{
        type: 'context',
        elements: [{ type: 'mrkdwn', text: '⏳ Processing your decision…' }],
      }],
    });
    // Do the real work BEFORE the 200. Cloud Run cpu-throttling=true would
    // starve anything queued via setImmediate after res.sendStatus.
    try {
      const result = await approveApprovalAsService({
        tenantId: ctx.tenantId, approvalId: reviewId,
        slackTeamId, slackUserId: payload.user.id, alwaysApply: false,
      });
      const footer = result.alreadyActioned
        ? `⚠️ This request has already been handled.`
        : `:white_check_mark: *Approved* by <@${payload.user.id}>`;
      // chatUpdateAllSiblingCards uses agent_id from review_slack_messages
      // (migration 247) to pick the same bot that posted each card — so the
      // originating card AND any sibling DMs update correctly.
      await chatUpdateAllSiblingCards({ reviewId, tenantId: ctx.tenantId, footer });
    } catch (err) {
      log.error({ reviewId, err: (err as Error).message }, 'approve via slack button failed');
      // Replace "Processing…" with a clear failure footer (deep-linked
      // straight to this approval) so the user isn't stuck staring at a
      // spinner. Only "Liftoff Dashboard" is the linked text.
      const failureText = `⚠️ Something went wrong. Please review in <${reviewDashboardUrl(reviewId)}|Liftoff Dashboard>.`;
      await postResponseUrl(payload.response_url, {
        replace_original: true,
        text: failureText,
        blocks: [{
          type: 'context',
          elements: [{ type: 'mrkdwn', text: failureText }],
        }],
      });
    }
    res.sendStatus(200);
    return;
  }

  if (action.action_id === 'review_open_reject_modal') {
    const reviewId = action.value;
    const botToken = await ctx.getBotToken();
    if (!botToken) { res.sendStatus(200); return; }

    // Hide the "always apply" affordance for high-risk gate reasons (the backend ignores
    // alwaysApply for those regardless). Fail-open to showing it — the backend is the guard.
    const approval = await tenantRuntimeClient.getApproval(ctx.tenantId, reviewId).catch(() => null);
    const allowStanding = standingApprovalAllowed(approval?.reason);

    await slackApiFetch('views.open', {
      authToken: botToken,
      body: { kind: 'json', value: {
        trigger_id: payload.trigger_id,
        view: buildRejectModalView(reviewId, allowStanding),
      }},
    }).catch((err) => log.warn({ reviewId, err: (err as Error).message }, 'views.open failed'));

    res.sendStatus(200);
    return;
  }

  res.sendStatus(200);
}

// Gate reasons too high-risk to offer a standing "always apply" decision. Mirror of
// tenant-runtime's standingApprovalAllowed (the backend enforces it authoritatively; this
// only hides the affordance so the operator isn't misled into thinking a blanket policy
// was set when the backend would ignore it).
const STANDING_APPROVAL_SUPPRESSED = new Set(['super_destructive_gate', 'merge_to_main', 'sensitive_work']);
function standingApprovalAllowed(reason: string | undefined): boolean {
  return !reason || !STANDING_APPROVAL_SUPPRESSED.has(reason);
}

function buildRejectModalView(reviewId: string, allowStanding: boolean): unknown {
  const blocks: unknown[] = [
    { type: 'input', block_id: 'reason_block', optional: true,
      label: { type: 'plain_text', text: 'Rejection reason (Optional)' },
      element: { type: 'plain_text_input', action_id: 'reason_input',
                 multiline: true, max_length: 2048,
                 placeholder: { type: 'plain_text',
                                text: 'Explain why this request is being rejected...' }}},
  ];
  if (allowStanding) {
    blocks.push({ type: 'input', block_id: 'always_apply_block', optional: true,
      label: { type: 'plain_text', text: ' ' },
      element: { type: 'checkboxes', action_id: 'always_apply_input',
                 options: [{
                   text: { type: 'plain_text',
                           text: 'Always apply this decision for similar requests from this agent' },
                   value: 'always_apply',
                 }]}});
  }
  return {
    type: 'modal',
    callback_id: 'review_submit_reject_modal',
    private_metadata: reviewId,
    title:  { type: 'plain_text', text: 'Reject message' },
    submit: { type: 'plain_text', text: 'Reject' },
    close:  { type: 'plain_text', text: 'Cancel' },
    blocks,
  };
}

async function handleViewSubmission(
  res: Response, payload: ViewSubmissionPayload, ctx: InteractivityCtx, slackTeamId: string,
): Promise<void> {
  if (payload.view.callback_id !== 'review_submit_reject_modal') { res.sendStatus(200); return; }

  const reviewId = payload.view.private_metadata;
  const reason = payload.view.state.values.reason_block?.reason_input?.value?.trim() || undefined;
  const alwaysApply =
    (payload.view.state.values.always_apply_block?.always_apply_input?.selected_options?.length ?? 0) > 0;

  let result;
  try {
    result = await rejectApprovalAsService({
      tenantId: ctx.tenantId, approvalId: reviewId,
      slackTeamId, slackUserId: payload.user.id,
      reason, alwaysApply,
    });
  } catch (err) {
    log.error({ reviewId, err: (err as Error).message }, 'reject via slack modal failed');
    // Modal error fields are plain text — Slack does not render mrkdwn or
    // links inside `errors`. Direct users to the Dashboard in plain prose.
    res.json({
      response_action: 'errors',
      errors: { reason_block: 'Something went wrong. Please visit Liftoff Dashboard for the latest status.' },
    });
    return;
  }

  // chat.update sibling cards BEFORE responding. Cloud Run cpu-throttling
  // starves any setImmediate work after res.json. Slack's 3s budget covers it.
  if (result.alreadyActioned) {
    await chatUpdateAllSiblingCards({
      reviewId, tenantId: ctx.tenantId,
      footer: `⚠️ This request has already been handled.`,
    }).catch((err) => log.warn({ reviewId, err: (err as Error).message }, 'chatUpdate after already-handled failed'));
    res.json({
      response_action: 'errors',
      errors: { reason_block: 'This request has already been handled. Please visit Liftoff Dashboard for the latest status.' },
    });
    return;
  }

  const reasonSuffix = reason ? ` — ${reason.length > 80 ? reason.slice(0, 80) + '…' : reason}` : '';
  const applySuffix = alwaysApply ? ' (applied to future requests)' : '';
  await chatUpdateAllSiblingCards({
    reviewId, tenantId: ctx.tenantId,
    footer: `:no_entry: *Rejected* by <@${payload.user.id}>${reasonSuffix}${applySuffix}`,
  }).catch((err) => log.warn({ reviewId, err: (err as Error).message }, 'chatUpdate after reject failed'));
  res.json({ response_action: 'clear' });
}

export { slackInteractivityRouter as slackInteractivityRouterExport };
