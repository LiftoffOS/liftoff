// Jest-only stub for `@liftoffos/telemetry`. Wired via `moduleNameMapper` in
// jest.config.js so unit-test suites never import the real OpenTelemetry SDK.
//
// Why this exists: importing `@liftoffos/telemetry` pulls `@opentelemetry/sdk-node`
// and, transitively, a nested `@opentelemetry/core` whose TypeScript source reads
// `TELEMETRY_SDK_NAME` off an undefined semantic-conventions object — throwing
// `Cannot read properties of undefined (reading 'TELEMETRY_SDK_NAME')` at import
// time under ts-jest. It is a version mismatch that only bites the TS-source
// import path jest takes, never the built `dist` used in production. Without
// this stub, that import error blocks every unit suite whose module graph
// reaches `src/infra/logging.ts` from even loading.
//
// This mapping is JEST-RUNTIME ONLY. `tsc` (typecheck + the production build)
// still resolves the real package, so types and runtime behavior are unchanged
// outside tests. Unit tests should never emit real traces or spans anyway; a
// suite that needs to assert on logging mocks `src/infra/logging.ts` directly.
//
// Keep the export surface in sync with the real package's runtime exports used
// across `src/` (createLogger, initTracing, shutdownTracing, withTraceContext,
// withSpan). Adding a new telemetry import to non-test code means adding it here.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

type LogFn = (...args: unknown[]) => void;

export interface Logger {
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  debug: LogFn;
  child: (...args: unknown[]) => Logger;
}

function noopLogger(): Logger {
  const log: Logger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    child: () => log,
  };
  return log;
}

export function createLogger(_opts?: unknown): Logger {
  return noopLogger();
}

export function initTracing(_opts?: unknown): void {
  // no-op in tests
}

export function shutdownTracing(): Promise<void> {
  return Promise.resolve();
}

// Real signature: withTraceContext(context, fn) — run fn within a trace context.
export function withTraceContext<T>(_context: unknown, fn: () => T): T {
  return fn();
}

// Real signature: withSpan(service, name, attributes, fn) — run fn inside a span.
export function withSpan<T>(
  _service: string,
  _name: string,
  _attributes: unknown,
  fn: () => T,
): T {
  return fn();
}
