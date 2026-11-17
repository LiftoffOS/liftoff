// Tenant Runtime Circuit Breaker
//
// Thin wrapper over @liftoffos/service-client's generic CircuitBreaker that
// encodes the `${tenantId}:${method}` key scheme and wires state transitions
// to the platform logger.

import { CircuitBreaker, type CircuitBreakerConfig, type CircuitStateName } from '@liftoffos/service-client';
import { log } from '../infrastructure/logging';

export type { CircuitBreakerConfig };

export interface BreakerIdentity {
  tenantId: string;
  method: string;
}

interface CircuitStateSnapshot {
  state: CircuitStateName;
  consecutiveFailures: number;
  openedAt: number | null;
  halfOpenAttempts: number;
}

function buildKey(identity: BreakerIdentity): string {
  return `${identity.tenantId}:${identity.method}`;
}

export class TenantRuntimeCircuitBreaker {
  private readonly inner: CircuitBreaker;

  constructor(config: CircuitBreakerConfig = {}) {
    this.inner = new CircuitBreaker({
      ...config,
      onStateChange: (key, state, meta) => {
        const [tenantId, method] = key.split(':');
        const ctx = { tenantId, method, ...meta };
        if (state === 'open') {
          log.warn(ctx, 'Tenant Runtime circuit breaker opened');
        } else if (state === 'half_open') {
          log.info(ctx, 'Tenant Runtime circuit breaker transitioned to half_open');
        } else if (state === 'closed' && meta.after === 'probe-success') {
          log.info(ctx, 'Tenant Runtime circuit breaker closed after probe success');
        } else if (meta.failures !== undefined) {
          log.warn(ctx, 'Tenant Runtime call failed');
        }
      },
    });
  }

  executeOrFallback<T>(
    identity: BreakerIdentity,
    fn: () => Promise<T>,
    fallback: T,
  ): Promise<T> {
    return this.inner.executeOrFallback(buildKey(identity), fn, fallback);
  }

  reset(): void {
    this.inner.reset();
  }

  peek(identity: BreakerIdentity): Readonly<CircuitStateSnapshot> | undefined {
    return this.inner.peek(buildKey(identity));
  }
}

// Singleton — one breaker shared across all tenant runtime calls.
export const tenantRuntimeBreaker = new TenantRuntimeCircuitBreaker();
