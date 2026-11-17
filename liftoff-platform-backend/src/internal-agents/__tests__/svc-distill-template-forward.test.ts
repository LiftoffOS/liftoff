// The service distill route forwards the template it was given.
//
// A source test, because the failure is silent in every other direction. A
// template carries obligations, authored flows and tool notes that reach the
// output only when distillation is told which template it is compiling; dropped,
// the call still succeeds and still returns a plausible agent — one missing its
// authored decomposition, its idempotency obligation and its tool notes.
// Nothing downstream reports that, and the agent behaves like a hire that was
// never templated because that is exactly what it is.
//
// It matters here specifically because the CAIO and the HRBP build through this
// route rather than the Explore page's. The premise that conversational building
// gets the input contract "with no separate work" holds only while both entry
// points pass the same inputs, and this one silently did not.

import { readFileSync } from 'fs';
import { join } from 'path';

const ROUTER = readFileSync(join(__dirname, '..', 'router.ts'), 'utf8');

/** The body of the `_svc/distill` handler. */
function svcDistillHandler(): string {
  const start = ROUTER.indexOf("internalAgentsServiceRouter.post('/_svc/distill'");
  expect(start).toBeGreaterThan(-1);
  const end = ROUTER.indexOf('internalAgentsServiceRouter', start + 10);
  return ROUTER.slice(start, end);
}

describe('POST /_svc/distill', () => {
  it('reads templateId off the request', () => {
    expect(svcDistillHandler()).toMatch(/templateId\s*\}\s*=\s*req\.body/);
  });

  it('passes it into distillInternalAgent', () => {
    const body = svcDistillHandler();
    const call = body.slice(body.indexOf('distillInternalAgent('));
    expect(call).toContain('templateId');
  });

  it('omits it rather than passing an empty string', () => {
    // `templateId: ''` is not the same as absent: the loader answers undefined
    // for it, which hashes into the distill cache key as a DIFFERENT input from
    // "no template" while producing the same output — so an untemplated hire
    // and an empty-string one never share a cache entry and both pay full price.
    expect(svcDistillHandler()).toContain("templateId.length > 0");
  });
});
