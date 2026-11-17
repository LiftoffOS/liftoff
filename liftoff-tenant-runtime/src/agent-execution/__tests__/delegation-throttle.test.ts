// Part 5 §F — soft-throttle behavior.
//
// The throttle:
//   • returns 0 when both signals are below threshold
//   • engages on simulated Anthropic 429 rate > 5%
//   • engages on simulated Cloud SQL pool utilization > 85%
//   • follows an exponential backoff up to BACKOFF.MAX_MS
//   • resets to 0 after one healthy batch

// Mock the dependencies so the throttle's signal sources are controllable.
const mockGetRate = jest.fn<number, [string, number]>();
jest.mock('../../llm/anthropic-pool-stats', () => ({
  getAnthropicPool429Rate: (group: string, windowMs: number) => mockGetRate(group, windowMs),
}));

const mockQuery = jest.fn<Promise<{ rows: Array<{ utilization: number }> }>, [string]>();
jest.mock('../../infrastructure/database', () => ({
  getPoolForService: () => ({ query: mockQuery }),
}));

// Logging is noisy — silence it.
jest.mock('../../infrastructure/logging', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

import { computeThrottleDelay, type ThrottleState } from '../delegation-throttle';

function freshState(): ThrottleState {
  return { consecutiveThrottledBatches: 0, lastBackoffMs: 0 };
}

beforeEach(() => {
  mockGetRate.mockReset();
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [{ utilization: 0 }] });
  mockGetRate.mockReturnValue(0);
});

describe('computeThrottleDelay', () => {
  it('returns 0 when both signals are below threshold', async () => {
    const state = freshState();
    mockGetRate.mockReturnValue(0.01);   // 1%, well under 5%
    mockQuery.mockResolvedValue({ rows: [{ utilization: 0.5 }] });   // 50%, well under 85%
    expect(await computeThrottleDelay(state)).toBe(0);
    expect(state.consecutiveThrottledBatches).toBe(0);
  });

  it('engages when Anthropic 429 rate exceeds 5%', async () => {
    const state = freshState();
    mockGetRate.mockReturnValue(0.10);   // 10%
    expect(await computeThrottleDelay(state)).toBeGreaterThan(0);
    expect(state.consecutiveThrottledBatches).toBe(1);
  });

  it('engages when DB utilization exceeds 85%', async () => {
    const state = freshState();
    mockQuery.mockResolvedValue({ rows: [{ utilization: 0.95 }] });
    expect(await computeThrottleDelay(state)).toBeGreaterThan(0);
    expect(state.consecutiveThrottledBatches).toBe(1);
  });

  it('follows exponential backoff up to a cap', async () => {
    const state = freshState();
    mockGetRate.mockReturnValue(0.10);
    const first = await computeThrottleDelay(state);
    const second = await computeThrottleDelay(state);
    const third = await computeThrottleDelay(state);
    expect(second).toBeGreaterThanOrEqual(first * 2 - 1);   // tolerate rounding
    expect(third).toBeGreaterThanOrEqual(second);
    expect(third).toBeLessThanOrEqual(10_000);   // hard ceiling
  });

  it('resets to 0 after one healthy batch', async () => {
    const state = freshState();
    mockGetRate.mockReturnValue(0.10);
    await computeThrottleDelay(state);
    await computeThrottleDelay(state);
    expect(state.consecutiveThrottledBatches).toBe(2);

    // Health restored
    mockGetRate.mockReturnValue(0);
    mockQuery.mockResolvedValue({ rows: [{ utilization: 0 }] });
    expect(await computeThrottleDelay(state)).toBe(0);
    expect(state.consecutiveThrottledBatches).toBe(0);
    expect(state.lastBackoffMs).toBe(0);
  });

  it('never rejects — only adds sleep (return type is always a number)', async () => {
    const state = freshState();
    mockGetRate.mockReturnValue(1.0);    // 100% — maximum pressure
    mockQuery.mockResolvedValue({ rows: [{ utilization: 1.0 }] });
    const delay = await computeThrottleDelay(state);
    expect(typeof delay).toBe('number');
    expect(delay).toBeGreaterThan(0);
    // The throttle must not throw — that would let a single saturated signal
    // tear down the whole fan-out.
  });
});
