import { CircuitBreaker } from './circuit-breaker.js';

describe('CircuitBreaker', () => {
  it('returns fn result on success and keeps circuit closed', async () => {
    const cb = new CircuitBreaker();
    const result = await cb.executeOrFallback('key-1', async () => 42, -1);
    expect(result).toBe(42);
    expect(cb.peek('key-1')?.state).toBe('closed');
    expect(cb.peek('key-1')?.consecutiveFailures).toBe(0);
  });

  it('returns fallback and increments failure counter on throw', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });
    const result = await cb.executeOrFallback(
      'key-1',
      async () => {
        throw new Error('boom');
      },
      'fallback',
    );
    expect(result).toBe('fallback');
    expect(cb.peek('key-1')?.state).toBe('closed');
    expect(cb.peek('key-1')?.consecutiveFailures).toBe(1);
  });

  it('opens the circuit after failureThreshold consecutive failures', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });
    const fail = () => cb.executeOrFallback('key-1', async () => { throw new Error('x'); }, 'fallback');
    await fail();
    await fail();
    expect(cb.peek('key-1')?.state).toBe('closed');
    await fail();
    expect(cb.peek('key-1')?.state).toBe('open');
  });

  it('fast-fails without calling fn when circuit is open', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 10_000 });
    const fn = jest.fn(async () => { throw new Error('x'); });

    // Trip the circuit
    await cb.executeOrFallback('key-1', fn, 'fallback');
    expect(cb.peek('key-1')?.state).toBe('open');
    expect(fn).toHaveBeenCalledTimes(1);

    // Subsequent call returns fallback WITHOUT invoking fn
    const result = await cb.executeOrFallback('key-1', fn, 'fallback-2');
    expect(result).toBe('fallback-2');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('transitions to half_open after resetTimeoutMs elapses', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 50 });
    await cb.executeOrFallback('key-1', async () => { throw new Error('x'); }, 'f');
    expect(cb.peek('key-1')?.state).toBe('open');

    await new Promise((r) => setTimeout(r, 60));

    // Next call acts as a probe; if it fails, circuit re-opens immediately.
    await cb.executeOrFallback('key-1', async () => { throw new Error('y'); }, 'f');
    expect(cb.peek('key-1')?.state).toBe('open');
  });

  it('closes the circuit on successful half_open probe', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 50 });
    await cb.executeOrFallback('key-1', async () => { throw new Error('x'); }, 'f');

    await new Promise((r) => setTimeout(r, 60));

    const result = await cb.executeOrFallback('key-1', async () => 'ok', 'f');
    expect(result).toBe('ok');
    expect(cb.peek('key-1')?.state).toBe('closed');
    expect(cb.peek('key-1')?.consecutiveFailures).toBe(0);
  });

  it('isolates circuits by key', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1 });
    await cb.executeOrFallback('tenant-A:m', async () => { throw new Error('x'); }, 'f');
    expect(cb.peek('tenant-A:m')?.state).toBe('open');
    expect(cb.peek('tenant-B:m')?.state).toBeUndefined();

    const result = await cb.executeOrFallback('tenant-B:m', async () => 'ok', 'f');
    expect(result).toBe('ok');
  });

  it('invokes onStateChange hook on transitions', async () => {
    const transitions: Array<{ key: string; state: string }> = [];
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 50,
      onStateChange: (key, state) => transitions.push({ key, state }),
    });

    await cb.executeOrFallback('k', async () => { throw new Error('x'); }, 'f');
    await new Promise((r) => setTimeout(r, 60));
    await cb.executeOrFallback('k', async () => 'ok', 'f');

    const states = transitions.map((t) => t.state);
    expect(states).toContain('open');
    expect(states).toContain('half_open');
    expect(states).toContain('closed');
  });
});
