// conversations__list / conversation__read
//
// A person works with the Chief AI Officer across one or more conversations —
// it browses, reads, runs capabilities, acts on the data — and then asks for
// that work to be automated. The plan for the standing team is drafted from
// what was actually done, which lives in this service's own thread store:
// the transcript, and since migration 025 the trail of tool calls each turn
// made. The CAIO could see neither its earlier conversations nor its own
// trail; these two tools are that window.
//
// VISIBILITY IS THE PRODUCT'S, NOT A NEW ONE. Team-plan threads are shared in
// the workspace: any member may open any thread (the GET route checks tenant
// membership only), several people take part in one thread, and a link can
// be shared. So the CAIO reads whatever the person asking could open
// themselves — any thread in the workspace, and the current one always — and
// lists what the history page would show them: every thread for an owner or
// admin, their own for a member. A stricter rule here would tell a colleague
// who joined a thread, or an admin, that it does not exist.
//
// The read returns the transcript and a WORK RECORD: the trail rendered
// deterministically as an ordered list of what was done, one line per call,
// with a browser task's own steps as sub-lines and, in their place in time,
// the segments the person drove the browser themselves (read from
// platform-backend's takeover endpoint, which reads the runtime's holds for
// this thread), ready to be carried into the plan's workflows section as is.
// The model keeps the judgement — role, responsibilities, connectors, the
// delta questions — and not the transcription. The takeover read never fails
// the conversation read: when it fails, `takeoversUnavailable` says so and
// the record is returned without the segments.
//
// The read is bounded, because it lands in the model's context whole and is
// re-sent on every round of the turn that made it. The work record is the
// compact form and is always complete; the transcript keeps the most recent
// messages whole up to a budget and says how many older ones it left out.
// A turn's trail is not repeated inside the transcript — a message names the
// work-record steps it made instead — since the same trail rendered twice
// was most of what a long conversation cost to read.

import { log } from '../../infrastructure/logging.js';
import { loadConfig } from '../../infrastructure/config.js';
import {
  getThread,
  getThreadRollingSummary,
  listMessages,
  listThreads,
} from '../chat-repository.js';
import { buildWorkRecord, renderWorkRecord, type TakeoverSegment } from '../work-record.js';
import type { WorkforcePlanTool, WorkforcePlanToolContext } from './types.js';

export { renderWorkRecord };

const LIST_LIMIT = 20;
const READ_LIMIT = 200;
/** Characters of transcript text a read carries, newest messages first. */
const TRANSCRIPT_CHARS = 40_000;

/**
 * The person's own browser segments on a thread, oldest first, from
 * platform-backend (which reads the runtime's holds). Any failure answers
 * null: the conversation read never fails over it.
 */
export async function readTakeovers(
  tenantId: string,
  threadId: string,
): Promise<{ takeovers: TakeoverSegment[]; truncated: boolean } | null> {
  const baseUrl = loadConfig().PLATFORM_BACKEND_URL.replace(/\/$/, '');
  const secret = loadConfig().WORKFORCE_SERVICE_TOKEN;
  try {
    const resp = await fetch(`${baseUrl}/api/internal/assistant-browser/takeovers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Service-Auth': secret },
      body: JSON.stringify({ tenantId, threadId }),
    });
    if (!resp.ok) {
      log.warn({ threadId, status: resp.status }, 'conversation__read: the takeover segments could not be read');
      return null;
    }
    const body = await resp.json() as { takeovers?: unknown; truncated?: unknown };
    if (!Array.isArray(body.takeovers)) return null;
    return { takeovers: body.takeovers as TakeoverSegment[], truncated: body.truncated === true };
  } catch (err) {
    log.warn({ threadId, error: (err as Error).message }, 'conversation__read: the takeover read failed');
    return null;
  }
}

interface TranscriptMessage {
  speaker: 'person' | 'you';
  text: string;
  attachments: string[];
  /** The work-record step numbers this turn made, in order. Only assistant
   *  turns have any. */
  steps: number[];
}

export const conversationsListTool: WorkforcePlanTool = {
  definition: {
    name: 'conversations__list',
    description:
      'List the conversations with you this person can see (most recent first), so that when they ask to '
      + 'automate work done "the other day" or "in our last chat" you can find it. Returns each conversation\'s '
      + 'id, title, when it started and last moved, and whether a plan is already attached. Read the one they '
      + 'mean with conversation__read. Shows what their history page shows: every conversation for an owner or '
      + 'admin, their own for a member.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: `How many to list, most recent first (default ${LIST_LIMIT}).` },
      },
    },
  },
  async execute(input: Record<string, unknown>, ctx: WorkforcePlanToolContext): Promise<Record<string, unknown>> {
    const limit = typeof input.limit === 'number' && input.limit > 0 ? Math.min(input.limit, LIST_LIMIT) : LIST_LIMIT;
    // The caller's real role: listThreads applies the history page's own rule.
    const page = await listThreads(ctx.tenantId, ctx.accountId, ctx.role, { limit });
    const conversations = page.threads.map((t) => ({
      conversationId: t.id,
      title: t.title,
      startedAt: t.createdAt,
      lastMovedAt: t.updatedAt,
      startedByYou: t.accountId === ctx.accountId,
      isThisConversation: t.id === ctx.threadId,
      hasPlan: Boolean(t.workforcePlanId),
    }));
    return { conversations, moreExist: page.hasMore };
  },
};

export const conversationReadTool: WorkforcePlanTool = {
  definition: {
    name: 'conversation__read',
    description:
      'Read a conversation with you in full: what was said, what you DID in each turn (the sites you opened, '
      + 'the capabilities you ran and with which arguments, and what came back), and a work record: that trail '
      + 'rendered as an ordered list of steps, ready to carry into a plan\'s workflows section. The record holds, '
      + 'in their place in time, the segments the person drove the browser themselves: the pages they opened, '
      + 'the controls they used and the non-protected values they entered, with protected or truncated '
      + 'information marked rather than included, and a browser task\'s own steps as sub-lines. Use it when the '
      + 'person asks to automate or turn into an agent the work done in a conversation. Pass no conversationId '
      + 'to read this conversation; pass one from conversations__list for an earlier one.',
    input_schema: {
      type: 'object',
      properties: {
        conversationId: { type: 'string', description: 'A conversation id from conversations__list. Omit for this conversation.' },
      },
    },
  },
  async execute(input: Record<string, unknown>, ctx: WorkforcePlanToolContext): Promise<Record<string, unknown>> {
    const requested = typeof input.conversationId === 'string' && input.conversationId ? input.conversationId : ctx.threadId;
    if (!requested) return { found: false, message: 'There is no conversation to read.' };

    // Any thread in the workspace, as the open route allows. getThread is
    // tenant-scoped, so a thread from another workspace is simply not found.
    const thread = await getThread(requested, ctx.tenantId);
    if (!thread) return { found: false, message: 'No conversation with that id.' };

    const page = await listMessages(thread.id, ctx.tenantId, { limit: READ_LIMIT });
    const ordered = [...page.messages].reverse(); // listMessages returns newest first
    // The person's own segments on the thread being read, merged into the
    // record by time. A failed read is said, not hidden.
    const takeoverRead = await readTakeovers(ctx.tenantId, thread.id);
    const takeovers = takeoverRead?.takeovers ?? [];
    const record = buildWorkRecord(ordered, takeovers);
    const workRecord = record.lines;

    // Step numbers follow the work record: a turn's steps are the record
    // lines its trail produced, in order. A segment is not a message and
    // takes no place in the transcript.
    const all: TranscriptMessage[] = ordered.map((m, i) => ({
      speaker: m.role === 'user' ? 'person' : 'you',
      text: m.content,
      attachments: m.attachments.map((a) => a.name),
      steps: m.role === 'assistant' ? record.stepsByMessage[i] : [],
    }));
    // Newest first into the budget, whole messages only, then back in order.
    const kept: TranscriptMessage[] = [];
    let chars = 0;
    for (let i = all.length - 1; i >= 0; i--) {
      const cost = all[i].text.length;
      if (kept.length > 0 && chars + cost > TRANSCRIPT_CHARS) break;
      kept.unshift(all[i]);
      chars += cost;
    }
    const rollingSummary = await getThreadRollingSummary(thread.id, ctx.tenantId);

    return {
      found: true,
      conversationId: thread.id,
      title: thread.title,
      startedAt: thread.createdAt,
      startedByYou: thread.accountId === ctx.accountId,
      hasPlan: Boolean(thread.workforcePlanId),
      rollingSummary,
      transcript: kept,
      /** Older messages left out of the transcript for length; the work
       *  record still covers every turn. */
      transcriptOmitted: all.length - kept.length,
      transcriptTruncated: page.hasMore,
      workRecord,
      /** The segments the person drove the browser themselves, oldest
       *  first, as the record merged them. */
      takeovers,
      /** Older segments were left out of this read for length. */
      ...(takeoverRead?.truncated ? { takeoversTruncated: true } : {}),
      /** The segments could not be read: the record is returned without
       *  them and is not complete. */
      ...(takeoverRead === null ? { takeoversUnavailable: true } : {}),
    };
  },
};
