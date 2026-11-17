// WS-1.2 — defensive `setTraceContext` wrapper.
//
// Production: delegates to `setTraceContext` from `./logging` which writes
// into AsyncLocalStorage and is auto-injected by mergeTraceContext on every
// log emission.
//
// Tests: many test files predate the no-stubs-reliability work and mock
// `infrastructure/logging` with a `{ logger, log }` literal that lacks
// `setTraceContext`. Without this wrapper, those mocks throw
// `TypeError: (0, logging_1.setTraceContext) is not a function` for every
// call site that imports the named export.
//
// The dynamic re-import sidesteps the named-export binding, so tests get
// `undefined` instead of a hard throw, and the noop fallback keeps the
// production semantics identical when a mock IS provided correctly.

 
const loggingMod: { setTraceContext?: (ctx: Record<string, unknown>) => void } = require('./logging');

export function setTraceContext(ctx: Record<string, unknown>): void {
  if (typeof loggingMod.setTraceContext === 'function') {
    loggingMod.setTraceContext(ctx);
  }
}
