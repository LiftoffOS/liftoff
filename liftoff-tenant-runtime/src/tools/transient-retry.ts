import type { StandardToolResult } from './standard-tool-handler';
import { logger } from '../infrastructure/logging';

// Hard upper bound on the retry delay. A vendor that pushes >3s of additional
// wait is structurally over-saturated (procurement problem), not transiently
// contended (runtime problem). Capping protects agent-call latency from
// runaway.
const MAX_RETRY_DELAY_MS = 3_000;

interface TransientRetryContext {
  /** Tool name being invoked — included in the observability log line so
   *  operators can build a per-tool busy-retry metric. */
  toolName?: string;
}

/**
 * Exactly one bounded auto-retry on `transient: true`.
 *
 * Without this wrapper, every VendorPoolBusy surfaces to the model as a
 * `success: false` tool result. The model is unreliable at recognizing
 * "system busy, please retry" prose — it may apologize, abandon the task,
 * or invent a workaround. This wrapper does the retry BEFORE the model is
 * involved.
 *
 * Every retry decision emits a structured log entry
 * (`web_fetch_transient_retry`) so operators can build a Cloud Logging /
 * Cloud Monitoring metric on retry rate, broken down by tool and outcome.
 * A sustained spike in `outcome=second_attempt_failed` is the signal that
 * vendor capacity needs to grow (procurement, not runtime).
 *
 * Why bounded at one retry, not exponential:
 *  - The 5s admission wait inside acquireInflightSlot already absorbs short
 *    contention windows. A retry that needed >1s more is hitting structural
 *    saturation, not transient noise.
 *  - Multiple retries amplify load on the already-stressed vendor pool —
 *    exactly the wrong direction.
 *  - One retry doubles best-case latency in the worst case (≤10s total),
 *    which is the upper bound of agent tool-call latency we're willing to
 *    absorb.
 */
export async function runToolWithTransientRetry(
  invoke: () => Promise<StandardToolResult | null>,
  ctx: TransientRetryContext = {},
): Promise<StandardToolResult | null> {
  const first = await invoke();
  // Converged retry signal: `retryable` (the connector-tool contract) is a
  // superset of the legacy web-tool `transient` alias. Honor either.
  if (!first || !(first.transient || first.retryable)) return first;

  const retryAfterMs = first.retryAfterMs ?? 1_000;
  const delay = Math.min(retryAfterMs, MAX_RETRY_DELAY_MS);
  logger.info({
    tool_name: ctx.toolName,
    retry_after_ms: retryAfterMs,
    delay_ms: delay,
    delay_capped: retryAfterMs > MAX_RETRY_DELAY_MS,
    phase: 'first_attempt_transient',
  }, 'web_fetch_transient_retry');
  await new Promise(r => setTimeout(r, delay));

  const second = await invoke();
  const succeeded = !!second?.success;
  logger.info({
    tool_name: ctx.toolName,
    phase: succeeded ? 'second_attempt_succeeded' : 'second_attempt_failed',
    second_transient: !!(second?.transient || second?.retryable),
  }, 'web_fetch_transient_retry');

  // Strip both retry flags on the second attempt — the runner has done its
  // retry, and we don't want the model trying to interpret a residual flag.
  return second ? { ...second, transient: false, retryable: false } : null;
}
