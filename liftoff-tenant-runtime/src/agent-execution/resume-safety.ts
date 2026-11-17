// Is this session safe to resume into?
//
// The failure shapes that poison a resume by leaving a malformed transcript —
// an empty assistant message, a dangling tool_use with no result — are already
// unreachable: a chat turn that fails never writes its JSONL back at all (the
// save sits inside the success branch), so nothing partial is persisted.
//
// The hole that IS live is the opposite case: a turn that SUCCEEDS while the
// conversation is already saturated. The artifact validates, gets persisted,
// and the NEXT turn resumes into a window that cannot fit it — so that turn
// fails, writes nothing, and leaves the same saturated artifact in place. Every
// subsequent turn on that thread fails the same way, forever, and the person's
// only recourse is to start over without being told that is what they need.
//
// context-pressure.ts cannot see this: it is gated on
// `adapter.managesOwnContext !== true`, which excludes every primary engine —
// the engines that manage their own context are exactly the ones that hit it.
//
// The signal is the model's own words. When a run ends by SAYING the window is
// full, that is a statement about the transcript, not about the task, and the
// transcript is what we were about to keep.

/** Longest output that can plausibly BE a "the context is full" report rather
 *  than an answer that happens to discuss context limits.
 *
 *  A real capitulation is short: the model has no room left to write anything
 *  else, which is the whole point. An essay about context windows, a code review
 *  of a token counter, or a summary quoting an earlier error are all long, and
 *  all of them would otherwise match on wording alone — and the cost of a false
 *  positive is throwing away a session the person is mid-way through. */
const MAX_CAPITULATION_CHARS = 600;

/** Each entry must match for the output to count, so a single stray word cannot
 *  trip it. Every clause is a composite: a phrase naming the WINDOW and a phrase
 *  naming its EXHAUSTION, both present. Drawn from the wordings the providers
 *  actually emit rather than invented. */
const EXHAUSTION_CLAUSES: ReadonlyArray<{ subject: RegExp; state: RegExp }> = [
  // "the context window is full", "context length exceeded", "context limit reached"
  {
    subject: /\bcontext\s+(?:window|length|limit|size)\b/i,
    state: /\b(?:full|exceed(?:ed|s)?|exhaust(?:ed)?|reach(?:ed)?|over|too\s+(?:long|large|big)|no\s+(?:more\s+)?(?:room|space))\b/i,
  },
  // "ran out of context", "out of context space"
  {
    subject: /\bcontext\b/i,
    state: /\b(?:ran\s+out|running\s+out|out\s+of)\b/i,
  },
  // "conversation is too long to continue"
  {
    subject: /\b(?:conversation|thread|transcript|history)\b/i,
    state: /\btoo\s+(?:long|large)\b/i,
  },
  // "maximum number of tokens", "token limit exceeded"
  {
    subject: /\b(?:token|tokens)\b/i,
    state: /\b(?:limit|maximum|max)\b.{0,40}\b(?:exceed(?:ed|s)?|reach(?:ed)?|hit)\b|\b(?:exceed(?:ed|s)?|reach(?:ed)?)\b.{0,40}\b(?:limit|maximum|max)\b/i,
  },
];

/**
 * Does this completion say the model ran out of room?
 *
 * Pure, and deliberately conservative: it must be cheaper to miss a saturated
 * session (the next turn fails once and the person retries) than to discard a
 * healthy one (the person silently loses the conversation they were having).
 *
 * Non-string output — a structured result, an object, null — is never a
 * capitulation: this shape only appears in prose.
 */
export function contextExhaustedCompletion(output: unknown): boolean {
  if (typeof output !== 'string') return false;
  const text = output.trim();
  if (!text || text.length > MAX_CAPITULATION_CHARS) return false;
  return EXHAUSTION_CLAUSES.some(
    (clause) => clause.subject.test(text) && clause.state.test(text),
  );
}
