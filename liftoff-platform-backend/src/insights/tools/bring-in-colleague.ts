// The Insights Manager brings a colleague into the conversation.
//
// NOT an ordinary tool, and deliberately not in the registry: when the model
// calls it, nothing comes back for the Insights Manager to paraphrase. The
// chat service intercepts the call before dispatch, hands the rest of the turn
// to the colleague on the shared rail (agent-chat/handover.ts), and says
// nothing further. The description says so plainly, because a model that
// expects a result writes a preamble and then a summary, and the person reads
// the same answer twice in two voices.
//
// Two colleagues, both always there, so `colleague` is an enum rather than an
// id the model has to look up: the Chief AI Officer for any change to an AI
// team, Liftoff for a question outside the workspace's own records. An agent
// is not a target from here; Liftoff has the roster for that.
//
// Offered on an ordinary turn only. An answer-only turn (a team brought the
// Insights Manager in for a number) has nobody present to confirm anything,
// and a turn that IS a hand-over is not offered a colleague of its own, so a
// hand-over is one deep whoever started it (role-matrix.ts withholds it).

import type { LLMToolDefinition } from '../../llm/types';
import {
  BRING_IN_COLLEAGUE_TOOL,
  CAIO_DELEGATION_TARGET,
  LIFTOFF_DELEGATION_TARGET,
  type DelegationTarget,
} from '../../liftoff/delegation-targets';

export { BRING_IN_COLLEAGUE_TOOL };

/** Who the Insights Manager can bring in, by the name the model passes. */
export const INSIGHTS_HANDOVER_TARGETS: Readonly<Record<'caio' | 'liftoff', DelegationTarget>> =
  Object.freeze({
    caio: CAIO_DELEGATION_TARGET,
    liftoff: LIFTOFF_DELEGATION_TARGET,
  });

/** The colleague a `colleague` argument names, or null for anything else. */
export function resolveInsightsHandoverTarget(colleague: unknown): DelegationTarget | null {
  if (typeof colleague !== 'string') return null;
  const key = colleague.trim().toLowerCase();
  return key === 'caio' || key === 'liftoff' ? INSIGHTS_HANDOVER_TARGETS[key] : null;
}

export const insightsBringInColleagueTool: LLMToolDefinition = {
  name: BRING_IN_COLLEAGUE_TOOL,
  description:
    'Bring one of your two colleagues into this conversation to do the work here. '
    + '`caio` (the Chief AI Officer) for any change to an agent: creating one, starting, pausing or '
    + 'archiving one, rewording what it does, what it is bound to, its tools, skills, memories or '
    + 'webhook. You read agents and report on them; you never change one. The Chief AI Officer reads the '
    + 'agent, posts here what would change, and applies it only when the person says yes. '
    + '`liftoff` for a question outside what the workspace\'s own records and your tools can answer: '
    + 'a general question, a document, a page, something about the product. '
    + 'The colleague joins this conversation: the person is not sent anywhere. '
    + 'Calling this hands the rest of the reply over, so you will not get a result back. Do not '
    + 'announce it, do not describe what will happen, and write nothing after the call. The one '
    + 'thing you may write before it is an answer of your own the person asked for alongside the '
    + 'hand-over (a figure, a finding from your tools): give it, then call this.',
  input_schema: {
    type: 'object',
    properties: {
      colleague: {
        type: 'string',
        enum: ['caio', 'liftoff'],
        description:
          "Who to bring in: 'caio' changes an agent; 'liftoff' answers everything outside the "
          + 'workspace records.',
      },
      request: {
        type: 'string',
        description:
          'A brief for the colleague, one or two sentences in your own words, never shown to the '
          + 'person: what they want done, and anything from earlier in this conversation the '
          + 'colleague would otherwise not know, because it does not see this thread: the figure '
          + 'you just found, the agent it is about with its id (so the colleague acts on the right '
          + 'one when two share a name), what the person decided.',
      },
    },
    required: ['colleague', 'request'],
  },
};
