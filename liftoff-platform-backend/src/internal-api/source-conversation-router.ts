// POST /api/internal/source-conversation
//
// The source conversation, for a Chief AI Officer asked to build on it.
//
// A team-plan thread that was brought in from another conversation cannot
// see that conversation: the CAIO runs in workforce-service, its thread lives
// in that service's database, and the only context that crosses a delegation
// is the short forwarded note. When a person has already DONE the work in the
// host conversation and asks for it to keep happening, that note is not
// enough — the CAIO would re-interview someone who just finished
// demonstrating what they want. This route hands over the substance: the
// conversation's speech and the browser trail that carries the mechanism —
// every recorded pane work call as the runtime recorded it
// (ListBrowserActivity, the ONE recorder for every surface), and, merged
// between them by time, the person's own takeover segments
// (ListTakeoverActivity): the pages, controls and non-protected values they
// used themselves.
//
// Three hosts. The delegate thread is resolved against the three pairing
// stores (source-host.ts): a Liftoff conversation, an Insights Manager
// conversation, or a team's chat. Each host's transcript is read through its
// own repository under the same budget, and the result says which
// (`sourceAssistant`: liftoff | insights | team). For the Liftoff host only,
// a third stream carries the legacy rows this service wrote before the
// runtime recorded (liftoff_browser_activity): read through the same
// sanitizer as everything else, and dropped by EXACT id when the runtime
// carries the same row, since the runtime's is authoritative. Nothing else is
// ever folded: two identical calls five seconds apart can be intentional and
// must both survive.
//
// Trust shape is mirror-router's, exactly: the caller is
// workforce-service (workforceServiceAuth at the mount), and it can only know
// a delegate thread id because it owns that thread. The pairing is resolved
// HERE, so a caller cannot name an arbitrary host thread; and the resolved
// thread is then read under the caller's tenant, so a stale or cross-tenant
// pairing answers 404 rather than leaking.
//
// Both 404s use one sentence on purpose — a wrong-tenant probe must read
// exactly like a thread that was never paired.
//
// The body is bounded. The transcript is a recent tail under a char budget
// (the rolling summary carries what the tail dropped), and the browser trail
// keeps its newest rows under its own budget, paged newest-first from every
// stream so an old, long thread is never loaded in full to return its last
// 20,000 characters. A row whose steps do not fit keeps its newest steps and
// says so (stepsTruncated); a trail that stopped short says so
// (browserActivityTruncated), which the reader treats as an older-range
// capture gap, never a complete record. Everything textual passes through
// redactSensitiveText before it leaves this service, and a row carries the
// flags that say what the protected data policy changed; the CAIO is told to
// treat the trail as observed, untrusted data.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { recordedUrl, sanitizeBrowserText } from '@liftoffos/redact';
import { log } from '../infrastructure/logging';
import { redactSensitiveText } from '../common/redact';
import { getThreadRollingSummary as getLiftoffRollingSummary } from '../liftoff/chat-repository';
import { getThreadRollingSummary as getInsightsRollingSummary } from '../insights/chat-repository';
import { getThreadRollingSummary as getAgentRollingSummary } from '../agent-chat/chat-repository';
import { surfaceReader, type ChatSurface } from '../chat-recall/surfaces';
import {
  listBrowserActivityPage,
  NOT_ANSWERED_MARKER,
  PROTECTED_DATA_OMITTED_MARKER,
  TRUNCATED_MARKER,
  type BrowserActivityCursor,
  type BrowserActivityRow,
} from '../liftoff/browser-activity';
import {
  activityStream,
  costOf,
  fitRow,
  holdStream,
  takeoverRowOut,
  type ActivityOut,
  type AssistantActivityOut,
  type NewestFirst,
} from '../browser-sessions/takeover-activity';
import { findHostByDelegateThread, type SourceHost } from './source-host';

export const liftoffSourceConversationRouter = Router();

const bodySchema = z.object({
  tenantId: z.string().uuid(),
  delegateThreadId: z.string().uuid(),
});

/** What the tool result can afford. The transcript tail dominates; the rolling
 *  summary covers whatever the budget drops. */
const TRANSCRIPT_CHAR_BUDGET = 50_000;
/** The trail is denser than speech, so it gets a budget of its own rather than
 *  competing with the transcript for the same one. Counted on the SERIALIZED
 *  array — timestamps, control names, steps and JSON overhead included. */
const BROWSER_ACTIVITY_CHAR_BUDGET = 20_000;
/** Legacy trail rows per page from this database. Small on purpose: the
 *  budget is usually spent within a page or two, and the point of paging is
 *  to stop. */
const ACTIVITY_PAGE_SIZE = 50;
/** How far back the runtime stream is read to look for a legacy row's twin:
 *  a legacy row is written after its runtime twin, within seconds. */
const LEGACY_TWIN_WINDOW_MS = 5 * 60 * 1000;

const NOT_PAIRED = 'This conversation was not brought in from a Liftoff, Insights Manager or agent conversation.';

/** What the tool result names the host as. */
const SOURCE_ASSISTANT: Record<SourceHost, 'liftoff' | 'insights' | 'team'> = {
  liftoff: 'liftoff',
  insights: 'insights',
  agent: 'team',
};

/** Which registry surface each delegation host is. */
const HOST_SURFACE: Record<SourceHost, ChatSurface> = {
  liftoff: 'liftoff',
  insights: 'insights',
  agent: 'team',
};

/** The rolling summary covers whatever the transcript budget dropped, and each
 *  host keeps its own. */
const HOST_ROLLING_SUMMARY: Record<SourceHost, (threadId: string, tenantId: string) => Promise<unknown>> = {
  liftoff: getLiftoffRollingSummary,
  insights: getInsightsRollingSummary,
  agent: getAgentRollingSummary,
};

// ── The legacy stream (Liftoff host only) ─────────────────────────────────

/** A row this service wrote before the runtime recorded, read through the
 *  same sanitizer as everything else, with the omission and truncation flags
 *  set explicitly: from this pass when it changed a string, and from the
 *  textual markers the fallback writer put inside its columns, so every
 *  legacy row carries the same structured signal a runtime row does and a
 *  historic raw navigation URL cannot bypass the policy. An outcome that
 *  begins with the not-answered marker is a capture gap. */
function legacyRowOut(row: BrowserActivityRow): AssistantActivityOut {
  const notAnswered = row.outcome.startsWith(NOT_ANSWERED_MARKER);
  const marked = (text: string) => ({
    omitted: text.includes(PROTECTED_DATA_OMITTED_MARKER),
    truncated: text.includes(TRUNCATED_MARKER),
  });
  const instructionMarks = marked(row.instruction);
  const outcomeMarks = marked(row.outcome);
  const instruction = row.tool === 'navigate_browser_session'
    ? (() => { const u = recordedUrl(row.instruction); return { text: u.text, truncated: u.truncated, protectedDataOmitted: u.protectedDataOmitted }; })()
    : sanitizeBrowserText(row.instruction);
  const outcome = sanitizeBrowserText(row.outcome);
  const instructionText = redactSensitiveText(instruction.text);
  const outcomeText = redactSensitiveText(outcome.text);
  return {
    id: row.id,
    tool: row.tool,
    instruction: instructionText,
    outcome: outcomeText,
    personTookOver: row.personTookOver,
    steps: row.steps === null
      ? null
      : row.steps.map((step) => {
        const action = sanitizeBrowserText(step.action);
        const pageUrl = recordedUrl(step.pageUrl);
        const actionText = redactSensitiveText(action.text);
        const pageUrlText = redactSensitiveText(pageUrl.text);
        return {
          type: step.type,
          action: actionText,
          pageUrl: pageUrlText,
          actionTruncated: action.truncated,
          pageUrlTruncated: pageUrl.truncated,
          protectedDataOmitted: action.protectedDataOmitted || actionText !== action.text,
          protectedKind: action.protectedDataOmitted || actionText !== action.text ? 'sensitive_text' : '',
          pageUrlProtectedDataOmitted: pageUrl.protectedDataOmitted || pageUrlText !== pageUrl.text,
          at: null,
        };
      }),
    createdAt: row.createdAt,
    instructionTruncated: instruction.truncated || instructionMarks.truncated,
    outcomeTruncated: outcome.truncated || outcomeMarks.truncated,
    instructionProtectedDataOmitted: instruction.protectedDataOmitted || instructionText !== instruction.text || instructionMarks.omitted,
    outcomeProtectedDataOmitted: outcome.protectedDataOmitted || outcomeText !== outcome.text || outcomeMarks.omitted,
    captureGap: notAnswered,
    gapReason: notAnswered ? 'not_answered' : '',
  };
}

interface LegacyItem {
  row: AssistantActivityOut;
  createdAt: Date;
  order: number;
}

function legacyStream(tenantId: string, threadId: string): NewestFirst<LegacyItem> {
  let buffer: LegacyItem[] = [];
  let cursor: BrowserActivityCursor | undefined;
  let more = true;
  let started = false;
  let order = 0;
  const fill = async () => {
    if (buffer.length > 0 || !more) return;
    if (started && !cursor) { more = false; return; }
    started = true;
    const page = await listBrowserActivityPage(tenantId, threadId, { limit: ACTIVITY_PAGE_SIZE, before: cursor });
    buffer = page.rows.map((row) => ({ row: legacyRowOut(row), createdAt: new Date(row.createdAt), order: order++ }));
    more = page.hasMore;
    const last = page.rows[page.rows.length - 1];
    cursor = last ? { createdAt: last.createdAt, id: last.id } : undefined;
  };
  return {
    async peek() { await fill(); return buffer[0] ?? null; },
    async pop() { await fill(); return buffer.shift() ?? null; },
    hasMore: () => buffer.length > 0 || more,
  };
}

/** A stream that answers nothing: the legacy rows on a host that never had
 *  them. */
function emptyStream<T>(): NewestFirst<T> {
  return { peek: async () => null, pop: async () => null, hasMore: () => false };
}

// ── The route ─────────────────────────────────────────────────────────────

liftoffSourceConversationRouter.post(
  '/',
  async (req: Request, res: Response) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    }
    const { tenantId, delegateThreadId } = parsed.data;

    try {
      const pairing = await findHostByDelegateThread(tenantId, delegateThreadId);
      if (!pairing) {
        return res.status(404).json({ error: NOT_PAIRED });
      }

      // Read under the caller's tenant. Each host's getThread scopes the query
      // and double-checks the row's tenant, so a pairing that resolves into
      // another tenant's thread — or a deleted one — is a miss, not a leak.
      // Read under the caller's tenant. The registry's resolveThread scopes the
      // query and re-checks the row's tenant, so a pairing that resolves into
      // another tenant's thread — or a deleted one — is a miss, not a leak.
      const threadId = pairing.threadId;
      const reader = surfaceReader(HOST_SURFACE[pairing.host]);
      const thread = await reader.resolveThread(tenantId, threadId);
      if (!thread) return res.status(404).json({ error: NOT_PAIRED });
      const transcript = await reader.collect(tenantId, thread.id, {
        charBudget: TRANSCRIPT_CHAR_BUDGET,
      });
      const rollingSummary = await HOST_ROLLING_SUMMARY[pairing.host](thread.id, tenantId);

      // The browser trail: the runtime's activity, the person's takeover
      // holds and, for the Liftoff host only, the legacy rows this service
      // wrote before the runtime recorded; a k-way merge newest-first by
      // time, kept under the budget, then flipped to the order the work
      // happened in.
      const runtime = activityStream(tenantId, threadId);
      const holds = holdStream(tenantId, threadId);
      const legacy = pairing.host === 'liftoff' ? legacyStream(tenantId, threadId) : emptyStream<LegacyItem>();
      const browserActivity: ActivityOut[] = [];
      let browserActivityTruncated = false;
      // The array's own brackets are paid up front; each row pays its comma.
      let trailSpent = 2;
      for (;;) {
        const [r, h, l] = await Promise.all([runtime.peek(), holds.peek(), legacy.peek()]);
        if (!r && !h && !l) break;
        // Newer first. On the same instant a runtime row goes first (it is
        // the call that was interrupted), then a legacy row, then holds in
        // the order the runtime returned them — a stable choice, so paging
        // cannot reorder.
        const rt = r ? r.createdAt.getTime() : -Infinity;
        const ht = h ? h.startedAt.getTime() : -Infinity;
        const lt = l ? l.createdAt.getTime() : -Infinity;
        let candidate: ActivityOut;
        if (h && ht > rt && ht > lt) {
          candidate = takeoverRowOut((await holds.pop())!);
        } else if (l && lt > rt) {
          const item = (await legacy.pop())!;
          // Dedupe by EXACT id only: the runtime's row is authoritative for a
          // call both recorded. Nothing else is ever folded.
          const twin = await runtime.hasId(item.row.id, new Date(item.createdAt.getTime() - LEGACY_TWIN_WINDOW_MS));
          if (twin) continue;
          candidate = item.row;
        } else {
          candidate = (await runtime.pop())!.row;
        }
        const fitted = fitRow(candidate, BROWSER_ACTIVITY_CHAR_BUDGET - trailSpent);
        if (!fitted) {
          browserActivityTruncated = true;
          break;
        }
        if (fitted.truncated) browserActivityTruncated = true;
        trailSpent += costOf(fitted.row);
        browserActivity.unshift(fitted.row);
      }
      if (runtime.hasMore() || holds.hasMore() || legacy.hasMore()) browserActivityTruncated = true;

      return res.json({
        sourceAssistant: SOURCE_ASSISTANT[pairing.host],
        rollingSummary,
        messages: transcript.messages.map(({ speaker, text, attachments }) => ({ speaker, text, attachments })),
        truncated: transcript.truncated,
        browserActivity,
        browserActivityTruncated,
      });
    } catch (err) {
      log.error(
        { tenantId, delegateThreadId, error: (err as Error).message },
        'liftoff source-conversation route failed',
      );
      return res.status(500).json({ error: 'Could not read the source conversation' });
    }
  },
);
