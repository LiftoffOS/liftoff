// Which of a workspace's OWN web-tool vendors a run may use, and through which
// connector.
//
// Two facts decide it, and both are required:
//
//   1. the workspace has CONNECTED the vendor — a connectors row of that type in
//      status active, which is what getTenantConnectedWebVendors answers; and
//   2. the TEAM is BOUND to that connector — it appears in the team's active
//      compiled instruction's `integrations`, the same list every connector
//      tool is gated on (getManifestsForAgent takes it) and the same list the
//      browser session picker has always read.
//
// The text-vendor chains in router.ts asked only the first question. A team
// bound to nothing therefore fetched pages through whichever Exa or Tavily
// account another team in the workspace had connected, and that account paid
// for it.
//
// Platform backends are not vendors here at all — perplexity, openai, google,
// xai, browserbase_x402, locus_web, locus_exa, and the platform key behind
// browser_use, steel, tavily and exa — and this module never withholds them: vendorAvailable() in router.ts admits
// them without a connector. The rule decides whose ACCOUNT serves a team,
// never whether the tool exists. That is the rule selectSessionVendor
// carries, now applied to every chain.
//
// Three answers, deliberately different:
//   - an active instruction that binds the vendor → that vendor, through the
//     bound connector ids;
//   - an active instruction that does not → not that vendor, even though the
//     workspace connected it (this is the fix);
//   - no active instruction at all → no opinion: the connected set as before.
//     A run with no team behind it (the platform assistants' pane sessions
//     carry the no-agent sentinel) is the workspace acting as itself, and a
//     team mid-compile must not lose a vendor it is about to be bound to.
// A binding that cannot be READ fails closed to the platform backends, and
// says so: spending a workspace's account needs proof of a binding, not the
// absence of a database answer.

import { getPool } from '../../infrastructure/database';
import { logger } from '../../infrastructure/logging';
import { getTenantConnectedWebVendors, type WebToolVendor } from './web-tool-secrets';

/** Why the scope came out the way it did. Carried on the log line so a
 *  workspace's routing can be explained from the record. */
export type WebVendorScopeBasis = 'bound' | 'unbound' | 'no_instruction' | 'unreadable';

export interface WebVendorScope {
  /** The workspace's own vendors this run may use. */
  vendors: Set<WebToolVendor>;
  /** Per usable vendor, the connector ids the team is bound to. An EMPTY set
   *  means the binding named the type without an id (the legacy shape), so
   *  any of the workspace's connectors of that type may serve. */
  connectorIds: Map<WebToolVendor, ReadonlySet<string>>;
  /** Connected vendors the binding left out. */
  excluded: WebToolVendor[];
  basis: WebVendorScopeBasis;
}

/** The connector types THIS agent is bound to, with the connector ids it is
 *  bound to them through, from its active compiled instruction. Null when
 *  there is no active instruction.
 *
 *  Reads `integrations` the way deriveAllowedConnectors does: an entry is
 *  identified by `type`, falling back to `id`; an entry whose `id` IS a vendor
 *  name (the legacy shape) binds the type with no id constraint.
 *
 *  Translates the id space first. compiled_instructions.agent_id is the
 *  RUNTIME agents.id, and a caller may hold the control-plane id (the pane's
 *  ensure RPC does). Querying with the wrong space matches zero rows and
 *  raises nothing (INV-TR-010), which would read as "this agent has no
 *  instruction" — and hand the workspace's accounts to a team bound to none.
 *  resolveRuntimeAgentId returns the input unchanged when there is no mapping
 *  row and logs agent_id_mapping_miss, so the miss stays greppable. */
export async function boundWebVendorConnectors(
  tenantId: string,
  agentId: string,
): Promise<Map<string, Set<string>> | null> {
  const { resolveRuntimeAgentId } = await import('../../agent-lifecycle/resolve-runtime-agent-id');
  const runtimeAgentId = await resolveRuntimeAgentId(tenantId, agentId, 'boundWebVendorConnectors');
  const { rows } = await getPool().query<{ integrations: unknown }>(
    `SELECT ci.integrations FROM compiled_instructions ci
      WHERE ci.tenant_id = $1 AND ci.agent_id = $2 AND ci.status = 'active'
      ORDER BY ci.version DESC LIMIT 1`,
    [tenantId, runtimeAgentId],
  );
  if (!rows || rows.length === 0) return null;
  const raw = rows[0].integrations;
  const list = Array.isArray(raw) ? (raw as Array<{ id?: string; type?: string }>) : [];
  // Every binding, keyed by connector type. Which of them are web-tool
  // vendors is decided by the intersection with the connected set below, so
  // this needs no vendor list of its own.
  const bound = new Map<string, Set<string>>();
  for (const entry of list) {
    const type = entry.type || entry.id;
    if (!type) continue;
    const ids = bound.get(type) ?? new Set<string>();
    // A legacy entry carries the type as its id: it binds the type, not a row.
    if (entry.type && entry.id && entry.id !== entry.type) ids.add(entry.id);
    bound.set(type, ids);
  }
  return bound;
}

/**
 * The workspace vendors a run may route to: connected AND bound, with the
 * connector ids the binding names. See the header for the three answers.
 *
 * `prefetchedConnected` is for a caller that already holds the connected set
 * (the session spawn does, and it is an uncached cross-service call).
 */
export async function usableWebVendors(
  tenantId: string,
  agentId: string | undefined,
  prefetchedConnected?: Set<WebToolVendor>,
): Promise<WebVendorScope> {
  const connected = prefetchedConnected ?? await getTenantConnectedWebVendors(tenantId);

  let bound: Map<string, Set<string>> | null;
  try {
    bound = agentId ? await boundWebVendorConnectors(tenantId, agentId) : null;
  } catch (err) {
    // Fail closed. The platform backends still serve the call; what is
    // withheld is the workspace's own accounts, which a read failure gives no
    // right to.
    logger.warn(
      { tenantId, agentId, err: (err as Error).message, event: 'web_vendor_scope_unreadable' },
      'web vendor scope: the team binding could not be read; the workspace\'s own vendors are withheld for this call',
    );
    return { vendors: new Set(), connectorIds: new Map(), excluded: [...connected], basis: 'unreadable' };
  }

  if (bound === null) {
    return { vendors: new Set(connected), connectorIds: new Map(), excluded: [], basis: 'no_instruction' };
  }

  const vendors = new Set<WebToolVendor>();
  const connectorIds = new Map<WebToolVendor, ReadonlySet<string>>();
  const excluded: WebToolVendor[] = [];
  for (const v of connected) {
    const ids = bound.get(v);
    if (ids === undefined) { excluded.push(v); continue; }
    vendors.add(v);
    connectorIds.set(v, ids);
  }
  return { vendors, connectorIds, excluded, basis: vendors.size > 0 ? 'bound' : 'unbound' };
}

/** One structured line per call that left a connected vendor out, so the
 *  effect of the rule is countable per workspace (a log-based metric). Quiet
 *  when nothing was excluded: that is every call in a workspace that binds
 *  what it connects, and every call with no vendor connected at all. */
export function logExcludedVendors(
  scope: WebVendorScope,
  ctx: { tenantId: string; agentId?: string; toolName: string; traceId?: string },
): void {
  if (scope.excluded.length === 0) return;
  logger.info(
    {
      event: 'web_vendor_excluded_by_binding',
      tenant_id: ctx.tenantId,
      agent_id: ctx.agentId,
      trace_id: ctx.traceId,
      tool: ctx.toolName,
      excluded: scope.excluded,
      basis: scope.basis,
    },
    'web vendor scope: connected vendors the team is not bound to were left out of this call',
  );
}
