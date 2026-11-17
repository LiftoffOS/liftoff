// The case table lives here, and so does the test of it. A consumer's own
// suite asserts its WIRING (that it passes the numbers it has and acts on the
// answer) and nothing about the arithmetic — otherwise three copies of the
// table drift again, which is the defect this package was written to end.

import {
  CONSERVATIVE_CONTEXT_WINDOW_TOKENS,
  CONTEXT_GUARD_SHARE,
  contextWindowOrFallback,
  decideTurnBound,
  mayRetireOn,
} from './index';

describe('the window a turn is bounded by', () => {
  it('uses the recorded window when there is one, and says so', () => {
    expect(contextWindowOrFallback(1_000_000)).toEqual({ tokens: 1_000_000, source: 'registry' });
  });

  it('falls back to the conservative window when the registry has none', () => {
    for (const none of [undefined, null, 0, -1]) {
      expect(contextWindowOrFallback(none)).toEqual({
        tokens: CONSERVATIVE_CONTEXT_WINDOW_TOKENS,
        source: 'fallback',
      });
    }
  });

  it('permits a destructive decision only on a recorded window', () => {
    expect(mayRetireOn({ tokens: 1_000_000, source: 'registry' })).toBe(true);
    expect(mayRetireOn({ tokens: CONSERVATIVE_CONTEXT_WINDOW_TOKENS, source: 'fallback' })).toBe(false);
    expect(mayRetireOn(undefined)).toBe(false);
  });
});

describe('the turn-bound case table', () => {
  const healthy = { iteration: 3, maxIterations: 50, contextTokens: 1_000, recordedContextWindow: 200_000 };

  it('keeps going when no bound has tripped', () => {
    const d = decideTurnBound(healthy);
    expect(d.close).toBeNull();
    expect(d.window).toEqual({ tokens: 200_000, source: 'registry' });
    expect(d.mayRetire).toBe(true);
    expect(d.ratio).toBe(0.005);
  });

  it('closes on rounds when the cap is reached', () => {
    expect(decideTurnBound({ ...healthy, iteration: 50 }).close).toBe('rounds');
    expect(decideTurnBound({ ...healthy, iteration: 51 }).close).toBe('rounds');
  });

  it('takes the round cap as an input, so a run with a bigger budget keeps going', () => {
    expect(decideTurnBound({ ...healthy, iteration: 50, maxIterations: 100 }).close).toBeNull();
  });

  it('never closes on rounds when the cap is not a positive number', () => {
    expect(decideTurnBound({ ...healthy, iteration: 9_999, maxIterations: 0 }).close).toBeNull();
  });

  it('leaves the round half out when the caller supplied no rounds', () => {
    // The two platform assistants test their rounds at the head of the loop
    // and at the end of each round; what they ask here is the per-call half.
    // Answering 'rounds' to them would close a turn one round early and skip
    // the tools it had just asked for.
    expect(decideTurnBound({ contextTokens: 1_000, recordedContextWindow: 200_000 }).close).toBeNull();
    expect(decideTurnBound({ iteration: 9_999, contextTokens: 1_000, recordedContextWindow: 200_000 }).close).toBeNull();
    expect(decideTurnBound({ maxIterations: 50, contextTokens: 1_000, recordedContextWindow: 200_000 }).close).toBeNull();
  });

  it('closes on context past the guarded share of a recorded window, and may retire', () => {
    const over = Math.floor(CONTEXT_GUARD_SHARE * 200_000) + 1;
    const d = decideTurnBound({ ...healthy, contextTokens: over });
    expect(d.close).toBe('context');
    expect(d.mayRetire).toBe(true);
  });

  it('does not close exactly AT the guarded share', () => {
    expect(decideTurnBound({ ...healthy, contextTokens: CONTEXT_GUARD_SHARE * 200_000 }).close).toBeNull();
  });

  it('closes on context against the fallback window, but may NOT retire on it', () => {
    const over = Math.floor(CONTEXT_GUARD_SHARE * CONSERVATIVE_CONTEXT_WINDOW_TOKENS) + 1;
    const d = decideTurnBound({ iteration: 1, maxIterations: 50, contextTokens: over, recordedContextWindow: undefined });
    expect(d.close).toBe('context');
    expect(d.window.source).toBe('fallback');
    expect(d.mayRetire).toBe(false);
  });

  it('measures a 1M model against 1M, not against the fallback', () => {
    // The sharpest case in the audit: claude-sonnet-5 closing at ~90k because
    // nobody had recorded its window.
    const d = decideTurnBound({ iteration: 1, maxIterations: 50, contextTokens: 300_000, recordedContextWindow: 1_000_000 });
    expect(d.close).toBeNull();
    expect(decideTurnBound({ iteration: 1, maxIterations: 50, contextTokens: 300_000 }).close).toBe('context');
  });

  it('leaves the window half inert when the provider reported no prompt size', () => {
    for (const none of [undefined, 0]) {
      const d = decideTurnBound({ iteration: 1, maxIterations: 50, contextTokens: none, recordedContextWindow: 200_000 });
      expect(d.close).toBeNull();
      expect(d.ratio).toBeUndefined();
    }
  });

  it('closes on a passed deadline', () => {
    expect(decideTurnBound({ ...healthy, deadlinePassed: true }).close).toBe('deadline');
    expect(decideTurnBound({ ...healthy, deadlinePassed: false }).close).toBeNull();
  });

  it('reports rounds first, then context, then deadline', () => {
    const everything = { iteration: 50, maxIterations: 50, contextTokens: 199_000, recordedContextWindow: 200_000, deadlinePassed: true };
    expect(decideTurnBound(everything).close).toBe('rounds');
    expect(decideTurnBound({ ...everything, iteration: 1 }).close).toBe('context');
    expect(decideTurnBound({ ...everything, iteration: 1, contextTokens: 1 }).close).toBe('deadline');
  });
});
