/**
 * Every billable field an adapter reports must survive into the STEP.
 *
 * `state.steps.push({ output: {...} })` is an explicit enumeration, and there are
 * two of them — the conversational loop and the workflow-shaped loop. A field the
 * adapter reports and one of those lists omits is read as 0 by everything
 * downstream: `priceRunSteps` reduces over `s.output`, and so does the
 * `totalCacheWriteTokens` sum the completion sites persist.
 *
 * This is the defect that made three separate cache-write fixes inert. Each one
 * read a different vendor field, each passed its own adapter test, and none could
 * ever have worked: the value was dropped one layer below where it was being
 * looked for. `webSearchRequests` and `vendorCostUsd` were both added to the two
 * sites for the same reason, and the workflow writer carries a comment saying so —
 * which is why this is a fitness function over the SOURCE rather than another
 * assertion about one adapter.
 *
 * Source-scanning on purpose: the failure is a missing line in an object literal,
 * which no behavioural test of a single path can see.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const SERVICE = join(__dirname, '..', 'service.ts');

/** The `state.steps.push` writers that record a usage event, as source blocks.
 *
 *  Anchored on `state.steps.push(` rather than on the field name, because
 *  `event.usage.inputTokens` is also read by the context-measurement block beside
 *  the conversational writer — which is not a billing record and carries none of
 *  these fields. A scan that caught it would fail for the wrong reason. */
function stepWriterBlocks(): string[] {
  const src = readFileSync(SERVICE, 'utf8');
  const blocks: string[] = [];
  const re = /state\.steps\.push\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const window = src.slice(m.index, m.index + 1600);
    // Only the writers that record a usage event; the loop pushes other step
    // kinds (tool calls, salvage) that carry no token counts.
    if (/inputTokens:\s*event\.usage\.inputTokens/.test(window)) blocks.push(window);
  }
  return blocks;
}

describe('a billable field reported by an adapter reaches the step', () => {
  const blocks = stepWriterBlocks();

  it('finds both step writers, so the assertions below cannot pass vacuously', () => {
    expect(blocks.length).toBeGreaterThanOrEqual(2);
  });

  // Each of these is billed at its own rate, and each was at some point carried by
  // one writer and not the other.
  for (const field of ['outputTokens', 'cachedTokens', 'cacheWriteTokens', 'webSearchRequests', 'vendorCostUsd']) {
    it(`every step writer carries ${field}`, () => {
      for (const [i, b] of blocks.entries()) {
        expect(`writer ${i}: ${b}`).toContain(`event.usage.${field}`);
      }
    });
  }
});

describe('the reducers that read the step agree with the writers', () => {
  const src = readFileSync(SERVICE, 'utf8');

  it('sums cache writes off the step output, which is why the writer must set it', () => {
    // If this reducer exists and the writer omits the field, the sum is silently 0
    // on every run — which is exactly what happened.
    expect(src).toContain('cacheWriteTokens');
    expect(src).toMatch(/totalCacheWriteTokens[\s\S]{0,200}cacheWriteTokens/);
  });

  it('prices cache writes per step rather than off a run-wide total', () => {
    // Per step, because a conditional rate band is evaluated against one request's
    // prompt and a sum is a number no single request had.
    expect(src).toMatch(/calculateCost\([^)]*\{\s*cacheWriteTokens/);
  });
});
