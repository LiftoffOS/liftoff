// Chat Input Sanitization
//
// Shared by every service that accepts user-supplied chat text: the Liftoff
// assistant and Insights chat in platform-backend, and CAIO workforce planning
// in workforce-service. It lives in this package rather than in any one service
// because a per-service copy is exactly what went wrong before - two functions
// with the same name and different behaviour, in two repos, and no way to tell
// from a call site which one you had.
//
// What this does: strips C0 control characters and DEL, preserving \t, \n, \r
// so legitimate multi-line input still works, then trims.
//
// What this deliberately does NOT do: HTML-entity encode. platform-backend's
// copy used to, and the encoded string was what got persisted AND what got
// handed to the model, so a person who typed "What's the best beer garden" had
// their message stored and answered as "What&#39;s the best beer garden". The
// reasoning was defense-in-depth against a renderer that might one day
// interpret HTML. It did not hold up:
//
//   - Chat bubbles render user text as a React text node, which escapes on
//     output. Encoding at rest protected a path that was never exposed.
//   - The one surface that DOES interpret HTML is the assistant reply
//     (rehype-raw, for citation superscripts). That content is model output and
//     never came through here, so the encoding guarded the safe half and left
//     the risky half open. That half is covered at render now, by
//     rehype-sanitize in liftoff-react.
//   - Escaping at the boundary is not composable. A message carried into a
//     delegate's thread arrived pre-encoded in a table whose own writer never
//     encodes, so one column held two different value shapes and no backfill
//     could tell them apart by inspection.
//
// Encode for the sink, at the sink. Store what the person actually typed.

/**
 * Strip C0 control characters and DEL from `input`, preserving \t, \n, and \r
 * which are legitimate in chat input. Implemented as a codepoint walk rather
 * than a regex so we avoid the eslint no-control-regex rule and stay obviously
 * correct.
 */
export function stripControlChars(input: string): string {
  let out = '';
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    const isAllowedControl = code === 0x09 || code === 0x0a || code === 0x0d;
    const isC0Control = code <= 0x1f && !isAllowedControl;
    const isDel = code === 0x7f;
    if (!isC0Control && !isDel) {
      out += input[i];
    }
  }
  return out;
}

/**
 * Strip control chars and trim whitespace. The result is safe to persist and is
 * the person's text verbatim otherwise. Callers should check the output length
 * before writing - an input that was only control characters comes out empty
 * and should be rejected with a 400.
 */
export function sanitizeChatMessageContent(input: string): string {
  return stripControlChars(input).trim();
}
