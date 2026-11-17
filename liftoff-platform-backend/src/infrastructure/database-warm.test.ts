// Unit tests for warmAdminPoolBestEffort — the startup admin-pool warmer that
// eliminates the "<name>-outbox-worker tick failed: timeout exceeded when
// trying to connect" noise on fresh Cloud Run instances by building + caching
// the admin pool at boot (with bounded retry) before any worker ticks.
//
// `ensure` and `sleep` are injected so the retry/backoff logic is exercised
// purely, with no real pg pool and no real timers.

import { warmAdminPoolBestEffort } from './database';

describe('warmAdminPoolBestEffort', () => {
  const noopSleep = (): Promise<void> => Promise.resolve();

  it('warms on the first attempt when the DB is reachable', async () => {
    const ensure = jest.fn().mockResolvedValue(undefined);

    const ok = await warmAdminPoolBestEffort({ ensure, sleep: noopSleep });

    expect(ok).toBe(true);
    expect(ensure).toHaveBeenCalledTimes(1);
  });

  it('retries through transient failures and succeeds (rides out warm-up)', async () => {
    const ensure = jest
      .fn()
      .mockRejectedValueOnce(new Error('timeout exceeded when trying to connect'))
      .mockRejectedValueOnce(new Error('Connection terminated due to connection timeout'))
      .mockResolvedValueOnce(undefined);
    const sleep = jest.fn().mockResolvedValue(undefined);

    const ok = await warmAdminPoolBestEffort({ ensure, sleep });

    expect(ok).toBe(true);
    expect(ensure).toHaveBeenCalledTimes(3);
    // Backoff slept once between each of the two failures (not after success).
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('gives up after the attempt budget without throwing (best-effort, non-fatal)', async () => {
    const ensure = jest.fn().mockRejectedValue(new Error('timeout exceeded when trying to connect'));
    const sleep = jest.fn().mockResolvedValue(undefined);

    const ok = await warmAdminPoolBestEffort({ attempts: 3, ensure, sleep });

    expect(ok).toBe(false);
    expect(ensure).toHaveBeenCalledTimes(3);
    // Sleeps between attempts only — not after the final failed attempt.
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('does not sleep when the single allotted attempt fails', async () => {
    const ensure = jest.fn().mockRejectedValue(new Error('nope'));
    const sleep = jest.fn().mockResolvedValue(undefined);

    const ok = await warmAdminPoolBestEffort({ attempts: 1, ensure, sleep });

    expect(ok).toBe(false);
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
