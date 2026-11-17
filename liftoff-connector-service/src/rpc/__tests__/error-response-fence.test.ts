// CI fence (Phase 7 §8.5): every failed ExecuteResponse MUST be built through
// errorResponse(...) so the structured {error_code, retryable, retry_after_ms,
// recovery} contract can never silently regress to an unclassified string.
//
// This is a static source scan (no imports of project modules) so it runs even
// before the new proto-gen / connector-types packages are published. It fails
// if any src/rpc/*.ts file constructs create(ExecuteResponseSchema, { … success:
// false … }) directly instead of going through the errorResponse helper.

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const RPC_DIR = join(__dirname, '..');

function rpcSourceFiles(): string[] {
  return readdirSync(RPC_DIR)
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => !f.endsWith('.test.ts'))
    // execute-error.ts is the ONE sanctioned builder of failed responses.
    .filter((f) => f !== 'execute-error.ts');
}

/** Extract each `create(ExecuteResponseSchema, { … })` call body from source. */
function executeResponseCreateBodies(source: string): string[] {
  const bodies: string[] = [];
  const marker = 'create(ExecuteResponseSchema';
  let idx = source.indexOf(marker);
  while (idx !== -1) {
    // Walk from the first `{` after the marker to its matching `}`.
    const braceStart = source.indexOf('{', idx);
    if (braceStart === -1) break;
    let depth = 0;
    let end = braceStart;
    for (; end < source.length; end++) {
      const ch = source[end];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    bodies.push(source.slice(braceStart, end + 1));
    idx = source.indexOf(marker, end + 1);
  }
  return bodies;
}

describe('errorResponse fence — no direct failed ExecuteResponse construction', () => {
  it('every failed ExecuteResponse is built via errorResponse(), not create() directly', () => {
    const offenders: string[] = [];
    for (const file of rpcSourceFiles()) {
      const source = readFileSync(join(RPC_DIR, file), 'utf8');
      for (const body of executeResponseCreateBodies(source)) {
        if (/success:\s*false/.test(body)) {
          offenders.push(`${file}: ${body.replace(/\s+/g, ' ').slice(0, 120)}…`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
