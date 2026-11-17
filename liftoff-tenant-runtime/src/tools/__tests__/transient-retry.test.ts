/**
 * B1.5 — runToolWithTransientRetry contract tests.
 *
 * The wrapper exists so the LLM never sees a "vendor pool busy, retry shortly"
 * prose — the runner retries once before surfacing failures to the model.
 */

const mockLoggerInfo = jest.fn();
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: mockLoggerInfo, warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { runToolWithTransientRetry } from '../transient-retry';
import type { StandardToolResult } from '../standard-tool-handler';

beforeEach(() => { mockLoggerInfo.mockReset(); });

describe('runToolWithTransientRetry', () => {
  it('returns success when the first attempt succeeds (no retry)', async () => {
    const invoke = jest.fn<Promise<StandardToolResult>, []>().mockResolvedValueOnce({ success: true, result: 'ok' });
    const out = await runToolWithTransientRetry(invoke);
    expect(out).toEqual({ success: true, result: 'ok' });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('retries once when the first attempt is transient and surfaces the second success', async () => {
    const invoke = jest.fn<Promise<StandardToolResult>, []>()
      .mockResolvedValueOnce({ success: false, transient: true, retryAfterMs: 5, error: 'busy' })
      .mockResolvedValueOnce({ success: true, result: 'ok-on-retry' });
    const out = await runToolWithTransientRetry(invoke);
    // Both retry flags are stripped on the second attempt (§6.5 converged
    // `retryable` with the legacy `transient` alias).
    expect(out).toEqual({ success: true, result: 'ok-on-retry', transient: false, retryable: false });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('strips transient flag on the second attempt so the model does not see "retry" prose', async () => {
    const invoke = jest.fn<Promise<StandardToolResult>, []>()
      .mockResolvedValueOnce({ success: false, transient: true, retryAfterMs: 5, error: 'busy' })
      .mockResolvedValueOnce({ success: false, transient: true, retryAfterMs: 5, error: 'still busy' });
    const out = await runToolWithTransientRetry(invoke);
    expect(out).toMatchObject({ success: false, error: 'still busy', transient: false });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('caps retryAfterMs at 3000ms so a misbehaving vendor cannot push agent latency unboundedly', async () => {
    const invoke = jest.fn<Promise<StandardToolResult>, []>()
      .mockResolvedValueOnce({ success: false, transient: true, retryAfterMs: 60_000, error: 'busy' })
      .mockResolvedValueOnce({ success: true, result: 'ok' });
    const t0 = Date.now();
    await runToolWithTransientRetry(invoke);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(3_500); // 3000 cap + slack
  });

  it('returns null when both invocations return null', async () => {
    const invoke = jest.fn<Promise<StandardToolResult | null>, []>().mockResolvedValue(null);
    const out = await runToolWithTransientRetry(invoke);
    expect(out).toBeNull();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('emits a structured `web_fetch_transient_retry` log line on first-attempt-transient and a second outcome line', async () => {
    const invoke = jest.fn<Promise<StandardToolResult>, []>()
      .mockResolvedValueOnce({ success: false, transient: true, retryAfterMs: 5, error: 'busy' })
      .mockResolvedValueOnce({ success: true, result: 'ok' });
    await runToolWithTransientRetry(invoke, { toolName: 'web_fetch_advanced' });
    const calls = mockLoggerInfo.mock.calls;
    expect(calls).toEqual(expect.arrayContaining([
      [expect.objectContaining({ tool_name: 'web_fetch_advanced', phase: 'first_attempt_transient', retry_after_ms: 5, delay_ms: 5, delay_capped: false }), 'web_fetch_transient_retry'],
      [expect.objectContaining({ tool_name: 'web_fetch_advanced', phase: 'second_attempt_succeeded' }), 'web_fetch_transient_retry'],
    ]));
  });

  it('marks delay_capped=true in the log when retryAfterMs exceeds the 3s cap', async () => {
    const invoke = jest.fn<Promise<StandardToolResult>, []>()
      .mockResolvedValueOnce({ success: false, transient: true, retryAfterMs: 60_000, error: 'busy' })
      .mockResolvedValueOnce({ success: true, result: 'ok' });
    await runToolWithTransientRetry(invoke, { toolName: 'web_task' });
    const firstCall = mockLoggerInfo.mock.calls.find(c => c[0]?.phase === 'first_attempt_transient');
    expect(firstCall?.[0]).toMatchObject({ delay_capped: true, delay_ms: 3_000, retry_after_ms: 60_000 });
  });

  it('logs `second_attempt_failed` when the retry is also transient (so operators can metric structural saturation)', async () => {
    const invoke = jest.fn<Promise<StandardToolResult>, []>()
      .mockResolvedValueOnce({ success: false, transient: true, retryAfterMs: 5, error: 'busy' })
      .mockResolvedValueOnce({ success: false, transient: true, retryAfterMs: 5, error: 'still busy' });
    await runToolWithTransientRetry(invoke, { toolName: 'web_extract' });
    const secondCall = mockLoggerInfo.mock.calls.find(c => c[0]?.phase === 'second_attempt_failed');
    expect(secondCall?.[0]).toMatchObject({ tool_name: 'web_extract', second_transient: true });
  });
});
