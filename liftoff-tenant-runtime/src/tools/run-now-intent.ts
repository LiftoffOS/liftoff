// Did the person actually ask for a run, or ask where the last one's work is?
//
// THE FAILURE. An agent has just finished a sweep that produced a battle card.
// The person writes "so where is my report". The model calls `search_documents`,
// finds the battle card document, and calls `run_routine_now` in the same turn.
// The tool arms the graph and returns its fresh-start note:
//
//   "The routine run begins when you finish this reply, and has done nothing
//    yet. Tell the person the work is about to begin … Do not describe any work
//    as done."
//
// So the reply is the same canned line the original request got, a second sweep
// starts, and the document the person was asking for goes unmentioned even
// though the turn is holding its link.
//
// WHY THE GATE IS HERE AND NOT IN THE TOOL'S PROSE, OR IN THE GRAPH.
//
// The tool cannot know a run already happened: `run-routine-now-handler.ts` sees
// the preflight and whether the tool was already called this turn, and nothing
// about prior artifacts. Exactly-once for the weekly window stays in the graph,
// where it already lives. What the tool CAN be given is the one thing that
// decides whether a run was asked for at all: the person's own message.
//
// FAIL CLOSED. A run is armed only on an explicit ask. Starting a sweep nobody
// asked for costs a person a wrong answer and the workspace a full run; declining
// one they did ask for costs a sentence, and the model can ask them to confirm.
//
// A QUESTION ABOUT WORK IS CHECKED FIRST, because "did you run it" and "run it"
// differ by one word and mean opposite things. The wh-words are kept to the ones
// that ask about work in this setting rather than every interrogative: "what I
// want is for you to run the sweep now" is a request, and a blanket `\bwhat\b`
// would refuse it.

/** What the person's message asks for. */
export type RunNowIntent =
  /** An explicit request to run the routine now. */
  | 'start'
  /** A question about work that has already happened, or should have. */
  | 'asks_about_work'
  /** Neither. Nothing is armed on this. */
  | 'unclear';

/** Asks about work rather than for it. */
const ASKS_ABOUT_WORK: readonly RegExp[] = [
  /\bwhere\b/i,
  /\bwhat\s+happened\b/i,
  /\bany\s+(update|progress|news)\b/i,
  /\bstatus\b/i,
  // "did you run it", "have you finished", "has the sweep gone out"
  /\b(did|have|has|had|was|were)\s+(you|it|they|the|this|that)\b/i,
  /\bis\s+(it|this|that|the\s+\w+)\s+(done|ready|finished|complete|ran|run|out)\b/i,
  // The contraction is one token: `how's` never has a space in it.
  /\bhow(?:\s+is|'s)\s+(?:it|this|that)\s+going\b/i,
  /\b(not|never)\s+(received|got|seen|done|finished|run|ran|arrived)\b/i,
];

/** Asks for a run, now. */
const ASKS_FOR_A_RUN_NOW: readonly RegExp[] = [
  /\b(run|rerun|re-run|start|restart|trigger|launch|execute|begin)\b/i,
  // "kick off", "kick it off", "kickoff".
  /\bkick\s+(?:\w+\s+)?off\b|\bkickoff\b/i,
  /\bgo\s+ahead\b/i,
];

/** ASKS FOR THE DELIVERABLE, which is asking for the work.
 *
 *  The lists above only know verbs for running a PROCESS — run, start, trigger.
 *  People ask for the OUTPUT: "i want my report now". That matched neither
 *  list, came back `unclear`, and the routine was refused while the person had
 *  said plainly what they wanted.
 *
 *  Checked AFTER `ASKS_ABOUT_WORK`, which is what keeps "where is my report"
 *  and "did you send the digest" on the question side: those match there first
 *  and never reach here. What lands here is a demand with no interrogative in
 *  it, and a demand for a deliverable is a request for the work that makes it.
 *
 *  Deliberately requires BOTH halves — a wanting and a thing wanted. "I want to
 *  understand the pricing" names no deliverable; "the report was useful" wants
 *  nothing. */
const DELIVERABLE = '(report|digest|summary|analysis|brief|update|write[- ]?up|findings|results)';
const ASKS_FOR_THE_DELIVERABLE: readonly RegExp[] = [
  new RegExp(`\\b(want|need)\\b[^.?!]*\\b${DELIVERABLE}\\b`, 'i'),
  new RegExp(`\\b(send|give|show|get|produce|write|make|do)\\s+me\\b[^.?!]*\\b${DELIVERABLE}\\b`, 'i'),
  new RegExp(`\\b(send|give|show|produce)\\s+(?:me\\s+)?(?:the|my|a|an)\\s+${DELIVERABLE}\\b`, 'i'),
  // "my report now", "the digest now" — a deliverable named with urgency and no
  // question around it.
  new RegExp(`\\b(my|the)\\s+${DELIVERABLE}\\b[^.?!]*\\bnow\\b`, 'i'),
];

/**
 * Read the intent off the person's own message.
 *
 * An absent message is NOT handled here: the caller decides what to do when it
 * has none, because "no message on the cell" is a fact about the caller and not
 * about anything a person said. An empty one is `unclear`.
 */
export function readRunNowIntent(message: string): RunNowIntent {
  const text = message.trim();
  if (!text) return 'unclear';
  if (ASKS_ABOUT_WORK.some((re) => re.test(text))) return 'asks_about_work';
  if (ASKS_FOR_A_RUN_NOW.some((re) => re.test(text))) return 'start';
  if (ASKS_FOR_THE_DELIVERABLE.some((re) => re.test(text))) return 'start';
  return 'unclear';
}

// ── The model, with the patterns behind it ─────────────────────────────────
//
// Intent is a judgement about language, and the patterns above are a list of
// verbs. They knew how to say "run" and not how to say "I want my report", and
// a person hit that twice with the same sentence. This asks the model the
// platform already uses for exactly this shape of question — a typed answer
// from something that replies in milliseconds — and keeps the patterns as what
// answers when it cannot be reached.
//
// FAILS OPEN TO THE PATTERNS, never to a run. No API key, no clock left, an
// unpinned threshold, a 400 from the usage route: `ask` returns null and the
// regex verdict stands, which is the behaviour that shipped before this.

import { RUN_NOW_INTENT_SET } from '../typesafe/questions';
import { ask } from '../typesafe/client';
import { asEntry } from '../typesafe/questions';
import { sanitizeBrowserText } from '@liftoffos/redact';
import { logger } from '../infrastructure/logging';

/** A message longer than this is truncated before it is asked about. Intent
 *  lives in the opening clause; a pasted document after it is not the ask. */
const INTENT_MAX_CHARS = 1_000;

/** How long the classification may take. A chat turn is waiting on it, so this
 *  is short and the patterns answer if it is not met. */
export const RUN_NOW_INTENT_TIMEOUT_MS = 4_000;

export interface RunNowIntentContext {
  tenantId: string;
  invocationId?: string;
  runtimeAgentId?: string;
}

/**
 * Read the intent, asking the model first and falling back to the patterns.
 *
 * Both questions are asked rather than one label because the two failures are
 * not opposites: arming a run nobody asked for, and refusing one they did. A
 * message can read as neither, which is `unclear` and arms nothing.
 */
export async function readRunNowIntentAsync(
  message: string,
  ctx: RunNowIntentContext,
): Promise<RunNowIntent> {
  const pattern = readRunNowIntent(message);
  const text = sanitizeBrowserText(message ?? '', INTENT_MAX_CHARS).text.trim();
  if (!text) return pattern;

  let answered;
  try {
    answered = await ask(RUN_NOW_INTENT_SET, asEntry({ message: text }), {
      deadlineMs: RUN_NOW_INTENT_TIMEOUT_MS,
      tenantId: ctx.tenantId,
      ...(ctx.invocationId ? { invocationId: ctx.invocationId } : {}),
      ...(ctx.runtimeAgentId ? { runtimeAgentId: ctx.runtimeAgentId } : {}),
    });
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, tenantId: ctx.tenantId, event: 'run_now_intent_check' },
      'run-now intent: the model could not be asked; the patterns stand',
    );
    return pattern;
  }
  if (!answered) return pattern;

  const run = Number(answered.answers.asks_to_run?.noul);
  const asksAbout = Number(answered.answers.asks_about_work?.noul);
  if (!Number.isFinite(run) || !Number.isFinite(asksAbout)) return pattern;

  const { RUN_T, ASK_T } = RUN_NOW_INTENT_SET.thresholds as { RUN_T: number; ASK_T: number };
  // A QUESTION WINS A TIE. Answering from work already done is recoverable;
  // starting a sweep nobody asked for is not, and that is the failure this
  // gate was built for.
  const verdict: RunNowIntent = asksAbout >= ASK_T
    ? 'asks_about_work'
    : run >= RUN_T ? 'start' : 'unclear';

  logger.info(
    {
      tenantId: ctx.tenantId, event: 'run_now_intent_check',
      verdict, pattern, asksToRun: run, asksAboutWork: asksAbout,
    },
    'run-now intent read',
  );
  return verdict;
}
