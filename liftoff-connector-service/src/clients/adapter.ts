// Bridges the CRUD-style `CompensationClient` interface (one method per
// read/create/update/delete) to the new `ConnectorExecutor` contract (one
// function per tool call, named like `send_email` / `post_message`).
//
// How it works:
//  1. The executor receives (connectorType, functionName, input).
//  2. It looks up the function in `connector-functions-registry` to find
//     the API-native `entityType` + categories.
//  3. It decides whether this is a read / delete / update / create call using
//     categories first, falling back to prefix-matching on the function name
//     (matches what tenant-runtime's ToolGatewayService.executeViaClient does).
//  4. It calls the right CRUD method on the client and packs the result
//     into the ExecutorResult shape.

import type { JsonObject } from '@bufbuild/protobuf';
import type { ExecutorContext, ExecutorResult } from '../rpc/execute-dispatcher.js';
import {
  getConnectorFunctions,
  resolveEntityType,
} from '../catalog/connector-functions-registry.js';
import type { ConnectorFunction } from '../types.js';
import type {
  CompensationClient,
  ConnectorCredentials,
  CredentialProvider,
  CreateResult,
  DeleteResult,
  ExternalRecord,
  UpdateResult,
} from './types.js';

type CrudOp = 'read' | 'create' | 'update' | 'delete';

/** A write client that reported failure IN BAND, as a return value.
 *
 *  `CreateResult`, `UpdateResult` and `DeleteResult` all declare
 *  `success: boolean` plus an optional `error`. A client that cannot perform
 *  the write does not throw — it returns `{success: false, error}`. That is a
 *  perfectly good contract, and it was being thrown away here: both executor
 *  factories packed the whole struct into `ExecutorResult.result` as opaque
 *  JSON, and `runConnectorExecution` then stamped `success: true` over it. The
 *  failure survived only as a field inside a blob nobody read.
 *
 *  For example, a Slack notification can come back
 *  `{"success":false,"id":"","error":"404 Connected account \"ca_…\" not
 *  found"}` and be audited as `outcome: success`. The message reaches no
 *  channel; the agent is told it has been delivered, so nothing retries and
 *  nothing escalates. This is invariant 4 — a tool that
 *  cannot dispatch must return `{success:false, error}`, never a fabricated
 *  success — failing at the last hop that could still see the truth.
 *
 *  It is not Slack-specific. Every REST connector registered through
 *  `makeClientExecutor` shares this seam, so every create/update/delete in the
 *  estate could report a vendor refusal as a success.
 *
 *  Reads are deliberately out of scope: `ExternalRecord` and `ListResult`
 *  declare no `success` field, so there is nothing to misread, and treating a
 *  record that merely happens to carry `success: false` in its DATA as a
 *  transport failure would invent failures that did not occur. The check keys
 *  on the write ops, where `success` is a declared part of the return type.
 */
export function crudFailure(
  op: CrudOp,
  raw: unknown,
): { message: string } | undefined {
  if (op === 'read') return undefined;
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as { success?: unknown; error?: unknown };
  // Explicitly `false`, not merely falsy: a client that omits the field has
  // told us nothing, and defaulting silence to failure would break every
  // client whose result shape predates the flag.
  if (r.success !== false) return undefined;
  return {
    message: typeof r.error === 'string' && r.error.trim() !== ''
      ? r.error
      : `${op} reported success=false without an error message`,
  };
}

/**
 * Given a ConnectorFunction (or just a name) + categories, decide which CRUD
 * op to route to. Category-driven first (registry is the source of truth),
 * prefix-match fallback to handle function names outside the registry.
 */
export function inferCrudOp(name: string, fn: ConnectorFunction | undefined): CrudOp {
  if (fn) {
    const cats = new Set(fn.categories ?? []);
    if (cats.has('destructive')) return 'delete';
    if (cats.has('read')) return 'read';
    if (cats.has('write') || cats.has('outbound')) {
      // Distinguish update-style writes from create-style by prefix.
      const lower = name.toLowerCase();
      if (
        lower.startsWith('update') ||
        lower.startsWith('patch') ||
        lower.startsWith('edit') ||
        lower.startsWith('modify')
      ) {
        return 'update';
      }
      return 'create';
    }
  }

  const lower = name.toLowerCase();
  if (
    lower.startsWith('delete') ||
    lower.startsWith('remove') ||
    lower.startsWith('destroy') ||
    lower.startsWith('archive') ||
    lower.startsWith('revoke')
  ) {
    return 'delete';
  }
  if (
    lower.startsWith('get') ||
    lower.startsWith('read') ||
    lower.startsWith('list') ||
    lower.startsWith('fetch') ||
    lower.startsWith('search') ||
    lower.startsWith('find') ||
    lower.startsWith('query')
  ) {
    return 'read';
  }
  if (
    lower.startsWith('update') ||
    lower.startsWith('patch') ||
    lower.startsWith('edit') ||
    lower.startsWith('modify')
  ) {
    return 'update';
  }
  return 'create';
}

/**
 * Extract an entityId from the input payload. Most connector clients key
 * off `id`, a few off `targetRef` or `entityId` — matches the behaviour in
 * tenant-runtime's executeViaClient.
 */
export function extractEntityId(input: JsonObject): string | undefined {
  const id = (input as Record<string, unknown>)['id'];
  if (typeof id === 'string' && id.length > 0) return id;
  const targetRef = (input as Record<string, unknown>)['targetRef'];
  if (typeof targetRef === 'string' && targetRef.length > 0) return targetRef;
  const entityId = (input as Record<string, unknown>)['entityId'];
  if (typeof entityId === 'string' && entityId.length > 0) return entityId;
  return undefined;
}

/**
 * Build a CredentialProvider closure from the ExecutorContext. The closure
 * re-reads `ctx.credentials` on every call, so when the dispatcher refreshes
 * a token between retries, clients see the fresh value.
 */
export function credentialProviderFromContext(ctx: ExecutorContext): CredentialProvider {
  return async (): Promise<ConnectorCredentials> => {
    const c = ctx.credentials;
    // Prefer access token for OAuth flows; fall back to API key otherwise.
    // Salesforce (and a few others) consume `instanceUrl`.
    // tenantId/connectorId are forwarded so clients can throw
    // OAuthRefreshError on vendor reconnect-required signals.
    return {
      accessToken: c.accessToken ?? c.apiKey ?? '',
      instanceUrl: c.instanceUrl,
      connectorConfig: ctx.connectorConfig,
      tenantId: ctx.tenantId,
      connectorId: ctx.connectorId,
    };
  };
}

/**
 * Wrap a typed REST/API client so it behaves as a ConnectorExecutor.
 *
 * `factory` constructs the client given a CredentialProvider. We build a
 * fresh client per call (REST clients are stateless HTTP — no caching win).
 */
/** Client factories, keyed by connector type, for callers that need to TALK to
 *  a connector rather than execute a named function on it.
 *
 *  `Execute` dispatches by function name, which is right for tool calls and
 *  useless for "list what is in this account". Browse needed the latter and,
 *  having no way to ask, grew its own `if/else` over a handful of connector
 *  types with a hand-rolled result mapper — so every new vendor meant editing
 *  an HTTP route, and vendors kept getting missed because nothing enumerated
 *  what was covered.
 *
 *  Populated here rather than at each of the 57 registration sites, because
 *  makeClientExecutor already receives both halves. Adding a connector
 *  therefore makes it browseable with no further wiring, which is the property
 *  that was missing. */
const clientFactories = new Map<
  string,
  (ctx: ExecutorContext, credentialProvider: CredentialProvider) => CompensationClient
>();

export function getClientFactory(connectorType: string) {
  return clientFactories.get(connectorType) ?? null;
}

export function registeredClientTypes(): string[] {
  return [...clientFactories.keys()];
}

export function makeClientExecutor(
  connectorType: string,
  factory: (ctx: ExecutorContext, credentialProvider: CredentialProvider) => CompensationClient,
) {
  clientFactories.set(connectorType, factory);
  return async (ctx: ExecutorContext): Promise<ExecutorResult> => {
    const credentialProvider = credentialProviderFromContext(ctx);
    const client = factory(ctx, credentialProvider);

    // Locate the registry entry if any. Tolerates unknown function names.
    const fns = getConnectorFunctions(connectorType);
    const fn = fns.find((f) => f.name === ctx.functionName);
    const entityType = resolveEntityType(connectorType, ctx.functionName);
    const op = inferCrudOp(ctx.functionName, fn);

    const entityId = extractEntityId(ctx.input);
    const payload = ctx.input as Record<string, unknown>;

    let raw: ExternalRecord | CreateResult | UpdateResult | DeleteResult | import('./types.js').ListResult;
    // useListMethod overrides the inferred read-op dispatch to instead route
    // through the client's typed `list(entityType, filters)` API, which
    // accepts polling-style filters (limit, pageToken, since, q). This is
    // the canonical path for functions like Gmail's `list_messages` where
    // the agent-supplied `query` must hit Gmail's `q` API parameter.
    if (fn?.useListMethod) {
      raw = await client.list(entityType, payloadToListFilters(payload));
    } else {
      switch (op) {
        case 'read':
          raw = await client.read(entityType, entityId, payload);
          break;
        case 'delete':
          raw = await client.delete(entityType, entityId, payload);
          break;
        case 'update':
          raw = await client.update(entityType, entityId, payload);
          break;
        case 'create':
        default:
          raw = await client.create(entityType, payload);
          break;
      }
    }

    // A write that failed in band travels as a failure, not as JSON inside a
    // success. `result` is still returned so the caller keeps the vendor's own
    // payload for diagnostics.
    const failure = crudFailure(op, raw);
    return {
      result: toJsonObject(raw),
      ...(failure ? { failure } : {}),
    };
  };
}

/**
 * Translate a tool-call payload to ListFilters. Agents pass `query` /
 * `maxResults` / `pageToken` / `since` and we map them onto the connector's
 * generic ListFilters contract. `query` becomes `q`; other connectors that
 * implement list() ignore `q` (additive — no behaviour change).
 */
function payloadToListFilters(payload: Record<string, unknown>): import('./types.js').ListFilters {
  const filters: import('./types.js').ListFilters = {};
  if (typeof payload.query === 'string' && payload.query.length > 0) filters.q = payload.query;
  // Outlook's `list_messages` tool exposes `filter` (an OData $filter expression);
  // route it through ListFilters.q so Outlook's list() can compose it as $filter.
  if (typeof payload.filter === 'string' && payload.filter.length > 0) filters.q = payload.filter;
  if (typeof payload.maxResults === 'number') filters.limit = payload.maxResults;
  if (typeof payload.limit === 'number') filters.limit = payload.limit;
  if (typeof payload.top === 'number') filters.limit = payload.top;
  if (typeof payload.pageToken === 'string') filters.pageToken = payload.pageToken;
  if (typeof payload.since === 'string' || typeof payload.since === 'number') {
    const d = new Date(payload.since as string | number);
    if (!Number.isNaN(d.getTime())) filters.since = d;
  }
  return filters;
}

function toJsonObject(value: unknown): JsonObject {
  if (value == null) return {};
  if (typeof value !== 'object') return { value: value as never };
  // Structured-clone via JSON to strip Date / BigInt etc. that JsonObject
  // cannot represent natively. This matches how the RPC serialises result.
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

// ──────────────────────────────────────────────────────────────────────
// MCP-client executor — for clients that take `{tenantId, credentialStore}`
// instead of a CredentialProvider closure. Routes CRUD ops the same way
// makeClientExecutor does.
// ──────────────────────────────────────────────────────────────────────

import { PerConnectorIdCredentialStore } from '../mcp/credential-store.js';
import type { CredentialStore } from '../mcp/credential-store.js';

export interface MCPClientFactoryArgs {
  tenantId: string;
  credentialStore: CredentialStore;
  correlationId?: string;
  connectorConfig?: Record<string, unknown>;
}

/**
 * Wrap an MCP-style connector client (one that takes tenantId +
 * credentialStore) as a ConnectorExecutor. Mirrors makeClientExecutor but
 * provides the credentialStore shape these clients expect.
 *
 * Each call constructs a fresh store scoped to this connectorId so the
 * MCP client's per-request getCredentials calls resolve to the right
 * secret — even if multiple connectors of the same type are installed for
 * one tenant.
 */
export function makeMCPClientExecutor(
  connectorType: string,
  factory: (args: MCPClientFactoryArgs) => CompensationClient,
) {
  // MCP-backed clients register into the SAME map as the REST ones, normalised
  // to the one signature callers use. There are two families here only because
  // MCP clients need a credential store rather than a credential closure; that
  // is a construction detail, and a caller asking "give me a client for notion"
  // should not have to know which family notion landed in.
  //
  // Registering only the REST family is a live bug, not a hypothetical: notion
  // and intercom are MCP-backed and were browseable before, so leaving them out
  // silently dropped two working connectors.
  clientFactories.set(connectorType, (ctx) =>
    factory({
      tenantId: ctx.tenantId,
      credentialStore: new PerConnectorIdCredentialStore(ctx.tenantId, ctx.connectorId),
      correlationId: ctx.traceId,
      connectorConfig: ctx.connectorConfig,
    }),
  );

  return async (ctx: ExecutorContext): Promise<ExecutorResult> => {
    const credentialStore = new PerConnectorIdCredentialStore(
      ctx.tenantId,
      ctx.connectorId,
    );
    const client = factory({
      tenantId: ctx.tenantId,
      credentialStore,
      correlationId: ctx.traceId,
      connectorConfig: ctx.connectorConfig,
    });

    const fns = getConnectorFunctions(connectorType);
    const fn = fns.find((f) => f.name === ctx.functionName);
    const entityType = resolveEntityType(connectorType, ctx.functionName);
    const op = inferCrudOp(ctx.functionName, fn);

    const entityId = extractEntityId(ctx.input);
    const payload = ctx.input as Record<string, unknown>;

    let raw: ExternalRecord | CreateResult | UpdateResult | DeleteResult | import('./types.js').ListResult;
    if (fn?.useListMethod) {
      raw = await client.list(entityType, payloadToListFilters(payload));
    } else {
      switch (op) {
        case 'read':
          raw = await client.read(entityType, entityId, payload);
          break;
        case 'delete':
          raw = await client.delete(entityType, entityId, payload);
          break;
        case 'update':
          raw = await client.update(entityType, entityId, payload);
          break;
        case 'create':
        default:
          raw = await client.create(entityType, payload);
          break;
      }
    }

    // A write that failed in band travels as a failure, not as JSON inside a
    // success. `result` is still returned so the caller keeps the vendor's own
    // payload for diagnostics.
    const failure = crudFailure(op, raw);
    return {
      result: toJsonObject(raw),
      ...(failure ? { failure } : {}),
    };
  };
}
