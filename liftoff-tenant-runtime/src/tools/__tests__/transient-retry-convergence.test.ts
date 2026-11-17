// §6.5: the bounded pre-model retry runner must treat the connector-tool
// `retryable` flag as a superset of the legacy web-tool `transient` alias, read
// `retryAfterMs`, and strip BOTH flags on the second attempt so the model never
// re-interprets a residual retry hint.

import { runToolWithTransientRetry } from '../transient-retry';
import type { StandardToolResult } from '../standard-tool-handler';

describe('runToolWithTransientRetry — retryable/transient convergence', () => {
  it('retries once on retryable:true (no transient flag)', async () => {
    let calls = 0;
    const invoke = async (): Promise<StandardToolResult> => {
      calls++;
      return calls === 1
        ? { success: false, retryable: true, retryAfterMs: 1, error: 'busy' }
        : { success: true, result: { ok: true } };
    };
    const res = await runToolWithTransientRetry(invoke, { toolName: 't' });
    expect(calls).toBe(2);
    expect(res?.success).toBe(true);
  });

  it('still retries on the legacy transient flag', async () => {
    let calls = 0;
    const invoke = async (): Promise<StandardToolResult> => {
      calls++;
      return calls === 1
        ? { success: false, transient: true, retryAfterMs: 1, error: 'busy' }
        : { success: true };
    };
    await runToolWithTransientRetry(invoke, { toolName: 't' });
    expect(calls).toBe(2);
  });

  it('does not retry a permanent failure (neither flag set)', async () => {
    let calls = 0;
    const invoke = async (): Promise<StandardToolResult> => {
      calls++;
      return { success: false, error: 'nope' };
    };
    const res = await runToolWithTransientRetry(invoke, { toolName: 't' });
    expect(calls).toBe(1);
    expect(res?.success).toBe(false);
  });

  it('strips both retry flags on the second attempt', async () => {
    const invoke = async (): Promise<StandardToolResult> => ({
      success: false,
      retryable: true,
      retryAfterMs: 1,
      error: 'still busy',
    });
    const res = await runToolWithTransientRetry(invoke, { toolName: 't' });
    expect(res?.transient).toBe(false);
    expect(res?.retryable).toBe(false);
  });
});
