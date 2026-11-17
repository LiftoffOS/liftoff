// bring_in_colleague: a team brings one of the three platform assistants in.
//
// A team cannot change its own configuration, cannot see the workspace's
// records, and must not guess. The Chief AI Officer changes teams; the
// Insights Manager answers from the workspace's data; Liftoff answers
// everything else. This handler hands the ask to the platform's colleague
// rail (POST /api/internal/agent-chat/colleague-request), and what happens
// next depends on who and where:
//   - the Chief AI Officer, in a chat: a design proposal. Its preview is
//     posted into this very chat, the person answers there, a yes applies
//     the change as the person. Nothing here changes the team, and the model
//     is told to promise nothing but the preview.
//   - the Insights Manager or Liftoff, in a chat: an answer, posted into this
//     chat under the colleague's name, out of turn.
//   - the Insights Manager or Liftoff, with no chat (an unattended run): an
//     answer, returned right here as the tool result.
//   - the Chief AI Officer with no chat: refused; nobody is there to say yes.
//
// Honest degradation as propose_routine: a refusal from the rail (the budget,
// the dedup latch) is an answer to relay, never a failure to invent around.

import { logger } from '../infrastructure/logging';
import { registerColleagueRequest } from '../platform-callback/client';
import type { StandardToolContext, StandardToolResult } from './standard-tool-handler';

const COLLEAGUES = new Set(['caio', 'insights', 'liftoff']);

const UNAVAILABLE_ERROR =
  'The colleague could not be reached right now. Tell the person plainly that you could not bring '
  + 'them in and that they can ask the colleague directly; do not imply anything about you changed '
  + 'and do not invent an answer.';

/** The sentence a refused registration puts in front of the person; shared
 *  with the chat turn's hand-over guard (colleague-handover-claim.ts), so a
 *  refusal reads the same whichever side relays it. */
export function colleagueRefusalSentence(reason: string): string {
  switch (reason) {
    case 'open_proposal_exists':
      return 'An earlier proposal of mine is still waiting for your answer, so I cannot open another until it is settled.';
    case 'already_offered':
      return 'That change was already put to you before and not taken up, so I will not raise it again on my own; the Chief AI Officer can make it if you ask them directly.';
    case 'needs_the_person':
      return 'A change to how I am built needs the person to agree, and nobody is in a conversation with me right now; I will raise it the next time we talk.';
    default:
      return 'I could not bring that colleague in just now.';
  }
}

export async function handleBringInColleague(
  payload: Record<string, unknown>,
  ctx: StandardToolContext,
): Promise<StandardToolResult> {
  const colleague = typeof payload.colleague === 'string' ? payload.colleague.trim() : '';
  const request = typeof payload.request === 'string' ? payload.request.trim() : '';
  const area = typeof payload.area === 'string' && payload.area.trim() ? payload.area.trim() : undefined;
  if (!COLLEAGUES.has(colleague)) {
    return { success: false, error: 'bring_in_colleague requires `colleague`: caio, insights or liftoff.' };
  }
  if (!request) {
    return { success: false, error: 'bring_in_colleague requires `request`: the change or the question, in the person\'s terms.' };
  }
  if (colleague === 'caio' && !ctx.threadId) {
    return {
      success: false,
      error:
        'The Chief AI Officer can only be brought in from a conversation: this run has no chat thread, so '
        + 'there is nobody here to agree to a change. Say what you could not do; do not imply anything changed.',
    };
  }

  try {
    const outcome = await registerColleagueRequest({
      tenantId: ctx.tenantId,
      agentId: ctx.agentId,
      ...(ctx.threadId ? { threadId: ctx.threadId } : {}),
      colleague: colleague as 'caio' | 'insights' | 'liftoff',
      request,
      ...(area ? { area } : {}),
    });

    if ('answered' in outcome) {
      if (outcome.answered) {
        return { success: true, result: { answered: true, colleague, reply: outcome.reply } };
      }
      return { success: false, error: UNAVAILABLE_ERROR };
    }
    if (outcome.registered) {
      return {
        success: true,
        result: {
          registered: true,
          colleague,
          nextStep: colleague === 'caio'
            ? 'Tell the person, in one sentence, that the Chief AI Officer will post here shortly what '
              + 'would change, and that it happens only when they agree. Ask nothing else, and do not '
              + 'describe the change as made.'
            : `Tell the person, in one sentence, that the ${colleague === 'insights' ? 'Insights Manager' : 'Liftoff assistant'} `
              + 'will post the answer here shortly. Do not guess the answer yourself.',
        },
      };
    }
    if (outcome.reason === 'unavailable') return { success: false, error: UNAVAILABLE_ERROR };
    if (outcome.reason === 'not_registerable') {
      return {
        success: false,
        error:
          'The platform does not recognise this conversation for this team member, so the colleague '
          + 'cannot be brought in from here. Do not imply anything changed or invent an answer.',
      };
    }
    const reason = outcome.reason ?? 'not_recorded';
    return { success: true, result: { registered: false, reason, explanation: colleagueRefusalSentence(reason) } };
  } catch (err) {
    logger.warn(
      { err, tenantId: ctx.tenantId, agentId: ctx.agentId, threadId: ctx.threadId, colleague },
      'bring_in_colleague: request failed',
    );
    return { success: false, error: UNAVAILABLE_ERROR };
  }
}
