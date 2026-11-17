// Per-agent binding resolution.
//
// Agent tool calls reach the tool-gateway with `input.connector` set to the
// identifier the agent used in its tool name — that may be:
//   - the connector type alias from the manifest (e.g. `gmail`,
//     `gmail_support`, `salesforce_prod`)
//   - the canonical connector type (`google_mail`, `salesforce`)
//   - the connector instance UUID (legacy / non-agent callers)
//
// `bindingsByType` is built once per agent execution and threaded onto
// every ExecuteInput. The map is keyed by EVERY identifier that could
// appear in `input.connector` so resolveBinding (in service.ts) finds
// the bound UUID + per-binding config regardless of which form the agent
// used.

interface BindingIntegration {
  id: string;
  type?: string;
  config?: Record<string, unknown>;
}

interface BindingManifest {
  connectorType: string;
  alias: string;
  /**
   * The manifest's own connector_id. Populated by the
   * connector.credentials_stored event handler (and migration 251's
   * backfill) to the CURRENT connectors-table row UUID. If a connector
   * is reconnected, the manifest's id is refreshed by the handler's
   * `ON CONFLICT (tenant_id, alias) DO UPDATE SET id = EXCLUDED.id`
   * clause. The integration's id baked into the compiled instruction is
   * NOT refreshed, so it can become stale.
   *
   * When present, buildBindingsByType prefers manifest.id over the
   * integration's id because the manifest is the authoritative current
   * UUID.
   */
  id?: string;
}

export type BindingsByType = Record<
  string,
  { connectorId: string; config?: Record<string, unknown> }
>;

/**
 * Build a `bindingsByType` map keyed by:
 *   1. canonical connector type (`google_mail`)
 *   2. every manifest alias that points at the same type (`gmail`,
 *      `gmail_support`, etc.)
 *   3. the connector UUID itself (so legacy callers passing a UUID still
 *      hit the binding-config injection path)
 *
 * `manifests` are the alias map for this tenant/agent (from
 * connectorManifestRepository.getManifestsForAgent). When omitted, only the
 * type and UUID keys are populated — sufficient for callers that don't have
 * manifest context (e.g. the delegate path in agent-execution/service.ts).
 *
 * Stale-UUID resolution: when a manifest carries an `id`, that id is
 * preferred over the integration's id for any binding entry that maps to
 * this manifest's type. Reason: compiled_instructions.integrations stores
 * the connector_id captured at distillation time. If the user reconnects
 * the connector later (PB issues a new connector_id, TR's handler updates
 * the manifest), the instruction's integration.id is now stale and
 * forwarding it to connector-service yields a "no such connector" 404.
 * The manifest is the authoritative current UUID; prefer it everywhere
 * we have one. The integration's id is still threaded in as an
 * additional key so callers that pass the stale UUID directly still
 * resolve to the current connector_id.
 */
export function buildBindingsByType(
  integrations: BindingIntegration[] | undefined,
  manifests?: BindingManifest[],
): BindingsByType {
  const out: BindingsByType = {};
  if (!integrations || integrations.length === 0) return out;

  // Group state for the multi-account-aware resolution below.
  const integrationsByType = new Map<string, BindingIntegration[]>();
  for (const i of integrations) {
    if (!i.type) continue;
    const list = integrationsByType.get(i.type) ?? [];
    list.push(i);
    integrationsByType.set(i.type, list);
  }

  const manifestsById = new Map<string, BindingManifest>();
  const manifestsByType = new Map<string, BindingManifest[]>();
  if (manifests) {
    for (const m of manifests) {
      if (m.id) manifestsById.set(m.id, m);
      const list = manifestsByType.get(m.connectorType) ?? [];
      list.push(m);
      manifestsByType.set(m.connectorType, list);
    }
  }

  // Given an integration, figure out its CURRENT connectorId (post any
  // reconnect). Priority:
  //   1. Exact manifest match by id (no drift — most common case)
  //   2. Sole manifest for this integration's type (handles the
  //      single-account stale-UUID case: instruction has the old id,
  //      manifest carries the new id; one-to-one)
  //   3. Fall back to integration.id (transition window — manifest
  //      doesn't exist yet; the call may fail downstream but we don't
  //      make it worse)
  const resolveCurrentId = (i: BindingIntegration): string => {
    if (manifestsById.has(i.id)) return manifestsById.get(i.id)!.id!;
    const sameType = i.type ? manifestsByType.get(i.type) : undefined;
    if (sameType && sameType.length === 1 && sameType[0].id) return sameType[0].id;
    return i.id;
  };

  // 1) UUID entries — always unambiguous. Each integration's id and its
  //    resolved current id both point to the current connector. The
  //    integration's id is kept as a key so callers passing the
  //    pre-reconnect stale UUID directly still resolve correctly.
  for (const i of integrations) {
    const currentId = resolveCurrentId(i);
    out[i.id] = { connectorId: currentId, config: i.config };
    if (currentId !== i.id) {
      out[currentId] = { connectorId: currentId, config: i.config };
    }
  }

  // 2) Type entries — populated ONLY when unambiguous (exactly one
  //    integration of this type). With two Gmails, looking up by
  //    `google_mail` would be ambiguous (which account?); silently
  //    picking one would route tool calls to the wrong inbox. We omit
  //    the type-keyed entry instead, so the caller hits a missing-key
  //    error explicitly and migrates to alias-based lookup. The
  //    canonical multi-account key is the alias, populated below.
  for (const [type, list] of integrationsByType) {
    if (list.length !== 1) continue;
    const i = list[0];
    const currentId = resolveCurrentId(i);
    out[type] = { connectorId: currentId, config: i.config };
  }

  // 3) Alias entries — the canonical multi-account lookup key. Each
  //    manifest carries a per-account alias (post-migration-252) like
  //    `google-mail-eaec0c30`. The LLM emits tool names prefixed with
  //    these aliases; the gateway's resolveBinding uses this map.
  if (manifests && manifests.length > 0) {
    const integrationsById = new Map<string, BindingIntegration>();
    for (const i of integrations) integrationsById.set(i.id, i);
    for (const m of manifests) {
      // Link manifest → integration. Prefer the exact id match. If none,
      // and there's exactly one integration of this manifest's type,
      // bind to that one (handles the stale-UUID single-account case).
      const exactMatch = m.id ? integrationsById.get(m.id) : undefined;
      const sameTypeIntegrations = integrationsByType.get(m.connectorType) ?? [];
      const i = exactMatch ?? (sameTypeIntegrations.length === 1 ? sameTypeIntegrations[0] : undefined);
      if (!i) continue;
      const connectorId = m.id ?? i.id;
      out[m.alias] = { connectorId, config: i.config };
    }
  }

  return out;
}
