// Tenant Runtime Circuit Breaker tests
//
// State machine + per-key isolation. Uses small real timers (~50ms cooldown)
// rather than jest fake timers — keeps the test simple and reliable, and the
// test suite stays under a second.

import { TenantRuntimeCircuitBreaker } from '../tenant-runtime-circuit-breaker';

jest.mock('../../infrastructure/logging', () => ({
  log: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('TenantRuntimeCircuitBreaker', () => {
  let breaker: TenantRuntimeCircuitBreaker;
  const key = { tenantId: 'tenant-1', method: 'getX' };

  beforeEach(() => {
    breaker = new TenantRuntimeCircuitBreaker({
      failureThreshold: 3,
      resetTimeoutMs: 50,
      halfOpenMaxAttempts: 1,
    });
  });

  describe('closed state', () => {
    it('returns the fn result on success and stays closed', async () => {
      const fn = jest.fn().mockResolvedValue('ok');
      const result = await breaker.executeOrFallback(key, fn, 'fallback');
      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(1);
      expect(breaker.peek(key)?.state).toBe('closed');
      expect(breaker.peek(key)?.consecutiveFailures).toBe(0);
    });

    it('returns fallback and increments failure count when fn throws', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('boom'));
      const result = await breaker.executeOrFallback(key, fn, 'fallback');
      expect(result).toBe('fallback');
      expect(breaker.peek(key)?.state).toBe('closed');
      expect(breaker.peek(key)?.consecutiveFailures).toBe(1);
    });

    it('opens the circuit after failureThreshold consecutive failures', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('boom'));
      await breaker.executeOrFallback(key, fn, 'fallback');
      await breaker.executeOrFallback(key, fn, 'fallback');
      expect(breaker.peek(key)?.state).toBe('closed');
      await breaker.executeOrFallback(key, fn, 'fallback');
      expect(breaker.peek(key)?.state).toBe('open');
    });

    it('resets the failure count after a successful call', async () => {
      const fn = jest.fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce('ok');

      await breaker.executeOrFallback(key, fn, 'fallback');
      await breaker.executeOrFallback(key, fn, 'fallback');
      expect(breaker.peek(key)?.consecutiveFailures).toBe(2);

      const result = await breaker.executeOrFallback(key, fn, 'fallback');
      expect(result).toBe('ok');
      expect(breaker.peek(key)?.consecutiveFailures).toBe(0);
    });

    it('preserves the fallback type — works with object/array/null fallbacks', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('boom'));

      const objResult = await breaker.executeOrFallback(
        { tenantId: 't', method: 'm1' },
        fn,
        { count: 0 },
      );
      expect(objResult).toEqual({ count: 0 });

      const arrResult = await breaker.executeOrFallback(
        { tenantId: 't', method: 'm2' },
        fn,
        [] as string[],
      );
      expect(arrResult).toEqual([]);

      const nullResult = await breaker.executeOrFallback<string | null>(
        { tenantId: 't', method: 'm3' },
        fn,
        null,
      );
      expect(nullResult).toBeNull();
    });
  });

  describe('open state', () => {
    beforeEach(async () => {
      const failingFn = jest.fn().mockRejectedValue(new Error('boom'));
      await breaker.executeOrFallback(key, failingFn, 'fallback');
      await breaker.executeOrFallback(key, failingFn, 'fallback');
      await breaker.executeOrFallback(key, failingFn, 'fallback');
      expect(breaker.peek(key)?.state).toBe('open');
    });

    it('returns fallback without calling fn during the cooldown window', async () => {
      const fn = jest.fn().mockResolvedValue('would-not-be-called');
      const result = await breaker.executeOrFallback(key, fn, 'fallback');
      expect(result).toBe('fallback');
      expect(fn).not.toHaveBeenCalled();
    });

    it('transitions to half_open and runs the probe after cooldown elapses', async () => {
      await wait(60);
      const fn = jest.fn().mockResolvedValue('probe-ok');
      const result = await breaker.executeOrFallback(key, fn, 'fallback');
      expect(result).toBe('probe-ok');
      expect(fn).toHaveBeenCalledTimes(1);
      // Successful probe → closed
      expect(breaker.peek(key)?.state).toBe('closed');
      expect(breaker.peek(key)?.consecutiveFailures).toBe(0);
    });
  });

  describe('half_open state', () => {
    beforeEach(async () => {
      const failingFn = jest.fn().mockRejectedValue(new Error('boom'));
      await breaker.executeOrFallback(key, failingFn, 'fallback');
      await breaker.executeOrFallback(key, failingFn, 'fallback');
      await breaker.executeOrFallback(key, failingFn, 'fallback');
      expect(breaker.peek(key)?.state).toBe('open');
      await wait(60);
    });

    it('closes the circuit and resets state on probe success', async () => {
      const fn = jest.fn().mockResolvedValue('ok');
      await breaker.executeOrFallback(key, fn, 'fallback');
      const state = breaker.peek(key);
      expect(state?.state).toBe('closed');
      expect(state?.consecutiveFailures).toBe(0);
      expect(state?.halfOpenAttempts).toBe(0);
    });

    it('re-opens the circuit immediately on probe failure (no extra threshold)', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('still broken'));
      await breaker.executeOrFallback(key, fn, 'fallback');
      const state = breaker.peek(key);
      expect(state?.state).toBe('open');
      // openedAt should have been updated to the new failure time
      expect(state?.openedAt).not.toBeNull();
    });

    it('bounds concurrent half_open probes by halfOpenMaxAttempts', async () => {
      // Call A enters half_open and starts a probe we control via a deferred promise
      let resolveProbe!: (value: string) => void;
      const probePromise = new Promise<string>(resolve => { resolveProbe = resolve; });
      const fnA = jest.fn().mockReturnValue(probePromise);
      const callA = breaker.executeOrFallback(key, fnA, 'fallback');

      // Yield once so call A advances past the half_open gate and increments halfOpenAttempts
      await Promise.resolve();

      // Concurrent call B arrives — should not call its fn, should return fallback
      const fnB = jest.fn().mockResolvedValue('B-result');
      const resultB = await breaker.executeOrFallback(key, fnB, 'fallback');

      expect(fnB).not.toHaveBeenCalled();
      expect(resultB).toBe('fallback');

      // Resolve probe and confirm A completes successfully
      resolveProbe('A-ok');
      const resultA = await callA;
      expect(resultA).toBe('A-ok');
      expect(breaker.peek(key)?.state).toBe('closed');
    });
  });

  describe('per-key isolation', () => {
    it('failures on one key do not open circuits on other keys', async () => {
      const failingFn = jest.fn().mockRejectedValue(new Error('boom'));
      await breaker.executeOrFallback({ tenantId: 'tenant-a', method: 'getCost' }, failingFn, null);
      await breaker.executeOrFallback({ tenantId: 'tenant-a', method: 'getCost' }, failingFn, null);
      await breaker.executeOrFallback({ tenantId: 'tenant-a', method: 'getCost' }, failingFn, null);
      expect(breaker.peek({ tenantId: 'tenant-a', method: 'getCost' })?.state).toBe('open');

      // Other tenant's same-method circuit unaffected
      expect(breaker.peek({ tenantId: 'tenant-b', method: 'getCost' })).toBeUndefined();
      // Same tenant's other method circuit unaffected
      expect(breaker.peek({ tenantId: 'tenant-a', method: 'getInvocations' })).toBeUndefined();

      // And both still allow calls through
      const okFn = jest.fn().mockResolvedValue('ok');
      const resultB = await breaker.executeOrFallback(
        { tenantId: 'tenant-b', method: 'getCost' },
        okFn,
        null,
      );
      expect(resultB).toBe('ok');

      const resultA2 = await breaker.executeOrFallback(
        { tenantId: 'tenant-a', method: 'getInvocations' },
        okFn,
        null,
      );
      expect(resultA2).toBe('ok');
    });
  });

  describe('reset()', () => {
    it('clears all circuits', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('boom'));
      await breaker.executeOrFallback(key, fn, 'fallback');
      await breaker.executeOrFallback(key, fn, 'fallback');
      await breaker.executeOrFallback(key, fn, 'fallback');
      expect(breaker.peek(key)?.state).toBe('open');

      breaker.reset();
      expect(breaker.peek(key)).toBeUndefined();
    });
  });
});
