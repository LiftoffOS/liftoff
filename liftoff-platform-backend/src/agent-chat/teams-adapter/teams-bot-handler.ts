// LiftoffTeamsBot — the single multi-tenant Teams bot's activity handler.
//
// Inbound flow: dedup the activity → resolve the Liftoff tenant from the Azure
// AD tenant id → resolve or bind the active agent (typeahead picker) → execution
// guard → dispatch to the chat worker and publish to connector-events. Adaptive
// Card Action.Submit payloads (picker selection, HITL approve/reject) arrive as
// message activities with `activity.value`; dynamic typeahead arrives as an
// `application/search` invoke.

import {
  TeamsActivityHandler,
  TurnContext,
  type Activity,
  type InvokeResponse,
} from 'botbuilder';
import { log } from '../../infrastructure/logging';
import { assistantByKind, isAssistantKind } from '../assistant-targets';
import { findTeamsAudio, downloadTeamsAudio } from './teams-files';
import { transcribeVoiceMemo, recordMemoCost } from '../../voice/chat-audio';
import { withTenantScope } from '../../infrastructure/database';
import { checkExecutionAllowed } from '../../billing/execution-guard';
import {
  approveApprovalForActor,
  rejectApprovalForActor,
} from '../../internal-agent-oversight/service-internal';
import {
  findTenantByAadTenant,
  getConversationAgent,
  bindConversationAgent,
  upsertConversationReference,
  isDuplicateActivity,
  searchAgents,
  getAgentNameAndStatus,
} from './repository';
import { resolveTeamsUser } from './identity-resolver';
import { buildAgentPickerCard, buildSearchResponse } from './cards';
import { updateAllReviewCards } from './review-card-notifier';

type ActivityValue = {
  action?: 'pick_agent' | 'switch' | 'review_approve' | 'review_reject';
  agentId?: string;
  reviewId?: string;
};

function scopeOf(activity: Partial<Activity>): 'personal' | 'channel' | 'groupChat' {
  const t = activity.conversation?.conversationType;
  if (t === 'channel') return 'channel';
  if (t === 'groupChat') return 'groupChat';
  return 'personal';
}

/** Strip the leading <at>Bot</at> mention from a Teams message. */
function stripMention(text: string | undefined): string {
  return (text ?? '').replace(/<at>.*?<\/at>/g, '').trim();
}

function isSwitchCommand(text: string): boolean {
  return /^(switch|talk to)\b/i.test(text.trim());
}

/** An inbound message could not be durably enqueued. Must propagate out of the
 *  activity handler so the Bot Framework response is non-2xx and Microsoft may
 *  redeliver — the generic onMessage catch swallows everything else. */
class ChatTurnEnqueueFailed extends Error {}

export class LiftoffTeamsBot extends TeamsActivityHandler {
  constructor() {
    super();

    this.onMessage(async (ctx, next) => {
      try {
        await this.handleMessage(ctx);
      } catch (err) {
        if (err instanceof ChatTurnEnqueueFailed) throw err;
        log.error({ err: (err as Error).message }, 'Teams onMessage failed');
      }
      await next();
    });

    this.onMembersAdded(async (ctx, next) => {
      try {
        const aadTenantId = ctx.activity.channelData?.tenant?.id as string | undefined;
        const tenantId = aadTenantId ? await findTenantByAadTenant(aadTenantId) : null;
        if (tenantId) {
          // STORE THE ADDRESS BEFORE USING IT.
          //
          // This handler proves the bot can reach the person — it posts a card
          // to them on the next line — and then used to throw the address away.
          // The reference was persisted only when a plain MESSAGE arrived, so a
          // user who installed the app and never typed had a live chat with the
          // bot and no stored conversation reference. Every proactive review
          // card to them reported "no teams conversation reference".
          //
          // That is precisely the state a PROACTIVE install leaves behind
          // (teams-app-service.proactiveInstallForUser), so the recovery path
          // for an unreachable assignee could never make them reachable: it
          // installed the app, Teams opened the chat, this handler answered in
          // it, and nothing was written down.
          //
          // No agent is bound: nobody has picked one yet, and the picker card
          // below is what asks. `agent_id` is nullable for exactly this state
          // (migration 377), and a null never clears an existing binding.
          await this.rememberConversation(ctx, tenantId, aadTenantId!);

          const agents = await searchAgents(tenantId, undefined, 15);
          await ctx.sendActivity({ attachments: [buildAgentPickerCard(agents)] });
        }
      } catch (err) {
        log.error({ err: (err as Error).message }, 'Teams onMembersAdded failed');
      }
      await next();
    });
  }

  /**
   * Persist the conversation reference for a 1:1 chat that has just come into
   * existence, with the person resolved but no agent bound.
   *
   * Best-effort by design: this runs on the install path, and failing to write
   * the address must not stop the picker card that tells the person the bot is
   * there. A miss costs reachability until their first message, which is the
   * behaviour this replaces — never worse than it was.
   */
  private async rememberConversation(
    ctx: TurnContext,
    tenantId: string,
    aadTenantId: string,
  ): Promise<void> {
    try {
      const activity = ctx.activity;
      // Only personal chats. A channel or group conversation is addressed by
      // its own id and is not a route to an individual.
      const scope = (activity.conversation?.conversationType ?? 'personal') as string;
      if (scope !== 'personal') return;

      const fromId = activity.from?.id;
      if (!fromId) return;
      const user = await resolveTeamsUser(ctx, fromId, activity.from?.name);

      await bindConversationAgent({
        tenantId,
        agentId: null,
        conversationId: activity.conversation.id,
        azureAdTenantId: aadTenantId,
        scope: 'personal',
        aadUserId: (activity.from?.aadObjectId as string | undefined) ?? null,
        accountId: user.accountId,
        conversationReference: TurnContext.getConversationReference(activity) as unknown as Record<string, unknown>,
      });

      log.info(
        { tenantId, conversationId: activity.conversation.id, resolvedAccount: Boolean(user.accountId) },
        'Teams personal conversation recorded at install',
      );
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'Teams conversation persist at install failed');
    }
  }

  private async handleMessage(ctx: TurnContext): Promise<void> {
    const activity = ctx.activity;

    // 1. Dedup.
    if (activity.id && (await isDuplicateActivity(activity.id))) return;

    // 2. Resolve Liftoff tenant from the Azure AD tenant id.
    const aadTenantId = activity.channelData?.tenant?.id as string | undefined;
    const tenantId = aadTenantId ? await findTenantByAadTenant(aadTenantId) : null;
    if (!tenantId || !aadTenantId) {
      await ctx.sendActivity('This workspace is not connected to Liftoff yet.');
      return;
    }

    const conversationId = activity.conversation.id;
    const ref = TurnContext.getConversationReference(activity);

    // 3. Adaptive Card Action.Submit payloads (picker / HITL).
    const value = activity.value as ActivityValue | undefined;
    if (value?.action) {
      await this.handleCardAction(ctx, tenantId, aadTenantId, value);
      return;
    }

    // 4. Plain message. Re-store the reference for proactive/streaming.
    await upsertConversationReference(tenantId, conversationId, ref as unknown as Record<string, unknown>);

    let text = stripMention(activity.text);
    const boundAgentId = await getConversationAgent(tenantId, conversationId);

    // A voice memo carries no text at all, so it would have fallen through the
    // picker branch below and been answered with "which teammate?" — or nothing.
    // Transcribed here, it becomes an ordinary message and the rest of this
    // handler cannot tell the difference.
    //
    // Teams answers in writing: it supports no audio card, and a spoken reply
    // would have to be written into the customer's own OneDrive to be sent at
    // all. Listening is the half that is worth having.
    const audio = findTeamsAudio(activity.attachments);
    if (audio && !text.trim()) {
      const downloaded = await downloadTeamsAudio(audio);
      const memoSourceId = `teams:${conversationId}:${activity.id ?? ''}`;
      const memo = downloaded
        ? await transcribeVoiceMemo({
            tenantId,
            surface: 'teams',
            audio: downloaded.audio,
            mimeType: downloaded.mimeType,
            sourceId: memoSourceId,
          })
        : null;
      // Teams binds its agent before the message arrives, so the cost can be
      // attributed straight away — and is billed even when nothing was heard,
      // because listening was charged either way.
      if (memo) {
        await recordMemoCost({
          tenantId,
          surface: 'teams',
          agentId: boundAgentId ?? undefined,
          memo,
          sourceId: memoSourceId,
        });
      }
      // Nothing heard — a silent clip, or a download we could not read. There is
      // no message to answer, and guessing at one would be worse than silence.
      if (!memo?.transcript) return;
      text = memo.transcript;
    }

    // 5. No bound agent, or an explicit switch → show the typeahead picker.
    //
    //    Before the picker, the suggested rung (Phase 9), mirrored from the
    //    Slack ladder: on an unbound message with something to answer that is
    //    not a switch, one selection request over the active roster names the
    //    team whose role the message plainly calls for, and that team answers
    //    WITHOUT binding the conversation. On `none`, sub-threshold, a failed
    //    call or a roster over the cap, the picker card as today. A switch
    //    asks for the picker by name and never consults it.
    let answeringAgentId = boundAgentId;
    let suggestedProbability: number | null = null;
    if (!answeringAgentId && text.trim() && !isSwitchCommand(text)) {
      const { suggestAnswerer } = await import('../route-suggestion');
      const { listRouteCandidates } = await import('./repository');
      const { ROUTE_CANDIDATE_CAP } = await import('../../typesafe/questions');
      const candidates = await listRouteCandidates(tenantId, ROUTE_CANDIDATE_CAP).catch((err) => {
        log.warn({ err: (err as Error).message, tenantId }, 'route candidate roster read failed — falling back to the picker');
        return [];
      });
      const suggestion = await suggestAnswerer({
        tenantId,
        message: text,
        channel: { kind: scopeOf(activity) === 'personal' ? 'dm' : 'channel' },
        candidates,
        surface: 'teams',
      });
      if (suggestion) {
        answeringAgentId = suggestion.agentId;
        suggestedProbability = suggestion.probability;
      }
    }
    log.info({
      event: 'teams_turn_routed',
      tenantId,
      conversationId,
      rung: boundAgentId ? 'conversation' : answeringAgentId ? 'suggested' : null,
      ...(suggestedProbability !== null ? { probability: suggestedProbability } : {}),
    }, 'teams turn routed');
    if (!answeringAgentId || isSwitchCommand(text)) {
      const agents = await searchAgents(tenantId, undefined, 15);
      await ctx.sendActivity({ attachments: [buildAgentPickerCard(agents)] });
      return;
    }

    // 6a. A paused teammate cannot answer. Liftoff says so itself rather than
    //     leaving the person waiting on silence; the binding stands, so they
    //     work again once resumed. Same wording as the Slack surface.
    const agent = await getAgentNameAndStatus(tenantId, answeringAgentId);
    if (agent?.status === 'paused') {
      await ctx.sendActivity(`Liftoff: ${agent.displayName} is paused right now`);
      return;
    }

    // A platform assistant answers in a personal chat only. It is a
    // conversation with the person who asked, not a teammate a channel can be
    // bound to, so anywhere else it says where to find it and runs nothing.
    if (isAssistantKind(answeringAgentId) && scopeOf(activity) !== 'personal') {
      await ctx.sendActivity(
        `${agent?.displayName ?? 'That assistant'}: I answer in a personal chat. Message me there and I will pick this up.`,
      );
      return;
    }

    // 6. Execution guard.
    const guard = await checkExecutionAllowed(tenantId);
    if (!guard.allowed) {
      await ctx.sendActivity(guard.reason ?? 'I am not available right now.');
      return;
    }

    // 7. Resolve who's talking from the roster (live turn context); identity
    //    needs the live TurnContext, which the queued worker no longer has.
    //    The worker's TeamsStreamer.begin() sends the single typing/informative
    //    ack (one indicator, no duplication).
    const resolvedUser = activity.from?.id
      ? await resolveTeamsUser(ctx, activity.from.id, activity.from?.name)
      : {
          userId: 'teams:unknown',
          accountId: null,
          displayName: activity.from?.name || 'there',
          // No from.id means nothing identifies this sender; an empty label is
          // honest and the persist boundary drops it.
          identityLabel: activity.from?.name?.trim() || '',
        };
    // The Bot Framework ack is this handler's HTTP response, so enqueueing
    // BEFORE returning is enqueue-before-ack: the durable Cloud Task worker
    // runs the turn inside its own request (this service is cpu-throttled at
    // minScale 0, so detached post-ack compute is neither CPU-guaranteed nor
    // safe from instance reclaim). A non-duplicate enqueue failure throws so
    // the adapter returns non-2xx and Microsoft may redeliver.
    try {
      const { enqueueChatTurnTask } = await import('../chat-turn-dispatch');
      // Dedupe key must be deterministic across redeliveries: the activity id
      // when present, else a stable digest of the message's identifying fields
      // (a wall-clock fallback would make every redelivery look new).
      const { createHash } = await import('crypto');
      const dedupeId = activity.id
        ? `teams:${activity.id}`
        : `teams:${createHash('sha256')
            .update(`${conversationId}|${activity.from?.id ?? ''}|${activity.timestamp ?? ''}|${text}`)
            .digest('hex').slice(0, 32)}`;
      // C1: stable turn id derived from the dedupe key — see the Slack path.
      const { turnIdForDedupeKey } = await import('../turn-id');
      await enqueueChatTurnTask(dedupeId, {
        surface: 'teams',
        task: {
          turnId: turnIdForDedupeKey(dedupeId),
          tenantId,
          agentId: answeringAgentId,
          conversationId,
          conversationReference: ref as unknown as Record<string, unknown>,
          scope: scopeOf(activity),
          resolvedUser,
          text,
        },
      });
    } catch (err) {
      const { isDuplicateTaskError } = await import('../chat-turn-dispatch');
      if (!isDuplicateTaskError(err)) {
        log.error(
          { err: (err as Error).message, tenantId, conversationId },
          'Teams chat enqueue failed',
        );
        throw new ChatTurnEnqueueFailed((err as Error).message);
      }
    }

    // 8. Publish the message to the reactive-subscription bus. Awaited: a
    // single Pub/Sub publish, and anything left detached here would run on
    // throttled CPU after the ack.
    await publishTeamsConnectorEvent({ tenantId, conversationId, aadTenantId, activity }).catch((err) =>
      log.warn({ err: (err as Error).message }, 'Teams→connector-events publish failed (non-fatal)'),
    );
  }

  // ── Card actions (Action.Submit) ──────────────────────────────────────────

  private async handleCardAction(
    ctx: TurnContext,
    tenantId: string,
    aadTenantId: string,
    value: ActivityValue,
  ): Promise<void> {
    const activity = ctx.activity;
    const conversationId = activity.conversation.id;

    if (value.action === 'switch') {
      const agents = await searchAgents(tenantId, undefined, 15);
      await ctx.sendActivity({ attachments: [buildAgentPickerCard(agents)] });
      return;
    }

    if (value.action === 'pick_agent' && value.agentId) {
      const aadUserId = (activity.from?.aadObjectId as string | undefined) ?? null;
      // Resolve the Liftoff account now (from the roster) so HITL review cards
      // can map an assignee accountId → this conversation later.
      const accountId = activity.from?.id
        ? (await resolveTeamsUser(ctx, activity.from.id, activity.from?.name)).accountId
        : null;
      const scope = scopeOf(activity);
      // A platform assistant is a conversation with a person, not a teammate
      // a channel can be bound to: picked outside a personal chat, it points
      // at the personal chat and binds nothing.
      if (isAssistantKind(value.agentId) && scope !== 'personal') {
        const name = assistantByKind(value.agentId)?.name ?? 'That assistant';
        await ctx.sendActivity(
          `${name} answers in a personal chat. Message ${name} there and they will pick this up.\n\n`
          + 'To choose an agent for this channel, say `switch`.',
        );
        return;
      }
      await bindConversationAgent({
        tenantId,
        agentId: value.agentId,
        conversationId,
        azureAdTenantId: aadTenantId,
        scope,
        aadUserId,
        accountId,
        teamId: (activity.channelData?.team?.id as string | undefined) ?? null,
        channelId: (activity.channelData?.channel?.id as string | undefined) ?? null,
        conversationReference: TurnContext.getConversationReference(activity) as unknown as Record<string, unknown>,
      });
      // Same wording as the Slack picker confirmation, and for the same
      // reasons: this message replaces the picker, so it is the only place
      // that can say how to get it back. A channel or group chat is read
      // mostly by people who picked nothing, so that wording drops "you"
      // and says outright that anyone can use it. Teams delivers a channel
      // message to the bot only when it is mentioned, so switching there
      // needs the mention too. Double newline: Teams markdown collapses a
      // single one.
      const agent = await getAgentNameAndStatus(tenantId, value.agentId).catch(() => null);
      const who = agent?.displayName ?? 'your agent';
      await ctx.sendActivity(
        scope === 'personal'
          ? `You are now talking to ${who}. Send a message here anytime.\n\n`
            + 'To talk to someone else, say `switch`.'
          : `${who} is now the agent for this ${scope === 'channel' ? 'channel' : 'chat'}. `
            + 'Anyone here can mention @Liftoff to reach them.\n\n'
            + 'To talk to another agent, say `@Liftoff switch`.',
      );
      return;
    }

    if (value.action === 'review_approve' || value.action === 'review_reject') {
      await this.handleReviewAction(ctx, tenantId, value);
      return;
    }
  }

  /**
   * HITL approve/reject. Resolves the Teams actor → Liftoff account + tenant
   * role, then delegates to the channel-agnostic oversight core (the same core
   * the Slack interactivity path uses via approveApprovalAsService).
   */
  private async handleReviewAction(
    ctx: TurnContext,
    tenantId: string,
    value: ActivityValue,
  ): Promise<void> {
    const reviewId = value.reviewId;
    if (!reviewId) return;

    const fromId = ctx.activity.from?.id as string | undefined;
    if (!fromId) {
      await ctx.sendActivity('Could not verify who you are.');
      return;
    }

    const resolved = await resolveTeamsUser(ctx, fromId, ctx.activity.from?.name);
    if (!resolved.accountId) {
      await ctx.sendActivity('You need a Liftoff account to approve or reject.');
      return;
    }

    const accountId = resolved.accountId;
    const role = await withTenantScope(tenantId, async (c) => {
      const res = await c.query<{ role: string }>(
        'SELECT role FROM tenant_members WHERE tenant_id = $1 AND account_id = $2',
        [tenantId, accountId],
      );
      return res.rows[0]?.role;
    });
    if (!role) {
      await ctx.sendActivity('You are not a member of this workspace.');
      return;
    }

    try {
      const decision = value.action === 'review_approve' ? 'approve' : 'reject';
      if (decision === 'approve') {
        await approveApprovalForActor({ tenantId, approvalId: reviewId, accountId, role, alwaysApply: false, operation: 'teams_approve' });
      } else {
        await rejectApprovalForActor({ tenantId, approvalId: reviewId, accountId, role, alwaysApply: false, operation: 'teams_reject' });
      }
      // Replace every posted review card (this actor's + all siblings) with a
      // resolved, action-less card so the request can't be actioned twice.
      const agentId = await getConversationAgent(tenantId, ctx.activity.conversation.id);
      if (agentId) {
        const footer = `${decision === 'approve' ? '✓ Approved' : '✕ Rejected'} by ${resolved.displayName}.`;
        await updateAllReviewCards(tenantId, reviewId, agentId, footer);
      }
      await ctx.sendActivity(decision === 'approve' ? 'Approved.' : 'Rejected.');
    } catch (err) {
      log.error({ reviewId, err: (err as Error).message }, 'Teams HITL action failed');
      await ctx.sendActivity('You do not have permission, or something went wrong. Check Liftoff for status.');
    }
  }

  // ── Dynamic typeahead (application/search) ────────────────────────────────

  protected async onInvokeActivity(ctx: TurnContext): Promise<InvokeResponse> {
    if (ctx.activity.name === 'application/search') {
      const aadTenantId = ctx.activity.channelData?.tenant?.id as string | undefined;
      const tenantId = aadTenantId ? await findTenantByAadTenant(aadTenantId) : null;
      const queryText = (ctx.activity.value as { queryText?: string } | undefined)?.queryText;
      const results = tenantId ? await searchAgents(tenantId, queryText, 15) : [];
      return buildSearchResponse(results) as InvokeResponse;
    }
    return super.onInvokeActivity(ctx);
  }
}

// ── connector-events publish ─────────────────────────────────────────────────

async function publishTeamsConnectorEvent(input: {
  tenantId: string;
  conversationId: string;
  aadTenantId: string;
  activity: Partial<Activity>;
}): Promise<void> {
  const { PubSub } = await import('@google-cloud/pubsub');
  const crypto = await import('crypto');
  const env = process.env.ENVIRONMENT ?? process.env.ENV ?? 'dev';
  const topic = new PubSub().topic(`connector-events-${env}`);
  const occurredAt = new Date().toISOString();
  await topic.publishMessage({
    data: Buffer.from(
      JSON.stringify({
        eventId: input.activity.id ?? `${input.conversationId}:${occurredAt}`,
        eventUUID: crypto.randomUUID(),
        tenantId: input.tenantId,
        connectorId: input.conversationId,
        entityType: 'Message',
        entityId: input.activity.id ?? '',
        eventType: 'connector.record.synced',
        occurredAt,
        payload: { source: 'microsoft_teams', data: input.activity },
      }),
    ),
    attributes: {
      tenantId: input.tenantId,
      entityType: 'Message',
      source: 'microsoft_teams',
      eventType: 'connector.record.synced',
      delivery: 'push',
      azure_ad_tenant_id: input.aadTenantId,
    },
  });
}

export const liftoffTeamsBot = new LiftoffTeamsBot();

