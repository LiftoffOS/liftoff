// One budgeted, newest-first pager over a thread's speech.
//
// Every surface's `listMessages` has the same shape — a `created_at` cursor,
// newest first, `hasMore` plus the next cursor — so one walk turns pages into a
// bounded transcript for all of them. `speakerOf` may answer synchronously or
// with a promise, which is what lets team chat, whose speaker resolution looks
// an agent's name up, share the loop rather than restate it.
//
// THE BUDGET COUNTS THE REDACTED TEXT, not the row: a filtered-out row costs
// nothing, so a narrow `match` reaches much further back through a long thread
// than an unfiltered read of the same budget.
//
// THE CONTINUATION CURSOR IS THE OLDEST CONSUMED MESSAGE'S TIMESTAMP, not the
// page's `nextCursor`. The two differ exactly when a bound stops the walk
// mid-page, and there the page's cursor would skip everything between the stop
// and the end of that page. Both inherit each repository's tie behaviour: a
// cursor is `created_at < $n`, so rows sharing the boundary instant are skipped.

import { redactSensitiveText } from '../common/redact';

/** One row of speech, as a person reading the thread saw it. */
export interface TranscriptEntry {
  speaker: string;
  text: string;
  attachments: string[];
  /** When it was said, so a reader can place it. */
  at: string;
}

export interface Transcript {
  /** Oldest first — reading order, whatever order the walk collected in. */
  messages: TranscriptEntry[];
  /** The walk stopped on a bound rather than reaching the start of the thread. */
  truncated: boolean;
  /** Pass as the next `cursor` to continue further back, or null at the start
   *  of the thread. Non-null only when `truncated`. */
  nextCursor: string | null;
}

export interface CollectOptions {
  /** Characters of speech to carry. Required: no one default is sensible for
   *  both a service payload and a tool result re-sent each round of a turn. */
  charBudget: number;
  /** Stop after this many messages, whatever the budget allows. */
  limit?: number;
  /** Keep only messages containing this text, case-insensitively. A filtered
   *  row consumes no budget. */
  match?: string;
  /** Start here instead of at the newest message (exclusive). */
  cursor?: string;
}

interface Page<M> {
  messages: M[];
  hasMore: boolean;
  nextCursor: string | null;
}

/** Newest-first pages until a bound is reached, then flipped to reading order.
 *  `speakerOf` answers null for a row written ABOUT the conversation rather
 *  than said in it, which is skipped as status. */
export async function collectTranscript<M extends { content: string; createdAt: string }>(
  page: (cursor: string | undefined) => Promise<Page<M>>,
  speakerOf: (message: M) => string | null | Promise<string | null>,
  attachmentsOf: (message: M) => string[],
  options: CollectOptions,
): Promise<Transcript> {
  const { charBudget, limit, match } = options;
  const needle = match && match.trim().length > 0 ? match.trim().toLowerCase() : null;

  const collected: TranscriptEntry[] = [];
  let spent = 0;
  let truncated = false;
  let oldestConsumed: string | null = null;
  let cursor: string | undefined = options.cursor;

  paging: for (;;) {
    const result = await page(cursor);
    for (const message of result.messages) {
      const speaker = await speakerOf(message);
      if (speaker === null) continue;
      const text = redactSensitiveText(message.content);
      if (needle !== null && !text.toLowerCase().includes(needle)) continue;
      // Both bounds leave at least one message: a single row longer than the
      // whole budget is still worth returning, and an empty result reads as
      // "the thread is empty" rather than "ask for less".
      if (collected.length > 0 && (
        spent + text.length > charBudget
        || (limit !== undefined && collected.length >= limit)
      )) {
        truncated = true;
        break paging;
      }
      spent += text.length;
      oldestConsumed = message.createdAt;
      collected.push({ speaker, text, attachments: attachmentsOf(message), at: message.createdAt });
    }
    if (!result.hasMore || !result.nextCursor) break;
    cursor = result.nextCursor;
  }

  return {
    messages: collected.reverse(),
    truncated,
    nextCursor: truncated ? oldestConsumed : null,
  };
}
