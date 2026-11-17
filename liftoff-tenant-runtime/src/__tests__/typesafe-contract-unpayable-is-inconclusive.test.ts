// An unpaid vendor account is an INCONCLUSIVE contract, not a failed one.
//
// `typesafe-contract` sits on the critical path of every runtime deploy, and
// that is deliberate: several kills default ON in this build and ship with these
// fixtures as their evidence, so a contract that skips itself is worse than a
// slow build. The three-state contract exists for the other case —
// `run-typesafe-contract.sh` opens by naming it: "What is NOT deliberate is a
// vendor outage blocking a billing fix from reaching production."
//
// An account out of credit fails every fixture with:
//
//     APIError: 402 Your organization has no available TypeSafe API credits.
//
// and stops the build before any image is built, blocking a release whose
// contents the contract has no opinion about. 402 is not transient (retrying a
// payment refusal cannot succeed), but unless it is reported as unreachable it
// falls through as a fixture breach.
//
// Two properties, and the pairing is the point. A 402 must reach the sentinel,
// and it must NOT be retried: retrying spends calls on an account that has none.
//
// Asserted on source because the behaviour lives in a LIVE suite — it runs only
// under LIVE_TESTS against a real vendor, and reproducing it would need an
// account that is out of credit on purpose.

import { readFileSync } from 'fs';
import { join } from 'path';

const SUITE = readFileSync(
  join(__dirname, '..', 'typesafe', '__tests__', 'fixtures.live.test.ts'),
  'utf8',
);
const RUNNER = readFileSync(
  join(__dirname, '..', '..', 'scripts', 'ci', 'run-typesafe-contract.sh'),
  'utf8',
);

describe('a 402 is reported as the vendor not answering', () => {
  it('402 is classified unpayable, and is NOT in the transient set', () => {
    expect(SUITE).toMatch(/UNPAYABLE_STATUSES\s*=\s*new Set\(\[\s*402\s*\]\)/);
    const transient = /TRANSIENT_STATUSES\s*=\s*new Set\(\[([^\]]*)\]\)/.exec(SUITE);
    expect(transient).not.toBeNull();
    expect(transient![1]).not.toContain('402');
  });

  it('prints the sentinel the CI wrapper reads', () => {
    const branch = SUITE.slice(SUITE.indexOf('UNPAYABLE_STATUSES.has(status)'));
    expect(branch.slice(0, 400)).toContain('VENDOR_UNAVAILABLE_SENTINEL');
  });

  it('is decided BEFORE the transient test, so it consumes no retries', () => {
    const unpayable = SUITE.indexOf('UNPAYABLE_STATUSES.has(status)');
    const transient = SUITE.indexOf('const transient = ');
    expect(unpayable).toBeGreaterThan(-1);
    expect(transient).toBeGreaterThan(-1);
    expect(unpayable).toBeLessThan(transient);
  });

  it('statusOf can see a 402 that only appears in the message', () => {
    // The SDK sets `status`, so this is the fallback — and a 402 it cannot
    // recognise fails as a fixture breach, which is the one wrong answer.
    const fallback = /const m = \/\\b\(([^)]*)\)\\b\//.exec(SUITE);
    expect(fallback).not.toBeNull();
    expect(fallback![1]).toContain('402');
  });

  it('the runner still maps the sentinel to exit 2, and a moved band to exit 1', () => {
    expect(RUNNER).toMatch(/grep -q "\$SENTINEL"[\s\S]{0,300}exit 2/);
    // A missing key stays BLOCKING: that is this build's own configuration, and
    // the features shipping on this evidence default ON regardless.
    expect(RUNNER).toMatch(/no key; refusing to run a contract that would skip itself[\s\S]{0,120}exit 1/);
  });
});
