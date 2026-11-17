// The one carve-out from invariant 3, and the six providers that must use it.
//
// The defect this exists for is silent by construction: every query succeeds,
// every card renders, and the number is zero. So the test asserts the two
// halves separately — the decision, and that nobody has hard-coded around it.

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const mockKind = { value: 'stripe' as 'stripe' | 'unbilled' };
jest.mock('../../billing/provider', () => ({
  getBillingProvider: () => ({ kind: mockKind.value }),
}));

import { costColumn } from '../cost-column';

describe('which cost column the workspace surfaces sum', () => {
  it('sums the charged amount when there is a billing provider', () => {
    mockKind.value = 'stripe';
    expect(costColumn()).toBe('customer_cost_usd');
  });

  it('sums raw vendor cost when nobody is being charged', () => {
    // Without a billing provider every call books customer_cost_usd = 0, so
    // the charged amount is zero for every row and the only real number left
    // is what the vendors cost.
    mockKind.value = 'unbilled';
    expect(costColumn()).toBe('cost_usd');
  });

  it('is read per call, not frozen at import', () => {
    // A module-level constant would answer with whatever the first caller in
    // the process saw, which in a long-lived container is whatever booted it.
    mockKind.value = 'stripe';
    expect(costColumn()).toBe('customer_cost_usd');
    mockKind.value = 'unbilled';
    expect(costColumn()).toBe('cost_usd');
  });
});

describe('the cost providers go through it', () => {
  const dir = join(__dirname, '..', 'data-providers');

  // Mirrors the CI rule in .github/workflows/ou-native-grep-gate.yml so the
  // property fails here too, where a developer sees it before pushing.
  // `SUM(cost_usd) AS cost_usd` is exempt: it preserves the raw amount
  // alongside the charged one for ops, which is what the gate has always
  // allowed.
  const HARD_CODED = /SUM\((?:customer_cost_usd|cost_usd)\)(?!\s+AS\s+cost_usd\b)/;

  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));

  it('finds the providers to check', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files)('%s does not hard-code a cost column', (file) => {
    const src = readFileSync(join(dir, file), 'utf8');
    const offender = src.split('\n').find((l) => HARD_CODED.test(l));
    expect(offender ?? null).toBeNull();
  });

  it('at least one provider actually sums the resolved column', () => {
    // Guards the inverse mistake: a regex that passes because every provider
    // stopped summing anything at all.
    const summing = files.filter((f) =>
      readFileSync(join(dir, f), 'utf8').includes('SUM(${costColumn()})'));
    expect(summing.length).toBeGreaterThanOrEqual(6);
  });
});
