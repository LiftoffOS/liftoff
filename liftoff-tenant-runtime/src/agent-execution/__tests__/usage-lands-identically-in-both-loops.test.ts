// The two adapter event loops must land the SAME usage fields.
//
// There are two of them — the conversational seam and the workflow-step loop —
// and they consume the same `usage` event into the same `state.steps[].output`,
// which is where `computeGroundingCost` and the invocation's token totals are
// read from. Nothing at runtime compares them, so a field added to one is
// simply absent from the other, and absent does not read as missing: it reads
// as ZERO. A per-call web-search charge that is zero looks exactly like a run
// that never searched.
//
// That is not hypothetical. `webSearchRequests` was carried by the
// conversational loop and dropped by the step loop, so every workflow-shaped
// run — the distiller's DEFAULT shape — billed nothing for its searches.
//
// Read out of the SOURCE rather than exercised, because reaching either loop
// needs a live adapter, a catalog and a model call. What matters is a property
// of the code that a diff can violate, and this is the cheapest place to state
// it.

import { readFileSync } from 'fs';
import { join } from 'path';

const SERVICE = join(__dirname, '..', 'service.ts');

/** The keys each `case 'usage':` block writes into `output: { ... }`. */
function usageOutputKeysPerLoop(): string[][] {
  const src = readFileSync(SERVICE, 'utf8');
  const blocks: string[][] = [];

  let from = 0;
  for (;;) {
    const at = src.indexOf("case 'usage':", from);
    if (at === -1) break;
    from = at + 1;

    // The `output: { ... }` literal that follows this case.
    const outputAt = src.indexOf('output: {', at);
    if (outputAt === -1 || outputAt - at > 2000) continue;
    const close = src.indexOf('},', outputAt);
    const body = src.slice(outputAt, close);

    // Property names only: `foo:` at the start of a line, comments stripped
    // first so a key named inside prose is not counted.
    const code = body.replace(/\/\/[^\n]*/g, '');
    blocks.push([...code.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gm)].map((m) => m[1]).sort());
  }
  return blocks;
}

describe('every adapter event loop lands the same usage fields', () => {
  const loops = usageOutputKeysPerLoop();

  it('found both loops', () => {
    // Guards the scan itself: if the loops move or are renamed, this fails
    // rather than silently comparing nothing.
    expect(loops.length).toBeGreaterThanOrEqual(2);
  });

  it('agrees on the fields, so neither silently bills zero', () => {
    const [first, ...rest] = loops;
    for (const other of rest) expect(other).toEqual(first);
  });

  it('carries the per-call web-search count', () => {
    // Named explicitly because it is the one whose absence costs money rather
    // than fidelity — it is the whole input to a per-call charge.
    for (const keys of loops) expect(keys).toContain('webSearchRequests');
  });
});
