// The Chief AI Officer brings a colleague into the conversation.
//
// NOT an ordinary tool, and deliberately not in the registry: when the model
// calls it, nothing comes back for the Chief AI Officer to paraphrase. The
// chat service intercepts the call before dispatch, ends the model loop
// (platform-agent's `handed_over` terminator), opens the hand-over stream on
// platform-backend, where the colleagues run (handover-client.ts), and
// relays the colleague's reply as the rest of the turn. The description says
// so plainly, because a model that expects a result writes a preamble and
// then a summary, and the person reads the same answer twice in two voices.
//
// Two colleagues, both always there, so `colleague` is an enum: the Insights
// Manager for what only the workspace's own records can answer, Liftoff for a
// question outside designing and changing agents. Their ids and labels are
// the ones every surface stores in `contributors`, the same spellings
// platform-backend's assistant-targets.ts holds; two spellings of one
// colleague would render as two colleagues.
//
// Offered on an ordinary turn only. A turn that IS a hand-over (Liftoff or the
// Insights Manager brought the Chief AI Officer in) is not offered a colleague
// of its own, so a hand-over is one deep whoever started it; the chat-stream
// route's `handover` flag is what says so (role-matrix.ts withholds it).

import type { LLMToolDefinition } from '../../llm/types.js';

/** The tool's name, shared with Liftoff's and the Insights Manager's tool of
 *  the same purpose, so a transcript's tool trail reads the same everywhere. */
export const BRING_IN_COLLEAGUE_TOOL = 'bring_in_colleague';

/** A colleague as the hand-over stream and the stored reply name it. */
export interface CAIOHandoverTarget {
  id: 'liftoff' | 'insights';
  label: string;
}

/** Who the Chief AI Officer can bring in, by the name the model passes. */
export const CAIO_HANDOVER_TARGETS: Readonly<Record<'liftoff' | 'insights', CAIOHandoverTarget>> =
  Object.freeze({
    liftoff: Object.freeze({ id: 'liftoff', label: 'Liftoff' }),
    insights: Object.freeze({ id: 'insights', label: 'Insights Manager' }),
  });

/** The colleague a `colleague` argument names, or null for anything else. */
export function resolveCAIOHandoverTarget(colleague: unknown): CAIOHandoverTarget | null {
  if (typeof colleague !== 'string') return null;
  const key = colleague.trim().toLowerCase();
  return key === 'liftoff' || key === 'insights' ? CAIO_HANDOVER_TARGETS[key] : null;
}

export const bringInColleagueTool: LLMToolDefinition = {
  name: BRING_IN_COLLEAGUE_TOOL,
  description:
    'Bring one of your two colleagues into this conversation to do the work here. '
    + '`insights` (the Insights Manager) for what only the workspace\'s own records can answer: '
    + 'spend, run counts, what happened across the workspace, who did what, how an agent has been '
    + 'performing. Never guess such a number. `liftoff` for a question outside designing, creating '
    + 'and changing agents that your own tools cannot answer: a general question, a document, a '
    + 'page, how the product works. The colleague joins this conversation: the person is not sent '
    + 'anywhere. Calling this hands the rest of the reply over, so you will not get a result back. '
    + 'Do not announce it, do not describe what will happen, and write nothing after the call. The '
    + 'one thing you may write before it is an answer of your own the person asked for alongside '
    + 'the hand-over: give it, then call this. Do not hand off work inside your own role: designing '
    + 'an agent, previewing or applying a change to one, is yours.',
  input_schema: {
    type: 'object',
    properties: {
      colleague: {
        type: 'string',
        enum: ['insights', 'liftoff'],
        description:
          "Who to bring in: 'insights' answers from workspace records; 'liftoff' answers "
          + 'everything outside agents and workspace records.',
      },
      request: {
        type: 'string',
        description:
          'A brief for the colleague, one or two sentences in your own words, never shown to the '
          + 'person: what they want, and anything from earlier in this conversation the colleague '
          + 'would otherwise not know, because it does not see this thread: the agent it is about, '
          + 'what was decided, what the person is trying to find out.',
      },
    },
    required: ['colleague', 'request'],
  },
};
