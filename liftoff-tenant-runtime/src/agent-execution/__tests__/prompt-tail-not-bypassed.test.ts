// Everything in the system prompt goes through the tiering.
//
// `prompt-tiers.ts` orders the prompt so a byte-identical prefix repeats and
// can be cached, and its own header says the ordering decays: "one volatile
// block placed early invalidates every stable block after it". The class
// enforces order among the segments it HOLDS — what it cannot see is a block
// appended past it.
//
// That had already happened. The browser-session block was appended after
// `tail.render()`, which put per-thread text after this turn's volatile blocks
// and, worse, outside the mechanism entirely: `stats()` never counted it, so the
// telemetry that exists to catch ordering decay could not see the one piece of
// decay that was present.
//
// Read from the source because the property is about SHAPE — where a line sits
// relative to the render — which no assertion on the rendered string can
// recover, since the result is one long string either way.
import { readFileSync } from 'fs';
import { join } from 'path';

const SOURCE = readFileSync(join(__dirname, '..', 'service.ts'), 'utf8');

/** A block appended after the tail may carry this with a reason. One does: the
 *  webhook-payload directive is deliberately the LAST system-level rule before
 *  the user turn carrying the marked payload, which is a position argument
 *  rather than an oversight. */
const EXEMPT = 'PROMPT_TAIL_APPEND_OK';

describe('the tiered tail is the last thing assembled', () => {
  const renderIdx = SOURCE.indexOf('prompt += `\\n\\n${tail.render()}`;');

  it('finds the tail render, so this cannot pass vacuously', () => {
    expect(renderIdx).toBeGreaterThan(0);
  });

  it('appends nothing to the prompt afterwards without a stated reason', () => {
    // Scoped to the end of the enclosing method: the next method's body is not
    // this one's tail.
    // Past the render line itself — it is the tail, not an append after it.
    const after = SOURCE.slice(SOURCE.indexOf('\n', renderIdx));
    const methodEnd = after.indexOf('\n  private ');
    const body = methodEnd > 0 ? after.slice(0, methodEnd) : after;

    const appends = body
      .split('\n')
      .map((line, i) => ({ line: line.trim(), i }))
      .filter(({ line }) => line.startsWith('prompt +='));

    const unexplained = appends.filter(({ i }) => {
      // The reason may sit in the comment block above the append.
      const context = body.split('\n').slice(Math.max(0, i - 12), i + 1).join('\n');
      return !context.includes(EXEMPT);
    });

    expect(unexplained.map((a) => a.line)).toEqual([]);
  });
});
