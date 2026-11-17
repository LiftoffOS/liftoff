// Composio cutover-completion (C8) — source-switchover env-var helpers.
//
// Two env vars drive dispatch-source flips:
//   - COMPOSIO_DISABLED_CONNECTORS=<types>   composio → native fallback
//                                            (existing var at mcp-server-registry.ts:104)
//   - FORCE_COMPOSIO_FOR_CONNECTOR_TYPES=<types>  native → composio
//                                                 (new; no prior precedent)
//
// Use cases + per-tenant reconnect requirements documented at
// docs/runbooks/CONNECTOR_SOURCE_FLIP.md.

/** Parse a comma-separated env var into a Set, normalising whitespace and
 *  filtering empties. */
export function parseEnvCsv(value: string | undefined): Set<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** Returns true when a composio_managed connector type has been switched
 *  back to its native dispatch via COMPOSIO_DISABLED_CONNECTORS. Mirrors
 *  the precedent at mcp-server-registry.ts:104 — the env var name + parse
 *  rules stay identical so operators have one knob, not two. */
export function shouldSwitchoverComposioToNative(connectorType: string): boolean {
  return parseEnvCsv(process.env.COMPOSIO_DISABLED_CONNECTORS).has(connectorType);
}

/** Returns true when a native connector type has been forced onto
 *  Composio dispatch via FORCE_COMPOSIO_FOR_CONNECTOR_TYPES. The reverse
 *  direction; new env var because COMPOSIO_DISABLED_CONNECTORS' semantics
 *  are inverted. */
export function shouldForceComposio(connectorType: string): boolean {
  return parseEnvCsv(process.env.FORCE_COMPOSIO_FOR_CONNECTOR_TYPES).has(connectorType);
}

// Every HRIS connector backed by a first-party native client. Kept in sync with
// NATIVE_HRIS_TYPES in native-hris-types.ts — this is the leaf copy to avoid an import
// cycle (that module imports this one). A dedicated test asserts the two lists match.
const NATIVE_HRIS_CLIENT_TYPES = new Set<string>([
  'workday', 'oracle_hcm', 'namely', 'sap_successfactors',
  'deel', 'factorial', 'hibob', 'personio', 'ukg_pro', 'ukg_ready', 'dayforce',
  'adp_run', 'adp_workforce_now',
  'gusto', 'rippling', 'bamboohr', 'warp',
]);

/** True for any connector backed by a first-party native HRIS client. */
export function isNativeHrisConnector(connectorType: string): boolean {
  return NATIVE_HRIS_CLIENT_TYPES.has(connectorType);
}
