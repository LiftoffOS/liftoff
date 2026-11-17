// When a model turn must stop, and what a missing context window may decide.
//
// Three loops used to answer this, each with its own copy of the arithmetic and
// its own answer for the one case that matters — a model whose window nobody
// recorded. Platform-backend substituted 128k silently, the tenant runtime
// refused to act on anything but a registry figure, and the workforce service's
// guard simply went inert. Same question, three answers, nothing comparing
// them.
//
// This package holds the DECISION and nothing else. It measures nothing: every
// caller reads its own prompt size, its own window and its own clock — those
// come from a provider's usage report and a registry the caller can see — and
// hands the numbers here. What comes back is what to do.
//
// TWO RULES, and the difference between them is the whole point:
//
//   * GRACEFUL CLOSING may run on a conservative fallback. Closing a reply one
//     round early costs a round; the person still gets an answer, and the work
//     continues. So a turn whose model has no recorded window is bounded by
//     CONSERVATIVE_CONTEXT_WINDOW_TOKENS, which sits below every current
//     frontier window.
//   * DESTRUCTIVE RETIREMENT requires a RECORDED window. Retiring a session,
//     declaring a run context-exhausted, clearing a transcript — those throw
//     work away, and a family floor understates every long-window model.
//     Anthropic's floor is 200,000 while claude-opus-5[1m] holds 1,000,000, so
//     a healthy 300k-token run measured against the floor reads as an overflow.
//     That is a data-losing false positive produced by the check meant to
//     prevent data loss.
//
// There is deliberately no MAX_ITERATIONS here. The round cap is an INPUT, not
// a shared constant: the two platform assistants and the Chief AI Officer pass
// 50, while the tenant runtime passes the budget it resolved for the run (the
// tenant's configured `maxToolCalls`, default 100, clamped by the delegation
// role). A constant here would be wrong for at least one of them, and the one
// it was wrong for would not notice.

/** Why a turn is being closed. The order of these names is the order the
 *  decision tests them in: a spent round budget is a fact about this loop, a
 *  full window is a fact about the model, and a passed deadline is a fact
 *  about the caller's clock. */
export type ClosingReason = 'rounds' | 'context' | 'deadline';

/**
 * The share of the model's context window a call's prompt may reach before the
 * turn is closed.
 *
 * Measured on the PROMPT the call carried — what the provider counts as the
 * context, cached part included — never on a sum across calls: the same prompt
 * is re-sent every round, so a sum measures how many rounds ran, not how much
 * room is left.
 *
 * 0.7 leaves room for the closing call itself, which re-sends the same prompt
 * plus the closing note and must fit. A guard set just under 1.0 is not a
 * guard: at that point the provider has already truncated or is about to
 * reject, and the reply that was supposed to be written has nowhere to go.
 */
export const CONTEXT_GUARD_SHARE = 0.7;

/**
 * The window a turn is bounded by when the model's own is not recorded.
 *
 * Below every current frontier window, so an unrecorded model closes EARLY
 * rather than overflowing. It is a bound for closing and nothing else — see
 * `mayRetireOn`.
 */
export const CONSERVATIVE_CONTEXT_WINDOW_TOKENS = 128_000;

/** Where a window figure came from. `registry` is the model's own recorded
 *  window. `fallback` is CONSERVATIVE_CONTEXT_WINDOW_TOKENS, or any family
 *  floor a caller substituted: both are lower bounds, and neither may drive a
 *  destructive decision. */
export type ContextWindowSource = 'registry' | 'fallback';

export interface ContextWindow {
  tokens: number;
  source: ContextWindowSource;
}

/**
 * The window to bound a turn by, labelled with where it came from.
 *
 * `recorded` is the registry's figure for the model that actually served the
 * call, or undefined/0 when the registry has none. Undefined is a real answer
 * and this is the one place it is turned into a number, so no caller has to
 * decide for itself what "we do not know" means.
 */
export function contextWindowOrFallback(recorded: number | null | undefined): ContextWindow {
  return typeof recorded === 'number' && recorded > 0
    ? { tokens: recorded, source: 'registry' }
    : { tokens: CONSERVATIVE_CONTEXT_WINDOW_TOKENS, source: 'fallback' };
}

/**
 * True when a reading may drive a DESTRUCTIVE decision — retiring a session,
 * clearing a transcript, declaring a run context-exhausted.
 *
 * A named predicate rather than an inline `=== 'registry'` at each call site:
 * the rule is the point, and a reader should not have to reconstruct it from a
 * string comparison.
 */
export function mayRetireOn(window: ContextWindow | undefined): boolean {
  return window?.source === 'registry';
}

/** What a caller knows at the moment it asks.
 *
 *  Every field is the caller's own measurement; nothing here reads a clock, a
 *  registry or a provider. EVERY FIELD IS OPTIONAL, and that is the contract:
 *  a half of the bound fires only when the caller supplied what that half
 *  needs. A loop that tests its rounds at its own head asks here about the
 *  per-call bounds and supplies no rounds; a relay that reported no prompt
 *  size leaves the window half inert rather than tripping on a zero. Silence
 *  is "not my question", never "zero". */
export interface TurnBoundReading {
  /** Rounds of tools already taken. Omit — with `maxIterations` — when the
   *  caller bounds its own rounds elsewhere. */
  iteration?: number | undefined;
  /** The round cap for THIS run. An input, never a constant here: see the
   *  header. Omitted, or non-positive, disables the round half. */
  maxIterations?: number | undefined;
  /** The prompt the last call carried, as the provider counted it (cached part
   *  included). Undefined when the provider reported none — an older relay, a
   *  call that failed before usage was known — and the window half of the
   *  bound is then INERT rather than tripping on a zero, which would close
   *  every reply on its first call. */
  contextTokens?: number | undefined;
  /** The model's recorded window, or undefined when the registry has none.
   *  Turned into a bound by `contextWindowOrFallback`. */
  recordedContextWindow?: number | null | undefined;
  /** Whether the caller's own deadline for this reply has passed. Absent for a
   *  run with no deadline. */
  deadlinePassed?: boolean | undefined;
}

export interface TurnBoundDecision {
  /** The reason to close the turn now, or null to keep going. */
  close: ClosingReason | null;
  /** The window the context half was measured against, and its provenance.
   *  Always present, so a log line can say WHAT the ratio was taken against. */
  window: ContextWindow;
  /** The share of that window the last prompt occupied, or undefined when the
   *  caller reported no prompt size. Rounded to three places: it is read by
   *  people, in logs, and the digits past that say nothing. */
  ratio?: number;
  /** True when this reading may ALSO drive a destructive decision. False on a
   *  fallback window even when `close` is 'context': the turn is closed
   *  gracefully, and nothing is thrown away. */
  mayRetire: boolean;
}

/**
 * The whole case table, in one place.
 *
 *   rounds spent (when the caller supplied them)   → close 'rounds'
 *   prompt over the share of a RECORDED window     → close 'context', may retire
 *   prompt over the share of the FALLBACK window   → close 'context', may NOT retire
 *   no prompt size reported                        → the window half is inert
 *   deadline passed                                → close 'deadline'
 *   none of those                                  → keep going
 *
 * Precedence is rounds, then context, then deadline, which is the order the
 * three loops already applied and the order that reads correctly in a log: a
 * run that spent its rounds ON a full window is reported as having spent its
 * rounds, because that is the bound a person can change.
 */
export function decideTurnBound(reading: TurnBoundReading): TurnBoundDecision {
  const window = contextWindowOrFallback(reading.recordedContextWindow);
  const mayRetire = mayRetireOn(window);
  const tokens = reading.contextTokens;
  const measured = typeof tokens === 'number' && tokens > 0 && window.tokens > 0;
  const ratio = measured ? Math.round((tokens / window.tokens) * 1000) / 1000 : undefined;

  const base = { window, mayRetire, ...(ratio !== undefined ? { ratio } : {}) };

  if (
    typeof reading.iteration === 'number'
    && typeof reading.maxIterations === 'number'
    && reading.maxIterations > 0
    && reading.iteration >= reading.maxIterations
  ) {
    return { ...base, close: 'rounds' };
  }
  if (measured && (tokens as number) > CONTEXT_GUARD_SHARE * window.tokens) {
    return { ...base, close: 'context' };
  }
  if (reading.deadlinePassed === true) {
    return { ...base, close: 'deadline' };
  }
  return { ...base, close: null };
}
