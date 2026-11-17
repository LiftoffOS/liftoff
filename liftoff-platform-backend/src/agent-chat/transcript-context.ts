// Which rows of a transcript are the CONVERSATION, and which are notes about it.
//
// A thread holds two kinds of row. One is what people and teams said. The other
// is what the system wrote ABOUT the conversation: a gate stalling it, a
// delegation's outcome, the background Liftoff forwarded, a run narrating its
// own progress. Both render, because a reader wants to see both. Only the first
// is conversation.
//
// The distinction matters wherever a transcript becomes CONTEXT — the model's
// history for the next turn, a rolling summary, an observer's absorbed
// recollection of what it missed. Feeding a status row back has the model read
// "Waiting on Ada Lovelace to approve" as its own prior turn, or an observer
// remember "12 web searches" as something a colleague said.
//
// One predicate rather than the same four-way comparison repeated at each
// reader, because the failure mode is a fifth type added to some readers and
// not others, and a reader that quietly disagrees with the others produces a
// model answer nobody can trace back to a row.

import { FORWARDED_CONTEXT_MESSAGE_TYPE } from '../liftoff/forwarded-context';
import {
  BROWSER_HANDBACK_MESSAGE_TYPE,
  BROWSER_POINT_MESSAGE_TYPE,
  HITL_STATUS_MESSAGE_TYPE,
  DELEGATION_STATUS_MESSAGE_TYPE,
} from './hitl-status-message';
import { RUN_PROGRESS_MESSAGE_TYPE, RUN_FAILED_MESSAGE_TYPE } from './run-progress';

/** Row types that are written about a conversation rather than said in it. */
export const NARRATION_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  HITL_STATUS_MESSAGE_TYPE,
  DELEGATION_STATUS_MESSAGE_TYPE,
  FORWARDED_CONTEXT_MESSAGE_TYPE,
  RUN_PROGRESS_MESSAGE_TYPE,
  // A run that stopped without an answer. Narration like the line above it,
  // and for the same reason: nobody said it. The fact still has to reach the
  // model, or the turn after a failure is written against a promise with no
  // outcome — it travels as a note on `conversationSummary`, which is the
  // control plane's model-context seam, rather than as words the team appears
  // to have spoken.
  RUN_FAILED_MESSAGE_TYPE,
  // The person's browser events: the segment itself reaches the model
  // through the Browser section, and the row is the person's, not the team's.
  BROWSER_HANDBACK_MESSAGE_TYPE,
  BROWSER_POINT_MESSAGE_TYPE,
]);

/** True when this row is part of the conversation, and so belongs in anything
 *  built FROM the conversation. An untyped row is ordinary speech. */
export function isConversationRow(message: { messageType?: string | null }): boolean {
  return !message.messageType || !NARRATION_MESSAGE_TYPES.has(message.messageType);
}

/** The same predicate as a SQL literal list, for the readers that filter in the
 *  database rather than in TypeScript.
 *
 *  Built from the set above rather than restated, because a restated list is
 *  the failure this module exists to prevent, one layer down: a SQL filter
 *  naming four of the types quietly admits the fifth, and what surfaces is a
 *  status row quoted back to a model as "what you discussed". Two readers
 *  filter in SQL today and both were written by hand; one of them already
 *  admitted `run_progress`.
 *
 *  `extra` is for a reader whose exclusions are a SUPERSET of narration — rows
 *  that are not narration of a run but are still not speech (a routine
 *  proposal, a learning confirmation). Every value is a code-defined constant,
 *  never input; the quote-doubling is belt-and-braces on that. */
export function narrationSqlList(extra: readonly string[] = []): string {
  return [...new Set([...NARRATION_MESSAGE_TYPES, ...extra])]
    .map((t) => `'${t.replace(/'/g, "''")}'`)
    .join(', ');
}
