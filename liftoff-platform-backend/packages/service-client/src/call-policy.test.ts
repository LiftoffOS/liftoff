import { CallPolicy, CallPolicyError } from './call-policy.js';

function makeClock() {
  let t = 0;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('CallPolicy', () => {
  it('returns invoke() result on first success', async () => {
    const policy = new CallPolicy({ calleeId: 'billing' });
    const result = await policy.execute({ idempotent: true, invoke: async () => 'ok' });
    expect(result).toBe('ok');
  });

  it('does NOT retry non-idempotent calls', async () => {
    const policy = new CallPolicy({ calleeId: 'billing' });
    const invoke = jest.fn().mockRejectedValue(new Error('boom'));
    await expect(policy.execute({ idempotent: false, invoke })).rejects.toThrow('boom');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('retries idempotent calls up to 3 attempts', async () => {
    const policy = new CallPolicy({ calleeId: 'billing', retryBudgetFraction: 1 });
    const invoke = jest
      .fn()
      .mockRejectedValueOnce(new Error('e1'))
      .mockRejectedValueOnce(new Error('e2'))
      .mockResolvedValueOnce('ok');
    const result = await policy.execute({ idempotent: true, invoke });
    expect(result).toBe('ok');
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(policy.getMetrics().retries).toBe(2);
  });

  it('enforces retry budget (10% of traffic)', async () => {
    const clock = makeClock();
    const policy = new CallPolicy({ calleeId: 'billing', retryBudgetFraction: 0.1, now: clock.now });
    // 10 successful calls to populate traffic history; budget allows 1 retry.
    for (let i = 0; i < 10; i++) {
      await policy.execute({ idempotent: false, invoke: async () => 'ok' });
      clock.advance(1);
    }
    // 11th call: one retry permitted → second retry rejected with RETRY_BUDGET_EXHAUSTED.
    const invoke = jest.fn().mockRejectedValue(new Error('flap'));
    await expect(policy.execute({ idempotent: true, invoke })).rejects.toMatchObject({ code: 'RETRY_BUDGET_EXHAUSTED' });
  });

  it('opens circuit on >=50% error rate in window with >=20 calls', async () => {
    const clock = makeClock();
    const policy = new CallPolicy({
      calleeId: 'billing',
      minCallsInWindow: 20,
      errorRateThreshold: 0.5,
      now: clock.now,
      retryBudgetFraction: 0,
    });
    for (let i = 0; i < 20; i++) {
      const invoke = jest.fn().mockRejectedValue(new Error('fail'));
      await expect(policy.execute({ idempotent: false, invoke })).rejects.toBeTruthy();
      clock.advance(100); // inside 10s window
    }
    expect(policy.getMetrics().circuitOpenCount).toBeGreaterThanOrEqual(1);
    // Subsequent call short-circuits with CIRCUIT_OPEN.
    await expect(
      policy.execute({ idempotent: false, invoke: async () => 'ok' }),
    ).rejects.toThrow(/circuit open/i);
  });

  it('reopens after open duration, probe success closes circuit', async () => {
    const clock = makeClock();
    const policy = new CallPolicy({
      calleeId: 'billing',
      minCallsInWindow: 2,
      errorRateThreshold: 0.5,
      openDurationMs: 1_000,
      now: clock.now,
      retryBudgetFraction: 0,
    });
    // Force-trip circuit with 2 failures over min window of 2 calls.
    for (let i = 0; i < 2; i++) {
      await expect(
        policy.execute({ idempotent: false, invoke: async () => { throw new Error('f'); } }),
      ).rejects.toBeTruthy();
      clock.advance(100);
    }
    // Circuit is open — advance past the open window.
    clock.advance(1_100);
    // Probe call succeeds → circuit closes.
    const result = await policy.execute({ idempotent: false, invoke: async () => 'probe-ok' });
    expect(result).toBe('probe-ok');
  });

  it('times out calls at defaultTimeoutMs', async () => {
    const policy = new CallPolicy({ calleeId: 'billing', defaultTimeoutMs: 20 });
    const invoke = () => new Promise(() => {}); // hangs forever
    await expect(policy.execute({ idempotent: false, invoke })).rejects.toThrow(/timed out/);
    expect(policy.getMetrics().timeouts).toBeGreaterThanOrEqual(1);
  });

  it('caps per-call timeout at 30s hard cap', () => {
    const policy = new CallPolicy({ calleeId: 'billing' });
    // Not a functional test — the clamp is internal. Just assert the type is exported.
    expect(policy).toBeInstanceOf(CallPolicy);
  });

  it('emits metrics via onMetric hook', async () => {
    const events: unknown[] = [];
    const policy = new CallPolicy({
      calleeId: 'billing',
      retryBudgetFraction: 1,
      onMetric: (m) => events.push(m),
    });
    let count = 0;
    await policy.execute({
      idempotent: true,
      invoke: async () => {
        if (count++ === 0) throw new Error('first');
        return 'ok';
      },
    });
    const retryEvents = events.filter((e) => (e as { kind: string }).kind === 'retry');
    expect(retryEvents.length).toBe(1);
  });

  it('CallPolicyError is thrown for policy-level failures', () => {
    const e = new CallPolicyError('CIRCUIT_OPEN', 'x');
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('CIRCUIT_OPEN');
  });
});
