// A streamed call is attributed to the model that served it.
//
// The defect this pins is silent. If `completeStream` records
// `request.model || 'default'`, a TIER-based caller supplies no
// `request.model` — so every streamed call from one is written to
// `llm_usage_log` as the literal string 'default', recorded against a model
// that does not exist.
//
// It costs money rather than tidiness. `computeRowCost` never bills zero — an
// unrecognised model falls back to a conservative default rate — so those rows
// would be priced against no model at all, indefinitely, with nothing to notice:
// the row is present, the tokens are right, only the name is wrong. They are
// also invisible to the pricing-coverage ratchet, which reasons about model
// ids, and to any per-model cache analysis, since 'default' has no vendor
// floor to compare against.
//
// The non-streaming path records `response.model`. That asymmetry is why the
// bug hides — a check that goes through complete() never sees it.

import { readFileSync } from 'fs';
import { join } from 'path';

const CLIENT = readFileSync(join(__dirname, '..', 'client.ts'), 'utf8');
const PROVIDERS = ['anthropic', 'openai', 'google'] as const;

describe('the stream reports which model served it', () => {
  it.each(PROVIDERS)('%s puts a model on message_complete', (name) => {
    const src = readFileSync(join(__dirname, '..', 'providers', `${name}.ts`), 'utf8');
    const at = src.indexOf("type: 'message_complete',");
    expect(at).toBeGreaterThan(-1);
    // Within the event literal, not merely somewhere in the file.
    expect(src.slice(at, at + 600)).toMatch(/\n\s+model: \w+,/);
  });

  it('the client prefers the served model over what was asked for', () => {
    expect(CLIENT).toMatch(/if \(event\.model\) model = event\.model;/);
  });

  it('the stream binding is mutable so it CAN be corrected', () => {
    // `const model = request.model || 'default'` is the bug in one line. If
    // this reverts to const, the assignment above stops compiling — but a
    // future edit could drop both together, so the shape is pinned here.
    const stream = CLIENT.slice(CLIENT.indexOf('completeStream'));
    expect(stream).toMatch(/let model = request\.model \|\| 'default';/);
  });

  it("the non-streaming path still records the response's own model", () => {
    // The half that was always right. Guarded so a well-meaning
    // "consistency" edit does not level the two down instead of up.
    expect(CLIENT).toMatch(/model: response\.model,/);
  });
});
