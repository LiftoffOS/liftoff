// Telling somebody a platform chat answered them while they were away.
//
// Agent chat got this in out-of-turn-delivery.ts and the other three surfaces
// did not, which made the feature look finished while being unable to fire for
// most of the places it was offered: the frontend asks for notification
// permission on Liftoff, Insights and the team plan too, so somebody could
// grant it there and never receive anything from the surface that asked.
//
// Separate from the agent-chat helper rather than shared with it because almost
// nothing is actually common. Agent chat has a channel column (a thread can be
// Slack), an agent id, and an agent display name to put in the title; none of
// the three here has any of that. What IS common — the opaque link, the
// presence check, never throwing — is small enough to state twice and clearer
// than a helper parameterised into meaninglessness.

import { log } from '../infrastructure/logging';
import { frontendUrl } from '../infrastructure/frontend-url';
import { findOrCreateLink } from '../notification-links';
import { isAccountPresent } from '../common/chat-presence-repository';
import { enqueueNotification } from './service';
import { assistantByKind, type AssistantKind } from '../agent-chat/assistant-targets';
import { pushAssistantOutOfTurnMessage } from '../agent-chat/assistant-out-of-turn';
import type { ActorVia } from '../workspace-actions/actor';

/** The three chat surfaces that are not agent chat. */
export type PlatformChatSurface = 'liftoff' | 'insights' | 'team_plan';

// The name the person sees as the sender.
// The name every surface uses for the colleague — the roster a coding tool
// sees, the name a Slack DM addresses, the sender of this notice — so a
// person reads one name for one colleague wherever the answer reaches them.
const KIND: Record<PlatformChatSurface, AssistantKind> = { liftoff: 'liftoff', insights: 'insights', team_plan: 'caio' };
const SPEAKER: Record<PlatformChatSurface, string> = {
  liftoff: assistantByKind('liftoff')!.name,
  insights: assistantByKind('insights')!.name,
  team_plan: assistantByKind('caio')!.name,
};

/**
 * Tell the person who asked that their answer landed while they were away.
 *
 * Best-effort and never throws: the reply is already committed when this runs,
 * so nothing here can cost somebody their message.
 *
 * Notifies whoever ASKED, not whoever created the thread. All three surfaces
 * are workspace-wide — any member can open any thread — so the two are often
 * different people, and the one waiting for the answer is the asker.
 *
 * Presence is read here for Liftoff and Insights, whose seats live in this
 * database. `team_plan` seats live in workforce-service (migration 131 moved
 * its tables there), so that caller checks presence itself before calling.
 */
export async function notifyPlatformChatReply(params: {
  tenantId: string;
  surface: PlatformChatSurface;
  threadId: string;
  text: string;
  /** Who asked. Every caller has it in scope from the turn it is completing. */
  accountId: string;
  /** Where the turn came through, when not the dashboard. An answer goes
   *  back where the question came from, as a team's does: a turn that came
   *  through a chat workspace is answered there by the surface that ran it,
   *  and a turn from the dashboard or a coding tool is answered in its thread
   *  with this notice. A person's Slack or Teams never hears about a question
   *  they did not ask there. Null for a message written between turns; the
   *  thread's own binding then decides. */
  via?: ActorVia | null;
}): Promise<void> {
  const { tenantId, surface, threadId, text, accountId } = params;
  if (params.via === 'slack' || params.via === 'teams') return;
  try {
    // A thread that lives in a chat workspace hears the message there and
    // nowhere else, as a team's Slack thread does: the person asked in that
    // DM, and a message written between turns (a plan finishing minutes after
    // they said yes) is answered where they asked. A turn that came from
    // there never reaches this line; this is the out-of-turn case.
    const chat = await pushAssistantOutOfTurnMessage({ tenantId, kind: KIND[surface], threadId, text });
    if (chat.channel !== null) {
      log.info(
        { tenantId, surface, threadId, accountId, channel: chat.channel, pushed: chat.pushed, metric: 'chat.reply_notified' },
        'platform chat message delivered to the thread\'s chat workspace',
      );
      return;
    }

    // Watching the message arrive is the same as having been told.
    if (surface !== 'team_plan' && (await isAccountPresent(surface, tenantId, threadId, accountId))) {
      return;
    }

    // Opaque link, never the ids. Same rule as every other notification
    // destination: the URL is the only public artifact.
    const linkId = await findOrCreateLink({
      tenantId,
      destination: 'chat',
      surface,
      agentId: null,
      threadId,
      recordId: null,
    });

    const eventLink = `${frontendUrl()}/notification/${linkId}`;
    const result = await enqueueNotification({
      accountId,
      tenantId,
      type: 'task_update',
      payload: {
        internalAgentName: SPEAKER[surface],
        eventTitle: SPEAKER[surface],
        eventSummary: text,
        eventLink,
        // The push builder's collapse key, so several replies in one thread
        // land as one notification rather than a stack.
        threadId,
      },
    });

    // The account's own rules can still stop this — the kill switch, task
    // updates turned off, browser delivery off — and every one of them looks
    // identical from the outside: the person granted permission and nothing
    // arrives. Recording which rule applied is the difference between a
    // diagnosis and a guess.
    log.info(
      {
        tenantId,
        surface,
        threadId,
        accountId,
        pushedDevices: result.pushedDevices,
        suppressed: result.suppressed ?? null,
        metric: 'chat.reply_notified',
      },
      'platform chat reply notification enqueued',
    );
  } catch (err) {
    log.warn(
      { tenantId, surface, threadId, error: (err as Error).message },
      'platform chat reply notification failed',
    );
  }
}

