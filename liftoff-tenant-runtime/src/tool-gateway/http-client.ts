// Tool Gateway HTTP Client
//
// Phase 4: when `SERVICE_TYPE=agent` or
// `SERVICE_TYPE=coordinator`, the tool-gateway's `execute` / `executeBatch`
// calls cross a network boundary to the `tool-gateway-service` Cloud Run
// instance. This client mirrors the `ToolGatewayService` public surface so
// the `dispatcher.ts` factory can swap between in-process and HTTP without
// the callers noticing.
//
// Transport choices (aligned with `ConnectorServiceClient` in Phase 2):
//   - `@liftoffos/service-client` ServiceClient — HTTP/2 + keep-alive
//     (undici under the hood), OIDC + X-Service-Auth headers, circuit
//     breaker, safe logging.
//   - Plain JSON body (not proto-encoded). Tool-gateway doesn't have a proto
//     contract yet; the REST endpoints under /api/v1/tool-calls and
//     /api/v1/conflict-policies are the serialisation format.
//
// Auth pattern: the ServiceClient's request pipeline attaches BOTH an OIDC
// id_token and the X-Service-Auth shared bearer, so the receiving side
// (service-auth.ts `requireServiceAuth({ acceptOidc: true })`) can accept
// either.
//
// Note: a thrown error from the HTTP layer propagates up to the caller. In
// monolith mode the in-process service throws directly too, so callers'
// try/catch semantics are unchanged.
//
// Every call has a deadline, body read included (withDeadline). A pooled
// connection that went dead in a network reset is still handed out, and a
// request on it waits for its caller's own timer: with none, a tool call hung
// the run forever. A timeout throws DeadlineExceededError, which callers see
// exactly as they see any other transport failure.

import { getToolSchema, catalogTypeFor } from '../connectors/tool-schema-cache';
import { stripProtocolArgs } from './staged-batches';
import { ServiceClient } from '@liftoffos/service-client';
import { Agent } from 'undici';
import { withManagedServiceAuth } from '../infrastructure/service-client-auth';
import { readBoundedErrorText } from '../infrastructure/bounded-error-body';
import { logger } from '../infrastructure/logging';
import { withDeadline } from '../infrastructure/deadline';
import { longestDispatchTimeoutMs } from '../agent-execution/adapter/dispatch-timeout';
import type { ToolGatewayDispatcher } from './dispatcher';
import type { ExecuteInput, ExecuteResult, ConflictPolicy, SelfDispatchedRecord } from './types';
import type { GuardExternalInput, ObserveExternalInput } from './dispatcher';

export interface ToolGatewayHttpClientOptions {
  /** Base URL of the tool-gateway-service Cloud Run instance. */
  baseUrl: string;
  /** Optional: override which managed secret supplies the shared bearer.
   *  Default `TENANT_RUNTIME_SERVICE_TOKEN`. */
  serviceAuthSecret?: 'TENANT_RUNTIME_SERVICE_TOKEN';
  /** Test seam: one deadline for every call in place of the per-call ones. */
  deadlineMsOverride?: number;
  /** Test seam: the undici dispatcher (null = the process's global one).
   *  Default: toolGatewayDispatcher(). */
  dispatcher?: unknown | null;
}

/**
 * The connection pool for agent -> tool-gateway calls.
 *
 * @liftoffos/service-client 0.2 passes every request its own HTTP/1.1
 * keep-alive Agent, and that Agent's headers/body timeouts are 300s. A tool
 * call's answer arrives only when the tool finishes, and code_session runs
 * 600s by default: on the shared Agent undici would end it at 300s whatever
 * deadline the call carried. So this client gets its own pool, identical but
 * with those two timeouts off. Every request through it carries its own
 * deadline (the per-call `timeoutMs` and withDeadline in `call()`), which is
 * the bound; the pool adds keep-alive, and retires idle sockets at 30s so a
 * connection left dead by a network reset is not handed out again.
 */
export const TOOL_GATEWAY_POOL_OPTIONS = {
  allowH2: false,
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 10 * 60_000,
  connections: 32,
  connect: { timeout: 10_000 },
  headersTimeout: 0,
  bodyTimeout: 0,
} as const;

let toolGatewayPool: Agent | undefined;
export function toolGatewayDispatcher(): Agent {
  toolGatewayPool ??= new Agent(TOOL_GATEWAY_POOL_OPTIONS);
  return toolGatewayPool;
}

/** Time for the gateway's own work on either side of a tool: gates, ledger,
 *  framing, the hop itself. */
const GATEWAY_MARGIN_MS = 30_000;

/** The gateway's bookkeeping routes (guard, observe, settle, record, policy
 *  lookup) are store reads and writes, never a tool run. */
const BOOKKEEPING_DEADLINE_MS = 30_000;

/** A budget the call's own arguments declare, in ms: `timeout_seconds`
 *  (code_session), `timeout_ms` / `timeoutMs` / `timeout` (sandbox waits and
 *  execs, which take milliseconds). Undefined when none is declared. */
function declaredBudgetMs(payload: unknown): number | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const p = payload as Record<string, unknown>;
  const candidates = [
    Number(p.timeout_seconds) * 1000,
    Number(p.timeout_ms),
    Number(p.timeoutMs),
    Number(p.timeout),
  ].filter((n) => Number.isFinite(n) && n > 0);
  return candidates.length > 0 ? Math.max(...candidates) : undefined;
}

/**
 * How long the agent waits for the gateway to answer ONE tool call.
 *
 * This endpoint fronts tools whose legitimate run time is long and set per call
 * — code_session (600s by default, more when declared), sandbox waits and
 * execs with a model-supplied `timeout_ms`, an external agent's A2A poll (300s)
 * — so the floor is the longest budget any caller of a tool will wait for
 * (longestDispatchTimeoutMs), and a call declaring a longer one gets that. A
 * tighter per-tool cut is the MCP bridge's (dispatchTimeoutMs), which fires
 * first on every bridged engine; this is the backstop that makes the call end
 * at all when the connection under it is dead.
 */
export function executeDeadlineMs(payload: unknown): number {
  const declared = declaredBudgetMs(payload) ?? 0;
  return Math.max(declared, longestDispatchTimeoutMs()) + GATEWAY_MARGIN_MS;
}

export class ToolGatewayHttpClient implements ToolGatewayDispatcher {
  private readonly client: ServiceClient;
  private readonly baseUrl: string;
  private readonly deadlineMsOverride: number | undefined;

  constructor(opts: ToolGatewayHttpClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.deadlineMsOverride = opts.deadlineMsOverride;
    // ServiceClient needs a resolver keyed on tenant; we're pointing at a
    // single upstream (tool-gateway-service) so the key is irrelevant — we
    // always return the same URL. The cache makes this a no-op.
    this.client = new ServiceClient(withManagedServiceAuth(
      opts.serviceAuthSecret ?? 'TENANT_RUNTIME_SERVICE_TOKEN',
      {
        resolveTargetUrl: async () => this.baseUrl,
        dispatcher: opts.dispatcher === undefined ? toolGatewayDispatcher() : opts.dispatcher,
        onLog: (level, ctx, msg) => {
          if (level === 'error') logger.error({ ...ctx }, msg);
          else if (level === 'warn') logger.warn({ ...ctx }, msg);
          else if (level === 'info') logger.info({ ...ctx }, msg);
          else logger.debug({ ...ctx }, msg);
        },
      },
    ));
  }

  async execute(input: ExecuteInput & { _internalSkipHitl?: boolean }): Promise<ExecuteResult> {
    // `_internalSkipHitl` is stripped at the server (SE-002). Wire-compat
    // with in-process callers is maintained by passing it through here.
    return (await this.call('execute', '/api/v1/tool-calls', {
      method: 'POST',
      body: JSON.stringify(input),
      breakerKey: 'tool-gateway:execute',
    }, executeDeadlineMs(input.payload), (resp) => this.readJson(resp, 'execute'))) as ExecuteResult;
  }

  async executeBatch(inputs: ExecuteInput[]): Promise<ExecuteResult[]> {
    const deadlineMs = Math.max(executeDeadlineMs(undefined), ...inputs.map((i) => executeDeadlineMs(i.payload)));
    const body = (await this.call('executeBatch', '/api/v1/tool-calls/batch', {
      method: 'POST',
      body: JSON.stringify({ items: inputs }),
      breakerKey: 'tool-gateway:executeBatch',
    }, deadlineMs, (resp) => this.readJson(resp, 'executeBatch'))) as { items: ExecuteResult[] };
    return body.items;
  }

  async preDispatchGuards(input: ExecuteInput): Promise<ExecuteResult | null> {
    // The guard chain runs where the provenance store is, which is the gateway
    // service. Evaluating it in the caller would judge a write against a store
    // that never saw the run's reads.
    //
    // FAIL-OPEN on transport failure, deliberately and narrowly: a gateway that
    // cannot be reached must not turn every Composio call into a refusal. The
    // call then dispatches ungated, which is exactly the status quo this change
    // replaces — strictly no worse, and loud, because the client logs the
    // failure and the breaker opens.
    const body = (await this.call('preDispatchGuards', '/api/v1/tool-calls/guard', {
      method: 'POST',
      body: JSON.stringify(input),
      breakerKey: 'tool-gateway:preDispatchGuards',
    }, BOOKKEEPING_DEADLINE_MS, (resp) => this.readJson(resp, 'preDispatchGuards'))) as { refusal: ExecuteResult | null };
    return body.refusal ?? null;
  }

  async guardExternal(args: GuardExternalInput): Promise<string | null> {
    // FAIL-OPEN on transport failure, narrowly: a gateway that cannot be reached
    // must not turn every vendor-hosted write into a refusal. The call then
    // dispatches unjudged — the status quo this replaces, and loud, because the
    // client logs it and the breaker opens.
    try {
      const body = (await this.call('guardExternal', '/api/v1/tool-calls/guard-external', {
        method: 'POST',
        body: JSON.stringify(args),
        breakerKey: 'tool-gateway:guardExternal',
      }, BOOKKEEPING_DEADLINE_MS, (resp) => this.readJson(resp, 'guardExternal'))) as { hold: string | null };
      return body.hold ?? null;
    } catch {
      return null;
    }
  }

  async observeExternal(args: ObserveExternalInput): Promise<boolean> {
    // A transport failure throws, and the caller treats a throw as "not
    // recorded". A 2xx says only that the gateway ANSWERED; whether the store
    // took the record is in the body.
    // `fetch` returns the Response, not its body. Read as a Response, every
    // record reported "not recorded", was retried three times and dropped,
    // while the stream fallback quietly re-recorded it — a store that worked
    // and a client that could not hear it say so.
    const body = (await this.call('observeExternal', '/api/v1/tool-calls/observe-external', {
      method: 'POST',
      body: JSON.stringify(args),
      breakerKey: 'tool-gateway:observeExternal',
    }, BOOKKEEPING_DEADLINE_MS, (res) => this.readJson(res, 'observeExternal'))) as { recorded?: unknown };
    return body.recorded === true;
  }

  stagedApplyPayload(input: ExecuteInput): Record<string, unknown> | undefined {
    // Pure over the schema cache this process holds too; no round trip.
    const schema = getToolSchema(catalogTypeFor(input.connector), input.actionType);
    if (schema?.writeRole !== 'apply') return undefined;
    return stripProtocolArgs(input.payload as Record<string, unknown> | undefined).args;
  }

  async settleStagedApply(input: ExecuteInput, outcome: { success: boolean; data?: unknown; error?: string }): Promise<void> {
    // The batch store lives with the gateway. A transport failure here loses
    // the settle and never the action; the batch stays claimed with no result,
    // which a later apply reads as "claimed, unsettled" and refuses rather than
    // sends twice — the safe side.
    const schema = getToolSchema(catalogTypeFor(input.connector), input.actionType);
    if (schema?.writeRole !== 'apply') return;
    await this.call('settleStagedApply', '/api/v1/tool-calls/staged-apply-settle', {
      method: 'POST',
      body: JSON.stringify({ input, outcome }),
      breakerKey: 'tool-gateway:settleStagedApply',
    }, BOOKKEEPING_DEADLINE_MS, (resp) => this.ensureOk(resp, 'settleStagedApply'));
  }

  async recordSelfDispatched(input: ExecuteInput, result: ExecuteResult): Promise<SelfDispatchedRecord> {
    // The ledger lives with the gateway, like the provenance store. Written
    // AFTER the caller dispatched, so a transport failure loses the row and
    // never the action — which is the right way round: the ledger is a record
    // OF the action, not a gate on it. It still has to be a failure the caller
    // can see: `ServiceClient.fetch` returns a non-2xx Response rather than
    // throwing, and a breaker-generated 503 is one of those.
    const body = await this.call('recordSelfDispatched', '/api/v1/tool-calls/self-dispatched', {
      method: 'POST',
      body: JSON.stringify({ input, result }),
      breakerKey: 'tool-gateway:recordSelfDispatched',
    }, BOOKKEEPING_DEADLINE_MS, async (resp) => {
      await this.ensureOk(resp, 'recordSelfDispatched');
      // The route answers with the host note when the recorder attached one.
      // An older gateway answers 204 with no body; that reads as no note, and
      // only a non-2xx above is a failure.
      return resp.status === 204 ? null : await resp.json().catch(() => null);
    });
    const record = (body ?? {}) as SelfDispatchedRecord;
    return record.hostNote ? { hostNote: record.hostNote } : {};
  }

  async getConflictPolicy(
    connector: string,
    entityType: string,
    actionType: string,
  ): Promise<ConflictPolicy | null> {
    const path = `/api/v1/conflict-policies/${encodeURIComponent(connector)}/${encodeURIComponent(entityType)}/${encodeURIComponent(actionType)}`;
    const body = await this.call('getConflictPolicy', path, {
      method: 'GET',
      breakerKey: 'tool-gateway:getConflictPolicy',
    }, BOOKKEEPING_DEADLINE_MS, async (resp) => (resp.status === 404 ? null : this.readJson(resp, 'getConflictPolicy')));
    // The router returns the policy object or `null` in the body directly.
    return (body as ConflictPolicy | null) ?? null;
  }

  /**
   * One request and its body read, under one deadline. The signal reaches the
   * socket (the request is aborted, not abandoned); the race bounds everything
   * else, auth header minting included.
   *
   * The same budget goes to the client as `timeoutMs`, replacing its 300s
   * default, which would otherwise cut a tool call the deadline allows (a
   * code_session). The client starts its timer after ours (it first resolves
   * the URL and mints headers), so ours fires first and callers see the typed
   * DeadlineExceededError; the client's is the backstop.
   */
  private call<T>(
    op: string,
    path: string,
    init: Parameters<ServiceClient['fetch']>[2],
    deadlineMs: number,
    read: (_resp: Response) => Promise<T>,
  ): Promise<T> {
    const budgetMs = this.deadlineMsOverride ?? deadlineMs;
    return withDeadline(`tool-gateway ${op}`, budgetMs, async (signal) => {
      const resp = await this.client.fetch('tool-gateway', path, { ...init, signal, timeoutMs: budgetMs });
      return read(resp);
    });
  }

  private async readJson(resp: Response, op: string): Promise<unknown> {
    await this.ensureOk(resp, op);
    return resp.json();
  }

  /** Throw on a non-2xx answer, for a route that answers with no body. */
  private async ensureOk(resp: Response, op: string): Promise<void> {
    if (resp.ok) return;
    // Read the body once for the error message, then discard. Tool-gateway
    // typically returns `{ error: string }` on non-2xx.
    let detail = '';
    try {
      const text = await readBoundedErrorText(resp);
      detail = text.length > 512 ? `${text.slice(0, 512)}…` : text;
    } catch {
      detail = '<unreadable body>';
    }
    throw new Error(`tool-gateway ${op} failed: HTTP ${resp.status} ${detail}`);
  }
}
