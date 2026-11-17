// Did this paragraph tell the person what the brief says?
//
// The verbatim half of this (brief-echo.ts) catches a colleague that reads the
// brief out word for word. It does not catch a paraphrase, and a paraphrase is
// the same leak: the person is still being told a note that was written about
// them, for another model.
//
// A similarity threshold was the obvious thing and is the wrong thing. There is
// no labelled corpus to pick one from, the two texts are ABOUT the same request
// by construction so lexical overlap is high on the legitimate case too, and a
// false positive here deletes a sentence of a real answer in front of the
// person. So the question goes to a reader that can answer it: a small model,
// given the brief AND the paragraph, asked the narrow question.
//
// This is not the output guard run twice. That guard reads a paragraph alone,
// against a general rubric, at temperature 0 — so a second identical read
// returns the identical verdict and buys nothing. This reader is handed
// something the guard has never seen: the actual text that must not come back
// out. That is a different question, and it is the easy one.
//
// Three properties make it safe to put in front of a person's reply:
//   - it can only REMOVE. Every sentence it returns must already appear in the
//     paragraph, checked here; a reader that invents or rewrites is discarded
//     and the paragraph stands.
//   - it fails open, with the same deadline and stand-aside as the output guard.
//     A small-model outage must not silence a colleague.
//   - its cost is the platform's, not the customer's: `brief_echo` is absorbed
//     like `output_guard`, because a safety control is not the customer's work.
//
// One call per prose paragraph of a delegated reply, and only while a brief
// exists — which is the same per-paragraph cost every other assistant surface
// already pays to the output guard.

import { llmClient } from '../llm';
import { log, logAudit } from '../infrastructure/logging';
import type { JSONSchema } from '../llm/types';

const SYSTEM_PROMPT = `You are checking one paragraph of a reply before a person reads it.

You are given BACKGROUND and a PARAGRAPH. The background is a private note one assistant wrote for another about this person's request. The person has never seen it and must never be told what it says.

Remove from the paragraph any sentence that:
- tells the person something the background says, or
- narrates a plan or an intention drawn from the background ("let me confirm this is right before advising them", "first I will check whether there is more detail"), or
- describes the handover itself, or what the other assistant asked for.

Keep every sentence that does the person's work: an answer, a finding, a question for them, a report of something that was done, an offer to do something. Covering the SAME SUBJECT as the background is not repeating it. The background is about their request, so almost every legitimate sentence will share its subject; that is not what you are looking for. You are looking for the person being handed the note instead of the work.

Rules you may not break:
- Return the kept sentences exactly as they appear in the paragraph, in the same order. Never reword, shorten, correct or join a sentence you keep.
- Never add a sentence, a transition or a word that is not in the paragraph.
- If nothing should be removed, return the paragraph unchanged with removed=false.
- Never remove or alter anything inside a fenced code block; return such a block exactly as it is.
- Removing the whole paragraph is allowed, and is the right answer when every sentence in it is the background.`;

const RESPONSE_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    removed: { type: 'boolean', description: 'true when at least one sentence was removed' },
    text: {
      type: 'string',
      description: 'The paragraph with those sentences removed, every kept sentence verbatim; unchanged when removed=false',
    },
  },
  required: ['removed', 'text'],
};

/** A paragraph reads in well under a second; past this the person has waited
 *  long enough and the verbatim-checked text goes out. Matches the output
 *  guard's, because a person waits on both in exactly the same way. */
const READ_DEADLINE_MS = 6_000;
const STAND_ASIDE_AFTER_FAILURES = 3;
const STAND_ASIDE_MS = 30_000;

let consecutiveFailures = 0;
let standingAsideUntil = 0;

/** Test seam: forget the failures seen so far. */
export function _resetBriefRestatementState(): void {
  consecutiveFailures = 0;
  standingAsideUntil = 0;
}

function readFailed(): void {
  consecutiveFailures += 1;
  if (consecutiveFailures >= STAND_ASIDE_AFTER_FAILURES && standingAsideUntil === 0) {
    standingAsideUntil = Date.now() + STAND_ASIDE_MS;
  }
}

function standingAside(): boolean {
  if (standingAsideUntil === 0) return false;
  if (Date.now() < standingAsideUntil) return true;
  standingAsideUntil = 0;
  consecutiveFailures = 0;
  return false;
}

/** The read, or a rejection at the deadline, or a rejection the moment the turn
 *  is abandoned — whichever comes first.
 *
 *  The turn's own signal is load-bearing and not a nicety. This runs inside a
 *  hand-over, which is where Stop and a lost reader both land: without it a
 *  person who pressed Stop, or a caller that closed the stream, waited out the
 *  full deadline on a provider that was never going to answer. A hand-over test
 *  that had taken 4 seconds took more than ten. */
async function withDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>,
  outer?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const abandon = (): void => controller.abort(new Error('brief_restatement_abandoned'));
  outer?.addEventListener('abort', abandon, { once: true });
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error('brief_restatement_deadline'));
      reject(new Error(`brief restatement read exceeded ${READ_DEADLINE_MS}ms`));
    }, READ_DEADLINE_MS);
    timer.unref?.();
  });
  const abandoned = new Promise<never>((_, reject) => {
    if (outer) {
      outer.addEventListener(
        'abort',
        () => reject(new Error('the turn was abandoned before the read finished')),
        { once: true },
      );
    }
  });
  try {
    return await Promise.race([run(controller.signal), deadline, abandoned]);
  } finally {
    if (timer) clearTimeout(timer);
    outer?.removeEventListener('abort', abandon);
  }
}

/** Sentences, for the only-ever-removes check. Deliberately the same crude
 *  split the verbatim reader uses: this is not parsing prose, it is asking
 *  whether each piece of what came back was already in what went in. */
const SENTENCE = /[^.!?]+(?:[.!?]+|$)/g;

/**
 * True when `after` contains only material that was already in `before`.
 *
 * The guarantee this enforces is narrow and absolute: this reader REMOVES. Any
 * sentence in the answer that is not in the paragraph means the model rewrote,
 * joined or invented, and the whole answer is discarded rather than reasoned
 * about. Whitespace is normalised because dropping a sentence changes the
 * spacing around the ones that remain.
 */
export function onlyRemoves(before: string, after: string): boolean {
  if (after.trim().length === 0) return true;
  const haystack = before.replace(/\s+/g, ' ');
  for (const raw of after.match(SENTENCE) ?? []) {
    const sentence = raw.replace(/\s+/g, ' ').trim();
    if (sentence.length === 0) continue;
    if (!haystack.includes(sentence)) return false;
  }
  return true;
}

export interface RestatementContext {
  tenantId: string;
  /** The colleague that wrote the paragraph, for the audit row. */
  speaker: string;
  threadId?: string;
  /** The turn's own signal. A stop, or a caller that walked away, abandons the
   *  read instead of waiting out its deadline. */
  abortSignal?: AbortSignal;
}

export interface RestatementResult {
  text: string;
  /** How many sentences went, for the audit. Never what they said. */
  removed: number;
}

/** Test seam. Production reads with the small tier. */
export type RestatementJudge = (
  paragraph: string,
  brief: string,
  signal: AbortSignal,
) => Promise<{ removed: boolean; text: string }>;

async function judgeWithModel(
  paragraph: string,
  brief: string,
  signal: AbortSignal,
  context: RestatementContext,
): Promise<{ removed: boolean; text: string }> {
  const usageContext: Record<string, string> = {
    tenantId: context.tenantId,
    purpose: 'brief_echo',
    speaker: context.speaker,
  };
  if (context.threadId) usageContext.threadId = context.threadId;

  const response = await llmClient.complete(
    {
      abortSignal: signal,
      messages: [
        // The rubric is the same bytes on every paragraph, and the texts sit
        // after it, so the prefix is cached where the provider caches.
        { role: 'system', content: SYSTEM_PROMPT, cacheControl: { type: 'ephemeral' } },
        { role: 'user', content: `BACKGROUND:\n${brief}\n\nPARAGRAPH:\n${paragraph}` },
      ],
      tier: 'small',
      maxTokens: Math.min(4000, Math.max(300, Math.ceil(paragraph.length / 2))),
      temperature: 0,
      responseSchema: {
        name: 'paragraph_without_the_background',
        description: 'The paragraph with any sentence that repeats the background removed',
        schema: RESPONSE_SCHEMA,
      },
    },
    undefined,
    usageContext,
  );
  const parsed = JSON.parse(response.content) as { removed?: unknown; text?: unknown };
  return {
    removed: parsed.removed === true,
    text: typeof parsed.text === 'string' ? parsed.text : paragraph,
  };
}

/**
 * The paragraph as the person may read it: the same text, or the same text with
 * the sentences that hand them the brief taken out.
 *
 * Never throws, and never returns anything that was not in `paragraph`.
 */
export async function removeBriefRestatement(
  paragraph: string,
  brief: string,
  context: RestatementContext,
  judge?: RestatementJudge,
): Promise<RestatementResult> {
  if (paragraph.trim().length === 0 || standingAside()) return { text: paragraph, removed: 0 };
  // Already gone: do not start a call whose answer nobody will read. Not a
  // failure either, so it does not count towards standing aside.
  if (context.abortSignal?.aborted) return { text: paragraph, removed: 0 };

  try {
    const verdict = await withDeadline(
      (signal) => (judge ? judge(paragraph, brief, signal) : judgeWithModel(paragraph, brief, signal, context)),
      context.abortSignal,
    );
    consecutiveFailures = 0;
    standingAsideUntil = 0;

    if (!verdict.removed || verdict.text === paragraph) return { text: paragraph, removed: 0 };
    if (!onlyRemoves(paragraph, verdict.text)) {
      log.warn(
        { tenantId: context.tenantId, speaker: context.speaker },
        'brief_echo: the reader returned text the colleague did not write; keeping the paragraph',
      );
      return { text: paragraph, removed: 0 };
    }

    const before = (paragraph.match(SENTENCE) ?? []).filter((s) => s.trim().length > 0).length;
    const after = (verdict.text.match(SENTENCE) ?? []).filter((s) => s.trim().length > 0).length;
    const removed = Math.max(1, before - after);
    logAudit(
      'brief_echo.removed',
      { tenantId: context.tenantId },
      {
        speaker: context.speaker,
        ...(context.threadId ? { threadId: context.threadId } : {}),
        kind: 'paraphrase',
        sentencesRemoved: removed,
        // Lengths only: what the person was not shown must not land in a log.
        paragraphLength: paragraph.length,
        keptLength: verdict.text.length,
      },
    );
    return { text: verdict.text, removed };
  } catch (err) {
    readFailed();
    log.error(
      {
        tenantId: context.tenantId,
        speaker: context.speaker,
        error: (err as Error).message,
        consecutiveFailures,
        ...(standingAsideUntil > 0 ? { standingAsideUntil: new Date(standingAsideUntil).toISOString() } : {}),
      },
      'brief_echo: read failed, failing open with the paragraph as written',
    );
    return { text: paragraph, removed: 0 };
  }
}
