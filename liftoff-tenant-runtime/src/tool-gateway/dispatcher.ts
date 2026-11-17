// Tool Gateway Dispatcher
//
// Phase 4: the tenant-runtime monolith
// hosts a single `ToolGatewayService` instance and every tool call runs
// in-process. Once split into Cloud Run services, `agent-service` and
// `coordinator-service` need to call `tool-gateway-service` over HTTP.
//
// This module provides a common interface (`ToolGatewayDispatcher`) and a
// factory (`getToolGatewayDispatcher()`) that returns either:
//
//   - An in-process `ToolGatewayService` instance (monolith / tool-gateway
//     mode, OR any mode where `TOOL_GATEWAY_SERVICE_URL` is unset), OR
//   - A `ToolGatewayHttpClient` that forwards calls to the tool-gateway
//     Cloud Run service (agent / coordinator modes when the URL is set).
//
// Hot-path callers (agent-execution/service.ts, coordinator/service.ts,
// corrections/*) instantiate through this factory so split deployments
// dispatch over HTTP without changing the calling code.

import { resolveServiceType } from '../service-type';
import { ToolGatewayService } from './service';
import { ToolGatewayHttpClient } from './http-client';
import type { ExecuteInput, ExecuteResult, ConflictPolicy, SelfDispatchedRecord } from './types';

/** One write the vendor SDK is about to dispatch without this gateway. */
/** What the caller derived from the tool's own schema, sent with every
 *  request about a vendor-hosted tool. The gateway never enumerated that
 *  server and runs as several instances, so nothing it could keep in memory
 *  from an earlier request is guaranteed to be on the instance that answers
 *  this one; the declaration travels with the request instead. */
export interface DerivedDeclaration {
  /** The write's arguments that name a record, by the catalog mappers' rule. */
  idArgs: string[];
}

export interface GuardExternalInput {
  tenantId: string;
  agentId: string;
  invocationId: string | undefined;
  toolName: string;
  input: Record<string, unknown> | undefined;
  derived?: DerivedDeclaration;
}

/** One tool call that reached its vendor without passing through this gateway. */
export interface ObserveExternalInput {
  tenantId: string;
  agentId: string;
  invocationId: string | undefined;
  toolName: string;
  input: Record<string, unknown> | undefined;
  result: unknown;
  error?: string;
  derived?: DerivedDeclaration;
}

/**
 * Narrow interface shared by the in-process service and the HTTP client.
 * Only the methods hot-path callers need — other `ToolGatewayService`
 * methods (internal helpers) are not exposed.
 */
export interface ToolGatewayDispatcher {
  execute(input: ExecuteInput & { _internalSkipHitl?: boolean }): Promise<ExecuteResult>;
  executeBatch(inputs: ExecuteInput[]): Promise<ExecuteResult[]>;
  /** The pre-dispatch guard chain, for a caller that dispatches to the vendor
   *  ITSELF rather than through `execute` — the Composio route does. Returns
   *  the refusal to hand back, or null to proceed. */
  preDispatchGuards(input: ExecuteInput): Promise<ExecuteResult | null>;
  /** Judge a write the vendor SDK is about to dispatch, in the process that
   *  owns the provenance store. The hold to hand the model, or null. */
  guardExternal(args: GuardExternalInput): Promise<string | null>;
  /** Record what a call the vendor SDK dispatched returned, in the process that
   *  owns the provenance store. */
  /** Resolves to whether the store now holds the result. False is a record
   *  that did not land, which the caller must not mark as remembered. */
  observeExternal(args: ObserveExternalInput): Promise<boolean>;
  /** Write the action-ledger row for a call the CALLER dispatched. The Composio
   *  route does, and wrote no `actions` row at all — which is what
   *  `have_i_acted_on` reads. Answers with the host note the recorder attached
   *  (a found file that became a card), for the caller to put in front of the
   *  model. */
  recordSelfDispatched(input: ExecuteInput, result: ExecuteResult): Promise<SelfDispatchedRecord>;
  /** The stage/apply protocol's dispatch half (staged-batches.ts): the
   *  arguments a claimed apply sends (the model's minus the protocol's), and
   *  the settle that records the vendor's answer on the batch or hands the
   *  claim back. `preDispatchGuards` makes the claim. */
  stagedApplyPayload(input: ExecuteInput): Record<string, unknown> | undefined;
  settleStagedApply(input: ExecuteInput, outcome: { success: boolean; data?: unknown; error?: string }): Promise<void>;
  getConflictPolicy(
    connector: string,
    entityType: string,
    actionType: string,
  ): Promise<ConflictPolicy | null>;
}

/**
 * Resolve the tool-gateway dispatcher for the current process. Cached per
 * process — the client holds an HTTP/2 session + a circuit breaker that we
 * want to share across the whole service.
 */
let cached: ToolGatewayDispatcher | null = null;

export function getToolGatewayDispatcher(): ToolGatewayDispatcher {
  if (cached) return cached;
  cached = createToolGatewayDispatcher();
  return cached;
}

/**
 * Build the dispatcher without caching. Exposed for tests and the factory
 * above. Rules:
 *
 *   - `SERVICE_TYPE=monolith` or `SERVICE_TYPE=tool-gateway` → in-process.
 *     Monolith runs everything in one image; tool-gateway IS the service,
 *     so HTTP-ing back to itself would add a pointless hop.
 *   - Otherwise, if `TOOL_GATEWAY_SERVICE_URL` is set, use the HTTP client.
 *   - Otherwise, fall back to in-process. This keeps local dev and jest
 *     tests working without needing the peer URL env var.
 */
export function createToolGatewayDispatcher(): ToolGatewayDispatcher {
  const svcType = resolveServiceType(process.env.SERVICE_TYPE) ?? 'monolith';
  const peerUrl = process.env.TOOL_GATEWAY_SERVICE_URL?.trim();

  if (svcType === 'monolith' || svcType === 'tool-gateway') {
    return new ToolGatewayService();
  }

  if (peerUrl && peerUrl.length > 0) {
    return new ToolGatewayHttpClient({ baseUrl: peerUrl });
  }

  return new ToolGatewayService();
}

/**
 * Reset the cached dispatcher. Tests only.
 */
export function resetToolGatewayDispatcherForTests(): void {
  cached = null;
}

/**
 * Inject a dispatcher (usually a mock). Tests only.
 */
export function setToolGatewayDispatcherForTests(dispatcher: ToolGatewayDispatcher): void {
  cached = dispatcher;
}
