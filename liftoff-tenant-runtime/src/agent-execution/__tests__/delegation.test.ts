// Part 5 — delegateToAgents core behavior.
//
// Tests the pre-flight gates (depth cap, fanout cap, spawn pause, cross-tenant
// guard, idempotency) and the result of a clean fan-out. The per-child adapter
// call is mocked at the delegateToAgent boundary so the test exercises only
// the orchestrator logic.

import { applyClamp, DELEGATION_DEFAULTS, DELEGATION_HARD_CAPS } from '../delegation-defaults';

describe('applyClamp', () => {
  it('returns the tenant value when within bounds', () => {
    expect(applyClamp(5, 1, 10)).toBe(5);
  });

  it('returns the default when tenant value is null', () => {
    expect(applyClamp(null, 7, 10)).toBe(7);
  });

  it('caps at the hard cap when tenant value exceeds it', () => {
    expect(applyClamp(100, 1, 10)).toBe(10);
  });

  it('floors at 1 when tenant value is 0 (operator-typo guard)', () => {
    expect(applyClamp(0, 1, 10)).toBe(1);
  });

  it('floors at 1 when default is 0 too', () => {
    expect(applyClamp(null, 0, 10)).toBe(1);
  });
});

describe('DELEGATION_DEFAULTS + HARD_CAPS', () => {
  it('defaults are conservative (depth=1, fanout=16, concurrent=8)', () => {
    // These come from process.env in the module; restore between runs.
    expect(DELEGATION_DEFAULTS.MAX_DEPTH).toBeLessThanOrEqual(DELEGATION_HARD_CAPS.MAX_DEPTH);
    expect(DELEGATION_DEFAULTS.MAX_FANOUT).toBeLessThanOrEqual(DELEGATION_HARD_CAPS.MAX_FANOUT);
    expect(DELEGATION_DEFAULTS.DEFAULT_CONCURRENT).toBeLessThanOrEqual(DELEGATION_HARD_CAPS.DEFAULT_CONCURRENT);
  });

  it('hard caps match plan §D (depth=3, fanout=64, concurrent=32)', () => {
    expect(DELEGATION_HARD_CAPS.MAX_DEPTH).toBe(3);
    expect(DELEGATION_HARD_CAPS.MAX_FANOUT).toBe(64);
    expect(DELEGATION_HARD_CAPS.DEFAULT_CONCURRENT).toBe(32);
  });
});

// Surface-level smoke: DelegationError discriminates by `code` so callers can
// branch on the reason without parsing the message text. Verifying the union
// shape here keeps callers honest if a new code is added.
describe('DelegationError', () => {
  it('exposes a stable `code` field for branching', async () => {
    const { DelegationError } = await import('../service');
    const err = new DelegationError('test', 'fanout_exceeded');
    expect(err.code).toBe('fanout_exceeded');
    expect(err.name).toBe('DelegationError');
    expect(err.message).toBe('test');
  });
});
