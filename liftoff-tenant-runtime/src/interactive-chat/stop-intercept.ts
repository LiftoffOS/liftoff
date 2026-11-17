// Pure decision pieces of the stop intercept, extracted so they are testable
// without importing the chat-turn handler (which pulls DB + SDK transitively).

/** A bare "stop" message (optionally punctuated) is a stop request when a run
 *  is active. Anything longer is a normal message — "stop using prod" is an
 *  instruction, not an abort. */
export function matchesStopText(text: string | undefined): boolean {
  return /^stop[.!]?$/i.test((text ?? '').trim());
}
