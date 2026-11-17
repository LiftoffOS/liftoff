// propose_routine — the standing-request tool.
//
// The person asked their team member, in whatever words, for standing
// behaviour ("can you just do this every Monday?"). The runtime cannot create
// a standing routine: routines exist only as prose in the agent's standing
// guidance, distilled by the platform after the person consents. So this
// handler registers a PROPOSAL on the platform's consent rail
// (POST /api/internal/agent-chat/routine-proposal) and tells the model to ask
// for confirmation in its own reply. The person's "yes" on the next turn is
// intercepted platform-side and folded into guidance + redistilled; nothing
// more happens here.
//
// Not schedule_followup. A follow-up is a one-off deferred continuation of
// work already in hand; a chain of them impersonating a standing routine dies
// at the chain cap, survives no review, and shows on no settings page. The
// two tool descriptions draw the same line.
//
// Honest degradation, in both directions the platform can refuse:
//   - no chat thread (an autonomous run): there is nobody present to consent,
//     so the tool refuses rather than parking a question nobody will see;
//   - the budget or the dedup latch declined it: that is an ANSWER the model
//     must relay, not a failure — the call dispatched and the rail said no.

import { logger } from '../infrastructure/logging';
import { registerRoutineProposal } from '../platform-callback/client';
import type { StandardToolContext, StandardToolResult } from './standard-tool-handler';

const UNAVAILABLE_ERROR =
  'The routine proposal could not be registered with the platform right now. '
  + 'Tell the person plainly that you could not set this up; do not imply a schedule exists.';

/** One sentence per refusal, for the model to relay. The reasons are the
 *  platform route's vocabulary; an unknown one falls through to the last. */
function refusalSentence(reason: string, candidates?: string[]): string {
  if (reason === 'open_proposal_exists') {
    return 'An earlier proposal is still waiting for an answer, and only one can be open at a time. Answer that one first.';
  }
  if (reason === 'already_offered') {
    return 'This idea was offered before and was declined or is cooling down, so it cannot be offered again right now.';
  }
  if (reason === 'ambiguous_target') {
    const names = (candidates ?? []).join('; ');
    return names.length > 0
      ? `That name could mean more than one routine. Ask the person which they mean: ${names}.`
      : 'That name did not match a routine this team member runs. Ask the person to name it differently.';
  }
  return 'The proposal was not recorded. Do not imply a schedule exists.';
}

export async function handleProposeRoutine(
  payload: Record<string, unknown>,
  ctx: StandardToolContext,
): Promise<StandardToolResult> {
  const routine = typeof payload.routine === 'string' ? payload.routine.trim() : '';
  const rawAction = typeof payload.action === 'string' ? payload.action : 'start';
  const action: 'start' | 'change' | 'stop' =
    rawAction === 'change' || rawAction === 'stop' ? rawAction : 'start';
  const target = typeof payload.target === 'string' ? payload.target.trim() : '';

  if (action !== 'stop' && !routine) {
    return {
      success: false,
      error:
        'propose_routine requires `routine` for start and change: one sentence carrying '
        + 'the schedule and the work.',
    };
  }
  if (action !== 'start' && !target) {
    return {
      success: false,
      error:
        'propose_routine requires `target` for change and stop: the existing routine in '
        + 'the words the person used for it.',
    };
  }

  // A person must be present to consent. Same rule run_browser_task applies
  // to a turn nobody sent: refuse honestly instead of pre-empting it.
  if (!ctx.threadId) {
    return {
      success: false,
      error:
        'propose_routine is only available in a conversation: this run has no chat thread, '
        + 'so there is nobody to ask for confirmation.',
    };
  }

  try {
    const outcome = await registerRoutineProposal({
      tenantId: ctx.tenantId,
      agentId: ctx.agentId,
      threadId: ctx.threadId,
      ...(routine ? { routineProse: routine } : {}),
      action,
      ...(target ? { target } : {}),
    });

    if (outcome.registered && outcome.autoAccepted) {
      // The person's own words stated exactly this change, so the platform
      // applied it: the ask was the consent, and a confirmation question here
      // would be a second confirmation of an explicit instruction.
      return {
        success: true,
        result: {
          registered: true,
          applied: true,
          action,
          nextStep:
            'The change is APPLIED. Do not ask for confirmation. Tell the person it is '
            + 'done, that it takes a few minutes to take effect, and that they can ask '
            + 'you to change it back.',
        },
      };
    }

    if (outcome.registered) {
      const consequence =
        action === 'stop'
          ? 'The routine stops only when they agree.'
          : action === 'change'
            ? 'The change happens only when they agree.'
            : 'The routine starts only when they agree.';
      return {
        success: true,
        result: {
          registered: true,
          action,
          nextStep:
            'Ask the person for confirmation in your reply now, in one plain question. '
            + consequence,
        },
      };
    }

    if (outcome.reason === 'unavailable') {
      return { success: false, error: UNAVAILABLE_ERROR };
    }

    if (outcome.reason === 'not_registerable') {
      // The platform answered clearly: this is not one of its conversations
      // with this team member (or the team member is not active), so there is
      // no person here whose confirmation could start a routine.
      return {
        success: false,
        error:
          'The platform does not recognise this conversation for this team member, so a routine '
          + 'cannot be proposed from here. Do not imply a schedule exists; if a person asked for '
          + 'this, tell them to ask again in a chat with this team member.',
      };
    }

    const reason = outcome.reason ?? 'not_recorded';
    return {
      success: true,
      result: {
        registered: false,
        reason,
        ...(outcome.candidates ? { candidates: outcome.candidates } : {}),
        explanation: refusalSentence(reason, outcome.candidates),
      },
    };
  } catch (err) {
    logger.warn(
      { err, tenantId: ctx.tenantId, agentId: ctx.agentId, threadId: ctx.threadId },
      'propose_routine: registration failed',
    );
    return { success: false, error: UNAVAILABLE_ERROR };
  }
}
