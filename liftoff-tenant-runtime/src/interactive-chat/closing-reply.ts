// Asking the agent to say what it did, when it finished without saying anything.
//
// A run can act — post a review, update a record — and end with no closing text.
// The thread then shows the person their own message and silence, and "no reply"
// and "never ran" are indistinguishable to them.
//
// The graph-level contract (platform-backend `reply-contract.ts`) fixes this
// where a graph exists AND has been redistilled since it shipped. That does not
// cover every agent: agents on the conversational branch have no graph to
// constrain, and agents with one keep their old steps until rebuilt. For them
// the only coverage is a paragraph in the chat system prompt, which is a hope.
// This turns it into a guarantee.
//
// TOOLS ARE WITHHELD, AND THAT IS THE WHOLE SAFETY ARGUMENT.
// `verify-on-stop` in agent-execution does the same shape for a different
// purpose: it nudges a run that stopped early so the agent KEEPS WORKING. This
// wants the opposite — the work is done, and the agent should stop and speak. A
// nudge that can call tools is a nudge that can act twice, and a turn that
// already posted a review deciding to post another is far worse than a blank
// thread. So this is a single completion with no tools, and it cannot be
// anything else.
//
// ONE ATTEMPT. If it returns nothing the caller falls through to the platform
// fallback. Retrying a model that just declined to speak buys latency on a turn
// the person is already waiting on.

import { llmClient } from '../llm/client';
import { logger } from '../infrastructure/logging';
import { readClosingVerdict } from './closing-verdict';

/** Kept short: the person is already waiting, and this runs after the work. */
const NUDGE_TIMEOUT_MS = 20_000;
const NUDGE_MAX_TOKENS = 400;

export interface ClosingReplyInput {
  tenantId: string;
  /** The RUNTIME agent id (`agents.id`), not the control plane's
   *  `internal_agents.id`.
   *
   *  It goes on the call's `usageContext`, and the BYOK resolver reads that
   *  field as a runtime id: `openByokSession` hands it to
   *  `resolveInternalAgentId`, which maps runtime -> control plane and returns
   *  NULL for anything else. An id from the wrong space matches zero rows with
   *  no error (ADR-039), so the session posts `agentId: null` and that spend
   *  loses its agent on a chargeable path.
   *
   *  Every caller is `chat-turn-handler`, whose own `agentId` is the id the
   *  CONTROL PLANE sent — which is why it resolves `runtimeAgentIdForRun` and
   *  passes that. Typed as a plain string because both spaces are UUIDs and
   *  neither the compiler nor `llm_usage_log.agent_id` (free TEXT, no FK) can
   *  tell them apart; this comment and the test beside it are the check. */
  agentId: string;
  threadId: string;
  invocationId?: string;
  /** What the person asked for. */
  userMessage: string;
  /** What the run did, as the transcript recorded it. Trimmed by the caller —
   *  this is a summary request, not a context window to fill. On the last
   *  resort it is the fair-share digest of the turn's own tool results
   *  (agent-execution/engine/step-salvage-prompt.ts), built over what the
   *  turn's calls actually returned rather than over the transcript. */
  activityDigest: string;
  /** The turn could not finish: its graph stopped before delivering. The
   *  request then asks for what WAS found, from the material alone, and says
   *  so — a person is looking at the thread and would otherwise read an
   *  error line beside everything the turn had gathered. */
  unfinished?: boolean;
  /** A bound closed the turn (its turn budget, or its deadline) with work
   *  possibly left: the request also asks for the verdict line the platform
   *  loops ask for — `[continue]` when work the person asked for is still to
   *  do, `[done]` when it is finished — read off the reply and removed before
   *  the text goes anywhere (closing-verdict.ts). Only `requestClosingReplyWithVerdict`
   *  sets it. */
  askVerdict?: boolean;
}

/** What the platform loops ask for at the end of a closing reply, word for
 *  word: the same sentence Liftoff, the Insights Manager and the Chief AI
 *  Officer put to their models, so every surface writes one marker. */
const VERDICT_INSTRUCTION =
  ' Then end with exactly one line on its own: [continue] if work you were asked for is still to do, or [done] if it is finished.';

/**
 * One completion, no tools, asking for the answer the run never gave.
 *
 * Returns null when the model produces nothing usable or the call fails, so the
 * caller keeps its existing fallback rather than this becoming a second way for
 * a finished turn to go wrong.
 */
export async function requestClosingReply(input: ClosingReplyInput): Promise<string | null> {
  const prompt = input.unfinished
    ? 'You were doing a piece of work for someone and could not finish it. '
      + 'They are looking at the thread and have not been told what you found.\n\n'
      + `What they asked:\n${input.userMessage}\n\n`
      + `What your tools returned before the work stopped:\n${input.activityDigest}\n\n`
      + 'Reply to them now, in your own voice, with what you FOUND from this material alone. '
      + 'Say plainly what you could not complete, and do not guess at what the missing parts would '
      + 'have said. Do not name a tool, an identifier or a limit. A few sentences. No preamble, no '
      + 'apology, and do not mention that you were prompted for this.'
      + (input.askVerdict ? VERDICT_INSTRUCTION : '')
    : 'You just finished a piece of work for someone and ended without replying to them. '
      + 'They are looking at their own message and nothing else.\n\n'
      + `What they asked:\n${input.userMessage}\n\n`
      + `What you did:\n${input.activityDigest}\n\n`
      + 'Reply to them now, in your own voice, with the ANSWER rather than a status update. '
      + 'If you found something, say what you found and what you would do about it. If the result '
      + 'landed somewhere else, say what it says as well as where it is, so they do not have to go '
      + 'and look to find out. A few sentences. No preamble, no apology for the delay, and do not '
      + 'mention that you were prompted for this.';

  try {
    const response = await Promise.race([
      llmClient.complete(
        {
          // No `tools`. See the header: a nudge that can act is a nudge that can
          // act twice, on a turn whose work is already done.
          messages: [{ role: 'user', content: prompt }],
          maxTokens: NUDGE_MAX_TOKENS,
          temperature: 0.3,
        } as Parameters<typeof llmClient.complete>[0],
        undefined,
        {
          tenantId: input.tenantId,
          agentId: input.agentId,
          // Already on the input and already logged either side of this call;
          // it belongs on the attribution too. It ties the usage row to the
          // invocation the ledger settles, which is also what lets the BYOK
          // resolver fund this call from the customer's own key rather than
          // leaving it on the managed pool for want of a run to settle against.
          ...(input.invocationId ? { invocationId: input.invocationId } : {}),
          purpose: 'chat_closing_reply',
        },
      ),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), NUDGE_TIMEOUT_MS)),
    ]);

    const text = (response as { content?: string } | null)?.content?.trim();
    if (!text) {
      logger.warn(
        { threadId: input.threadId, invocationId: input.invocationId },
        'closing-reply nudge produced nothing — falling back',
      );
      return null;
    }
    logger.info(
      { threadId: input.threadId, invocationId: input.invocationId, chars: text.length },
      'closing-reply nudge answered a turn that would have been silent',
    );
    return text;
  } catch (err) {
    // Never fails the turn. The work happened and is persisted; this is the
    // difference between a good reply and a plain one.
    logger.warn(
      { err: (err as Error).message, threadId: input.threadId },
      'closing-reply nudge failed — falling back',
    );
    return null;
  }
}

/**
 * The closing reply a BOUND asks for: a turn that ran out of its turn budget
 * (`limit_reached`) or its deadline with work possibly left. Same completion
 * as `requestClosingReply`, plus the verdict line, read here and stripped:
 * the text returned never carries it. Null when the model produced nothing
 * usable, in which case the caller treats the turn as unfinished (a bound
 * closed it) and keeps its existing fallback.
 */
export async function requestClosingReplyWithVerdict(
  input: Omit<ClosingReplyInput, 'unfinished' | 'askVerdict'>,
): Promise<{ text: string; unfinished: boolean } | null> {
  const raw = await requestClosingReply({ ...input, unfinished: true, askVerdict: true });
  if (raw === null) return null;
  const read = readClosingVerdict(raw);
  if (!read.text) return null;
  // No verdict line is read as unfinished: the bound closed the turn, and the
  // cap on continuations bounds a model that never writes the line.
  return { text: read.text, unfinished: read.verdict !== 'done' };
}

/** How much transcript the nudge is given. Enough to see what the run did,
 *  bounded because this is a summary request and not a context window to fill —
 *  and because a chat transcript can carry customer content that has no reason
 *  to be re-sent wholesale. */
const DIGEST_MAX_CHARS = 6000;

/**
 * Trim the SDK transcript to what the nudge needs.
 *
 * TAIL, not head: the actions that need reporting are the ones it took last, and
 * the head of a resumed session is an earlier conversation entirely.
 *
 * Takes the text rather than reading it, so this module never imports the chat
 * handler that imports it.
 */
export function trimActivityDigest(jsonl: string | null | undefined): string {
  if (!jsonl) return '(no transcript for this turn)';
  return jsonl.length > DIGEST_MAX_CHARS ? jsonl.slice(-DIGEST_MAX_CHARS) : jsonl;
}
