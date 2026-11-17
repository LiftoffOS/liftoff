// Reading further back in the conversation the model is already in.
//
// WHAT A MODEL OTHERWISE HAS of a long thread: the recent window (twenty
// messages for the platform assistants; for an agent an engine session that
// compacts itself and is dropped when it goes stale) and the rolling summary of
// everything older. The summary is a compression and cannot answer "what
// exactly did I tell you" — it holds five fields under six hundred output
// tokens. This is the way to go and look instead.
//
// THIS GRANTS NO NEW VISIBILITY, which is what makes it safe to offer without
// a consent step. The person asking is in the thread and their own client
// already renders the whole scrollback; the model is reading what is on the
// screen in front of them. That is the same rule the Chief AI Officer's
// conversation read states for its own surface. Cross-thread recall is a
// different question with a different answer — see recall-conversations.
//
// BOUNDED BECAUSE IT IS RE-SENT. A tool result lands in the model's context
// whole and is sent again on every subsequent round of the turn that asked for
// it, so an unbounded read of a long thread is paid for many times over. The
// result says what it left out and how to ask for the next page, which is worth
// more than a bigger single answer: a model looking for one fact pages with
// `match` and stops.

import { surfaceReader, type ChatSurface } from './surfaces';
import type { TranscriptEntry } from './transcript';

/** Characters of speech one read carries. Deliberately well under the
 *  source-conversation route's 50,000: that is a one-shot service payload, this
 *  is re-sent on every round of a turn. */
const DEFAULT_CHAR_BUDGET = 20_000;
const MAX_MESSAGES = 100;
const DEFAULT_MESSAGES = 30;

export interface ReadThreadHistoryInput {
  /** Read messages older than this timestamp. The previous result's
   *  `nextBefore`, or absent to start at the newest. */
  before?: string;
  /** Messages to return, 1–100. */
  limit?: number;
  /** Only messages containing this text, case-insensitively. A filtered
   *  message costs no budget, so a narrow match reaches much further back. */
  match?: string;
}

export interface ReadThreadHistoryContext {
  tenantId: string;
  surface: ChatSurface;
  threadId: string;
}

function boundedLimit(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_MESSAGES;
  return Math.min(MAX_MESSAGES, Math.max(1, Math.floor(n)));
}

/** A timestamp the caller can actually have got from us, or nothing. A
 *  malformed cursor reads as "start at the newest" rather than failing the
 *  call: the model wrote it, and the recoverable reading is the useful one. */
function boundedBefore(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined;
  const at = new Date(raw.trim());
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}

function renderEntry(entry: TranscriptEntry): string {
  const at = entry.at.replace('T', ' ').slice(0, 16);
  const attachments = entry.attachments.length > 0
    ? ` [attached: ${entry.attachments.join(', ')}]`
    : '';
  return `[${at}] ${entry.speaker}: ${entry.text}${attachments}`;
}

/** Read this conversation's own earlier messages. Never throws: a failure is
 *  answered with what it was, because a model told "that could not be read"
 *  says so to the person instead of inventing what the thread contained. */
export async function readThreadHistory(
  ctx: ReadThreadHistoryContext,
  input: ReadThreadHistoryInput,
): Promise<string> {
  const reader = surfaceReader(ctx.surface);
  const limit = boundedLimit(input.limit);
  const before = boundedBefore(input.before);
  const match = typeof input.match === 'string' ? input.match.trim() : '';

  const thread = await reader.resolveThread(ctx.tenantId, ctx.threadId);
  if (!thread) {
    return 'This conversation could not be read.';
  }

  const transcript = await reader.collect(ctx.tenantId, thread.id, {
    charBudget: DEFAULT_CHAR_BUDGET,
    limit,
    ...(match.length > 0 ? { match } : {}),
    ...(before ? { cursor: before } : {}),
  });

  if (transcript.messages.length === 0) {
    return match.length > 0
      ? `No earlier message in this conversation contains "${match}".`
      : 'There is nothing earlier in this conversation.';
  }

  const first = transcript.messages[0];
  const last = transcript.messages[transcript.messages.length - 1];
  const scope = match.length > 0 ? ` containing "${match}"` : '';
  const header = `${transcript.messages.length} earlier message(s)${scope} in this conversation with `
    + `${reader.counterpart}, from ${first.at.slice(0, 16).replace('T', ' ')} to `
    + `${last.at.slice(0, 16).replace('T', ' ')}, oldest first.`;

  const more = transcript.nextCursor
    ? `\n\nOlder messages remain. To continue further back, read again with before="${transcript.nextCursor}".`
    : '\n\nThis reaches the start of the conversation.';

  return `${header}\n\n${transcript.messages.map(renderEntry).join('\n\n')}${more}`;
}
