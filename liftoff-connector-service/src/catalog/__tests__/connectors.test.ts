// Invariants for the unified CONNECTORS registry.
//
// The registry is the single source of truth; every other view
// (FUNCTIONAL_CONNECTOR_TYPES, CONNECTOR_DISPLAY_NAMES, capability map,
// the catalog response) is a projection. These tests guarantee that:
//
//   - Projections match the registry.
//   - Types are consistent between the ConnectorType union in types.ts
//     and the keys of CONNECTORS.
//   - Every registry entry is internally coherent (coming_soon entries
//     have a statusReason; static_oauth entries have client-id env vars;
//     sidecar MCP entries have a path starting with '/').

import { CONNECTORS, computeCatalogVersion, URL_RESOLVERS, CATEGORY_DISPLAY_LABELS } from '../connectors.js';
import { isAllowedDiscoveryUrl } from '../../oauth/discovery.js';
import type { ConnectorCategory } from '@liftoffos/connector-types';
import { getConnectorFunctions, getRegisteredConnectorTypes } from '../connector-functions-registry.js';
import {
  FUNCTIONAL_CONNECTOR_TYPES,
  CONNECTOR_DISPLAY_NAMES as PROJECTED_DISPLAY_NAMES,
  buildCapabilityMap,
  getConnectorCatalog,
  isConnectorFunctional,
} from '../projections.js';
import {
  CONNECTOR_DISPLAY_NAMES,
  CONNECTOR_TYPES_LIST,
  OAUTH_PROVIDER_CONFIGS,
  getOAuthProvider,
  type ConnectorType,
  type OAuthProvider,
} from '../../types.js';
import { getMCPServerConfig } from '../mcp-server-registry.js';

// isConnectorFunctional now resolves ids through composio-resources, which
// prefers this deployment's own config/composio-resources.json. The placeholder
// case below regresses a CATALOGUE id, and the real file has that toolkit
// provisioned — a pairing composio-resources-parity.test.ts makes impossible in
// this repo, so reading it here would only defeat the test. Resolution itself is
// covered by composio-resources.test.ts.
jest.mock('../composio-resources', () => ({
  composioAuthConfigId: (_s: string, baked: Record<string, string> | undefined, env: string) => baked?.[env],
  composioMcpServerId: (_s: string, baked: Record<string, string> | undefined, env: string) => baked?.[env],
  _resetComposioResourceCache: () => {},
}));


describe('CONNECTORS registry invariants', () => {
  it('has at least the core connector types', () => {
    for (const required of ['github', 'slack', 'salesforce', 'hubspot', 'google_sheets']) {
      expect(CONNECTORS[required]).toBeDefined();
    }
  });

  it('every entry has type matching its key', () => {
    for (const [key, connector] of Object.entries(CONNECTORS)) {
      expect(connector.type).toBe(key);
    }
  });

  it('coming_soon entries declare a statusReason', () => {
    for (const connector of Object.values(CONNECTORS)) {
      if (connector.status === 'coming_soon') {
        expect(connector.statusReason).toBeTruthy();
      }
    }
  });

  it('static_oauth auth entries declare client-id and client-secret env vars', () => {
    for (const connector of Object.values(CONNECTORS)) {
      if (connector.auth.kind === 'static_oauth') {
        expect(connector.auth.clientIdEnvVar).toBeTruthy();
        expect(connector.auth.clientSecretEnvVar).toBeTruthy();
        expect(connector.auth.authUrl).toMatch(/^https:\/\//);
        expect(connector.auth.tokenUrl).toMatch(/^https:\/\//);
      }
    }
  });

  it('dcr_oauth auth entries declare a discoveryBaseUrl', () => {
    for (const connector of Object.values(CONNECTORS)) {
      if (connector.auth.kind === 'dcr_oauth') {
        expect(connector.auth.discoveryBaseUrl).toMatch(/^https:\/\//);
      }
    }
  });

  // Regression guard: a dcr_oauth connector whose discovery host is NOT in
  // ALLOWED_DISCOVERY_DOMAINS fails "Connect" at the very first step —
  // resolveAuthServerUrl() throws ssrf_blocked before any fetch, surfacing as a
  // "failed to connect" toast. (This is exactly how the 6 GTM connectors
  // shipped dead: catalog + MCP allowlists were wired, but discovery.ts wasn't.)
  // We can only assert the *base* host offline; downstream auth-server hosts
  // (e.g. okta-login.zoominfo.com) still need manual allowlisting when a vendor
  // splits them — but the base check catches the common miss.
  it('every dcr_oauth discoveryBaseUrl host is in ALLOWED_DISCOVERY_DOMAINS', () => {
    const unallowed: string[] = [];
    for (const connector of Object.values(CONNECTORS)) {
      if (connector.auth.kind === 'dcr_oauth') {
        const probe = `${connector.auth.discoveryBaseUrl}/.well-known/oauth-protected-resource`;
        if (!isAllowedDiscoveryUrl(probe)) unallowed.push(`${connector.type} (${connector.auth.discoveryBaseUrl})`);
      }
    }
    expect(unallowed).toEqual([]);
  });

  it('sidecar MCP entries declare a path starting with /', () => {
    for (const connector of Object.values(CONNECTORS)) {
      if (connector.mcp?.kind === 'sidecar') {
        expect(connector.mcp.sidecarPath.startsWith('/')).toBe(true);
      }
    }
  });

  it('vendor_hosted MCP entries declare an https mcpUrl', () => {
    for (const connector of Object.values(CONNECTORS)) {
      if (connector.mcp?.kind === 'vendor_hosted') {
        expect(connector.mcp.mcpUrl).toMatch(/^https:\/\//);
      }
    }
  });
});

describe('Projections are consistent with the registry', () => {
  it('FUNCTIONAL_CONNECTOR_TYPES equals the set of effectively-available entries', () => {
    // A connector is "functional" when status === 'available' AND (for
    // Composio-managed entries) its resource IDs are no longer bootstrap
    // placeholders. The projection used to be a pure status filter — it
    // was widened to include the placeholder check so placeholder-broken
    // entries don't appear in the picker while still letting the catalog
    // ship inlined `<from-phase-0>` sentinels pre-bootstrap.
    const expected = new Set(
      Object.values(CONNECTORS).filter(isConnectorFunctional).map((c) => c.type),
    );
    expect(FUNCTIONAL_CONNECTOR_TYPES).toEqual(expected);
  });

  it('isConnectorFunctional rejects composio_managed entries with placeholder ids', () => {
    // All shipped Composio connectors are now bootstrapped, so we
    // synthesize a placeholder-equivalent entry to exercise the guard
    // that gates `effective status` on `<from-phase-0>` markers.
    const synthetic = {
      ...CONNECTORS.microsoft_dynamics!,
      status: 'available' as const,
      mcp: {
        ...(CONNECTORS.microsoft_dynamics!.mcp as { kind: 'composio_managed' }),
        kind: 'composio_managed' as const,
        toolkitSlug: 'dynamics365',
        authConfigIds: { dev: '<from-phase-0>', prod: '<from-phase-0>' },
        mcpServerIds: { dev: '<from-phase-0>', prod: '<from-phase-0>' },
        transport: 'streamable-http' as const,
      },
    };
    expect(isConnectorFunctional(synthetic)).toBe(false);
  });

  it('projected display names match each entry displayName', () => {
    for (const connector of Object.values(CONNECTORS)) {
      expect(PROJECTED_DISPLAY_NAMES[connector.type]).toBe(connector.displayName);
    }
  });

  it('capability map only includes effectively-functional connectors', () => {
    const map = buildCapabilityMap();
    for (const options of Object.values(map)) {
      for (const option of options) {
        const c = CONNECTORS[option.connectorType];
        expect(c).toBeDefined();
        expect(isConnectorFunctional(c!)).toBe(true);
      }
    }
  });

  it('catalog array is sorted by type', () => {
    const catalog = getConnectorCatalog();
    const sorted = [...catalog].sort((a, b) => a.type.localeCompare(b.type));
    expect(catalog).toEqual(sorted);
  });

  it('catalog version is stable across calls', () => {
    expect(computeCatalogVersion()).toBe(computeCatalogVersion());
  });
});

describe('types.ts compatibility — CONNECTOR_DISPLAY_NAMES matches registry', () => {
  it('every registry entry type is in the ConnectorType union (CONNECTOR_TYPES_LIST)', () => {
    const typeSet = new Set(CONNECTOR_TYPES_LIST);
    for (const connector of Object.values(CONNECTORS)) {
      expect(typeSet.has(connector.type as (typeof CONNECTOR_TYPES_LIST)[number])).toBe(true);
    }
  });

  it('CONNECTOR_DISPLAY_NAMES (types.ts) matches registry displayName for every registry entry', () => {
    for (const connector of Object.values(CONNECTORS)) {
      const type = connector.type as keyof typeof CONNECTOR_DISPLAY_NAMES;
      expect(CONNECTOR_DISPLAY_NAMES[type]).toBe(connector.displayName);
    }
  });
});

describe('Reverse completeness: ConnectorType union ⊆ CONNECTORS keys', () => {
  // Canonical list of connector types from the union. If this passes, every
  // `ConnectorType` literal has a matching registry entry — the union and
  // the registry cannot drift silently.
  it('every ConnectorType appears in CONNECTORS', () => {
    const registryTypes = new Set(Object.keys(CONNECTORS));
    const missing = CONNECTOR_TYPES_LIST.filter((t) => !registryTypes.has(t));
    expect(missing).toEqual([]);
  });

  it('every CONNECTORS entry type is a valid ConnectorType', () => {
    // Inverse: registry never declares a connector that isn't in the union.
    const unionTypes = new Set(CONNECTOR_TYPES_LIST as string[]);
    const orphans = Object.keys(CONNECTORS).filter((t) => !unionTypes.has(t));
    expect(orphans).toEqual([]);
  });
});

describe('OAUTH_PROVIDER_CONFIGS projection', () => {
  it('has an entry for every OAuth provider referenced by getOAuthProvider()', () => {
    const referencedProviders = new Set<OAuthProvider>();
    for (const connectorType of Object.keys(CONNECTORS) as ConnectorType[]) {
      const provider = getOAuthProvider(connectorType);
      if (provider) referencedProviders.add(provider);
    }
    for (const provider of referencedProviders) {
      expect(OAUTH_PROVIDER_CONFIGS[provider]).toBeDefined();
    }
  });

  it('maintains original per-provider shape for static providers', () => {
    // Sanity checks that the projection produces the shape existing tests
    // and routers expect — matching the old hand-written OAUTH_PROVIDER_CONFIGS.
    const github = OAUTH_PROVIDER_CONFIGS.github;
    expect(github.kind).toBe('static');
    if (github.kind === 'static') {
      expect(github.clientIdEnvVar).toBe('GITHUB_CLIENT_ID');
      expect(github.clientSecretEnvVar).toBe('GITHUB_CLIENT_SECRET');
      expect(github.authUrl).toContain('github.com');
    }
  });

  it('uses [] for provider scopes on multi-connector providers', () => {
    expect(OAUTH_PROVIDER_CONFIGS.google.scopes).toEqual([]);
    expect(OAUTH_PROVIDER_CONFIGS.atlassian.scopes).toEqual([]);
  });
});

describe('CATEGORY_DISPLAY_LABELS', () => {
  it('every category used in CONNECTORS has a display label', () => {
    const usedCategories = new Set(Object.values(CONNECTORS).map((c) => c.category));
    for (const cat of usedCategories) {
      expect(CATEGORY_DISPLAY_LABELS[cat]).toBeTruthy();
    }
  });

  it('no orphan labels (every key in the label map is a valid category)', () => {
    // Compile-time type enforces this already, but verify the runtime string
    // values are non-empty.
    for (const [category, label] of Object.entries(CATEGORY_DISPLAY_LABELS) as Array<[ConnectorCategory, string]>) {
      expect(category).toBeTruthy();
      expect(label).toBeTruthy();
      expect(label.length).toBeGreaterThan(2);
    }
  });
});

describe('MCP_SERVER_REGISTRY projection', () => {
  it('returns vendor-hosted config for connectors with mcp.kind=vendor_hosted', () => {
    const cfg = getMCPServerConfig('github');
    expect(cfg).not.toBeNull();
    expect(cfg!.isVendorHosted).toBe(true);
    expect(cfg!.mcpUrl).toBe('https://api.githubcopilot.com/mcp/');
  });

  it('resolves snowflake URL via URL_RESOLVERS.snowflake_account', () => {
    const cfg = getMCPServerConfig('snowflake', { accountIdentifier: 'acme' });
    expect(cfg?.mcpUrl).toBe('https://acme.snowflakecomputing.com/api/2.0/mcp');
  });

  it('resolves databricks URL via URL_RESOLVERS.databricks_workspace', () => {
    const cfg = getMCPServerConfig('databricks', { workspaceUrl: 'https://dbc-abc123.cloud.databricks.com' });
    expect(cfg?.mcpUrl).toBe('https://dbc-abc123.cloud.databricks.com/api/2.0/mcp/sql');
  });

  it('URL_RESOLVERS covers every urlResolverKey referenced in CONNECTORS', () => {
    for (const connector of Object.values(CONNECTORS)) {
      if (connector.mcp?.kind === 'vendor_hosted' && connector.mcp.urlResolverKey) {
        expect(URL_RESOLVERS[connector.mcp.urlResolverKey]).toBeDefined();
      }
    }
  });
});

describe('historyReads catalog invariants', () => {
  const connectors = Object.values(CONNECTORS).filter((c) => c.historyReads?.length);

  it('at least google_mail, linear, atlassian_jira, slack, zendesk have historyReads', () => {
    for (const required of ['google_mail', 'linear', 'atlassian_jira', 'slack', 'zendesk']) {
      expect(CONNECTORS[required]?.historyReads?.length).toBeGreaterThan(0);
    }
  });

  it('every historyReads entry has non-empty entityType, idDescription, and description', () => {
    for (const connector of connectors) {
      for (const h of connector.historyReads!) {
        expect(h.entityType).toBeTruthy();
        expect(h.idDescription).toBeTruthy();
        expect(h.description).toBeTruthy();
      }
    }
  });

  it('entityType values are lower_snake_case with no spaces', () => {
    for (const connector of connectors) {
      for (const h of connector.historyReads!) {
        expect(h.entityType).toMatch(/^[a-z][a-z0-9_]*$/);
      }
    }
  });

  it('getConnectorFunctions merges historyReads tools into the tool list', () => {
    // microsoft_teams has historyReads: [{ entityType: 'thread', ... }] and is
    // still a direct (non-composio_managed) connector, so getConnectorFunctions
    // returns the merged manual + history tools rather than [].
    const fns = getConnectorFunctions('microsoft_teams');
    const names = fns.map((f) => f.name);
    expect(names).toContain('read_thread');
    // read_thread must be category read and have id in schema
    const readThread = fns.find((f) => f.name === 'read_thread')!;
    expect(readThread.categories).toContain('read');
    expect(readThread.entityType).toBe('thread');
    expect(readThread.inputSchema.properties?.['id']).toBeDefined();
    expect(readThread.inputSchema.required).toContain('id');
  });

  it('getConnectorFunctions includes read_comments for linear', () => {
    const names = getConnectorFunctions('linear').map((f) => f.name);
    expect(names).toContain('read_comments');
  });

  it('getConnectorFunctions includes read_comments for zendesk', () => {
    const names = getConnectorFunctions('zendesk').map((f) => f.name);
    expect(names).toContain('read_comments');
  });

  it('getConnectorFunctions includes read_activity for salesforce', () => {
    const names = getConnectorFunctions('salesforce').map((f) => f.name);
    expect(names).toContain('read_activity');
  });

  it('getConnectorFunctions includes read_messages and read_thread for microsoft_teams', () => {
    const names = getConnectorFunctions('microsoft_teams').map((f) => f.name);
    expect(names).toContain('read_messages');
    expect(names).toContain('read_thread');
  });

  it('getConnectorFunctions returns the merged composio overlay for composio_managed connectors (post-C5)', () => {
    // Composio cutover-completion (C5): composio_managed connectors now
    // return the merged overlay set (vendor schemas + Liftoff stable names
    // + W1 tags), all stamped definitionSource='composio'. The tenant-
    // runtime stable-name router picks the dispatch path off that marker.
    const gmail = getConnectorFunctions('google_mail');
    expect(gmail.length).toBeGreaterThan(0);
    expect(gmail.every((f) => f.definitionSource === 'composio')).toBe(true);
    expect(gmail.map((f) => f.name)).toContain('list_messages');
    expect(gmail.map((f) => f.name)).toContain('mark_as_read');

    // slack uses native dispatch (own Slack app; see the
    // catalog entry comment) — its functions come from SLACK_FUNCTIONS again
    // and must NOT be stamped composio.
    const slack = getConnectorFunctions('slack');
    expect(slack.length).toBeGreaterThan(0);
    expect(slack.every((f) => f.definitionSource === 'composio')).toBe(false);

    const jira = getConnectorFunctions('atlassian_jira');
    expect(jira.length).toBeGreaterThan(0);
    expect(jira.every((f) => f.definitionSource === 'composio')).toBe(true);
  });

  it('getRegisteredConnectorTypes includes every connector with historyReads (composio_managed now included)', () => {
    const registered = new Set(getRegisteredConnectorTypes());
    for (const [type, connector] of Object.entries(CONNECTORS)) {
      if (!connector.historyReads?.length) continue;
      // Post-C5: composio_managed connectors are included (the boot merge
      // synthesizes their tool list from @liftoffos/composio-overlays).
      expect(registered.has(type)).toBe(true);
    }
  });

  it('no historyReads entry duplicates a manually registered function name', () => {
    for (const [connectorType, connector] of Object.entries(CONNECTORS)) {
      if (!connector.historyReads?.length) continue;
      const manual = getConnectorFunctions(connectorType).filter(
        (f) => !connector.historyReads!.some((h) => `read_${h.entityType}` === f.name),
      );
      const historyNames = new Set(connector.historyReads!.map((h) => `read_${h.entityType}`));
      for (const fn of manual) {
        expect(historyNames.has(fn.name)).toBe(false);
      }
    }
  });
});
