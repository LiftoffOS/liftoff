// Phase 0q — unified retry + circuit-breaker + timeout + retry-budget
// policy. Wraps an outbound call with:
//
//   1. Timeout (default 3 s, hard cap 30 s).
//   2. Retry budget (10% of traffic per caller×callee, token bucket).
//   3. Exponential-backoff retry for idempotent calls only
//      (100ms → 2s, jittered, max 3 attempts). Non-idempotent calls
//      fail on first error.
//   4. Per-callee half-open circuit breaker with a rolling 10 s window
//      (trip on 50% error rate, min 20 calls).
//
// Emits metrics: retry.count, circuit.open_count, budget.exhausted_count.

export interface CallPolicyOptions {
  /** Stable callee identifier (e.g. `billing`, `workforce`). */
  calleeId: string;
  /** Default 3000. Hard cap 30_000. */
  defaultTimeoutMs?: number;
  /** Rolling window for circuit-breaker stats. Default 10_000. */
  windowMs?: number;
  /** Minimum call count inside the window before the breaker may trip. Default 20. */
  minCallsInWindow?: number;
  /** Error-rate threshold for tripping. Default 0.5. */
  errorRateThreshold?: number;
  /** How long the circuit stays open. Default 30_000. */
  openDurationMs?: number;
  /** Retry budget — max retries as a fraction of total traffic. Default 0.1. */
  retryBudgetFraction?: number;
  /** Optional metric hook — invoked for every metric event. */
  onMetric?: (metric: CallPolicyMetricEvent) => void;
  /** Override clock for tests. */
  now?: () => number;
}

export interface CallPolicyMetricEvent {
  kind: 'retry' | 'circuit_open' | 'circuit_close' | 'budget_exhausted' | 'timeout';
  calleeId: string;
  meta?: Record<string, unknown>;
}

export interface CallPolicyMetrics {
  retries: number;
  circuitOpenCount: number;
  budgetExhaustedCount: number;
  timeouts: number;
}

export interface CallInvocation<T> {
  /** Whether this is a read-ish / idempotency-keyed call — retries allowed. */
  idempotent: boolean;
  /** Per-call timeout override. Clamped to [1, 30000]. */
  timeoutMs?: number;
  /** The actual call — e.g. a fetch / ServiceClient invocation. */
  invoke: () => Promise<T>;
}

type CircuitState = 'closed' | 'open' | 'half_open';

const MAX_TIMEOUT_MS = 30_000;

export class CallPolicy {
  private readonly opts: Required<
    Omit<CallPolicyOptions, 'onMetric' | 'now' | 'calleeId'>
  > & { calleeId: string; onMetric?: (m: CallPolicyMetricEvent) => void; now: () => number };

  private circuitState: CircuitState = 'closed';
  private openedAt = 0;
  private probeInFlight = false;
  private window: Array<{ ts: number; ok: boolean }> = [];
  private totalCalls = 0;
  private totalRetries = 0;
  private metrics: CallPolicyMetrics = {
    retries: 0,
    circuitOpenCount: 0,
    budgetExhaustedCount: 0,
    timeouts: 0,
  };

  constructor(options: CallPolicyOptions) {
    this.opts = {
      calleeId: options.calleeId,
      defaultTimeoutMs: clamp(options.defaultTimeoutMs ?? 3_000, 1, MAX_TIMEOUT_MS),
      windowMs: options.windowMs ?? 10_000,
      minCallsInWindow: options.minCallsInWindow ?? 20,
      errorRateThreshold: options.errorRateThreshold ?? 0.5,
      openDurationMs: options.openDurationMs ?? 30_000,
      retryBudgetFraction: options.retryBudgetFraction ?? 0.1,
      onMetric: options.onMetric,
      now: options.now ?? (() => Date.now()),
    };
  }

  getMetrics(): CallPolicyMetrics {
    return { ...this.metrics };
  }

  async execute<T>(call: CallInvocation<T>): Promise<T> {
    this.maybeReopen();

    if (this.circuitState === 'open') {
      throw new CallPolicyError('CIRCUIT_OPEN', `circuit open for ${this.opts.calleeId}`);
    }
    if (this.circuitState === 'half_open' && this.probeInFlight) {
      throw new CallPolicyError('CIRCUIT_OPEN', `probe in flight for ${this.opts.calleeId}`);
    }

    const maxAttempts = call.idempotent ? 3 : 1;
    const timeoutMs = clamp(call.timeoutMs ?? this.opts.defaultTimeoutMs, 1, MAX_TIMEOUT_MS);

    let attempt = 0;
    let lastError: unknown;
    while (attempt < maxAttempts) {
      const isRetry = attempt > 0;
      if (isRetry) {
        if (!this.tryReserveRetry()) {
          this.metrics.budgetExhaustedCount++;
          this.emit({ kind: 'budget_exhausted', calleeId: this.opts.calleeId });
          throw new CallPolicyError(
            'RETRY_BUDGET_EXHAUSTED',
            `retry budget exhausted for ${this.opts.calleeId}`,
          );
        }
        this.metrics.retries++;
        this.emit({ kind: 'retry', calleeId: this.opts.calleeId, meta: { attempt } });
        const delay = backoffDelayMs(attempt);
        await sleep(delay);
      }
      if (this.circuitState === 'half_open') this.probeInFlight = true;

      try {
        const result = await this.withTimeout(call.invoke(), timeoutMs);
        this.recordOutcome(true);
        if (this.circuitState === 'half_open') {
          this.transition('closed');
          this.probeInFlight = false;
        }
        return result;
      } catch (err) {
        lastError = err;
        if (this.circuitState === 'half_open') {
          this.recordOutcome(false);
          this.transition('open');
          this.probeInFlight = false;
          throw err;
        }
        this.recordOutcome(false);
        this.maybeTrip();
        attempt++;
      }
    }
    throw lastError ?? new Error('unknown');
  }

  // ── internals ────────────────────────────────────────────────────────

  private withTimeout<T>(p: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.metrics.timeouts++;
        this.emit({ kind: 'timeout', calleeId: this.opts.calleeId, meta: { timeoutMs } });
        reject(new CallPolicyError('TIMEOUT', `timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      p.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }

  private recordOutcome(ok: boolean): void {
    const now = this.opts.now();
    this.window.push({ ts: now, ok });
    this.totalCalls++;
    this.pruneWindow(now);
  }

  private tryReserveRetry(): boolean {
    // Token bucket: at most `retryBudgetFraction` * totalCalls retries.
    const budget = Math.floor(this.opts.retryBudgetFraction * this.totalCalls);
    if (this.totalRetries + 1 > budget) return false;
    this.totalRetries++;
    return true;
  }

  private pruneWindow(now: number): void {
    const cutoff = now - this.opts.windowMs;
    while (this.window.length > 0 && this.window[0].ts < cutoff) this.window.shift();
  }

  private maybeTrip(): void {
    if (this.circuitState !== 'closed') return;
    if (this.window.length < this.opts.minCallsInWindow) return;
    const errors = this.window.filter((w) => !w.ok).length;
    const rate = errors / this.window.length;
    if (rate >= this.opts.errorRateThreshold) {
      this.transition('open');
    }
  }

  private maybeReopen(): void {
    if (this.circuitState !== 'open') return;
    const now = this.opts.now();
    if (now - this.openedAt >= this.opts.openDurationMs) {
      this.transition('half_open');
    }
  }

  private transition(to: CircuitState): void {
    if (this.circuitState === to) return;
    this.circuitState = to;
    if (to === 'open') {
      this.openedAt = this.opts.now();
      this.metrics.circuitOpenCount++;
      this.emit({ kind: 'circuit_open', calleeId: this.opts.calleeId });
    } else if (to === 'closed') {
      this.emit({ kind: 'circuit_close', calleeId: this.opts.calleeId });
    }
  }

  private emit(m: CallPolicyMetricEvent): void {
    this.opts.onMetric?.(m);
  }
}

export class CallPolicyError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'CallPolicyError';
  }
}

function backoffDelayMs(attempt: number): number {
  // attempt 1 = 100ms, 2 = 400ms, 3 = 1600ms — capped at 2000 ms.
  const base = Math.min(2_000, 100 * Math.pow(4, attempt - 1));
  const jitter = Math.random() * base * 0.25;
  return Math.floor(base + jitter);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
