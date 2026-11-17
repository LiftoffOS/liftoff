// Compaction for the engines whose conversation history WE hold.
//
// context-pressure.ts measures and warns; it deliberately does not compact. That
// left the OpenAI / OpenRouter / Gemini loops — the ones running through
// `runConversationalTurnsViaAdapter`, where the platform owns the history — with
// two outcomes once a conversation grew past the window: one nudge asking the
// model to be briefer, and then a run ended by the platform with an escalation.
// The Anthropic, Codex, opencode and ADK engines never reach either, because
// their SDKs compact their own sessions (`adapter.managesOwnContext === true`).
//
// So the engines that cannot compact were the only ones with nothing compacting
// for them. This is that missing half.
//
// SHAPE, taken from the compactor already in this repo rather than invented:
// gemini-adk's `TokenBasedContextCompactor` summarizes once past a threshold and
// retains the most recent turns verbatim. The same two decisions are made here.
// What is NOT taken from it is its retention COUNT: 20 events is right for the
// ADK's own event stream and means nothing here, where one message can be four
// characters or forty thousand. Retention is a character budget derived from the
// ratios context-pressure already calibrated, so compaction lands the run under
// the pressure line instead of hoping twenty messages happen to fit.
//
// THE SUMMARIZER IS THE ONE WE ALREADY HAVE. `compressForPrompt` is an LLM pass
// whose prompt names what must survive: "Identifiers: ids, URLs, slugs, codes,
// versions". That is not incidental here, it is load-bearing. The context-pressure
// nudge tells the model that its shell and Node sessions are "still open under the
// same ids" — true of the sessions, and useless if compaction threw the ids away.
// A summarizer written fresh for this file would have had to re-derive that
// requirement, and its own timeout, fallback and cost attribution with it.
//
// FAIL CLOSED, which is the opposite of what `compressForPrompt` does on its own.
// Its contract is to return the deterministic `truncateForPrompt` bound whenever
// the semantic pass does not happen, so the caller can use the result
// unconditionally. That is right for a single oversized value and wrong for a
// conversation: `truncateForPrompt` keeps ten array items at 200 characters each,
// so an eighty-message history would come back as ten fragments and the run would
// carry on believing that was its past. When the semantic pass did not happen we
// return null and today's behaviour stands — the nudge, or the escalation.
//
// EVERY OLDER TURN IS REPRESENTED. A head too large for one summarizer prompt is
// folded in chronological chunks, each pass seeing the summary so far — so the
// oldest turns reach the final summary through it rather than being cut off at a
// cap. The chunk count is bounded (a run in trouble cannot spend unbounded
// latency on its own rescue), and only past that bound is anything dropped, with
// the count named in the summary the model reads.
//
// CANONICAL RECORD (ADR-006). Nothing here can corrupt a replay, and the reason is
// structural rather than careful: the canonical transcript is built by the
// trajectory recorder from adapter OUTPUT events plus one explicit
// `recordCanonicalMessage` for the current user turn. It is never built from
// `state.conversationHistory`, which is what this module rewrites. The one seam
// that reads both is that user-turn capture, and context-pressure's
// `isMidRunPlatformTurn` is what keeps this summary — and the pressure nudge
// beside it — out of it. That predicate lives there rather than here on purpose:
// the record it protects is corrupted by the NUDGE whether or not compaction is
// switched on, so the fix must not depend on this module.

import type { PlatformMessage } from './adapter/types';
import type { ConversationMessage } from './types';
import { compressForPrompt, semanticCompressionEnabled } from './engine/compress-for-prompt';
import { truncateForPrompt } from './engine/truncate-for-prompt';
import {
  estimateHistoryChars,
  estimatePlatformMessageChars,
  COMPACTION_SUMMARY_HEADER,
  CONTEXT_PRESSURE_RATIOS,
} from './context-pressure';
import { logger } from '../infrastructure/logging';

export function historyCompactionEnabled(): boolean {
  return process.env.HISTORY_COMPACTION_ENABLED === '1';
}

/** Explicit operator override for the retained tail, as a message COUNT.
 *  Unset — the normal case — means retention is decided by the character budget
 *  below, which is the only one of the two that knows how big a message is. */
function retainCountOverride(): number | undefined {
  const raw = Number(process.env.HISTORY_COMPACT_RETAIN);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : undefined;
}

/** Smallest retained tail, in messages, whatever the budget says.
 *
 *  Four, because that is one intact exchange: a user turn, the assistant turn
 *  answering it, a tool call and its result. Retaining fewer can cut a
 *  round-trip in half, and a model handed a tool result whose call it can no
 *  longer see will re-issue the call. A structural floor, not a tuned one. */
const RETAIN_FLOOR_MESSAGES = 4;

/** Share of the retention budget reserved for the summary.
 *
 *  A tenth: enough for a dense recap of a long run, and small enough that the
 *  thing replacing the old turns cannot become the reason the next compaction
 *  fires. Bounded at both ends so a tiny window still gets a usable summary and a
 *  1M-token window does not get a 50,000-character one nobody reads. */
const SUMMARY_BUDGET_SHARE = 0.1;
const MIN_SUMMARY_CHARS = 4_000;
const MAX_SUMMARY_CHARS = 20_000;

/**
 * What the conversation must fit into after compaction, in characters.
 *
 * `PRESSURE_RATIO` is the level at which context-pressure already decided a
 * conversation is heavy — the same number it nudges on. Landing there rather than
 * at some fresh fraction means compaction aims at the line the rest of the system
 * measures against, and one number moves both.
 */
export function retentionBudgetChars(windowChars: number): number {
  return Math.floor(windowChars * CONTEXT_PRESSURE_RATIOS.PRESSURE_RATIO);
}

export function summaryBudgetChars(windowChars: number): number {
  const derived = Math.floor(retentionBudgetChars(windowChars) * SUMMARY_BUDGET_SHARE);
  return Math.min(MAX_SUMMARY_CHARS, Math.max(MIN_SUMMARY_CHARS, derived));
}

/** How much of ONE message is shown to the summarizer.
 *
 *  2,000 characters, the same preview the tool-result spill leaves inline when it
 *  parks a result to disk — enough to see what a turn was about, and the point
 *  past which more text stops changing the summary. */
const PER_MESSAGE_RENDER_CHARS = 2_000;

/** Ceiling on ONE summarizer prompt, as a multiple of its output budget.
 *  A summarizer prompt that itself overflows a window is the failure this module
 *  exists to prevent, arriving by another door. */
const SUMMARY_INPUT_RATIO = 15;

/** Most summarizer passes one compaction may spend.
 *
 *  Each pass carries `compressForPrompt`'s own 10-second ceiling, so this is also
 *  the latency bound: four passes is at most forty seconds added to a run that
 *  would otherwise be nudged into brevity or ended outright. At the input cap
 *  those four passes cover roughly 1.2M characters of prior conversation, which
 *  is past every window we send to. */
const MAX_SUMMARY_PASSES = 4;

/** Named when the oldest turns did not fit even the chunked fold.
 *  A cap nobody is told about reads as complete coverage. */
function droppedNotice(count: number): string {
  return `\n\n[The oldest ${count} turns predate this record and are not represented above.]`;
}

export interface CompactionInput {
  /** Cross-engine history rebuilt from the canonical record. Sent ahead of
   *  `history`, so these are the OLDEST turns. */
  rebuilt: PlatformMessage[];
  /** This run's own conversation. */
  history: ConversationMessage[];
  /** Window the caller is trying to fit, in characters. */
  windowChars: number;
  attribution: { tenantId: string; agentId?: string; invocationId?: string };
}

export type CompactionDeclineReason =
  /** The summarizer this depends on is switched off, so there is no summary to
   *  compact to. Distinct from the others because it is a MISCONFIGURATION —
   *  compaction is on and cannot ever fire — not a property of this run. */
  | 'semantic_compression_disabled'
  /** The pass ran and fell back to the deterministic bound. */
  | 'no_semantic_summary'
  /** Nothing older than the retained tail, or the split would orphan a tool
   *  result, or the result would not be smaller. */
  | 'nothing_to_compact';

export interface CompactionResult {
  rebuilt: PlatformMessage[];
  history: ConversationMessage[];
  /** How many messages the summary represents. */
  summarizedMessages: number;
  /** Oldest messages that did not fit even the chunked fold, named as missing in
   *  the summary itself. Zero in every ordinary case. */
  droppedMessages: number;
  /** Summarizer passes spent. One in the ordinary case. */
  summaryPasses: number;
  beforeChars: number;
  afterChars: number;
}

type Entry =
  | { kind: 'rebuilt'; msg: PlatformMessage }
  | { kind: 'history'; msg: ConversationMessage };

/** Render one message for the summarizer. Tool calls and results are named
 *  rather than reproduced: what the summary needs from them is that they
 *  happened and what they were about. */
function renderEntry(entry: Entry): { role: string; text: string } {
  if (entry.kind === 'history') {
    // `content` is typed a string and is not always one at runtime: the caller
    // serializes a non-string before sending it, and `estimateHistoryChars`
    // carries the same tolerance. Trusting the type here would throw on the
    // slice and take the whole compaction down with it.
    const text = typeof entry.msg.content === 'string'
      ? entry.msg.content
      : truncateForPrompt(entry.msg.content, PER_MESSAGE_RENDER_CHARS);
    return { role: entry.msg.role, text: bound(text) };
  }
  const parts: string[] = [];
  for (const block of entry.msg.content) {
    if (block.type === 'text') {
      parts.push(block.text);
    } else if (block.type === 'tool_use') {
      parts.push(`[called ${block.toolName} with ${truncateForPrompt(block.args, 400)}]`);
    } else if (block.type === 'media') {
      // Compaction renders history as TEXT for a summarizer to read, so media
      // cannot survive it as media. It survives as a note that it was there: a
      // summary that silently omits the picture the whole exchange was about
      // reads as though the person never sent one.
      const kind = block.mimeType.startsWith('video/') ? 'a video' : 'an image';
      parts.push(`[the person attached ${kind} (${block.mimeType})${block.alt ? `: ${bound(block.alt)}` : ''}]`);
    } else {
      parts.push(
        block.error
          ? `[tool result for ${block.callId} failed: ${bound(block.error)}]`
          : `[tool result for ${block.callId}: ${truncateForPrompt(block.result, 400)}]`,
      );
    }
  }
  return { role: entry.msg.role, text: bound(parts.join('\n')) };
}

function bound(text: string): string {
  return text.length <= PER_MESSAGE_RENDER_CHARS
    ? text
    : `${text.slice(0, PER_MESSAGE_RENDER_CHARS)}…[${text.length - PER_MESSAGE_RENDER_CHARS} more characters]`;
}

/** What one entry costs against the retention budget. The same measurement the
 *  caller's pressure assessment uses, so "retained fits the budget" means the
 *  same thing in both places. */
function entryChars(entry: Entry): number {
  return entry.kind === 'rebuilt'
    ? estimatePlatformMessageChars([entry.msg])
    : estimateHistoryChars([entry.msg]);
}

/** Tool-call ids a rebuilt message opens, and the ones it answers.
 *  History messages never carry tool blocks into the invocation input — the
 *  caller flattens each to a single text block — so only rebuilt messages can
 *  hold a pair. */
function toolIds(entry: Entry): { uses: string[]; results: string[] } {
  if (entry.kind === 'history') return { uses: [], results: [] };
  const uses: string[] = [];
  const results: string[] = [];
  for (const block of entry.msg.content) {
    if (block.type === 'tool_use') uses.push(block.callId);
    else if (block.type === 'tool_result') results.push(block.callId);
  }
  return { uses, results };
}

/**
 * Where the retained tail begins.
 *
 * The tail is the most recent messages that fit the retention budget, with a
 * structural floor so a single enormous message cannot leave the model with no
 * recent context at all. An explicit operator count overrides the budget.
 */
function splitForBudget(entries: Entry[], retainBudget: number): number {
  const override = retainCountOverride();
  if (override !== undefined) return Math.max(0, entries.length - override);

  let used = 0;
  let split = entries.length;
  for (let i = entries.length - 1; i >= 0; i--) {
    const cost = entryChars(entries[i]);
    const retained = entries.length - i;
    if (used + cost > retainBudget && retained > RETAIN_FLOOR_MESSAGES) break;
    used += cost;
    split = i;
  }
  return split;
}

/**
 * Move the split earlier until no retained message answers a tool call that the
 * summary would have swallowed.
 *
 * An orphaned `tool_result` is the exact shape that makes a provider reject a
 * conversation (ADR-006 §4 rule 2 synthesizes results for the inverse case), so a
 * compaction that produced one would trade a window overflow for a hard 400.
 *
 * Only ever moves messages OUT of the summary and into the retained tail, so it
 * terminates: the split decreases on every iteration and stops at zero.
 */
function splitWithoutOrphans(entries: Entry[], initialSplit: number): number {
  let split = initialSplit;
  for (;;) {
    if (split <= 0) return 0;
    const openedInHead = new Set<string>();
    for (let i = 0; i < split; i++) {
      for (const id of toolIds(entries[i]).uses) openedInHead.add(id);
    }
    let orphaned = false;
    for (let i = split; i < entries.length; i++) {
      if (toolIds(entries[i]).results.some((id) => openedInHead.has(id))) {
        orphaned = true;
        break;
      }
    }
    if (!orphaned) return split;
    split -= 1;
  }
}

type Rendered = { role: string; text: string };

/** Split the head into chronological chunks, each within one summarizer prompt.
 *  A single message larger than the cap still becomes its own chunk: it has
 *  already been bounded to PER_MESSAGE_RENDER_CHARS, and dropping it to respect a
 *  cap it cannot meet would lose a turn for an arithmetic reason. */
function chunkForSummarizer(rendered: Rendered[], inputCap: number): Rendered[][] {
  const chunks: Rendered[][] = [];
  let current: Rendered[] = [];
  let used = 0;
  for (const r of rendered) {
    const cost = r.role.length + r.text.length + 16;
    if (current.length > 0 && used + cost > inputCap) {
      chunks.push(current);
      current = [];
      used = 0;
    }
    current.push(r);
    used += cost;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Replace the oldest turns with one summary, keeping the most recent verbatim.
 *
 * Returns null — meaning "do not compact, today's behaviour stands" — when the
 * flag is off, the summarizer it depends on is off, there is nothing old enough
 * to be worth summarizing, the split cannot be taken without orphaning a tool
 * result, a semantic pass did not happen, or the result would not be smaller.
 *
 * Never throws: a compaction failure must leave the run exactly as it was.
 */
export async function compactConversation(
  input: CompactionInput,
): Promise<CompactionResult | null> {
  if (!historyCompactionEnabled()) return null;

  // Checked BEFORE any work, and reported as its own reason. This module cannot
  // compact without a semantic summary, so the two flags disagreeing is a
  // configuration that silently does nothing — the failure mode that kept the
  // verify gate dead for a quarter. One log line makes it a fact somebody can
  // see rather than an absence.
  if (!semanticCompressionEnabled()) {
    decline(input, 'semantic_compression_disabled', input.rebuilt.length + input.history.length);
    return null;
  }

  try {
    const entries: Entry[] = [
      ...input.rebuilt.map((msg): Entry => ({ kind: 'rebuilt', msg })),
      ...input.history.map((msg): Entry => ({ kind: 'history', msg })),
    ];
    if (entries.length <= RETAIN_FLOOR_MESSAGES) return null;

    const retainBudget = retentionBudgetChars(input.windowChars);
    const budget = summaryBudgetChars(input.windowChars);
    // The summary lives inside the retention budget, so what the tail may occupy
    // is what is left after room is made for it.
    const split = splitWithoutOrphans(
      entries,
      splitForBudget(entries, Math.max(0, retainBudget - budget)),
    );
    if (split <= 0) return null;

    const head = entries.slice(0, split);
    const tail = entries.slice(split);

    // The run's own objective is kept VERBATIM, never summarized.
    //
    // Two reasons, and the second is the one that would have hurt. A run whose
    // task has been paraphrased is a run that can drift off it. And the canonical
    // record captures this run's user turn as the last user message of what is
    // sent (ADR-006 §3b): summarize the objective away and a long conversation
    // has no user turn left to capture, so the record goes assistant-only — the
    // exact defect the rebuild canary counts as `halfConversations`, manufactured
    // by the thing meant to keep the run alive.
    //
    // Only relevant when the split falls inside this run's own history; if any
    // REBUILT turn is retained then every history turn is already in the tail.
    const anchorIndex = head.findIndex((e) => e.kind === 'history' && e.msg.role === 'user');
    const anchor = anchorIndex >= 0 ? head[anchorIndex] : undefined;
    const summarizable = anchor ? head.filter((_, i) => i !== anchorIndex) : head;
    if (summarizable.length === 0) return null;

    const inputCap = budget * SUMMARY_INPUT_RATIO;
    const rendered = summarizable.map(renderEntry);
    let chunks = chunkForSummarizer(rendered, inputCap);

    // Only past the pass bound is anything actually lost, and the oldest goes
    // first: the turns closest to the retained tail are the ones the model is
    // most likely to still need.
    let droppedMessages = 0;
    if (chunks.length > MAX_SUMMARY_PASSES) {
      const dropped = chunks.slice(0, chunks.length - MAX_SUMMARY_PASSES);
      droppedMessages = dropped.reduce((n, c) => n + c.length, 0);
      chunks = chunks.slice(chunks.length - MAX_SUMMARY_PASSES);
    }
    if (chunks.length === 0) return null;

    // Fold the chunks in order, each pass seeing the summary so far, so the
    // oldest turns reach the final summary through it rather than being cut.
    let summary = '';
    for (const chunk of chunks) {
      const payload = summary
        ? [{ role: 'summary-so-far', text: summary }, ...chunk]
        : chunk;
      // `compressForPrompt` returns exactly `truncateForPrompt(value, budget)` on
      // every path where the semantic pass did not happen — empty response,
      // over-budget response, error, timeout. Computing the same bound here and
      // comparing is how this module tells "summarized" from "fell back", which
      // its contract has no other way to report.
      const deterministic = truncateForPrompt(payload, budget);
      const pass = await compressForPrompt(payload, {
        maxChars: budget,
        attribution: input.attribution,
        purpose: 'history-compaction',
      });
      if (!pass || pass === deterministic) {
        decline(input, 'no_semantic_summary', head.length);
        return null;
      }
      summary = pass;
    }

    const summaryText = `${COMPACTION_SUMMARY_HEADER}\n\n${summary}`
      + (droppedMessages > 0 ? droppedNotice(droppedMessages) : '');

    // The summary sits where the turns it replaces sat: at the front, ahead of
    // everything retained. Which array holds it follows from where the tail
    // starts, so the two arrays stay in conversation order when the caller
    // concatenates them.
    const tailRebuilt = tail
      .filter((e): e is { kind: 'rebuilt'; msg: PlatformMessage } => e.kind === 'rebuilt')
      .map((e) => e.msg);
    const tailHistory = tail
      .filter((e): e is { kind: 'history'; msg: ConversationMessage } => e.kind === 'history')
      .map((e) => e.msg);

    // Summary, then the objective it did not touch, then the retained tail.
    // Chronological: the anchor is older than everything retained and newer than
    // most of what the summary covers, so reading it back in order still reads as
    // the conversation that happened.
    const anchorMsg = anchor?.kind === 'history' ? anchor.msg : undefined;

    const outRebuilt: PlatformMessage[] = tailRebuilt.length > 0
      ? [{ role: 'user', content: [{ type: 'text', text: summaryText }] }, ...tailRebuilt]
      : [];
    const outHistory: ConversationMessage[] = tailRebuilt.length > 0
      ? tailHistory
      : [
        { role: 'user', content: summaryText },
        ...(anchorMsg ? [anchorMsg] : []),
        ...tailHistory,
      ];

    const beforeChars = estimatePlatformMessageChars(input.rebuilt)
      + estimateHistoryChars(input.history);
    const afterChars = estimatePlatformMessageChars(outRebuilt)
      + estimateHistoryChars(outHistory);
    // A compaction that grew the conversation is not a compaction. Possible when
    // the head was short and the summary header is longer than what it replaced.
    if (afterChars >= beforeChars) return null;

    return {
      rebuilt: outRebuilt,
      history: outHistory,
      summarizedMessages: summarizable.length - droppedMessages,
      droppedMessages,
      summaryPasses: chunks.length,
      beforeChars,
      afterChars,
    };
  } catch (err) {
    // Compaction is an optimisation on a run that is already in trouble. A
    // failure here must leave that run exactly as it would have been.
    logger.warn(
      { err: (err as Error).message, tenantId: input.attribution.tenantId },
      'history compaction failed — leaving the conversation as it was',
    );
    return null;
  }
}

/** One line per run that reached compaction and did not get it. Without this,
 *  "compaction is rare" and "compaction cannot fire at all" look identical,
 *  which is the failure the verify-on-stop gate spent a quarter in. */
function decline(
  input: CompactionInput,
  reason: CompactionDeclineReason,
  candidateMessages: number,
): void {
  logger.info(
    {
      event: 'history_compaction_declined',
      tenantId: input.attribution.tenantId,
      agentId: input.attribution.agentId,
      invocationId: input.attribution.invocationId,
      candidateMessages,
      reason,
    },
    'history compaction declined',
  );
}
