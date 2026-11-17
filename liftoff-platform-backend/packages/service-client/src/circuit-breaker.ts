// Generic circuit breaker for service-to-service calls.
//
// 3-state machine per target key:
//   closed     — calls go through; consecutive failures advance toward open
//   open       — calls fast-fail with the caller-supplied fallback; fn is NOT
//                invoked. After resetTimeoutMs elapses, the next call
//                transitions to half_open and is allowed through as a probe
//   half_open  — exactly halfOpenMaxAttempts probe(s) are allowed through.
//                Probe success → closed. Probe failure → open immediately.
//
// Callers pass a `key` (e.g. `${tenantId}:${method}`) so one tenant's flapping
// endpoint doesn't open the circuit for unrelated tenants or methods.
//
// Failures are SWALLOWED into the fallback — callers must design their
// wrapped functions to fail-soft. The breaker's only behavioral change is
// that calls during the cooldown window are instant instead of paying the
// full HTTP timeout.

export type CircuitStateName = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerConfig {
  /** Consecutive failures before opening the circuit. Default 5. */
  failureThreshold?: number;
  /** Milliseconds to stay open before allowing a half_open probe. Default 30000. */
  resetTimeoutMs?: number;
  /** Max concurrent probes allowed in half_open. Default 1. */
  halfOpenMaxAttempts?: number;
  /** Optional hook called on state transitions (for logging/metrics). */
  onStateChange?: (key: string, state: CircuitStateName, meta: Record<string, unknown>) => void;
}

interface CircuitState {
  state: CircuitStateName;
  consecutiveFailures: number;
  openedAt: number | null;
  halfOpenAttempts: number;
}

const DEFAULTS = {
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
  halfOpenMaxAttempts: 1,
} as const;

export class CircuitBreaker {
  private circuits = new Map<string, CircuitState>();
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly halfOpenMaxAttempts: number;
  private readonly onStateChange?: CircuitBreakerConfig['onStateChange'];

  constructor(config: CircuitBreakerConfig = {}) {
    this.failureThreshold = config.failureThreshold ?? DEFAULTS.failureThreshold;
    this.resetTimeoutMs = config.resetTimeoutMs ?? DEFAULTS.resetTimeoutMs;
    this.halfOpenMaxAttempts = config.halfOpenMaxAttempts ?? DEFAULTS.halfOpenMaxAttempts;
    this.onStateChange = config.onStateChange;
  }

  /**
   * Execute `fn` with circuit breaker protection. If the circuit is open,
   * `fn` is NOT called and `fallback` is returned immediately. On failure,
   * the failure is counted and `fallback` is returned (failure is swallowed).
   */
  async executeOrFallback<T>(key: string, fn: () => Promise<T>, fallback: T): Promise<T> {
    const circuit = this.getOrCreateCircuit(key);

    if (circuit.state === 'open') {
      const elapsed = Date.now() - (circuit.openedAt ?? 0);
      if (elapsed < this.resetTimeoutMs) {
        return fallback;
      }
      circuit.state = 'half_open';
      circuit.halfOpenAttempts = 0;
      this.onStateChange?.(key, 'half_open', {});
    }

    if (circuit.state === 'half_open') {
      if (circuit.halfOpenAttempts >= this.halfOpenMaxAttempts) {
        return fallback;
      }
      circuit.halfOpenAttempts++;
    }

    try {
      const result = await fn();
      if (circuit.state !== 'closed') {
        this.onStateChange?.(key, 'closed', { after: 'probe-success' });
      }
      circuit.state = 'closed';
      circuit.consecutiveFailures = 0;
      circuit.openedAt = null;
      circuit.halfOpenAttempts = 0;
      return result;
    } catch (err) {
      circuit.consecutiveFailures++;
      const errorMessage = (err as Error).message;

      // Failure during half_open re-opens immediately — a single failed
      // probe answers "is the endpoint healthy?" with no.
      const shouldOpen =
        circuit.state === 'half_open' ||
        circuit.consecutiveFailures >= this.failureThreshold;

      if (shouldOpen) {
        circuit.state = 'open';
        circuit.openedAt = Date.now();
        circuit.halfOpenAttempts = 0;
        this.onStateChange?.(key, 'open', {
          failures: circuit.consecutiveFailures,
          error: errorMessage,
        });
      } else {
        this.onStateChange?.(key, circuit.state, {
          failures: circuit.consecutiveFailures,
          error: errorMessage,
        });
      }

      return fallback;
    }
  }

  /** Test-only: clear all circuits. */
  reset(): void {
    this.circuits.clear();
  }

  /** Test-only: inspect a circuit's state. */
  peek(key: string): Readonly<CircuitState> | undefined {
    const c = this.circuits.get(key);
    return c ? { ...c } : undefined;
  }

  private getOrCreateCircuit(key: string): CircuitState {
    let circuit = this.circuits.get(key);
    if (!circuit) {
      circuit = {
        state: 'closed',
        consecutiveFailures: 0,
        openedAt: null,
        halfOpenAttempts: 0,
      };
      this.circuits.set(key, circuit);
    }
    return circuit;
  }
}
