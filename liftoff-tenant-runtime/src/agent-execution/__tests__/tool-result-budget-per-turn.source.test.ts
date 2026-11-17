/**
 * The tool-result budget is a CONTEXT budget, so it ends where a context does:
 * at the end of one step's turn.
 *
 * `turnUsage` is keyed by invocation id, and the only two callers of
 * `resetTurnUsage` were both at INVOCATION end — so a 21-step run shared one
 * 200,000-character allowance across every step of it. The map's own comment
 * said "cleared by the adapter at turn end" and no adapter cleared it.
 *
 * Nothing failed when it ran out. Past the budget every LATER result in the run
 * is bounded to a quarter of the per-result cap, so a sweep reading eight pages
 * of ~25,000 characters — each inside the 50,000 per-result cap, none oversized
 * enough to park — started reading quarter-pages from the ninth onward. A live
 * run reported "the detailed competitor readings from the research step were
 * cut short" with no error anywhere.
 *
 * It also defeated the only thing a template can do about size: "read the
 * competitors ONE AT A TIME" keeps each STEP small, which buys nothing while
 * the allowance never resets between them.
 *
 * The engine cannot be imported here (DB + SDK transitively), so this pins the
 * structure directly, like the other `*.source.test.ts` contracts.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const ENGINE = readFileSync(join(__dirname, '..', 'service.ts'), 'utf8');
const BOUND = readFileSync(join(__dirname, '..', 'adapter', 'tool-result-bound.ts'), 'utf8');

/** The body of `invokeStepLLM`, which is the ONE turn a step gets. */
function invokeStepLLMBody(): string {
  const start = ENGINE.indexOf('private async invokeStepLLM(');
  expect(start).toBeGreaterThan(-1);
  // The next method declaration at the same indentation ends it.
  const end = ENGINE.indexOf('\n  private async ', start + 1);
  expect(end).toBeGreaterThan(start);
  return ENGINE.slice(start, end);
}

describe('the tool-result budget resets per step turn', () => {
  it('invokeStepLLM clears the usage when its turn ends', () => {
    // The step turn is the unit that has a context window. Without this the
    // allowance is per RUN and every step after the trip reads quarter-sized
    // results, silently.
    expect(invokeStepLLMBody()).toContain('resetTurnUsage(');
  });

  it('clears it in the finally, so a thrown turn does not keep the allowance spent', () => {
    // A step that throws is retried or salvaged, and that attempt is a fresh
    // context. Clearing only on the success path would leave a failed step's
    // characters charged against the retry that replaces it.
    const body = invokeStepLLMBody();
    const finallyAt = body.lastIndexOf('} finally {');
    const resetAt = body.indexOf('resetTurnUsage(');
    expect(finallyAt).toBeGreaterThan(-1);
    expect(resetAt).toBeGreaterThan(finallyAt);
  });

  it('keeps the invocation-end resets, which do a different job', () => {
    // Those stop the module-level map growing for the life of the process. A
    // per-turn reset does not replace them: a conversational invocation makes
    // no step turn at all.
    const resets = ENGINE.split('resetTurnUsage(').length - 1;
    expect(resets).toBeGreaterThanOrEqual(3);
  });

  it('the map no longer claims a clearing that does not happen', () => {
    // The comment asserted "cleared by the adapter at turn end" while both
    // callers sat at invocation end. A comment that states the property it
    // lacks is how this survived.
    const decl = BOUND.slice(
      Math.max(0, BOUND.indexOf('const turnUsage = new Map') - 1200),
      BOUND.indexOf('const turnUsage = new Map'),
    );
    expect(decl).toContain('invokeStepLLM');
  });
});
