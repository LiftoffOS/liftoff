// Async context propagation — trace IDs flow through the call chain
// without every function having to take a context argument.
//
// Enter a context:
//   withTraceContext({ tenantId, agentId }, async () => { ... })
//
// Read the current context (anywhere inside the block):
//   const ctx = getTraceContext();
//
// Values nest — inner withTraceContext calls MERGE with the outer context,
// so middleware can set tenantId at the top and a tool handler can add
// workflowId later without losing tenantId.

import { AsyncLocalStorage } from 'async_hooks';
import type { TraceContext } from './tracing.js';

const storage = new AsyncLocalStorage<TraceContext>();

export function withTraceContext<T>(ctx: TraceContext, fn: () => T): T {
  const current = storage.getStore() ?? {};
  return storage.run({ ...current, ...ctx }, fn);
}

export function getTraceContext(): TraceContext | undefined {
  return storage.getStore();
}

/**
 * Mutate the current context in place. Only works inside an active
 * withTraceContext block — no-op otherwise. Use this sparingly; prefer
 * nested withTraceContext calls.
 */
export function setTraceContext(partial: Partial<TraceContext>): void {
  const current = storage.getStore();
  if (current) Object.assign(current, partial);
}
