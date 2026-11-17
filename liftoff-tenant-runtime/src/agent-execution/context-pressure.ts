// B5 — context posture for the engines that do NOT manage their own context.
//
// This is deliberately NOT a compaction engine. The Anthropic path runs inside
// the Claude Agent SDK, which compacts its own session and does not expose the
// seam to us. The OpenAI / OpenRouter / Gemini paths run through
// `runConversationalTurnsViaAdapter`, where WE hold the conversation history —
// and there we have no compaction at all. History there is bounded only by
// tool-result caps and a finite turn count, so a long-running or repeatedly
// resumed conversation can walk into a provider 400 for exceeding the model
// window. A 400 is the worst possible ending: the run dies with no output and
// no terminal state anyone can act on.
//
// So: measure before the call, nudge once when the history gets heavy, and end
// cleanly rather than let the provider reject it. Building real compaction for
// the secondary engines is not justified by anything we have observed.

/** Characters per token. Deliberately conservative (real English prose is
 *  closer to 4) so the estimate errs toward triggering early rather than
 *  discovering the ceiling from a provider error. */
const CHARS_PER_TOKEN = 3.5;

/** Input-token windows, by provider family. These are floors, not exact model
 *  specs: the guard only needs to be right about the order of magnitude, and a
 *  model with a larger window simply gets nudged sooner than it had to be. */
const PROVIDER_WINDOW_TOKENS: Record<string, number> = {
  openai: 128_000,
  google: 1_000_000,
  anthropic: 200_000,
  // Retired provider, kept for rows that still name it. Claude over Google
  // Vertex served the same models with the same window; dropping the entry
  // would fall through to DEFAULT_WINDOW_TOKENS and nudge those runs early for
  // a reason that has nothing to do with their context.
  'anthropic-vertex': 200_000,
};

const DEFAULT_WINDOW_TOKENS = 128_000;

/** Fraction of the window at which one summarize-and-continue nudge is worth
 *  spending a turn on. */
const PRESSURE_RATIO = 0.75;

/** Fraction of the window past which the next call is expected to be rejected.
 *  Below 1.0 because our char estimate is approximate and the system prompt,
 *  tool schemas, and the model's own reply all consume window we are not
 *  counting here. */
const HARD_RATIO = 0.95;

export type ContextPressureLevel = 'ok' | 'pressure' | 'exceeded';

export interface ContextPressureAssessment {
  level: ContextPressureLevel;
  historyChars: number;
  windowChars: number;
  /** Share of the window the history alone is using, 0..n. */
  usedRatio: number;
}

/** Total characters in the accumulated conversation history. Non-string
 *  content is serialized the same way the invocation input serializes it, so
 *  the estimate matches what is actually sent. */
export function estimateHistoryChars(
  history: Array<{ content: unknown }>,
): number {
  let total = 0;
  for (const m of history) {
    if (typeof m.content === 'string') {
      total += m.content.length;
      continue;
    }
    try {
      total += JSON.stringify(m.content).length;
    } catch {
      /* unserializable content contributes nothing measurable */
    }
  }
  return total;
}

/** The same estimate for messages already in platform block form — a
 *  conversation rebuilt from the canonical record, which never passes through
 *  the string-content history the function above measures. Serialized the way
 *  the invocation input serializes it, so the estimate matches what is sent. */
export function estimatePlatformMessageChars(
  messages: Array<{ content: unknown[] }>,
): number {
  let total = 0;
  for (const m of messages) {
    try {
      total += JSON.stringify(m.content).length;
    } catch {
      /* unserializable content contributes nothing measurable */
    }
  }
  return total;
}

/** The provider-family FLOOR in tokens. Exported so the per-model window lookup
 *  has one place to fall back to, and so a caller that ends up on the floor can
 *  be told that is where it landed — the floor understates every long-window
 *  model, so a decision that would destroy data must never rest on it. */
export function windowTokensForProvider(provider: string | undefined): number {
  return (provider && PROVIDER_WINDOW_TOKENS[provider]) || DEFAULT_WINDOW_TOKENS;
}

export function windowCharsForProvider(provider: string | undefined): number {
  return Math.floor(windowTokensForProvider(provider) * CHARS_PER_TOKEN);
}

export function assessContextPressure(params: {
  provider: string | undefined;
  historyChars: number;
}): ContextPressureAssessment {
  const windowChars = windowCharsForProvider(params.provider);
  const usedRatio = windowChars > 0 ? params.historyChars / windowChars : 0;
  const level: ContextPressureLevel =
    usedRatio >= HARD_RATIO ? 'exceeded'
      : usedRatio >= PRESSURE_RATIO ? 'pressure'
        : 'ok';
  return { level, historyChars: params.historyChars, windowChars, usedRatio };
}

/** The single nudge. Phrased as a working instruction rather than a warning:
 *  the agent should carry the thread forward in fewer words, not stop to
 *  explain that it is running out of room.
 *
 *  The second paragraph exists because the first is easy to over-read. A model
 *  told to restate and carry on can conclude that everything outside the
 *  restatement is gone — and then re-clone a repository, re-open a shell, and
 *  re-derive a result it already parked, spending exactly the context the nudge
 *  was trying to reclaim. None of that changed: the nudge is a message in a
 *  conversation, not a new run, and the workspace, the sessions and the spill
 *  files are all still there. */
export const CONTEXT_PRESSURE_NUDGE =
  'This conversation has grown long. Before continuing, restate in a short paragraph '
  + 'what has been established so far and what still needs doing, then carry on from that '
  + 'summary. Keep subsequent replies and tool calls tight.\n\n'
  + 'Nothing outside this conversation has changed. Your workspace still holds every file '
  + 'you have written, any shell or Node sessions you opened are still open under the same '
  + 'ids, and any large tool results that were parked to files are still on disk. Read what '
  + 'you need back rather than redoing the work that produced it.';

/** Header the compaction summary carries into the conversation. Says plainly
 *  that this is a condensed record and that the run continues, so the model does
 *  not read it as a fresh start and re-derive what it already has.
 *
 *  Lives HERE, beside the nudge, rather than in the compactor that writes it.
 *  These are the platform's two mid-run messages, the predicate below has to
 *  recognise both, and the canonical-record fix that predicate exists for is not
 *  conditional on compaction being switched on — so it must not depend on the
 *  compaction module either. */
export const COMPACTION_SUMMARY_HEADER =
  'CONDENSED RECORD OF EARLIER TURNS. The turns below this point are unchanged. '
  + 'This run has not restarted and nothing outside the conversation was reset: '
  + 'your workspace, any shell or Node sessions you opened, and any files that '
  + 'large results were parked to are all still there under the same names and ids.';

/**
 * Is this user-role text something the PLATFORM put into a running conversation,
 * rather than something a person, a trigger or an objective said?
 *
 * The canonical record captures "this run's user turn" as the last user message
 * of what is about to be sent (ADR-006 §3b). Both messages above are user-role
 * and are appended immediately before that capture, so without this the record
 * names the platform's own housekeeping as the thing the run was asked to do —
 * and a cross-engine rebuild then hands the next engine a conversation whose
 * question is "this conversation has grown long".
 *
 * Deliberately NOT matching `frameSystemContinuation`. That prefix belongs to
 * the verify-on-stop continuation, which is a NEW invocation whose objective
 * genuinely is that text; recording it there is correct.
 */
export function isMidRunPlatformTurn(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith(COMPACTION_SUMMARY_HEADER) || t === CONTEXT_PRESSURE_NUDGE.trimStart();
}

export const CONTEXT_PRESSURE_RATIOS = { PRESSURE_RATIO, HARD_RATIO, CHARS_PER_TOKEN };
