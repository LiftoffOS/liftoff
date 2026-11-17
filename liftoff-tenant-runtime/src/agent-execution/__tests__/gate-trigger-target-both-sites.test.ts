// BOTH `checkHitlGate` call sites must pass the trigger target.
//
// `isInPlaceReply` begins `if (!target) return false`, so a call site that omits
// the argument makes the entire in-place carve-out unreachable — no allowlist
// entry, no record normalization, and no classification change can rescue it.
//
// service.ts has two call sites: the single-call one (executeToolCall) and
// the batch one (executeToolCalls), which is the path a workflow step takes.
// If the batch one passes `{ trustLevel, externalContentGateDisabled }` and
// nothing else, then however the allowlist is extended (e.g.
// `pull_request_review_write` with a method-scoped guard) and however the
// trigger target is normalized (so `repository` and `number` compare as
// scalars), a reviewer agent still asks permission to open a draft review on
// the pull request that woke it — every time, all avoidable.
//
// A source assertion rather than a behavioural one: the failure is an argument
// that is absent, and absence at a call site is not observable from the
// function's own behaviour. This is the check that catches it.

import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'service.ts'), 'utf8');

/** Every `checkHitlGate(` invocation with its argument list. */
function gateCallSites(): string[] {
  const out: string[] = [];
  let i = SRC.indexOf('hitlEnforcementService.checkHitlGate(');
  while (i !== -1) {
    // The options object is the last argument; take a generous window and stop
    // at the closing paren of the call.
    const end = SRC.indexOf('\n          );', i);
    const end2 = SRC.indexOf('\n    );', i);
    const stop = Math.min(...[end, end2].filter((n) => n > i));
    out.push(SRC.slice(i, Number.isFinite(stop) ? stop : i + 1200));
    i = SRC.indexOf('hitlEnforcementService.checkHitlGate(', i + 1);
  }
  return out;
}

describe('every checkHitlGate call site supplies the trigger target', () => {
  it('finds both call sites', () => {
    expect(gateCallSites().length).toBeGreaterThanOrEqual(2);
  });

  it('passes triggerTarget at EVERY one of them', () => {
    const offenders = gateCallSites()
      .map((site, idx) => ({ idx, site }))
      .filter(({ site }) => !site.includes('triggerTarget'));
    expect(offenders.map((o) => o.idx)).toEqual([]);
  });

  it('builds it through the one shared helper, never inline', () => {
    // Two inline constructions is how the two sites drifted in the first place.
    for (const site of gateCallSites()) {
      expect(site).toContain('this.buildTriggerTarget(state)');
    }
    expect(SRC).toContain('private buildTriggerTarget(');
  });

  it('the helper still builds only from the run OWN trigger', () => {
    // A model-supplied target would let untrusted content nominate what counts
    // as "in place", which is the injection this gate exists to stop.
    const helper = SRC.slice(
      SRC.indexOf('private buildTriggerTarget('),
      SRC.indexOf('private async executeToolStep('),
    );
    expect(helper).toContain("state.context.trigger?.kind === 'connector_event'");
    expect(helper).toContain('state.context.inputData');
    // and normalizes the vendor shapes into scalars the gate can compare
    expect(helper).toContain('repositorySlug(');
    expect(helper).toContain('prNumber(');
  });
});
