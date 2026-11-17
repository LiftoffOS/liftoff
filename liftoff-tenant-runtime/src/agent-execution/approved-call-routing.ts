// Where an operator-approved call goes, decided from the catalog it resolves
// against rather than from the shape of its name.
//
// The HITL resume used to infer ownership from the name alone: a standard
// tool, else split on the first `__` and call whatever came before it a
// connector. That rule is right for exactly two families and wrong for every
// other one. A teammate tool (`internal__<alias>__execute`), a vendor MCP tool
// (`<server>__<tool>`), a deferred vendor tool and a gateway-native tool
// (`sleep_until`, `delegate_task`, `spawn_task_graph`, …) were all dispatched
// to a connector named after the tool, failed, and the model asked again — so
// every approval bought one more copy of the same question.
//
// Resolve, THEN route. The catalog says whose tool it is: the server it lives
// on and the source the gateway tagged it with; for the gateway's own tools the
// dispatcher's family resolver — the one authority on what executeToolCalls
// can execute — says which of them it routes (a standard tool, a connector's,
// the per-agent Slack and Teams surfaces). Those keep the dispatcher; everything
// else goes through the same bridge the engines use, with the catalog entry in
// hand. A name the catalog does not know is never guessed at: it fails closed.

import type { McpToolCatalog, McpToolDefinition } from './adapter/catalog-types';
import type { ToolCallRequest } from './types';
import { dispatchNameFor, resolveCatalogTool } from '../hitl-enforcement/tool-name-resolution';
import { entityTypeForDispatch, resolveToolDispatch } from './tool-dispatch-family';

/** Server id of the in-process gateway whose tools this runtime registers itself. */
const OWN_GATEWAY_SERVER_ID = 'liftoff-tool-gateway';

/** Who owns the tool, per the catalog. Also the vocabulary the approved-dispatch
 *  event reports, so the log names the same families this decides between.
 *  `connector` is everything the dispatcher routes by a connector segment: a
 *  bound connector's tool, a runtime pseudo-connector's (the per-agent Slack
 *  and Teams surfaces, the sandbox family's prefixed form) and an external
 *  agent's. */
export type ApprovedCallOwnership =
  | 'standard'
  | 'connector'
  | 'gateway'
  | 'vendor_mcp'
  | 'teammate'
  | 'unresolved';

export type ApprovedDispatchPath = 'execute_tool_calls' | 'bridge' | 'none';

export interface ApprovedCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ApprovedCallRoute {
  call: ApprovedCall;
  ownership: ApprovedCallOwnership;
  dispatchPath: ApprovedDispatchPath;
  /** The catalog entry the call resolved to, or null when nothing did. */
  resolvedName: string | null;
  /** The dispatcher's request shape, when the call runs through
   *  executeToolCalls. A standard tool keeps its whole name as the actionType
   *  with an empty connector — the dispatcher routes a standard tool only when
   *  the connector is empty; a connector tool splits on its first `__`. */
  request?: ToolCallRequest;
  /** What the engines' dispatcher is handed, when the call runs through the
   *  bridge: the catalog to resolve against — a deferred vendor entry inlined
   *  into `tools`, so the bridge finds it and sends its remote name on the wire
   *  — and the name to dispatch. */
  bridge?: { catalog: McpToolCatalog; name: string };
}

type DeferredVendorTool = {
  name: string;
  remoteToolName?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  serverId: string;
};

/**
 * Resolve one approved call against the catalog and decide its route.
 *
 * `isStandardTool` is injected rather than imported for the same reason the
 * dispatch-family resolver injects it: the standard-tool module pulls in the
 * handlers, browser sessions and web vendors, and this module has no need of
 * any of them.
 */
export function routeApprovedCall(
  catalog: McpToolCatalog,
  call: ApprovedCall,
  isStandardTool: (name: string) => boolean,
): ApprovedCallRoute {
  const dispatchName = dispatchNameFor(call.name);
  const resolved = resolveCatalogTool(call.name, catalog.tools);
  if (resolved) return routeResolved(catalog, call, dispatchName, resolved, isStandardTool);

  // A collapsed vendor server keeps its tools off `tools` and behind a search
  // pair. The gate saw the INNER name — the bridge unwraps a wrapper call and
  // re-dispatches the tool as itself — so that is the name persisted here, and
  // it lives only in the deferred lists.
  const deferred = resolveDeferred(catalog, call.name, dispatchName);
  if (deferred) {
    return {
      call,
      ownership: 'vendor_mcp',
      dispatchPath: 'bridge',
      resolvedName: deferred.name,
      bridge: {
        catalog: { ...catalog, tools: [...catalog.tools, deferred as unknown as McpToolDefinition] },
        name: deferred.name,
      },
    };
  }

  // A bound outbound tool the Communication setting withheld from the model
  // (Draft-first offers its draft form instead). The person approved the send
  // itself; whether that yes still covers the setting as it is now is the
  // obligation recompute's question, not a missing connector.
  const withheld = resolveCatalogTool(call.name, catalog.withheldByOversight ?? []);
  if (withheld) return routeResolved(catalog, call, dispatchName, withheld, isStandardTool);

  return { call, ownership: 'unresolved', dispatchPath: 'none', resolvedName: null };
}

function routeResolved(
  catalog: McpToolCatalog,
  call: ApprovedCall,
  dispatchName: string,
  resolved: McpToolDefinition,
  isStandardTool: (name: string) => boolean,
): ApprovedCallRoute {
  const viaBridge = (ownership: ApprovedCallOwnership): ApprovedCallRoute => ({
    call,
    ownership,
    dispatchPath: 'bridge',
    resolvedName: resolved.name,
    bridge: { catalog, name: resolved.name },
  });
  const viaDispatcher = (ownership: ApprovedCallOwnership, request: ToolCallRequest): ApprovedCallRoute => ({
    call,
    ownership,
    dispatchPath: 'execute_tool_calls',
    resolvedName: resolved.name,
    request,
  });

  // A tool on a remote server is the vendor's, whatever its name looks like.
  if (resolved.serverId !== OWN_GATEWAY_SERVER_ID) return viaBridge('vendor_mcp');
  // A teammate tool is named `internal__<alias>__execute`, which the name
  // split reads as a connector called `internal`. The gateway tagged it.
  if (resolved.source === 'internal_agent') return viaBridge('teammate');

  // The rest of the gateway's tools are sorted by the dispatcher's OWN family
  // resolver — the one authority on what executeToolCalls can execute, shared
  // with the workflow-step and recovery paths so this cannot disagree with them.
  const family = resolveToolDispatch(dispatchName, isStandardTool);
  switch (family.kind) {
    // A standard tool executes locally, whole name as the actionType.
    case 'standard':
      return viaDispatcher('standard', { id: call.id, connector: '', entityType: '', actionType: dispatchName, payload: call.input });
    // `<segment>__<fn>`: a bound connector's tool, a runtime pseudo-connector
    // (`agent_slack__…`, `agent_teams__…`, `execution_environment__…`) or an
    // external agent's (`external__<alias>__<tool>`). The dispatcher routes
    // each by that first segment, exactly as it always has.
    case 'connector':
      return viaDispatcher('connector', {
        id: call.id, connector: family.connector, entityType: '', actionType: family.actionType, payload: call.input,
      });
    // The per-agent Slack and Teams surfaces, called by their bare catalog
    // name on the engines that read the catalog. The dispatcher routes them
    // by family; the gateway's own handlers for these tools re-apply the
    // oversight decision at execute time, and an approved send must not be
    // asked for approval again on its way out.
    case 'agent_slack':
    case 'agent_teams':
      return viaDispatcher('connector', {
        id: call.id, connector: family.connector, entityType: entityTypeForDispatch(family, ''), actionType: family.actionType, payload: call.input,
      });
    // Everything else the gateway registers — the wake tools, delegation and
    // teammate work, the sandbox primitives, code_session, the built-in
    // collaboration tools — is reached the way every engine reaches it:
    // through the in-process MCP server.
    case 'sandbox':
    case 'builtin':
    case 'unresolved':
      return viaBridge('gateway');
  }
}

function resolveDeferred(
  catalog: McpToolCatalog,
  callName: string,
  dispatchName: string,
): DeferredVendorTool | undefined {
  const all: DeferredVendorTool[] = [];
  for (const list of catalog.deferredVendorTools?.values() ?? []) all.push(...list);
  if (all.length === 0) return undefined;
  return resolveCatalogTool(callName, all)
    ?? all.find((t) => t.remoteToolName !== undefined && t.remoteToolName === dispatchName);
}
