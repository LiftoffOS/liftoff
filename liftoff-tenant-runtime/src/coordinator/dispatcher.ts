// Coordinator Dispatcher
//
// Phase 4: agent-service calls coordinator
// for workflow lifecycle (commit-transition, complete/fail). The dispatcher
// factory picks in-process (monolith / coordinator mode / no peer URL) vs
// HTTP (agent mode with COORDINATOR_SERVICE_URL set) so call sites don't
// change when the image boots in a different SERVICE_TYPE.
//
// Only the methods agent-execution actually invokes are on the dispatcher
// interface — this keeps the HTTP contract narrow. Coordinator's richer
// operations (sub-workflows, compensation, reconciliation) stay local to
// coordinator-service and are called from its own routers.

import { resolveServiceType } from '../service-type';
import { CoordinatorService } from './service';
import { CoordinatorHttpClient } from './http-client';
import type { ToolCall } from './types';

export interface CoordinatorDispatcher {
  commitTransition(input: {
    workflowId: string;
    taskId: string;
    idempotencyKey: string;
    newState: unknown;
    pendingToolCalls: ToolCall[];
  }): Promise<unknown>;

  completeWorkflow(workflowId: string, outcome: unknown): Promise<unknown>;

  failWorkflow(workflowId: string, error: string): Promise<unknown>;

  getWorkflow(workflowId: string): Promise<unknown | null>;
}

let cached: CoordinatorDispatcher | null = null;

export function getCoordinatorDispatcher(): CoordinatorDispatcher {
  if (cached) return cached;
  cached = createCoordinatorDispatcher();
  return cached;
}

/**
 * Build the dispatcher. Rules:
 *   - `SERVICE_TYPE=monolith` / `coordinator` → in-process CoordinatorService.
 *     The monolith hosts everything; coordinator IS the service so HTTP to
 *     itself would be pointless.
 *   - Otherwise, if `COORDINATOR_SERVICE_URL` is set, HTTP via client.
 *   - Otherwise, fall back to in-process — keeps local dev and jest working
 *     without the peer URL env var.
 */
export function createCoordinatorDispatcher(): CoordinatorDispatcher {
  const svcType = resolveServiceType(process.env.SERVICE_TYPE) ?? 'monolith';
  const peerUrl = process.env.COORDINATOR_SERVICE_URL?.trim();

  if (svcType === 'monolith' || svcType === 'coordinator') {
    return new CoordinatorService();
  }

  if (peerUrl && peerUrl.length > 0) {
    return new CoordinatorHttpClient({ baseUrl: peerUrl });
  }

  return new CoordinatorService();
}

export function resetCoordinatorDispatcherForTests(): void {
  cached = null;
}

export function setCoordinatorDispatcherForTests(dispatcher: CoordinatorDispatcher): void {
  cached = dispatcher;
}
