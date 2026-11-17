// Phase 0r — graceful shutdown for Cloud Run services.
//
// On SIGTERM:
//   1. Flip readiness to false so `/ready` returns 503 and Cloud Run
//      stops routing new requests to this container. `/health` stays
//      green (container is still alive).
//   2. Wait for in-flight requests to drain, up to `gracePeriodMs`
//      (default 30 s). Cloud Run's `terminationGracePeriodSeconds`
//      should be configured to this + 5 s buffer (35 s).
//   3. Call each drain function in order (outbox publisher flush, etc).
//   4. `process.exit(0)`.
//
// Design choices:
//   - `/ready` reads a mutable readiness flag, not a snapshot. This is
//     the canonical kubernetes-style pattern.
//   - Drain functions are sequential, not parallel: most callers want
//     "flush pub/sub THEN close DB pool" ordering.
//   - `forceExitFn` is injectable so tests can assert shutdown without
//     actually killing the process.

export interface ReadinessState {
  isReady: () => boolean;
}

export interface SigtermHandlerOptions {
  /** Soft deadline for in-flight + drain work. Default 30_000. */
  gracePeriodMs?: number;
  /** Invoked while `/ready` is already false. Run in order. */
  drainFns?: Array<() => Promise<void>>;
  /** Predicate returning true when all in-flight requests have completed. Polled every 100 ms. */
  inflightCountFn?: () => number;
  /** Test seam — defaults to process.exit. */
  forceExitFn?: (code: number) => void;
  /** Test seam — defaults to real signal listener. */
  attachSignal?: (handler: () => void) => void;
  /** Test seam — defaults to real clock. */
  now?: () => number;
  logger?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

export interface SigtermHandlerControls extends ReadinessState {
  /** Manually trigger shutdown (useful for tests and for non-signal exits). */
  shutdown: () => Promise<void>;
}

export function installSigtermHandler(options: SigtermHandlerOptions = {}): SigtermHandlerControls {
  const gracePeriodMs = options.gracePeriodMs ?? 30_000;
  const drainFns = options.drainFns ?? [];
  const inflightCountFn = options.inflightCountFn ?? (() => 0);
  const forceExit = options.forceExitFn ?? ((code) => process.exit(code));
  const now = options.now ?? (() => Date.now());
  const logger = options.logger;

  let ready = true;
  let shutdownStarted = false;

  async function shutdown(): Promise<void> {
    if (shutdownStarted) return;
    shutdownStarted = true;
    ready = false;
    logger?.info('service-runtime.shutdown.started');

    const start = now();
    // Wait for in-flight requests, up to the grace period.
    while (inflightCountFn() > 0 && now() - start < gracePeriodMs) {
      await sleep(100);
    }
    const remaining = inflightCountFn();
    if (remaining > 0) {
      logger?.warn('service-runtime.shutdown.inflight_timeout', { remaining });
    }

    // Run drain functions sequentially, each bounded by whatever time
    // is left in the grace period.
    for (const fn of drainFns) {
      const elapsed = now() - start;
      if (elapsed >= gracePeriodMs) {
        logger?.warn('service-runtime.shutdown.drain_skipped_grace_expired');
        break;
      }
      try {
        await fn();
      } catch (err) {
        logger?.error('service-runtime.shutdown.drain_failed', { err: String(err) });
      }
    }

    logger?.info('service-runtime.shutdown.complete', { durationMs: now() - start });
    forceExit(0);
  }

  const attach = options.attachSignal ?? ((handler) => {
    process.on('SIGTERM', handler);
    process.on('SIGINT', handler);
  });
  attach(() => {
    void shutdown();
  });

  return {
    isReady: () => ready,
    shutdown,
  };
}

/**
 * Create `/health` + `/ready` route handlers that speak to the
 * readiness flag installed above. Usage with Fastify:
 *
 *   const controls = installSigtermHandler({ drainFns: [...] });
 *   const routes = createReadinessRoutes(controls);
 *   app.get('/health', routes.health);
 *   app.get('/ready', routes.ready);
 */
export function createReadinessRoutes(state: ReadinessState): {
  health: (req: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => unknown;
  ready: (req: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => unknown;
} {
  return {
    health: (_req, reply) => reply.code(200).send({ status: 'ok' }),
    ready: (_req, reply) => {
      if (state.isReady()) return reply.code(200).send({ status: 'ready' });
      return reply.code(503).send({ status: 'draining' });
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
