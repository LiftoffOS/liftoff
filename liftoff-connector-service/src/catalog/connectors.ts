// Unified connector catalog — single source of truth for connector metadata.
//
// Every connector that can appear in the product is defined here ONCE. The
// following derivations are projections of this registry (see
// src/catalog/projections.ts) and should NEVER be hand-maintained:
//
//   - FUNCTIONAL_CONNECTOR_TYPES         (filter: status === 'available')
//   - CONNECTOR_DISPLAY_NAMES            (map: type → displayName)
//   - Frontend catalog (/api/connectors/catalog response)
//   - platform-backend static fallback   (auto-generated via `npm run sync:connectors`)
//   - docs/CONNECTORS.md                 (auto-generated via `npm run gen:connector-docs`)
//
// DETAILED internal config (OAuth client-id env vars, MCP URLs, capability
// scope maps) continues to live alongside the code that owns it:
//
//   - OAUTH_PROVIDER_CONFIGS in src/types.ts (static + DCR flow details)
//   - MCP_SERVER_REGISTRY   in src/catalog/mcp-server-registry.ts (URLs, transports)
//   - CONNECTOR_CAPABILITIES in src/catalog/connector-capabilities.ts (capability → scopes)
//
// The `auth.kind` and `mcp.kind` here are high-level signals for the UI
// ("this connector uses static OAuth so show the connect button"), not the
// full implementation config.
//
// ── How to add a new connector ────────────────────────────────────────
//
// 1. Append an entry below. Set `status: 'coming_soon'` if prerequisites
//    (vendor OAuth app registration, MCP server publication, sidecar
//    implementation) are not yet in place.
// 2. If OAuth-based: add the full config to OAUTH_PROVIDER_CONFIGS in
//    src/types.ts and the scope map to connector-capabilities.ts if the
//    connector satisfies a capability.
// 3. If MCP-based: add the registry entry in mcp-server-registry.ts.
// 4. Run `npm run sync:connectors` in liftoff-platform-backend to refresh
//    the static fallback.
// 5. Run `npm run gen:connector-docs` here to refresh docs/CONNECTORS.md.
// 6. If the connector has `status: 'available'` and an `mcp` field: run
//    `npm run classify:tools -- --connector <type> --token <token>` to
//    classify its tools and generate a migration SQL. Paste the SQL into
//    a new migration in liftoff-platform-backend/migrations/.
//    Without this, all tools default to fail-secure (write+sensitive+destructive)
//    until first use — triggering HITL for every action.
// ──────────────────────────────────────────────────────────────────────

import type { ConnectorDef } from '@liftoffos/connector-types';

/**
 * Describes a history-reading capability for a connector.
 * Adding this to a connector's definition automatically generates a
 * `read_<entityType>` tool in the registry — no registry edits needed.
 *
 * To add history reading to a new connector:
 * 1. Add historyReads entry here (with entityType + description)
 * 2. Implement case '<entityType>' in the client's read() method
 * Done — the tool appears in the registry automatically.
 */
export interface ConnectorHistoryConfig {
  entityType: string;      // maps to client.read(entityType, id); tool named read_<entityType>
  idDescription: string;   // describes the id input field in the generated tool
  description: string;     // full tool description shown to the agent
}

// Local extension of the shared ConnectorDef — historyReads is connector-service internal.
/**
 * Keyless "customer grants IAM out-of-band, then we verify" auth (plan §3C/§5).
 * Not in the published @liftoffos/connector-types union yet, so it's widened
 * LOCALLY here — BigQuery (per-tenant SA impersonation) needs a catalog
 * auth.kind the connect UI routes to a grant→verify flow rather than OAuth or
 * the instant-connect `none`. The catalog is served as plain JSON, so the
 * frontend receives `{ kind: 'iam_grant' }` verbatim and dispatches on it.
 */
export interface IamGrantAuth {
  kind: 'iam_grant';
}

/**
 * An API a workspace described and connected from a conversation.
 *
 * Deliberately NOT `api_key`, even though the credential is one:
 * `apikey-router.test.ts` asserts that every available `api_key` connector
 * without an `mcp` has an `API_KEY_CONNECTOR_CONFIGS` entry, and this family
 * has no static form to put there — the fields only exist once an assistant
 * has read a particular provider's documentation.
 *
 * Widened LOCALLY the same way IamGrantAuth is, so the catalog can carry the
 * kind before @liftoffos/connector-types ships a release for it; the union in
 * `packages/connector-types/src/catalog.ts` carries it too, so the local
 * widening falls away on the next version bump.
 */
export interface CustomApiAuth {
  kind: 'custom_api';
}

/**
 * A polling row that can also say it delivers events through its OWN webhook.
 *
 * Widened LOCALLY, the same way IamGrantAuth is above, so the catalog can carry
 * the fact before the shared package ships a release for it. The catalog is
 * served as plain JSON, so consumers receive `nativeEventDelivery` verbatim.
 */
type LocalPollingConfig = NonNullable<ConnectorDef['polling']>[number] & {
  nativeEventDelivery?: boolean;
};

export interface LocalConnectorDef extends Omit<ConnectorDef, 'auth' | 'polling'> {
  auth: ConnectorDef['auth'] | IamGrantAuth | CustomApiAuth;
  polling?: LocalPollingConfig[];
  historyReads?: ConnectorHistoryConfig[];
  /** The platform ALSO serves this vendor on its own identity
   *  (`internal:<type>` in Execute), beside the workspace's own connection:
   *  a native executor with a platform key, a keyless lane or the x402
   *  wallet behind it. Implied for `status: 'internal'`; set explicitly on a
   *  card a workspace may connect while the platform keeps running the
   *  vendor for everyone else (strale, gloria). Connector-service internal,
   *  like historyReads. */
  platformServed?: boolean;
}

/**
 * All known connectors keyed by canonical type identifier. Order within
 * this map is preserved by Object.entries, so group connectors by
 * category for readability.
 */

// DocuSign demo and production are SEPARATE OAuth hosts, each with its own
// app + integration key. Liftoff-dev binds the demo app (account-d), prod binds
// the production app (account). The eSignature API base path is per-connection
// (credentials.instanceUrl from userinfo), so only the OAuth host is env-scoped.
const DOCUSIGN_OAUTH_HOST =
  (process.env.ENVIRONMENT ?? 'dev') === 'prod'
    ? 'https://account.docusign.com'
    : 'https://account-d.docusign.com';

export const CONNECTORS: Record<string, LocalConnectorDef> = {
  // ── CRM / Sales ──────────────────────────────────────────────────────
  salesforce: {
    type: 'salesforce',
    displayName: 'Salesforce CRM',
    category: 'crm_sales',
    objectsCovered: ['Leads', 'Contacts', 'Accounts', 'Opportunities', 'Cases', 'Tasks', 'Events', 'Campaigns'],
    status: 'available',
    // Composio-managed. A self-owned Connected App is a single point of failure:
    // if its consumer key stops resolving, login.salesforce.com AND
    // test.salesforce.com both answer invalid_client_id and the connect flow
    // dead-ends on Salesforce's own error page. Composio's managed OAuth app
    // removes the credential from our custody entirely, and its connection
    // takes a `subdomain`, so a customer's My Domain or a sandbox host is
    // handled rather than being a second way for this to break. The env vars below are the COMPOSIO_MANAGED sentinels every
    // composio_managed OAuth connector carries: the /start router branches on
    // mcp.kind BEFORE consulting auth, so they are never read.
    auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
      authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev',
      scopes: [], scopeDelimiter: ' ' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'salesforce',
      authConfigIds: { dev: 'ac_Qym9bT6F7lPY', prod: 'ac_wYOqBMurY-58' },
      mcpServerIds: { dev: 'aa0f0234-d299-4f48-85c5-d25d60b66d10', prod: 'f6962ce1-5896-4538-bed0-3ac6058fa944' },
      transport: 'streamable-http',
      // The Liftoff sidecar and SALESFORCE_FUNCTIONS are both kept, so
      // COMPOSIO_DISABLED_CONNECTORS=salesforce switches dispatch back. That is
      // temporary mitigation only (a Composio outage): per
      // docs/runbooks/CONNECTOR_SOURCE_FLIP.md the OAuth-init branch reads this
      // STATIC mcp.kind and ignores the env var, so Reconnect would still mint
      // the Composio authorize URL and no tenant could re-auth onto the sidecar.
      rollbackSidecar: { sidecarPath: '/salesforce', allowedEgressDomain: '*.salesforce.com' },
    },
    capabilities: [{ capability: 'crm', requiredScopes: [] }],
    historyReads: [
      { entityType: 'activity', idDescription: 'Salesforce record ID (Account, Contact, Lead, Opportunity, or Case)', description: 'Read all tasks and events related to a Salesforce record, giving the full activity history and correspondence log.' },
    ],
    polling: [
      { entityType: 'Lead', eventTopics: ['lead.created'], listImplemented: true },
      { entityType: 'Opportunity', eventTopics: ['opportunity.updated'], listImplemented: true },
      { entityType: 'Contact', eventTopics: ['contact.created', 'contact.updated'], listImplemented: true },
    ],
  },
  hubspot: {
    type: 'hubspot', displayName: 'HubSpot', category: 'crm_sales',
    objectsCovered: ['Contacts', 'Companies', 'Deals', 'Marketing Contacts', 'Campaigns', 'Forms'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'HUBSPOT_CLIENT_ID', clientSecretEnvVar: 'HUBSPOT_CLIENT_SECRET',
      authUrl: 'https://app.hubspot.com/oauth/authorize', tokenUrl: 'https://api.hubapi.com/oauth/v1/token',
      scopes: ['crm.objects.contacts.read', 'crm.objects.deals.read'], scopeDelimiter: ' ', requiresPkce: true },
    mcp: { kind: 'vendor_hosted', mcpUrl: 'https://mcp.hubspot.com', transport: 'sse' },
    capabilities: [
      { capability: 'crm', requiredScopes: ['crm.objects.contacts.read', 'crm.objects.deals.read'] },
      { capability: 'email_marketing', requiredScopes: ['crm.objects.contacts.read', 'marketing-email:read'] },
    ],
    polling: [
      { entityType: 'Contact', eventTopics: ['contact.created', 'contact.updated'], listImplemented: true },
      { entityType: 'Deal', eventTopics: ['deal.updated'], listImplemented: true },
      { entityType: 'Company', eventTopics: ['company.updated'], listImplemented: true },
    ],
  },
  pipedrive: {
    type: 'pipedrive', displayName: 'Pipedrive', category: 'crm_sales',
    objectsCovered: ['Deals', 'Contacts', 'Organizations', 'Activities'],
    status: 'available',
    // Composio-managed via API_KEY (user supplies their Pipedrive API token +
    // company domain); Composio has no managed OAuth app for Pipedrive.
    auth: { kind: 'api_key' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'pipedrive',
      authConfigIds: { dev: 'ac_T0KzpLv8ROob', prod: 'ac_tKG9QLMW4sf8' },
      mcpServerIds: { dev: '296088a4-ae1b-4566-a287-c07b97a65373', prod: 'ac6dc1b2-8424-4d56-8769-ed533c3676bf' },
      transport: 'streamable-http',
    },
    capabilities: [{ capability: 'crm', requiredScopes: ['deals:read', 'contacts:read'] }],
    polling: [
      { entityType: 'Deal', eventTopics: ['deal.updated'], listImplemented: true },
      { entityType: 'Contact', eventTopics: ['contact.created', 'contact.updated'], listImplemented: true },
    ],
  },
  outreach: {
    type: 'outreach', displayName: 'Outreach', category: 'crm_sales',
    objectsCovered: ['Sequences', 'Prospects', 'Accounts', 'Calls', 'Tasks'],
    status: 'coming_soon',
    statusReason: 'First-party MCP + DCR is fully wired (authorize URL + DCR registration supported); pending end-to-end validation against an Outreach account.',
    // First-party MCP (api.outreach.io/mcp) with DCR — replaces the never-built
    // sidecar. All auth-server metadata (registration/authorize/token) is
    // discovered from discoveryBaseUrl per docs/ADDING_A_CONNECTOR.md §4B.
    auth: { kind: 'dcr_oauth', discoveryBaseUrl: 'https://api.outreach.io',
      clientIdEnvVar: 'OUTREACH_CLIENT_ID', clientSecretEnvVar: 'OUTREACH_CLIENT_SECRET',
      scopes: [], scopeDelimiter: ' ' },
    mcp: { kind: 'vendor_hosted', mcpUrl: 'https://api.outreach.io/mcp/', transport: 'streamable-http' },
    capabilities: [{ capability: 'crm', requiredScopes: [] }],
  },
  salesloft: {
    type: 'salesloft', displayName: 'Salesloft', category: 'crm_sales',
    objectsCovered: ['Cadences', 'People', 'Accounts', 'Activities', 'Calls'],
    // First-party MCP (mcp.salesloft.com/mcp) with DCR. The authorization server is
    // accounts.salesloft.com/mcp — a path-bearing issuer, which authServerMetadataUrls
    // handles. Only *:read scopes are advertised, so every tool is a read.
    // Registration answers 400 invalid_redirect_uri
    // "redirect_uris must belong to an allowed domain" — Salesloft allowlists callback
    // domains per client. Flip to available once this deployment's domain is on that allowlist.
    status: 'coming_soon',
    statusReason: 'Salesloft MCP dynamic client registration rejects OAuth callback domains it has not allowlisted: the registration endpoint returns invalid_redirect_uri "redirect_uris must belong to an allowed domain". Requires Salesloft to allowlist the OAuth callback domain of this deployment.',
    auth: { kind: 'dcr_oauth', discoveryBaseUrl: 'https://mcp.salesloft.com',
      clientIdEnvVar: 'SALESLOFT_CLIENT_ID', clientSecretEnvVar: 'SALESLOFT_CLIENT_SECRET',
      scopes: ['accounts:read', 'conversations:read', 'opportunities:read', 'people:read', 'team:read'],
      scopeDelimiter: ' ' },
    mcp: { kind: 'vendor_hosted', mcpUrl: 'https://mcp.salesloft.com/mcp', transport: 'streamable-http' },
    capabilities: [{ capability: 'crm', requiredScopes: ['people:read'] }],
    polling: [{ entityType: 'Person', eventTopics: ['contact.created', 'contact.updated'], listImplemented: false }],
  },
  // ── GTM / market intelligence (vendor-hosted MCP + DCR; docs/ADDING_A_CONNECTOR.md §4B) ──
  zoominfo: {
    type: 'zoominfo', displayName: 'ZoomInfo', category: 'crm_sales',
    objectsCovered: ['Companies', 'Contacts', 'Intent', 'Scoops'],
    // ZoomInfo's MCP OAuth is NOT open dynamic client registration. Its /oauth/register
    // gates on an approved-vendor allowlist: BOTH the client_name AND the redirect_uri
    // must be pre-whitelisted by ZoomInfo. Verified: client_name "Liftoff"
    // (and "Claude Code", "ZoomInfo MCP") → 400 "vendor not found in approved vendors";
    // only "Claude" clears the name check, then fails on redirect_uri. The anthropics/
    // knowledge-work-plugins repo connects only because it runs inside Claude, which
    // Anthropic has a standing vendor agreement with ZoomInfo for. To make this live,
    // Liftoff must be whitelisted by ZoomInfo (partner/vendor onboarding), after which:
    // flip status→available AND relax the RFC-8414 issuer check in oauth/discovery.ts
    // (ZoomInfo serves AS metadata at mcp.zoominfo.com but declares issuer
    // okta-login.zoominfo.com — the strict origin==issuer check rejects it today).
    status: 'coming_soon',
    statusReason: 'ZoomInfo gates MCP OAuth behind an approved-vendor allowlist (client_name + redirect_uri must be whitelisted by ZoomInfo; open DCR returns "vendor not found"). Requires ZoomInfo vendor/partner onboarding for Liftoff.',
    auth: { kind: 'dcr_oauth', discoveryBaseUrl: 'https://mcp.zoominfo.com',
      clientIdEnvVar: 'ZOOMINFO_CLIENT_ID', clientSecretEnvVar: 'ZOOMINFO_CLIENT_SECRET',
      scopes: [], scopeDelimiter: ' ' },
    mcp: { kind: 'vendor_hosted', mcpUrl: 'https://mcp.zoominfo.com/mcp', transport: 'streamable-http' },
    capabilities: [{ capability: 'crm', requiredScopes: [] }],
  },
  common_room: {
    type: 'common_room', displayName: 'Common Room', category: 'crm_sales',
    objectsCovered: ['Contacts', 'Organizations', 'Activities', 'Segments', 'Signals'],
    status: 'coming_soon',
    statusReason: 'Common Room has no self-serve signup — access is sales-gated; validation requires a sales-provisioned account.',
    auth: { kind: 'dcr_oauth', discoveryBaseUrl: 'https://mcp.commonroom.io',
      clientIdEnvVar: 'COMMON_ROOM_CLIENT_ID', clientSecretEnvVar: 'COMMON_ROOM_CLIENT_SECRET',
      scopes: [], scopeDelimiter: ' ' },
    mcp: { kind: 'vendor_hosted', mcpUrl: 'https://mcp.commonroom.io/mcp', transport: 'streamable-http' },
    capabilities: [{ capability: 'crm', requiredScopes: [] }],
  },
  similarweb: {
    type: 'similarweb', displayName: 'Similarweb', category: 'marketing_comms',
    objectsCovered: ['Website Traffic', 'Rankings', 'Keywords', 'Competitors', 'Audience'],
    status: 'coming_soon',
    statusReason: 'Similarweb grants no API access on the free trial — a paid plan is required for any API/MCP access (same posture as ZoomInfo); validation requires a paid account.',
    auth: { kind: 'dcr_oauth', discoveryBaseUrl: 'https://mcp.similarweb.com',
      clientIdEnvVar: 'SIMILARWEB_CLIENT_ID', clientSecretEnvVar: 'SIMILARWEB_CLIENT_SECRET',
      scopes: [], scopeDelimiter: ' ' },
    mcp: { kind: 'vendor_hosted', mcpUrl: 'https://mcp.similarweb.com/mcp', transport: 'streamable-http' },
    // SEO / competitive-intel has no existing capability analog — left untagged
    // per docs/ADDING_A_CONNECTOR.md §5.2 (add a new capability if a tile is wanted).
  },
  ahrefs: {
    type: 'ahrefs', displayName: 'Ahrefs', category: 'marketing_comms',
    objectsCovered: ['Backlinks', 'Referring Domains', 'Keywords', 'Domain Rating', 'Rank Tracker'],
    status: 'coming_soon',
    statusReason: 'Requires a paid Ahrefs subscription for API/MCP access; pending end-to-end validation with a paid account.',
    auth: { kind: 'dcr_oauth', discoveryBaseUrl: 'https://api.ahrefs.com',
      clientIdEnvVar: 'AHREFS_CLIENT_ID', clientSecretEnvVar: 'AHREFS_CLIENT_SECRET',
      scopes: [], scopeDelimiter: ' ' },
    mcp: { kind: 'vendor_hosted', mcpUrl: 'https://api.ahrefs.com/mcp/mcp', transport: 'streamable-http' },
  },
  supermetrics: {
    type: 'supermetrics', displayName: 'Supermetrics', category: 'marketing_comms',
    objectsCovered: ['Data Sources', 'Accounts', 'Fields', 'Marketing Metrics'],
    status: 'coming_soon',
    statusReason: 'Requires a paid Supermetrics plan for API access; pending end-to-end validation with a paid account.',
    auth: { kind: 'dcr_oauth', discoveryBaseUrl: 'https://mcp.supermetrics.com',
      clientIdEnvVar: 'SUPERMETRICS_CLIENT_ID', clientSecretEnvVar: 'SUPERMETRICS_CLIENT_SECRET',
      scopes: [], scopeDelimiter: ' ' },
    mcp: { kind: 'vendor_hosted', mcpUrl: 'https://mcp.supermetrics.com/mcp', transport: 'streamable-http' },
  },
  // ── Marketing: vendor-hosted MCP + DCR (docs/ADDING_A_CONNECTOR.md §4B) ──
  klaviyo: {
    type: 'klaviyo', displayName: 'Klaviyo', category: 'marketing_comms',
    objectsCovered: ['Profiles', 'Lists', 'Segments', 'Campaigns', 'Flows', 'Metrics'],
    status: 'available',
    auth: { kind: 'dcr_oauth', discoveryBaseUrl: 'https://mcp.klaviyo.com',
      clientIdEnvVar: 'KLAVIYO_CLIENT_ID', clientSecretEnvVar: 'KLAVIYO_CLIENT_SECRET',
      scopes: [], scopeDelimiter: ' ' },
    mcp: { kind: 'vendor_hosted', mcpUrl: 'https://mcp.klaviyo.com/mcp', transport: 'streamable-http' },
    capabilities: [{ capability: 'email_marketing', requiredScopes: [] }],
  },
  kit: {
    type: 'kit', displayName: 'Kit', category: 'marketing_comms',
    objectsCovered: ['Subscribers', 'Tags', 'Forms', 'Sequences', 'Broadcasts'],
    status: 'available',
    // Protected-resource metadata at app.kit.com names api.kit.com as the authorization
    // server; authorize, token and register all live on app.kit.com.
    auth: { kind: 'dcr_oauth', discoveryBaseUrl: 'https://app.kit.com',
      clientIdEnvVar: 'KIT_CLIENT_ID', clientSecretEnvVar: 'KIT_CLIENT_SECRET',
      scopes: ['public'], scopeDelimiter: ' ' },
    mcp: { kind: 'vendor_hosted', mcpUrl: 'https://app.kit.com/mcp', transport: 'streamable-http' },
    capabilities: [{ capability: 'email_marketing', requiredScopes: ['public'] }],
  },
  omnisend: {
    type: 'omnisend', displayName: 'Omnisend', category: 'marketing_comms',
    objectsCovered: ['Contacts', 'Campaigns', 'Automations', 'Segments', 'Reports'],
    // app.omnisend.com/oauth/register answers
    // 400 invalid_client_metadata "unknown application: Liftoff" — registration is
    // gated on a client_name Omnisend has approved (the zoominfo shape). Flip to
    // available once Omnisend has allowlisted the Liftoff client.
    status: 'coming_soon',
    statusReason: 'Omnisend gates MCP dynamic client registration on an approved application name: the registration endpoint returns invalid_client_metadata "unknown application: Liftoff". Requires Omnisend to allowlist the Liftoff client.',
    // The metadata served at mcp.omnisend.com declares issuer app.omnisend.com; the
    // expected issuer is pinned in oauth/discovery.ts. The server exposes four meta-tools
    // (search / tool_schema / tool_documentation / execute); classification is per
    // execute operation (see the vendor-mcp inventory).
    auth: { kind: 'dcr_oauth', discoveryBaseUrl: 'https://mcp.omnisend.com',
      clientIdEnvVar: 'OMNISEND_CLIENT_ID', clientSecretEnvVar: 'OMNISEND_CLIENT_SECRET',
      scopes: ['contacts.read', 'contacts.write', 'campaigns.read', 'automations.read', 'segments.read',
        'reports.read', 'analytics.read', 'products.read', 'events.write', 'forms.read'],
      scopeDelimiter: ' ' },
    mcp: { kind: 'vendor_hosted', mcpUrl: 'https://mcp.omnisend.com/mcp', transport: 'streamable-http' },
    capabilities: [{ capability: 'email_marketing', requiredScopes: ['contacts.read', 'campaigns.read'] }],
  },
  amplitude: {
    type: 'amplitude', displayName: 'Amplitude', category: 'data',
    objectsCovered: ['Charts', 'Cohorts', 'Events', 'Dashboards', 'Experiments'],
    status: 'available',
    auth: { kind: 'dcr_oauth', discoveryBaseUrl: 'https://mcp.amplitude.com',
      clientIdEnvVar: 'AMPLITUDE_CLIENT_ID', clientSecretEnvVar: 'AMPLITUDE_CLIENT_SECRET',
      scopes: ['mcp:read', 'mcp:write', 'offline_access'], scopeDelimiter: ' ' },
    mcp: { kind: 'vendor_hosted', mcpUrl: 'https://mcp.amplitude.com/mcp', transport: 'streamable-http' },
    capabilities: [{ capability: 'product_analytics', requiredScopes: ['mcp:read'] }],
  },
  pendo: {
    type: 'pendo', displayName: 'Pendo', category: 'data',
    objectsCovered: ['Visitors', 'Accounts', 'Segments', 'Pages', 'Features', 'Guides'],
    status: 'available',
    // US data centre only: EU, US1 and JP subscriptions use other hostnames and
    // VendorHostedMcp has no region resolver beyond snowflake/databricks. A subscription
    // admin must enable the MCP under Subscription settings > AI access first.
    auth: { kind: 'dcr_oauth', discoveryBaseUrl: 'https://app.pendo.io',
      clientIdEnvVar: 'PENDO_CLIENT_ID', clientSecretEnvVar: 'PENDO_CLIENT_SECRET',
      scopes: [], scopeDelimiter: ' ' },
    mcp: { kind: 'vendor_hosted', mcpUrl: 'https://app.pendo.io/mcp/v0/shttp', transport: 'streamable-http' },
    capabilities: [{ capability: 'product_analytics', requiredScopes: [] }],
  },
  webflow: {
    type: 'webflow', displayName: 'Webflow', category: 'marketing_comms',
    objectsCovered: ['Sites', 'Pages', 'CMS Collections', 'Forms', 'Analytics'],
    status: 'available',
    auth: { kind: 'dcr_oauth', discoveryBaseUrl: 'https://mcp.webflow.com',
      clientIdEnvVar: 'WEBFLOW_CLIENT_ID', clientSecretEnvVar: 'WEBFLOW_CLIENT_SECRET',
      scopes: [], scopeDelimiter: ' ' },
    mcp: { kind: 'vendor_hosted', mcpUrl: 'https://mcp.webflow.com/mcp', transport: 'streamable-http' },
    capabilities: [{ capability: 'cms', requiredScopes: [] }],
  },
  typefully: {
    type: 'typefully', displayName: 'Typefully', category: 'marketing_comms',
    objectsCovered: ['Drafts', 'Social Sets', 'Queue', 'Analytics', 'Comments'],
    status: 'available',
    auth: { kind: 'dcr_oauth', discoveryBaseUrl: 'https://mcp.typefully.com',
      clientIdEnvVar: 'TYPEFULLY_CLIENT_ID', clientSecretEnvVar: 'TYPEFULLY_CLIENT_SECRET',
      scopes: ['full_access'], scopeDelimiter: ' ' },
    mcp: { kind: 'vendor_hosted', mcpUrl: 'https://mcp.typefully.com/mcp', transport: 'streamable-http' },
    capabilities: [{ capability: 'social_media', requiredScopes: ['full_access'] }],
  },
  crustdata: {
    type: 'crustdata', displayName: 'Crustdata', category: 'crm_sales',
    objectsCovered: ['Companies', 'People', 'Jobs', 'Social Posts', 'Watchers'],
    status: 'available',
    // docs.crustdata.com/for-agents/mcp documents install.crustdata.com; the server is
    // code-mode (execute / list_tools / get_schema), so execute is classified as a write.
    auth: { kind: 'dcr_oauth', discoveryBaseUrl: 'https://install.crustdata.com',
      clientIdEnvVar: 'CRUSTDATA_CLIENT_ID', clientSecretEnvVar: 'CRUSTDATA_CLIENT_SECRET',
      scopes: [], scopeDelimiter: ' ' },
    mcp: { kind: 'vendor_hosted', mcpUrl: 'https://install.crustdata.com/mcp', transport: 'streamable-http' },
    capabilities: [{ capability: 'enrichment', requiredScopes: [] }],
  },
  tapfiliate: {
    type: 'tapfiliate', displayName: 'Tapfiliate', category: 'marketing_comms',
    objectsCovered: ['Affiliates', 'Conversions', 'Commissions', 'Programs', 'Payments'],
    // The registration endpoint answers 400
    // invalid_client_metadata "redirect_uri is not allowed" for our callback —
    // Tapfiliate allowlists redirect URIs per client. Flip to available once
    // <this deployment>/api/connectors/oauth/callback (and the dev one) are allowlisted.
    status: 'coming_soon',
    statusReason: 'Tapfiliate MCP dynamic client registration rejects the OAuth callback: the registration endpoint returns invalid_client_metadata "redirect_uri is not allowed". Requires Tapfiliate to allowlist the Liftoff callback URI.',
    // Metadata at mcp.tapfiliate.com declares issuer api.tapfiliate.com; authorize and
    // register live on app.tapfiliate.com. Expected issuer pinned in oauth/discovery.ts.
    auth: { kind: 'dcr_oauth', discoveryBaseUrl: 'https://mcp.tapfiliate.com',
      clientIdEnvVar: 'TAPFILIATE_CLIENT_ID', clientSecretEnvVar: 'TAPFILIATE_CLIENT_SECRET',
      scopes: ['affiliates', 'conversions_commissions', 'programs', 'payments'], scopeDelimiter: ' ' },
    mcp: { kind: 'vendor_hosted', mcpUrl: 'https://mcp.tapfiliate.com/mcp', transport: 'streamable-http' },
    capabilities: [{ capability: 'partner_management', requiredScopes: ['affiliates', 'conversions_commissions'] }],
  },
  partnerstack: {
    type: 'partnerstack', displayName: 'PartnerStack', category: 'marketing_comms',
    objectsCovered: ['Partnerships', 'Customers', 'Leads', 'Deals', 'Transactions', 'Rewards'],
    status: 'available',
    auth: { kind: 'dcr_oauth', discoveryBaseUrl: 'https://mcp.partnerstack.com',
      clientIdEnvVar: 'PARTNERSTACK_CLIENT_ID', clientSecretEnvVar: 'PARTNERSTACK_CLIENT_SECRET',
      scopes: ['partnership:read', 'customer:read', 'customer:write', 'lead:read', 'lead:write', 'deal:read',
        'transaction:read', 'reward:read', 'analytics:read', 'link:read', 'group:read', 'profile'],
      scopeDelimiter: ' ' },
    mcp: { kind: 'vendor_hosted', mcpUrl: 'https://mcp.partnerstack.com/mcp', transport: 'streamable-http' },
    capabilities: [{ capability: 'partner_management', requiredScopes: ['partnership:read', 'customer:read'] }],
  },
  crossbeam: {
    type: 'crossbeam', displayName: 'Crossbeam', category: 'marketing_comms',
    objectsCovered: ['Partners', 'Overlaps', 'Populations', 'Reports'],
    status: 'available',
    auth: { kind: 'dcr_oauth', discoveryBaseUrl: 'https://mcp.crossbeam.com',
      clientIdEnvVar: 'CROSSBEAM_CLIENT_ID', clientSecretEnvVar: 'CROSSBEAM_CLIENT_SECRET',
      scopes: [], scopeDelimiter: ' ' },
    mcp: { kind: 'vendor_hosted', mcpUrl: 'https://mcp.crossbeam.com/mcp', transport: 'streamable-http' },
    capabilities: [{ capability: 'partner_management', requiredScopes: [] }],
  },
  paddle: {
    type: 'paddle', displayName: 'Paddle', category: 'finance',
    objectsCovered: ['Products', 'Prices', 'Customers', 'Subscriptions', 'Transactions', 'Reports'],
    status: 'available',
    // Authorization server is id.paddle.com. Code-mode server (search / execute /
    // report_missing_tool): execute is classified as a financial write on every call.
    // The open-source stdio package (PaddleHQ/paddle-mcp-server) exposes one tool per
    // API operation instead; the hosted server this entry points at does not, so the
    // HITL seed follows the hosted surface and treats the package as a cross-check.
    auth: { kind: 'dcr_oauth', discoveryBaseUrl: 'https://mcp.paddle.com',
      clientIdEnvVar: 'PADDLE_CLIENT_ID', clientSecretEnvVar: 'PADDLE_CLIENT_SECRET',
      scopes: [], scopeDelimiter: ' ' },
    mcp: { kind: 'vendor_hosted', mcpUrl: 'https://mcp.paddle.com/mcp', transport: 'streamable-http' },
    capabilities: [{ capability: 'e_commerce', requiredScopes: [] }],
  },
  snov: {
    type: 'snov', displayName: 'Snov.io', category: 'crm_sales',
    objectsCovered: ['Prospects', 'Email Verification', 'Campaigns', 'Lists'],
    status: 'available',
    auth: { kind: 'dcr_oauth', discoveryBaseUrl: 'https://mcp.snov.io',
      clientIdEnvVar: 'SNOV_CLIENT_ID', clientSecretEnvVar: 'SNOV_CLIENT_SECRET',
      scopes: ['mcp'], scopeDelimiter: ' ' },
    mcp: { kind: 'vendor_hosted', mcpUrl: 'https://mcp.snov.io/mcp', transport: 'streamable-http' },
    capabilities: [{ capability: 'enrichment', requiredScopes: ['mcp'] }],
  },
  sparktoro: {
    type: 'sparktoro', displayName: 'SparkToro', category: 'marketing_comms',
    objectsCovered: ['Audience Reports', 'Demographics', 'Websites', 'Podcasts', 'Social'],
    status: 'available',
    auth: { kind: 'dcr_oauth', discoveryBaseUrl: 'https://mcp.sparktoro.com',
      clientIdEnvVar: 'SPARKTORO_CLIENT_ID', clientSecretEnvVar: 'SPARKTORO_CLIENT_SECRET',
      scopes: ['mcp'], scopeDelimiter: ' ' },
    mcp: { kind: 'vendor_hosted', mcpUrl: 'https://mcp.sparktoro.com/mcp', transport: 'streamable-http' },
    capabilities: [{ capability: 'web_research', requiredScopes: ['mcp'] }],
  },
  livestorm: {
    type: 'livestorm', displayName: 'Livestorm', category: 'marketing_comms',
    objectsCovered: ['Events', 'Sessions', 'People', 'Registrations'],
    status: 'available',
    // The workspace's Public API must be enabled by Livestorm support before the MCP answers.
    auth: { kind: 'dcr_oauth', discoveryBaseUrl: 'https://mcp.livestorm.co',
      clientIdEnvVar: 'LIVESTORM_CLIENT_ID', clientSecretEnvVar: 'LIVESTORM_CLIENT_SECRET',
      scopes: ['full:read', 'full:write'], scopeDelimiter: ' ' },
    mcp: { kind: 'vendor_hosted', mcpUrl: 'https://mcp.livestorm.co/mcp', transport: 'streamable-http' },
  },
  coupler: {
    type: 'coupler', displayName: 'Coupler.io', category: 'data',
    objectsCovered: ['Data Flows', 'Datasets', 'Reports'],
    // Authorization server is auth.coupler.io. The vendor labels the server alpha.
    // Registration answers 400 invalid_redirect_uri
    // "Redirect uri is invalid" for our callback — Coupler allowlists redirect URIs.
    // Flip to available once the Liftoff callback URI is allowlisted.
    status: 'coming_soon',
    statusReason: 'Coupler.io MCP dynamic client registration rejects the OAuth callback: the registration endpoint returns invalid_redirect_uri "Redirect uri is invalid". Requires Coupler.io to allowlist the Liftoff callback URI.',
    auth: { kind: 'dcr_oauth', discoveryBaseUrl: 'https://mcp.coupler.io',
      clientIdEnvVar: 'COUPLER_CLIENT_ID', clientSecretEnvVar: 'COUPLER_CLIENT_SECRET',
      scopes: ['mcp'], scopeDelimiter: ' ' },
    mcp: { kind: 'vendor_hosted', mcpUrl: 'https://mcp.coupler.io/mcp', transport: 'streamable-http' },
  },
  keywords_everywhere: {
    type: 'keywords_everywhere', displayName: 'Keywords Everywhere', category: 'marketing_comms',
    objectsCovered: ['Keyword Metrics', 'Related Keywords', 'Domain Keywords', 'Backlinks', 'Traffic'],
    status: 'available',
    auth: { kind: 'dcr_oauth', discoveryBaseUrl: 'https://mcp.keywordseverywhere.com',
      clientIdEnvVar: 'KEYWORDS_EVERYWHERE_CLIENT_ID', clientSecretEnvVar: 'KEYWORDS_EVERYWHERE_CLIENT_SECRET',
      scopes: ['default'], scopeDelimiter: ' ' },
    mcp: { kind: 'vendor_hosted', mcpUrl: 'https://mcp.keywordseverywhere.com/mcp', transport: 'streamable-http' },
    capabilities: [{ capability: 'seo', requiredScopes: ['default'] }],
  },
  // ── Marketing: vendor-hosted MCP + API key (sentry precedent) ──
  tolt: {
    type: 'tolt', displayName: 'Tolt', category: 'marketing_comms',
    objectsCovered: ['Programs', 'Partners', 'Customers', 'Transactions', 'Commissions', 'Links'],
    status: 'available',
    auth: { kind: 'api_key' },
    // The MCP is served at the host root; /mcp is a 404. The dashboard API key goes as Bearer.
    mcp: { kind: 'vendor_hosted', mcpUrl: 'https://mcp.tolt.com/', transport: 'streamable-http' },
    capabilities: [{ capability: 'partner_management', requiredScopes: [] }],
  },
  // ── Marketing: vendor-hosted MCP + DCR, awaiting vendor-side allowlisting (zoominfo precedent) ──
  demandbase: {
    type: 'demandbase', displayName: 'Demandbase', category: 'crm_sales',
    objectsCovered: ['Accounts', 'People', 'Intent', 'Buying Groups', 'Account Briefs'],
    // developer.demandbase.com/docs/custom-mcp-clients: Demandbase Support must allowlist the
    // exact redirect URI for our client_id and enable MCP on the tenant. The AS metadata at
    // gateway.demandbase.com declares issuer authentication.demandbase.com/oauth2/aus7fu7m8kDj90Z532p7
    // (pinned in oauth/discovery.ts). Flip to available once the callback is allowlisted.
    status: 'coming_soon',
    statusReason: 'Demandbase MCP requires Demandbase Support to allowlist the OAuth redirect URI per client id and to enable MCP on the tenant.',
    auth: { kind: 'dcr_oauth', discoveryBaseUrl: 'https://gateway.demandbase.com',
      clientIdEnvVar: 'DEMANDBASE_CLIENT_ID', clientSecretEnvVar: 'DEMANDBASE_CLIENT_SECRET',
      scopes: ['openid', 'profile', 'email', 'offline_access'], scopeDelimiter: ' ' },
    mcp: { kind: 'vendor_hosted', mcpUrl: 'https://gateway.demandbase.com/mcp/servers/db-mcp', transport: 'streamable-http' },
    capabilities: [{ capability: 'crm', requiredScopes: [] }, { capability: 'enrichment', requiredScopes: [] }],
  },
  // ── Marketing: Composio-managed (docs/ADDING_A_CONNECTOR.md §4A) ──
  google_analytics: {
    type: 'google_analytics', displayName: 'Google Analytics', category: 'data',
    objectsCovered: ['Accounts', 'Properties', 'Reports', 'Audiences', 'Key Events'],
    // Composio's verified Google app carries the analytics scopes; Liftoff's own Google app
    // would need the sensitive-scope review (same reasoning as google_ads).
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
      authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev', scopes: [], scopeDelimiter: ' ' },
    mcp: { kind: 'composio_managed', toolkitSlug: 'google_analytics',
      authConfigIds: { dev: 'ac_RPHLbvEAuj07', prod: 'ac_6jiu1ADesFuM' },
      mcpServerIds: { dev: 'dbcf9186-c2eb-47ed-a67c-1528d67cac59', prod: '3f78f591-4ed2-4b12-a855-2f159681b8dc' },
      transport: 'streamable-http' },
    capabilities: [{ capability: 'web_analytics', requiredScopes: [] }],
    multiInstance: true,
  },
  google_search_console: {
    type: 'google_search_console', displayName: 'Google Search Console', category: 'marketing_comms',
    objectsCovered: ['Sites', 'Search Analytics', 'Sitemaps', 'URL Inspection'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
      authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev', scopes: [], scopeDelimiter: ' ' },
    mcp: { kind: 'composio_managed', toolkitSlug: 'google_search_console',
      authConfigIds: { dev: 'ac_EN1NHW_XDo5J', prod: 'ac_yeXFUEbd7RAQ' },
      mcpServerIds: { dev: 'd33dd379-488d-4bf0-b091-f4919d95ded4', prod: '97bfdd7a-d235-4a10-ac49-0a639a5f1aeb' },
      transport: 'streamable-http' },
    capabilities: [{ capability: 'seo', requiredScopes: [] }],
    multiInstance: true,
  },
  reddit_ads: {
    type: 'reddit_ads', displayName: 'Reddit Ads', category: 'marketing_comms',
    objectsCovered: ['Campaigns', 'Ad Groups', 'Ads', 'Audiences', 'Reports'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
      authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev', scopes: [], scopeDelimiter: ' ' },
    mcp: { kind: 'composio_managed', toolkitSlug: 'reddit_ads',
      authConfigIds: { dev: 'ac_74Epas_ObQel', prod: 'ac_xD75RFm6U9ux' },
      mcpServerIds: { dev: 'a356baaa-10fc-48d1-bfc9-f99507a3bbeb', prod: '8f54cf03-b48a-4297-a685-5d4388bd442e' },
      transport: 'streamable-http' },
    capabilities: [{ capability: 'advertising', requiredScopes: [] }],
    multiInstance: true,
  },
  plausible: {
    type: 'plausible', displayName: 'Plausible Analytics', category: 'data',
    objectsCovered: ['Sites', 'Stats', 'Goals', 'Realtime Visitors'],
    status: 'available',
    auth: { kind: 'api_key' },
    mcp: { kind: 'composio_managed', toolkitSlug: 'plausible_analytics',
      authConfigIds: { dev: 'ac_xWDizPr8yfN-', prod: 'ac_fLFBP3l0KEXy' },
      mcpServerIds: { dev: '6d8a2351-bd8b-4af0-8bff-25ed20faeaef', prod: '70c49a4b-1df6-475f-be71-3e6cc4ea701b' },
      transport: 'streamable-http' },
    capabilities: [{ capability: 'web_analytics', requiredScopes: [] }],
  },
  dataforseo: {
    type: 'dataforseo', displayName: 'DataForSEO', category: 'marketing_comms',
    objectsCovered: ['Keywords', 'SERP', 'Backlinks', 'On-Page Audits', 'Traffic Estimates'],
    // The vendor's own MCP authenticates with HTTP Basic and the tool gateway sends only a
    // Bearer, so the Composio toolkit (BASIC login/password) is the route.
    status: 'available',
    auth: { kind: 'api_key' },
    mcp: { kind: 'composio_managed', toolkitSlug: 'dataforseo',
      authConfigIds: { dev: 'ac_owZK36JF5knf', prod: 'ac_m0AVFO5K4ldc' },
      mcpServerIds: { dev: '1bf94e36-36bc-4b2e-9fca-33a64b8c2b15', prod: '16dd1c8f-ddde-4fd0-a353-b5e8900777bb' },
      transport: 'streamable-http' },
    capabilities: [{ capability: 'seo', requiredScopes: [] }],
  },
  apollo: {
    type: 'apollo', displayName: 'Apollo.io', category: 'crm_sales',
    objectsCovered: ['Contacts', 'Accounts', 'Sequences', 'Emails', 'Calls'],
    status: 'available',
    // Composio-managed via API_KEY (user supplies their Apollo API key).
    auth: { kind: 'api_key' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'apollo',
      authConfigIds: { dev: 'ac_K5-IUQcKf3-2', prod: 'ac_g5LdauZ3rOYV' },
      mcpServerIds: { dev: 'e8da9ea0-26ba-47d7-827e-fd909a867bc1', prod: 'e45332bc-a1ef-4cb5-94d6-717a2a07ff8c' },
      transport: 'streamable-http',
    },
    capabilities: [{ capability: 'crm', requiredScopes: [] }, { capability: 'enrichment', requiredScopes: [] }],
    polling: [{ entityType: 'Contact', eventTopics: ['contact.created', 'contact.updated'], listImplemented: true }],
  },
  gong: {
    type: 'gong', displayName: 'Gong', category: 'crm_sales',
    objectsCovered: ['Calls', 'Deals', 'Insights', 'Transcripts', 'Stats'],
    status: 'available',
    // These env vars are unused for Composio-managed connectors but the
    // ConnectorAuth type requires them. Set to sentinel values; the OAuth
    // router branches on mcp.kind === 'composio_managed' BEFORE consulting
    // auth, so they're never read.
    auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
      authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev',
      scopes: [], scopeDelimiter: ' ' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'gong',
      authConfigIds: { dev: 'ac_lWSCtGz9RYQJ', prod: 'ac_8T3jmjka6zCL' },
      mcpServerIds: { dev: '336366e2-bf0f-498b-9592-aa31a7ccde14', prod: '4d9353be-0e1e-49c3-98b3-b744b1109a1f' },
      transport: 'streamable-http',
      // No rollbackSidecar: gong never shipped a Liftoff-side sidecar
      // (status was coming_soon pending OAuth approval), so there's nothing
      // to fall back to. Setting COMPOSIO_DISABLED_CONNECTORS=gong marks
      // the entry disabled in the registry.
    },
    capabilities: [{ capability: 'conversation_intelligence', requiredScopes: [] }],
    polling: [{ entityType: 'Call', eventTopics: ['call.completed', 'meeting.notes_available'], listImplemented: true }],
    multiInstance: true,
  },
  attio: {
    type: 'attio', displayName: 'Attio', category: 'crm_sales',
    objectsCovered: ['People', 'Companies', 'Deals', 'Lists', 'Notes', 'Tasks', 'Meetings', 'Comments', 'Emails', 'Call Recordings', 'Files'],
    status: 'available',
    auth: { kind: 'dcr_oauth', discoveryBaseUrl: 'https://mcp.attio.com',
      clientIdEnvVar: 'ATTIO_CLIENT_ID', clientSecretEnvVar: 'ATTIO_CLIENT_SECRET',
      // Attio consolidated their per-resource scopes into the catch-all `mcp`
      // scope; the DCR endpoint now rejects the old granular scopes with
      // `invalid_scope`. `openid` is also advertised but not required for
      // refresh-token flows; `mcp + offline_access` is the minimal working set.
      scopes: ['mcp', 'offline_access'], scopeDelimiter: ' ' },
    mcp: { kind: 'vendor_hosted', mcpUrl: 'https://mcp.attio.com/mcp', transport: 'streamable-http' },
    capabilities: [{ capability: 'crm', requiredScopes: ['mcp'] }],
    // NO polling. Attio's DCR token is audience-restricted to
    // `https://mcp.attio.com` (the DCR access token is
    // an ES256 JWT with `aud: ["https://mcp.attio.com"]`, `scope: openid
    // offline_access mcp`). AttioClient talks to api.attio.com/v2, which
    // rejects it — "The API Key provided was invalid because it was the wrong
    // length (API Keys should be 64 characters long)". That is not a missing
    // scope; the token is not for that resource, and Attio's REST API wants a
    // token from a standard OAuth app or a 64-char API key instead.
    //
    // So Contact/Deal polling could only 401, and five consecutive
    // credential-class failures flip the connector to reconnect-required —
    // which is what happened the first time anyone connected Attio after the
    // OAuth fix landed. The poller selects `WHERE c.status = 'active'`, so the
    // flip then silently stops the connector until a human reconnects it, and
    // reconnecting just restarts the same five-minute countdown.
    //
    // Agents are unaffected: Attio is vendor-hosted MCP, tool calls go direct
    // to mcp.attio.com — which the token DOES authenticate, 39 tools — and
    // nothing in the tool path filters on connector status.
    //
    // Restoring polling needs a REST-capable credential (a standard Attio
    // OAuth app alongside the MCP one), not a client-side change. Advertising
    // event topics we cannot deliver is what made this class of defect
    // invisible everywhere else, so the entries are removed rather than
    // disabled.
  },
  microsoft_dynamics: {
    type: 'microsoft_dynamics', displayName: 'Microsoft Dynamics 365', category: 'crm_sales',
    objectsCovered: ['Leads', 'Contacts', 'Opportunities', 'Accounts', 'Cases'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
      authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev',
      scopes: [], scopeDelimiter: ' ' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'dynamics365',
      authConfigIds: { dev: 'ac_MWe1aHjWC6zj', prod: 'ac_fBrsGwXdiY43' },
      mcpServerIds: { dev: 'c4f57687-6c86-4e84-935c-3dc46e8d00ae', prod: 'bc0613c2-f47a-4234-b0e8-d2123e917198' },
      transport: 'streamable-http',
      // No rollbackSidecar: microsoft_dynamics never shipped a Liftoff
      // sidecar (was coming_soon pending Microsoft OAuth review).
    },
    capabilities: [{ capability: 'crm', requiredScopes: [] }],
    polling: [
      { entityType: 'Lead', eventTopics: ['lead.created'], listImplemented: true },
      // Contact stays unimplemented: Composio exposes no list-contacts action for
      // Dynamics 365 (only DYNAMICS365_DYNAMICSCRM_GET_ALL_LEADS). Flip when one exists.
      { entityType: 'Contact', eventTopics: ['contact.created', 'contact.updated'], listImplemented: false },
    ],
    multiInstance: true,
  },
  // ── Zoho suite ───────────────────────────────────────────────────────
  // Seven Composio toolkits, one catalog entry each, all available. They are
  // kept together here rather than split across the category sections because
  // they share the region caveat below; `category` still routes each tile to
  // its own group in the UI.
  //
  // REGION IS A REQUIRED CONNECT-TIME FIELD. Zoho is data-centre partitioned
  // (zoho.com / .eu / .in / .com.au / .jp / .ca / .sa / .cn) and every one of
  // these toolkits declares the data centre REQUIRED at connected-account
  // initiation — `region` on zoho and zoho_inventory, `suffix.one` on the other
  // five, confirmed on the live auth configs. Composio's hosted Connect Link
  // page renders it, exactly as it does the Jira subdomain and the Mailchimp
  // server prefix (ADR-050), so there is nothing to wire here and no
  // apikey-router form to add: these are OAuth and the hosted page is the only
  // surface that asks.
  //
  // COUNTING THE TOOLS: read them from the SDK's getRawComposioTools (what
  // @liftoffos/composio-overlays' scaffolder and sync-schemas use), never from
  // REST GET /v3/tools?toolkit_slug=. That REST filter returns 200 OK with a
  // short set — 6 of zoho's 57, and a flat 0 for zoho_books (265), zoho_desk
  // (31), zoho_inventory (58) and zoho_mail (15). Believing it is how these
  // four were briefly written off as serving no tools at all.
  //
  // `zoho_people` (further down, HR) is NOT part of this block: it is a native
  // in-house HRIS build, not a Composio toolkit.
  // Zoho CRM. Lead polling rides ZOHO_GET_ZOHO_RECORDS with module_api_name
  // pinned to 'Leads' (see composio-poll-spec.ts) — a stock module in every
  // org, unlike a per-customer resource the poller would have to discover.
  zoho: {
    type: 'zoho', displayName: 'Zoho CRM', category: 'crm_sales',
    objectsCovered: ['Leads', 'Contacts', 'Accounts', 'Deals', 'Tasks', 'Events', 'Notes', 'Calls'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
      authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev',
      scopes: [], scopeDelimiter: ' ' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'zoho',
      authConfigIds: { dev: 'ac_jdSmeE0o1bP7', prod: 'ac_sRFUBqnwDY96' },
      mcpServerIds: { dev: 'fe9ce281-bbd6-46c5-88d4-366c612dfb67', prod: 'ceffb3df-905d-4c71-a0bc-0495678d911f' },
      transport: 'streamable-http',
    },
    capabilities: [
      { capability: 'crm', requiredScopes: [] },
    ],
    polling: [
      { entityType: 'Lead', eventTopics: ['lead.created'], listImplemented: true },
      { entityType: 'Contact', eventTopics: ['contact.created', 'contact.updated'], listImplemented: false },
    ],
    multiInstance: true,
  },
  // Bigin is Zoho's small-business CRM — a separate product from Zoho CRM with
  // its own ZohoBigin.* scopes, not a view onto it. A customer runs one or the
  // other, so both tiles exist and neither implies the other.
  zoho_bigin: {
    type: 'zoho_bigin', displayName: 'Zoho Bigin', category: 'crm_sales',
    objectsCovered: ['Contacts', 'Companies', 'Pipelines', 'Notes', 'Attachments', 'Tags'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
      authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev',
      scopes: [], scopeDelimiter: ' ' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'zoho_bigin',
      authConfigIds: { dev: 'ac_AJtjPpPHDcr2', prod: 'ac_YMN2BkvupAYa' },
      mcpServerIds: { dev: '58380de1-467c-43c4-a9e8-def87e2244b9', prod: 'ff5a70bd-5cc5-48f6-a7f9-836a3cad2887' },
      transport: 'streamable-http',
    },
    capabilities: [
      { capability: 'crm', requiredScopes: [] },
    ],
    polling: [
      { entityType: 'Contact', eventTopics: ['contact.created', 'contact.updated'], listImplemented: true },
    ],
    multiInstance: true,
  },
  // No poller: ZOHO_INVOICE_LIST_INVOICES requires an organization_id that is
  // per-connection, and the served set has no list-organizations the scheduler
  // could chain off. Topics documented, no poller runs.
  zoho_invoice: {
    type: 'zoho_invoice', displayName: 'Zoho Invoice', category: 'accounting',
    objectsCovered: ['Invoices', 'Estimates', 'Payments', 'Expenses', 'Contacts', 'Items', 'Credit Notes'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
      authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev',
      scopes: [], scopeDelimiter: ' ' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'zoho_invoice',
      authConfigIds: { dev: 'ac_bmVV8TrkVua9', prod: 'ac_P16nfU_8awdi' },
      mcpServerIds: { dev: '186ec16f-77ee-4a04-aa98-273967330dd0', prod: 'b75ca388-5345-4d6e-8ff9-434a7178e620' },
      transport: 'streamable-http',
    },
    capabilities: [
      { capability: 'accounting', requiredScopes: [] },
    ],
    polling: [
      { entityType: 'Invoice', eventTopics: ['invoice.created', 'invoice.updated'], listImplemented: false },
    ],
    multiInstance: true,
  },
  // Books exposes no plain create-invoice — the only creation paths are from a
  // sales order or a recurring template — so the overlay carries the lifecycle
  // verbs (mark sent, void, write off) instead. Same organization_id blocker
  // as zoho_invoice, so no poller.
  zoho_books: {
    type: 'zoho_books', displayName: 'Zoho Books', category: 'accounting',
    objectsCovered: ['Invoices', 'Bills', 'Estimates', 'Expenses', 'Contacts', 'Items', 'Sales Orders', 'Purchase Orders'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
      authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev',
      scopes: [], scopeDelimiter: ' ' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'zoho_books',
      authConfigIds: { dev: 'ac_DjNoyQYnJ2VT', prod: 'ac_rPthNYq_PPYe' },
      mcpServerIds: { dev: '2c377367-81d3-4516-8af2-9262c17e71a8', prod: '45ee401d-d5e3-4f53-b7c2-85d72cb6d5fc' },
      transport: 'streamable-http',
    },
    capabilities: [
      { capability: 'accounting', requiredScopes: [] },
    ],
    polling: [
      { entityType: 'Invoice', eventTopics: ['invoice.created', 'invoice.updated'], listImplemented: false },
    ],
    multiInstance: true,
  },
  // No poller: ZOHO_DESK_LIST_TICKETS takes only from/limit/orgId/viewId. Zoho
  // Desk's REST API supports sortBy=-modifiedTime but the Composio action does
  // not expose it, so there is no since filter AND no newest-first sort — every
  // cycle would re-scan from the oldest ticket. Flip when the action gains a
  // sort or modified-since parameter.
  zoho_desk: {
    type: 'zoho_desk', displayName: 'Zoho Desk', category: 'customer_support',
    objectsCovered: ['Tickets', 'Threads', 'Contacts', 'Agents', 'Departments'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
      authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev',
      scopes: [], scopeDelimiter: ' ' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'zoho_desk',
      authConfigIds: { dev: 'ac_hEzmQSDh1BDa', prod: 'ac_43_ylF7QlXV-' },
      mcpServerIds: { dev: '74f21e02-7d4b-4672-a92b-8c870525e785', prod: 'f16cd62d-c76b-4d5d-b31d-bc2a100eead9' },
      transport: 'streamable-http',
    },
    capabilities: [
      { capability: 'support_ticketing', requiredScopes: [] },
      { capability: 'support_helpdesk', requiredScopes: [] },
    ],
    polling: [
      { entityType: 'Ticket', eventTopics: ['ticket.created', 'ticket.updated'], listImplemented: false },
    ],
    multiInstance: true,
  },
  // No poller: LIST_SALES_ORDERS offers only page/per_page — no since filter and
  // no sort — so there is no way to detect change without a full re-scan.
  zoho_inventory: {
    type: 'zoho_inventory', displayName: 'Zoho Inventory', category: 'e_commerce',
    objectsCovered: ['Items', 'Sales Orders', 'Purchase Orders', 'Packages', 'Invoices', 'Contacts', 'Bills'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
      authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev',
      scopes: [], scopeDelimiter: ' ' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'zoho_inventory',
      authConfigIds: { dev: 'ac_kw16Tk2T6OVG', prod: 'ac_OtCyVCRglTUL' },
      mcpServerIds: { dev: '18a47450-9ce8-48f4-b306-b52b4eccf568', prod: 'c338f64f-f8c1-4ed7-8e87-2df143391115' },
      transport: 'streamable-http',
    },
    capabilities: [
      { capability: 'e_commerce', requiredScopes: [] },
    ],
    polling: [
      { entityType: 'Order', eventTopics: ['order.created', 'order.updated'], listImplemented: false },
    ],
    multiInstance: true,
  },
  // No poller: ZOHO_MAIL_MESSAGES_LIST_EMAILS requires an account_id that is
  // per-connection. It does expose sort_by/sort_order, so this becomes
  // pollable the moment the account id can be resolved at poll time.
  // The overlay deliberately omits the org-admin tools (storage quotas, spam
  // policy, domain operations, bulk group deletes) — those are admin surface
  // an agent should not be able to reach.
  zoho_mail: {
    type: 'zoho_mail', displayName: 'Zoho Mail', category: 'productivity_comms',
    objectsCovered: ['Messages', 'Drafts', 'Accounts', 'Bookmarks'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
      authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev',
      scopes: [], scopeDelimiter: ' ' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'zoho_mail',
      authConfigIds: { dev: 'ac_rufQLCZJUBil', prod: 'ac_XnOmyItRNs_r' },
      mcpServerIds: { dev: '104ee1ad-8446-430b-8665-2ae18be4d02c', prod: '6fdbc5ac-773e-43fc-82ed-ca60761e5d24' },
      transport: 'streamable-http',
    },
    capabilities: [
      { capability: 'email_communication', requiredScopes: [] },
    ],
    polling: [
      { entityType: 'Email', eventTopics: ['email.received'], listImplemented: false },
    ],
    multiInstance: true,
  },

  // ── Engineering / Dev ────────────────────────────────────────────────
  github: {
    type: 'github', displayName: 'GitHub', category: 'engineering',
    objectsCovered: ['Repositories', 'Issues', 'Pull Requests', 'Actions'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'GITHUB_CLIENT_ID', clientSecretEnvVar: 'GITHUB_CLIENT_SECRET',
      authUrl: 'https://github.com/login/oauth/authorize', tokenUrl: 'https://github.com/login/oauth/access_token',
      scopes: ['repo', 'read:user', 'user:email', 'read:org'], scopeDelimiter: ',' },
    mcp: { kind: 'vendor_hosted', mcpUrl: 'https://api.githubcopilot.com/mcp/', transport: 'streamable-http' },
    capabilities: [{ capability: 'version_control', requiredScopes: ['repo'] }],
    // Each entityType below carries `nativeEventDelivery` only because
    // `src/events/github-event-publisher.ts` forwards that GitHub event:
    // PullRequest rides `pull_request`, Issue rides `issues`. Adding a third
    // entityType here without adding it to `entityTypeFor()` gives the
    // distiller an event trigger nothing fires — which is worse than the cron
    // polling it replaces, because a waiting agent never runs at all.
    //
    // `nativeEventDelivery` says this connector puts events on the wire through
    // its OWN webhook, not through a Composio trigger slug. GitHub App webhooks
    // deliver pull_request and pull_request_review to
    // /api/connectors/github/webhook.
    //
    // It exists because `eventTrigger` cannot express this. That field carries a
    // Composio slug, so a natively-delivering connector has no way to say so —
    // and the distiller's deliversEvents() keys on `eventTrigger !== undefined`.
    // Told no integration can deliver events, the distiller turns reactive
    // responsibilities into cron polling and invents its own dedupe to make the
    // polling safe.
    //
    // Slack carries the flag for the same reason: its eventTrigger was removed
    // with the Composio revert, and it has delivered natively ever since.
    polling: [
      { entityType: 'Issue', eventTopics: ['issue.created', 'issue.updated'], listImplemented: true, nativeEventDelivery: true },
      { entityType: 'PullRequest', eventTopics: ['pr.opened', 'pr.updated', 'pr.ready_for_review', 'pr.reopened', 'pr.merged', 'code.pushed'], listImplemented: true, nativeEventDelivery: true },
    ],
  },
  gitlab: {
    type: 'gitlab', displayName: 'GitLab', category: 'engineering',
    objectsCovered: ['Repositories', 'Issues', 'Merge Requests', 'Pipelines'],
    status: 'available',
    // GitLab is a NATIVE-REST tool connector: the review roles' merge-request tools (create/get
    // merge_request, get diffs/notes, create note — GITLAB_FUNCTIONS in connector-functions-registry.ts)
    // run over the documented v4 REST API via GitLabClient (src/clients/gitlab.ts), NOT GitLab's vendor
    // MCP. Empirically the MCP at /api/v4/mcp requires a distinct `mcp`-scope token granted ONLY through
    // dynamic client registration (gitlab.com forces the DCR scope to `mcp`); an `api`-scoped OAuth token
    // is rejected there, and an `mcp` token conversely 403s /api/v4/user and can't do git-over-HTTP —
    // GitLab's own model forces the scopes apart. REST on the `api` token covers the entire tool surface,
    // so there is deliberately NO `mcp` field here (its absence routes tool dispatch to the registered
    // native executor in src/clients/index.ts).
    //
    // OAuth is static_oauth against a pre-registered gitlab.com app (GITLAB_CLIENT_ID/SECRET), moved off
    // dcr_oauth (whose token grants only `mcp`). The four requested scopes each cover a DISTINCT path:
    //   api                    -> the v4 REST API: poller (/merge_requests, /issues), the MR tools above,
    //                             and /api/v4/user for bot_login.
    //   read/write_repository  -> Git-over-HTTP clone + push — a SEPARATE path from the API (GitLab's own
    //                             write_repository doc says "not using the API", so `api` can't push).
    //   read_user              -> identity read; a strict subset of api, kept explicit for clarity.
    // Reactive polling: GitLabClient polls /merge_requests + /issues with the `api` token and publishes
    // under the SAME entityTypes GitHub uses — 'PullRequest' (merge requests) and 'Issue' — so one
    // software-delivery-team subscription matches events from both hosts.
    auth: { kind: 'static_oauth', clientIdEnvVar: 'GITLAB_CLIENT_ID', clientSecretEnvVar: 'GITLAB_CLIENT_SECRET',
      authUrl: 'https://gitlab.com/oauth/authorize', tokenUrl: 'https://gitlab.com/oauth/token',
      scopes: ['api', 'read_user', 'read_repository', 'write_repository'], scopeDelimiter: ' ' },
    capabilities: [{ capability: 'version_control', requiredScopes: ['api'] }],
    polling: [
      { entityType: 'Issue', eventTopics: ['issue.created', 'issue.updated'], listImplemented: true },
      { entityType: 'PullRequest', eventTopics: ['pr.opened', 'pr.updated', 'pr.ready_for_review', 'pr.reopened', 'pr.merged', 'code.pushed'], listImplemented: true },
    ],
  },
  linear: {
    type: 'linear', displayName: 'Linear', category: 'engineering',
    objectsCovered: ['Issues', 'Projects', 'Cycles', 'Roadmaps'],
    status: 'available',
    auth: { kind: 'dcr_oauth', discoveryBaseUrl: 'https://mcp.linear.app',
      clientIdEnvVar: 'LINEAR_CLIENT_ID', clientSecretEnvVar: 'LINEAR_CLIENT_SECRET',
      scopes: [], scopeDelimiter: ' ' },
    mcp: { kind: 'vendor_hosted', mcpUrl: 'https://mcp.linear.app/mcp', transport: 'streamable-http' },
    capabilities: [{ capability: 'project_management', requiredScopes: ['issues:read', 'cycles:read'] }],
    historyReads: [
      { entityType: 'comments', idDescription: 'Issue ID (UUID) or identifier (e.g. ENG-123)', description: 'Read all comments on a Linear issue in chronological order, including author name and timestamps.' },
    ],
    polling: [{ entityType: 'Issue', eventTopics: ['ticket.created', 'ticket.updated'], listImplemented: true }],
  },
  // coming_soon — see "Composio-managed coming_soon batch" notes below the HR / ATS block.
  bitbucket: {
    type: 'bitbucket', displayName: 'Bitbucket', category: 'engineering',
    objectsCovered: ['Repositories', 'Pull Requests', 'Pipelines', 'Issues'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
      authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev',
      scopes: [], scopeDelimiter: ' ' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'bitbucket',
      authConfigIds: { dev: 'ac_1a41Qo2TPr4d', prod: 'ac_JLCjSNpDqlNL' },
      mcpServerIds: { dev: '3edcf816-f29d-456f-ae90-50472591558a', prod: 'cf4fd056-79c6-4aaa-a779-d725aa13a8ea' },
      transport: 'streamable-http',
      rollbackSidecar: { sidecarPath: '/bitbucket', allowedEgressDomain: '*.bitbucket.org' },
    },
    capabilities: [{ capability: 'engineering', requiredScopes: [] }],
    // Repository IS account-wide pollable (BITBUCKET_LIST_REPOSITORIES, role=member,
    // sort=-updated_on — see composio-poll-spec.ts). PullRequests are NOT: every
    // Composio list-PR action needs workspace + user/repo_slug (no global "my PRs")
    // and has no updated-since filter — the poller can't supply repo scope.
    polling: [
      { entityType: 'Repository', eventTopics: ['repository.created', 'repository.updated'], listImplemented: true },
      { entityType: 'PullRequest', eventTopics: ['pr.opened', 'pr.updated'], listImplemented: false },
    ],
    multiInstance: true,
  },
  atlassian_jira: {
    type: 'atlassian_jira', displayName: 'Atlassian Jira', category: 'project_management',
    objectsCovered: ['Issues', 'Projects', 'Sprints', 'Boards'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
      authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev',
      scopes: [], scopeDelimiter: ' ' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'jira',
      authConfigIds: { dev: 'ac_5UadyzfR3MJR', prod: 'ac_F87tb6O5yetP' },
      mcpServerIds: { dev: 'ee997fae-1a9e-471b-9d63-64c4b892a98a', prod: '69c974fe-da4a-4bd4-b80c-9d367974a23d' },
      transport: 'streamable-http',
      rollbackSidecar: { sidecarPath: '/jira', allowedEgressDomain: '*.atlassian.net' },
    },
    capabilities: [{ capability: 'project_management', requiredScopes: ['read:jira-work'] }],
    historyReads: [
      { entityType: 'comments', idDescription: 'Issue ID or key (e.g. PROJ-123)', description: 'Read all comments on a Jira issue in chronological order, including author and timestamp for each comment.' },
    ],
    polling: [{ entityType: 'Issue', eventTopics: ['ticket.created', 'ticket.updated'], listImplemented: true, eventTrigger: { slug: 'JIRA_NEW_ISSUE_TRIGGER' } }],
  },
  atlassian_confluence: {
    type: 'atlassian_confluence', displayName: 'Atlassian Confluence', category: 'knowledge',
    objectsCovered: ['Pages', 'Spaces', 'Comments'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
      authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev',
      scopes: [], scopeDelimiter: ' ' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'confluence',
      authConfigIds: { dev: 'ac_MjMlx37Nxbcj', prod: 'ac_JSlTb4wBeOfp' },
      mcpServerIds: { dev: 'a4284401-87c0-4496-a854-496057e84516', prod: 'd81419b2-19ed-446d-b241-0b27f56c453b' },
      transport: 'streamable-http',
      rollbackSidecar: { sidecarPath: '/confluence', allowedEgressDomain: '*.atlassian.net' },
    },
    capabilities: [],
    polling: [{ entityType: 'Page', eventTopics: ['document.created', 'document.updated'], listImplemented: false, eventTrigger: { slug: 'CONFLUENCE_PAGE_CREATED_TRIGGER', triggerConfig: { interval: 1 } } }],
  },

  // ── Communication / Productivity ─────────────────────────────────────
  slack: {
    type: 'slack', displayName: 'Slack', category: 'productivity_comms',
    objectsCovered: ['Messages', 'Channels'],
    status: 'available',
    // Not Composio-managed: Slack is internal team collaboration on OUR OWN
    // Slack app (own OAuth app + native sidecar dispatch). The Composio-managed
    // connectors exist to bypass Google CASA verification, a problem Slack does
    // not have.
    // NOTE the OAuth-init branch (oauth/router.ts) keys off mcp.kind directly,
    // so a catalog-level revert (not the COMPOSIO_DISABLED_CONNECTORS env var)
    // is the only way reconnects mint slack.com authorize URLs.
    auth: { kind: 'static_oauth', clientIdEnvVar: 'SLACK_CLIENT_ID', clientSecretEnvVar: 'SLACK_CLIENT_SECRET',
      authUrl: 'https://slack.com/oauth/v2/authorize', tokenUrl: 'https://slack.com/api/oauth.v2.access',
      // Full user-scope set, mirroring the Slack app's declared User Token
      // Scopes (settings page). The previous 4-scope subset silently under-
      // granted fresh installs: thread-history reads (conversations.replies),
      // users.lookupByEmail identity matching, and reaction acks all
      // missing_scope'd on new tokens while old tokens coasted on scopes
      // accumulated from earlier grants. Slack accumulates scopes per token,
      // so widening here is additive on reconnect. These are USER scopes —
      // app_mentions:read is bot-only and must never appear in user_scope.
      scopes: [
        'channels:history', 'channels:read', 'chat:write', 'files:read',
        'groups:history', 'groups:read', 'im:history', 'im:read',
        'mpim:history', 'mpim:read', 'reactions:read', 'reactions:write',
        'users:read', 'users:read.email',
      ], scopeDelimiter: ',' },
    mcp: { kind: 'sidecar', sidecarPath: '/slack', allowedEgressDomain: '*.slack.com' },
    historyReads: [
      { entityType: 'thread', idDescription: 'Thread identifier in format "channelId:messageTimestamp" (e.g. "C01234:1234567890.123456")', description: 'Read all replies in a Slack message thread by channel and message timestamp, returning the full conversation in chronological order.' },
    ],
    capabilities: [{ capability: 'team_chat', requiredScopes: [] }],
    // eventTrigger removed with the Composio revert — SLACK_RECEIVE_MESSAGE is a
    // Composio trigger slug and cannot fire without a Composio connected account.
    // …but it has delivered natively ever since, through the Slack Events API
    // webhook onto connector-events. The distiller never knew: deliversEvents()
    // keys on eventTrigger, so removing the slug also removed Slack's ability to
    // say it is reactive, and every Slack agent has been given cron polling for
    // a connector that pushes.
    polling: [{ entityType: 'Message', eventTopics: ['slack.message', 'chat.message'], listImplemented: false, nativeEventDelivery: true }],
  },
  // Design tools — coming_soon Composio-managed batch.
  figma: {
    type: 'figma', displayName: 'Figma', category: 'productivity_comms',
    objectsCovered: ['Files', 'Projects', 'Components', 'Comments'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
      authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev',
      scopes: [], scopeDelimiter: ' ' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'figma',
      authConfigIds: { dev: 'ac_D5NPJwIFE2tJ', prod: 'ac_wuSwE3Sj9jgN' },
      mcpServerIds: { dev: 'eabd143a-9b58-4183-bb47-5051a1e85dfc', prod: 'e67dcab1-714f-4cfe-8d3d-23aca4489357' },
      transport: 'streamable-http',
      rollbackSidecar: { sidecarPath: '/figma', allowedEgressDomain: 'api.figma.com' },
    },
    capabilities: [],
    // Not poll-addressable: Figma has no global file-list action (all require
    // project_id/team_id, which aren't obtainable programmatically), plus no date
    // filter and no pagination on the list actions.
    polling: [{ entityType: 'File', eventTopics: ['file.updated'], listImplemented: false }],
    multiInstance: true,
  },
  canva: {
    type: 'canva', displayName: 'Canva', category: 'productivity_comms',
    objectsCovered: ['Designs', 'Folders', 'Templates'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
      authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev',
      scopes: [], scopeDelimiter: ' ' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'canva',
      authConfigIds: { dev: 'ac_VnVXOkyxxgwk', prod: 'ac_3j99RmdxjNjo' },
      mcpServerIds: { dev: '2872f906-82bf-4f14-a409-56a8f9d3b493', prod: 'b13d8f65-f659-4508-89dc-9628a67c395f' },
      transport: 'streamable-http',
      rollbackSidecar: { sidecarPath: '/canva', allowedEgressDomain: '*.canva.com' },
    },
    capabilities: [],
    polling: [{ entityType: 'Design', eventTopics: ['design.created', 'design.updated'], listImplemented: true }],
    multiInstance: true,
  },

  // ── Customer Support ─────────────────────────────────────────────────
  zendesk: {
    type: 'zendesk', displayName: 'Zendesk', category: 'customer_support',
    objectsCovered: ['Tickets', 'Users', 'Organizations', 'Help Center Articles'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'ZENDESK_CLIENT_ID', clientSecretEnvVar: 'ZENDESK_CLIENT_SECRET',
      authUrl: 'https://SUBDOMAIN.zendesk.com/oauth/authorizations/new',
      tokenUrl: 'https://SUBDOMAIN.zendesk.com/oauth/tokens',
      scopes: ['read', 'write', 'tickets:read', 'tickets:write'], scopeDelimiter: ' ' },
    mcp: { kind: 'sidecar', sidecarPath: '/zendesk', allowedEgressDomain: '*.zendesk.com' },
    capabilities: [{ capability: 'support_ticketing', requiredScopes: ['read', 'write'] }, { capability: 'support_helpdesk', requiredScopes: ['read', 'write'] }],
    historyReads: [
      { entityType: 'comments', idDescription: 'Zendesk ticket ID', description: 'Read all public and internal comments on a Zendesk ticket in chronological order, including who wrote each comment and when.' },
    ],
    polling: [
      { entityType: 'Ticket', eventTopics: ['ticket.created', 'ticket.updated'], listImplemented: true },
      { entityType: 'Article', eventTopics: ['article.created', 'article.updated'], listImplemented: true },
    ],
  },
  // Intercom is composio_managed: Composio operates the OAuth app and hosts the
  // per-tenant MCP server (133-tool surface — conversations/contacts/companies/
  // tickets/articles/segments/subscriptions + outbound CREATE_CONVERSATION).
  // The outbound-message + segment + subscription/consent tools give it the
  // operational core of email marketing, hence the email_marketing capability
  // alongside support. (Switched off the native mcp.intercom.com vendor MCP,
  // which was read-only and had no outbound surface.) Help-center article
  // browse/read for the CRUD router routes through IntercomComposioClient.
  intercom: {
    type: 'intercom', displayName: 'Intercom', category: 'customer_support',
    objectsCovered: ['Conversations', 'Contacts', 'Companies', 'Help Center Articles'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
      authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev',
      scopes: [], scopeDelimiter: ' ' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'intercom',
      authConfigIds: { dev: 'ac_US8oopmnWun1', prod: 'ac_VPKThxSVEP8p' },
      mcpServerIds: { dev: 'dc4e51cf-5943-42da-b688-8583519bdcd6', prod: '62719249-fc7f-43b1-a73c-a4be6dc49b76' },
      transport: 'streamable-http',
    },
    capabilities: [
      { capability: 'support_ticketing', requiredScopes: [] },
      { capability: 'support_helpdesk', requiredScopes: [] },
      { capability: 'email_marketing', requiredScopes: [] },
    ],
    // Reactive Conversation polling: scheduler buildClient → IntercomComposioClient.
    // list('Conversation') via the Composio HTTP PROXY (raw GET /conversations),
    // normalized by the existing IntercomNormalizer (type:'conversation' passthrough).
    // The proxy is used instead of the INTERCOM_LIST_CONVERSATIONS *action* because
    // that action fails Composio's pydantic validation on Intercom's legit source:null
    // (the proxy returns the raw response untouched — verified on a live account).
    // Composio has no Intercom trigger and no contact-list action, so Contact events
    // are not pollable; Article events are low-value and left unimplemented.
    polling: [
      { entityType: 'Conversation', eventTopics: ['conversation.started', 'message.received'], listImplemented: true },
      { entityType: 'Article', eventTopics: ['article.created', 'article.updated'], listImplemented: false },
    ],
  },

  // ── Finance / Payments ───────────────────────────────────────────────
  stripe: {
    type: 'stripe', displayName: 'Stripe', category: 'finance',
    objectsCovered: ['Customers', 'Charges', 'Invoices', 'Subscriptions', 'Payment Intents'], // integrations.json omits; keep backend values
    status: 'available',
    // DCR, not Stripe Connect. Declaring Connect (connect.stripe.com + a `ca_…`
    // client id) needs a STRIPE_CONNECT_CLIENT_ID; without one /start hits the
    // static branch, finds no client id and 500s.
    //
    // No Connect application is needed. mcp.stripe.com publishes RFC 9728
    // protected-resource metadata pointing at https://access.stripe.com/mcp,
    // whose /oauth2/register accepts RFC 7591 dynamic registration (verified:
    // 201, client_id oacli_…, scope `mcp`, PKCE S256, refresh_token
    // supported). So Stripe authenticates exactly like attio and notion, with
    // no dashboard step.
    //
    // The env vars are the local-dev override every DiscoveryOAuthConfig
    // carries; they are ignored in a deployed service. Deliberately NOT named
    // STRIPE_SECRET_KEY — that is the platform's own billing key and must never
    // be presented as a per-tenant OAuth credential.
    auth: { kind: 'dcr_oauth', discoveryBaseUrl: 'https://mcp.stripe.com',
      clientIdEnvVar: 'STRIPE_MCP_CLIENT_ID', clientSecretEnvVar: 'STRIPE_MCP_CLIENT_SECRET',
      scopes: ['mcp'], scopeDelimiter: ' ' },
    mcp: { kind: 'vendor_hosted', mcpUrl: 'https://mcp.stripe.com', transport: 'sse' },
    polling: [
      { entityType: 'PaymentIntent', eventTopics: ['payment.received'], listImplemented: true },
      // NO `invoice.updated` / `subscription.updated`. StripeMCPClient.list()
      // filters `created: { gte: since }` — the object's CREATION time — and
      // `since` advances every cycle (scheduler: lastSyncAt minus one overlap).
      // An invoice created before that window and later moved draft -> open ->
      // paid is therefore never returned by the poll, so the status change that
      // makes it interesting cannot be observed. The normalizer versions on
      // hashCanonicalJson, which WOULD produce a fresh dedupe key on any change,
      // but a key never helps a record the fetch does not return.
      //
      // The update topics are back, delivered by WEBHOOK rather than by the
      // poll (events/stripe-webhook-router.ts). `eventTopics` here is not a
      // claim about polling: the tenant runtime loads this map as the routing
      // vocabulary for ANY connector event of a given (source, entityType),
      // webhook deliveries included. So the poll carries creations, the webhook
      // carries updates, and both land on the topics below.
      { entityType: 'Invoice', eventTopics: ['invoice.created', 'invoice.updated'], listImplemented: true },
      { entityType: 'Subscription', eventTopics: ['subscription.updated'], listImplemented: true },
    ],
  },
  square: {
    type: 'square', displayName: 'Square', category: 'finance',
    objectsCovered: ['Payments', 'Orders', 'Customers', 'Items'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
      authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev',
      scopes: [], scopeDelimiter: ' ' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'square',
      authConfigIds: { dev: 'ac_pMHDFzxb-yCo', prod: 'ac_UK_IT1-Uo6b5' },
      mcpServerIds: { dev: '5b527b44-e898-4974-8925-c26a790637a0', prod: '97612f39-fef6-41db-b0f6-2a812711e6c7' },
      transport: 'streamable-http',
      rollbackSidecar: { sidecarPath: '/square', allowedEgressDomain: '*.squareup.com' },
    },
    capabilities: [{ capability: 'e_commerce', requiredScopes: [] }],
    polling: [{ entityType: 'Payment', eventTopics: ['payment.received'], listImplemented: true }],
    multiInstance: true,
  },
  paypal: {
    type: 'paypal', displayName: 'PayPal', category: 'finance',
    objectsCovered: ['Payments', 'Invoices', 'Subscriptions'],
    status: 'available',
    auth: { kind: 'dcr_oauth', discoveryBaseUrl: 'https://mcp.paypal.com',
      clientIdEnvVar: 'PAYPAL_CLIENT_ID', clientSecretEnvVar: 'PAYPAL_CLIENT_SECRET',
      scopes: [], scopeDelimiter: ' ' },
    mcp: { kind: 'vendor_hosted', mcpUrl: 'https://mcp.paypal.com/sse', transport: 'sse' },
    polling: [{ entityType: 'Payment', eventTopics: ['payment.received'], listImplemented: true }],
  },
  plaid: {
    type: 'plaid', displayName: 'Plaid', category: 'finance',
    objectsCovered: ['Accounts', 'Transactions', 'Balances'],
    status: 'coming_soon',
    statusReason: 'Plaid partner program approval required (plaid.com/partners)',
    auth: { kind: 'api_key' },
    mcp: { kind: 'sidecar', sidecarPath: '/plaid', allowedEgressDomain: '*.plaid.com' },
    polling: [{ entityType: 'Transaction', eventTopics: ['payment.received'], listImplemented: false }],
  },

  // ── Accounting ───────────────────────────────────────────────────────
  quickbooks: {
    // Poll-reactive via QUICKBOOKS_GET_CHANGED_ENTITIES (CDC, changedSince) — see composio-poll-spec.ts.
    type: 'quickbooks', displayName: 'QuickBooks Online', category: 'accounting',
    objectsCovered: ['Invoices', 'Customers', 'Payments', 'Accounts'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
      authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev',
      scopes: [], scopeDelimiter: ' ' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'quickbooks',
      authConfigIds: { dev: 'ac_HN7cdooe208O', prod: 'ac_NuOR6kMBxuFb' },
      mcpServerIds: { dev: '2f39abed-a527-4d95-ac9f-3b6a3e96c467', prod: 'c730b4e2-ef9c-412e-96f0-943043d57f27' },
      transport: 'streamable-http',
    },
    capabilities: [{ capability: 'accounting', requiredScopes: [] }],
    multiInstance: true,
    polling: [{ entityType: 'Invoice', eventTopics: ['invoice.created', 'invoice.updated'], listImplemented: true }],
  },
  xero: {
    type: 'xero', displayName: 'Xero', category: 'accounting',
    objectsCovered: ['Invoices', 'Contacts', 'Payments', 'Accounts'],
    status: 'coming_soon',
    statusReason: 'Composio does not operate managed credentials for Xero (the Composio API rejects use_composio_managed_auth). To enable: register a Xero OAuth app at developer.xero.com and plug it into Composio as use_custom_auth. 25-org cap until Xero certification.',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'XERO_CLIENT_ID', clientSecretEnvVar: 'XERO_CLIENT_SECRET',
      authUrl: 'https://login.xero.com/identity/connect/authorize',
      tokenUrl: 'https://identity.xero.com/connect/token',
      scopes: ['accounting.transactions', 'accounting.contacts', 'offline_access'], scopeDelimiter: ' ', requiresPkce: true },
    mcp: { kind: 'vendor_hosted', mcpUrl: 'https://mcp.xero.com', transport: 'sse' },
    capabilities: [{ capability: 'accounting', requiredScopes: ['accounting.transactions', 'accounting.contacts'] }],
    polling: [
      { entityType: 'Invoice', eventTopics: ['invoice.created', 'invoice.updated'], listImplemented: false },
      { entityType: 'Payment', eventTopics: ['payment.received'], listImplemented: false },
    ],
  },

  // Net-new Composio-managed addition.
  freshbooks: {
    type: 'freshbooks', displayName: 'FreshBooks', category: 'accounting',
    objectsCovered: ['Invoices', 'Clients', 'Expenses', 'Estimates', 'Time Tracking'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
      authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev',
      scopes: [], scopeDelimiter: ' ' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'freshbooks',
      authConfigIds: { dev: 'ac_0UY9ZzbAF5xU', prod: 'ac_ANdavPnCLxqw' },
      mcpServerIds: { dev: '37f81775-67d0-44b3-ab8f-70a2fe41b4ca', prod: 'cb3aa5a2-6ad0-4f40-81ad-a555585dd974' },
      transport: 'streamable-http',
    },
    capabilities: [{ capability: 'accounting', requiredScopes: [] }],
    multiInstance: true,
  },

  // ── HR / Payroll ─────────────────────────────────────────────────────
  // Gusto + Rippling use first-party static_oauth (our own Gusto/Rippling OAuth apps);
  // the auth block is finalized by the NATIVE_HRIS_OAUTH loop near the end of this file.
  gusto: {
    type: 'gusto', displayName: 'Gusto', category: 'hr',
    objectsCovered: ['Employees', 'Company', 'Employment', 'Payroll'],
    status: 'available',
    auth: { kind: 'api_key' }, // upgraded to static_oauth by the NATIVE_HRIS_OAUTH loop
    capabilities: [{ capability: 'hris', requiredScopes: [] }],
    // A tenant may connect several Gusto companies (one connection each).
    multiInstance: true,
  },
  rippling: {
    type: 'rippling', displayName: 'Rippling', category: 'hr',
    objectsCovered: ['Employees', 'Company', 'Employment'],
    status: 'available',
    auth: { kind: 'api_key' }, // upgraded to static_oauth by the NATIVE_HRIS_OAUTH loop
    capabilities: [{ capability: 'hris', requiredScopes: [] }],
    // A tenant may connect several Rippling accounts (one connection each).
    multiInstance: true,
  },
  bamboohr: {
    type: 'bamboohr', displayName: 'BambooHR', category: 'hr',
    objectsCovered: ['Employees', 'Time Off', 'Reports'],
    status: 'available',
    auth: { kind: 'api_key' },
    mcp: { kind: 'sidecar', sidecarPath: '/bamboohr', allowedEgressDomain: '*.bamboohr.com' },
    capabilities: [{ capability: 'hris', requiredScopes: ['employee:read', 'policies:read'] }],
    polling: [{ entityType: 'Employee', eventTopics: ['employee.created', 'employee.updated'], listImplemented: true }],
  },
  // Warp — native api_key (x-api-key). The NATIVE_HRIS_EGRESS loop finalizes
  // api_key + sidecar + available. Workers/departments/workplaces/time-off +
  // custom-field values (where PII/comp/banking live). Base URL api.joinwarp.com.
  warp: {
    type: 'warp', displayName: 'Warp', category: 'hr',
    objectsCovered: ['Employees', 'Contractors', 'Departments', 'Workplaces', 'Time Off', 'Custom Fields'],
    status: 'available',
    auth: { kind: 'api_key' },
    capabilities: [{ capability: 'hris', requiredScopes: [] }],
  },

  // ── HR / ATS — coming_soon ───────────────────────────────────────────
  // Why these are coming_soon and NOT under the Composio-managed section:
  //
  //   Composio's API returns `composio_managed_auth_schemes: []` for all three
  //   toolkits — verified against backend.composio.dev. That means
  //   Composio has the toolkit pages but has NOT registered OAuth client apps
  //   with these vendors. The "use_custom_auth" path would require us to
  //   register OAuth apps ourselves at each vendor, at which point Composio
  //   adds nothing over the existing sidecar pattern (bamboohr/rippling/gusto)
  //   — we'd still own app registration, and we'd take on a third-party runtime
  //   dependency for no gain. The lever toolkit at Composio also has ZERO
  //   tools defined, so using Composio for Lever would be strictly negative.
  //
  //   Workday's OAuth is per-customer-tenant by architecture (each Workday
  //   tenant has its own authorize/token URLs) — this is a Workday platform
  //   decision that any auth provider has to accommodate, not a Composio bug.
  //
  //   Auth-provider decision (managed OAuth provider vs per-vendor sidecar)
  //   is open. These ship as coming_soon tiles for now.
  //
  //   Placeholder mcp blocks (kind: 'sidecar') exist only to satisfy the
  //   composio_managed parity test; they are NEVER routed because status is
  //   coming_soon. Do not bootstrap these against Composio.
  workday: {
    // Native api_key direct-vault: the employer generates a Workday ISU token used
    // by the native client. auth is finalized by the NATIVE_HRIS_EGRESS loop.
    // multiInstance: a tenant can link several Workday tenants.
    type: 'workday', displayName: 'Workday', category: 'hr',
    objectsCovered: ['Employees', 'Company', 'Employment', 'Payroll'],
    status: 'available',
    auth: { kind: 'api_key' },
    capabilities: [{ capability: 'hris', requiredScopes: [] }],
    multiInstance: true,
  },

  // ── Enterprise HRIS (native, api_key) ────────────────────────────────────
  // The available connectors here (adp_workforce_now once shipped/ukg_pro/ukg_ready/
  // dayforce/hibob/personio/deel/factorial) are native api_key; paylocity/paycor/
  // paychex/justworks/zoho_people stay coming_soon for a future in-house native impl.
  adp_workforce_now: {
    type: 'adp_workforce_now', displayName: 'ADP Workforce Now', category: 'hr',
    objectsCovered: ['Employees', 'Companies', 'Time Off'],
    status: 'coming_soon',
    statusReason: 'Native in-house HRIS integration pending',
    auth: { kind: 'api_key' },
    capabilities: [{ capability: 'hris', requiredScopes: [] }],
    polling: [{ entityType: 'Employee', eventTopics: ['employee.created', 'employee.updated'], listImplemented: false }],
    multiInstance: true,
  },
  // First-party native via ADP API Central (OAuth client-credentials over mutual TLS).
  // base auth is api_key; the NATIVE_HRIS_EGRESS loop finalizes api_key + sidecar + available.
  adp_run: {
    type: 'adp_run', displayName: 'ADP RUN', category: 'hr',
    objectsCovered: ['Employees', 'Companies', 'Pay Statements'],
    status: 'coming_soon',
    statusReason: 'Native ADP RUN via API Central (client credentials + mTLS) pending',
    auth: { kind: 'api_key' },
    capabilities: [{ capability: 'hris', requiredScopes: [] }],
    multiInstance: true,
  },
  sap_successfactors: {
    // Native api_key direct-vault. auth is finalized by the NATIVE_HRIS_EGRESS loop.
    type: 'sap_successfactors', displayName: 'SAP SuccessFactors', category: 'hr',
    objectsCovered: ['Employees', 'Company', 'Employment'],
    status: 'available',
    auth: { kind: 'api_key' },
    capabilities: [{ capability: 'hris', requiredScopes: [] }],
    multiInstance: true,
  },
  oracle_hcm: {
    // Native api_key direct-vault. auth is finalized by the NATIVE_HRIS_EGRESS loop.
    type: 'oracle_hcm', displayName: 'Oracle Cloud HCM', category: 'hr',
    objectsCovered: ['Employees', 'Company', 'Employment'],
    status: 'available',
    auth: { kind: 'api_key' },
    capabilities: [{ capability: 'hris', requiredScopes: [] }],
    multiInstance: true,
  },
  ukg_pro: {
    type: 'ukg_pro', displayName: 'UKG Pro', category: 'hr',
    objectsCovered: ['Employees', 'Companies', 'Time Off'],
    status: 'coming_soon',
    statusReason: 'Native in-house HRIS integration pending',
    auth: { kind: 'api_key' },
    capabilities: [{ capability: 'hris', requiredScopes: [] }],
    polling: [{ entityType: 'Employee', eventTopics: ['employee.created', 'employee.updated'], listImplemented: false }],
    multiInstance: true,
  },
  ukg_ready: {
    type: 'ukg_ready', displayName: 'UKG Ready', category: 'hr',
    objectsCovered: ['Employees', 'Companies', 'Time Off'],
    status: 'coming_soon',
    statusReason: 'Native in-house HRIS integration pending',
    auth: { kind: 'api_key' },
    capabilities: [{ capability: 'hris', requiredScopes: [] }],
    polling: [{ entityType: 'Employee', eventTopics: ['employee.created', 'employee.updated'], listImplemented: false }],
    multiInstance: true,
  },
  dayforce: {
    type: 'dayforce', displayName: 'Dayforce', category: 'hr',
    objectsCovered: ['Employees', 'Companies', 'Time Off'],
    status: 'coming_soon',
    statusReason: 'Native in-house HRIS integration pending',
    auth: { kind: 'api_key' },
    capabilities: [{ capability: 'hris', requiredScopes: [] }],
    polling: [{ entityType: 'Employee', eventTopics: ['employee.created', 'employee.updated'], listImplemented: false }],
    multiInstance: true,
  },
  paylocity: {
    type: 'paylocity', displayName: 'Paylocity', category: 'hr',
    objectsCovered: ['Employees', 'Companies', 'Time Off'],
    status: 'coming_soon',
    statusReason: 'Native in-house HRIS integration pending',
    auth: { kind: 'api_key' },
    capabilities: [{ capability: 'hris', requiredScopes: [] }],
    polling: [{ entityType: 'Employee', eventTopics: ['employee.created', 'employee.updated'], listImplemented: false }],
    multiInstance: true,
  },
  paycor: {
    type: 'paycor', displayName: 'Paycor', category: 'hr',
    objectsCovered: ['Employees', 'Companies', 'Time Off'],
    status: 'coming_soon',
    statusReason: 'Native in-house HRIS integration pending',
    auth: { kind: 'api_key' },
    capabilities: [{ capability: 'hris', requiredScopes: [] }],
    polling: [{ entityType: 'Employee', eventTopics: ['employee.created', 'employee.updated'], listImplemented: false }],
    multiInstance: true,
  },
  paychex: {
    type: 'paychex', displayName: 'Paychex', category: 'hr',
    objectsCovered: ['Employees', 'Companies', 'Time Off'],
    status: 'coming_soon',
    statusReason: 'Native in-house HRIS integration pending',
    auth: { kind: 'api_key' },
    capabilities: [{ capability: 'hris', requiredScopes: [] }],
    polling: [{ entityType: 'Employee', eventTopics: ['employee.created', 'employee.updated'], listImplemented: false }],
    multiInstance: true,
  },
  hibob: {
    type: 'hibob', displayName: 'HiBob', category: 'hr',
    objectsCovered: ['Employees', 'Companies', 'Time Off'],
    status: 'coming_soon',
    statusReason: 'Native in-house HRIS integration pending',
    auth: { kind: 'api_key' },
    capabilities: [{ capability: 'hris', requiredScopes: [] }],
    polling: [{ entityType: 'Employee', eventTopics: ['employee.created', 'employee.updated'], listImplemented: false }],
    multiInstance: true,
  },
  personio: {
    type: 'personio', displayName: 'Personio', category: 'hr',
    objectsCovered: ['Employees', 'Companies', 'Time Off'],
    status: 'coming_soon',
    statusReason: 'Native in-house HRIS integration pending',
    auth: { kind: 'api_key' },
    capabilities: [{ capability: 'hris', requiredScopes: [] }],
    polling: [{ entityType: 'Employee', eventTopics: ['employee.created', 'employee.updated'], listImplemented: false }],
    multiInstance: true,
  },
  deel: {
    type: 'deel', displayName: 'Deel', category: 'hr',
    objectsCovered: ['Employees', 'Companies', 'Time Off'],
    status: 'coming_soon',
    statusReason: 'Native in-house HRIS integration pending',
    auth: { kind: 'api_key' },
    capabilities: [{ capability: 'hris', requiredScopes: [] }],
    polling: [{ entityType: 'Employee', eventTopics: ['employee.created', 'employee.updated'], listImplemented: false }],
    multiInstance: true,
  },
  namely: {
    // Native api_key direct-vault: the employer generates a Namely API token used by
    // the native client. auth is finalized by the NATIVE_HRIS_EGRESS loop.
    type: 'namely', displayName: 'Namely', category: 'hr',
    objectsCovered: ['Employees', 'Company', 'Employment'],
    status: 'available',
    auth: { kind: 'api_key' },
    capabilities: [{ capability: 'hris', requiredScopes: [] }],
    multiInstance: true,
  },
  zenefits: {
    // TriNet HR Platform (fka Zenefits). Held coming_soon pending an in-house native integration.
    type: 'zenefits', displayName: 'Zenefits', category: 'hr',
    objectsCovered: ['Employees', 'Company', 'Employment', 'Payroll'],
    status: 'coming_soon',
    statusReason: 'Native in-house HRIS integration pending',
    auth: { kind: 'api_key' },
    capabilities: [{ capability: 'hris', requiredScopes: [] }],
    multiInstance: true,
  },
  factorial: {
    type: 'factorial', displayName: 'Factorial', category: 'hr',
    objectsCovered: ['Employees', 'Companies', 'Time Off'],
    status: 'coming_soon',
    statusReason: 'Native in-house HRIS integration pending',
    auth: { kind: 'api_key' },
    capabilities: [{ capability: 'hris', requiredScopes: [] }],
    polling: [{ entityType: 'Employee', eventTopics: ['employee.created', 'employee.updated'], listImplemented: false }],
    multiInstance: true,
  },
  justworks: {
    type: 'justworks', displayName: 'Justworks', category: 'hr',
    objectsCovered: ['Employees', 'Companies', 'Time Off'],
    status: 'coming_soon',
    statusReason: 'Native in-house HRIS integration pending',
    auth: { kind: 'api_key' },
    capabilities: [{ capability: 'hris', requiredScopes: [] }],
    polling: [{ entityType: 'Employee', eventTopics: ['employee.created', 'employee.updated'], listImplemented: false }],
    multiInstance: true,
  },
  zoho_people: {
    type: 'zoho_people', displayName: 'Zoho People', category: 'hr',
    objectsCovered: ['Employees', 'Companies', 'Time Off'],
    status: 'coming_soon',
    statusReason: 'Native in-house HRIS integration pending',
    auth: { kind: 'api_key' },
    capabilities: [{ capability: 'hris', requiredScopes: [] }],
    polling: [{ entityType: 'Employee', eventTopics: ['employee.created', 'employee.updated'], listImplemented: false }],
    multiInstance: true,
  },

  lever: {
    type: 'lever', displayName: 'Lever', category: 'hr',
    objectsCovered: ['Candidates', 'Postings', 'Opportunities', 'Stages'],
    status: 'available',
    // Composio-managed via API_KEY (user supplies their Lever API key, base64).
    // Composio now exposes a functional lever toolkit (64 tools); the earlier
    // "zero tools / managed auth empty" note is stale. Lever is an ATS.
    auth: { kind: 'api_key' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'lever',
      authConfigIds: { dev: 'ac_mkSN5w8_r-uE', prod: 'ac_RlUNwnhpdD6Y' },
      mcpServerIds: { dev: 'c9db93fc-7328-466f-a080-742238162741', prod: '4574bd60-9384-4637-9657-88df564ac6e7' },
      transport: 'streamable-http',
    },
    capabilities: [{ capability: 'ats', requiredScopes: [] }],
    polling: [{ entityType: 'Candidate', eventTopics: ['candidate.created', 'candidate.updated'], listImplemented: true }],
    multiInstance: true,
  },
  workable: {
    type: 'workable', displayName: 'Workable', category: 'hr',
    objectsCovered: ['Candidates', 'Jobs', 'Hiring Pipeline', 'Members'],
    status: 'available',
    // Composio-managed via API_KEY (user supplies subdomain + Workable API key).
    // Workable is an ATS.
    auth: { kind: 'api_key' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'workable',
      authConfigIds: { dev: 'ac_SrfBW3GSE_Xw', prod: 'ac_QTD_sXkaiktT' },
      mcpServerIds: { dev: 'a96cd0bb-9bee-41ac-9602-d37e5d66293e', prod: 'f9c0df84-fdff-4734-b7a7-20db09f49bee' },
      transport: 'streamable-http',
    },
    capabilities: [{ capability: 'ats', requiredScopes: [] }],
    polling: [{ entityType: 'Candidate', eventTopics: ['candidate.created', 'candidate.updated'], listImplemented: true }],
    multiInstance: true,
  },

  // ── Storage ─────────────────────────────────────────────────────────
  google_drive: {
    type: 'google_drive', displayName: 'Google Drive', category: 'storage',
    objectsCovered: ['Files', 'Folders', 'Shared Drives'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
      authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev',
      scopes: [], scopeDelimiter: ' ' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'googledrive',
      authConfigIds: { dev: 'ac_33YReAX7g9LS', prod: 'ac_63jfkQi5gTEP' },
      mcpServerIds: { dev: 'd2ad78e8-c961-43f9-9ca2-2f748e2476c6', prod: '10abed75-dc9c-4f45-945b-e9f8cb95caf3' },
      transport: 'streamable-http',
      rollbackSidecar: { sidecarPath: '/google/drive', allowedEgressDomain: '*.googleapis.com' },
    },
    capabilities: [{ capability: 'cloud_storage', requiredScopes: ['https://www.googleapis.com/auth/drive'] }],
    polling: [{ entityType: 'File', eventTopics: ['file.created', 'file.updated'], listImplemented: true, eventTrigger: { slug: 'GOOGLEDRIVE_FILE_CREATED_TRIGGER', triggerConfig: { interval: 1 } } }],
  },
  // Composio-managed since the M365 file-plane change. The 9 hand-written
  // native tools become 35, and — because Composio's managed scopes include
  // Sites.Read.All — the same connection reaches SharePoint document
  // libraries, which the native client never could: it resolved every item
  // against /me/drive, the user's personal OneDrive.
  //
  // Word and PowerPoint are files here, not connector tools: no vendor
  // in-place editing API exists and Composio has no Word or PowerPoint
  // toolkit, so read_document / generate_docx / edit_document round-trip the
  // real OOXML through the file proxy (crud/router.ts) over Composio's
  // binary_data / binary_body. rollbackSidecar keeps the native client one
  // COMPOSIO_DISABLED_CONNECTORS entry away.
  microsoft_onedrive: {
    type: 'microsoft_onedrive', displayName: 'Microsoft OneDrive', category: 'storage',
    objectsCovered: ['Files', 'Folders', 'Shared Items'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
      authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev',
      scopes: [], scopeDelimiter: ' ' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'one_drive',
      authConfigIds: { dev: 'ac_6_-K1nQhPdLr', prod: 'ac_HPvOpEA5cHnK' },
      mcpServerIds: { dev: 'a621a5d8-1188-4200-807f-b2b3a9f0e271', prod: '582f3fde-f0ce-4a30-a74d-7576e7160a4d' },
      transport: 'streamable-http',
      rollbackSidecar: { sidecarPath: '/microsoft/onedrive', allowedEgressDomain: '*.microsoft.com' },
    },
    capabilities: [{ capability: 'cloud_storage', requiredScopes: [] }],
    polling: [{ entityType: 'File', eventTopics: ['file.created', 'file.updated'], listImplemented: true }],
  },
  dropbox: {
    type: 'dropbox', displayName: 'Dropbox', category: 'storage',
    objectsCovered: ['Files', 'Folders', 'Paper Docs'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
      authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev',
      scopes: [], scopeDelimiter: ' ' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'dropbox',
      authConfigIds: { dev: 'ac_gEvT_Od0Ci-D', prod: 'ac_tFUZfmwm-CNS' },
      mcpServerIds: { dev: '8fedbe0f-d23f-4e2d-80e8-415f25650f5f', prod: '5b05f37b-99f3-4bd0-941f-27f4fdc55216' },
      transport: 'streamable-http',
      rollbackSidecar: { sidecarPath: '/dropbox', allowedEgressDomain: '*.dropboxapi.com' },
    },
    capabilities: [{ capability: 'cloud_storage', requiredScopes: ['files.content.read', 'files.content.write'] }],
    polling: [{ entityType: 'File', eventTopics: ['file.created', 'file.updated'], listImplemented: true }],
  },
  box: {
    type: 'box', displayName: 'Box', category: 'storage',
    objectsCovered: ['Files', 'Folders', 'Box Notes'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'BOX_CLIENT_ID', clientSecretEnvVar: 'BOX_CLIENT_SECRET',
      authUrl: 'https://account.box.com/api/oauth2/authorize', tokenUrl: 'https://api.box.com/oauth2/token',
      scopes: ['root_readwrite'], scopeDelimiter: ' ' },
    mcp: { kind: 'sidecar', sidecarPath: '/box', allowedEgressDomain: '*.box.com' },
    capabilities: [{ capability: 'cloud_storage', requiredScopes: ['root_readwrite'] }],
    polling: [{ entityType: 'File', eventTopics: ['file.created', 'file.updated'], listImplemented: true }],
  },

  // ── Google Workspace (continued) ─────────────────────────────────────
  google_mail: {
    type: 'google_mail', displayName: 'Gmail', category: 'productivity_comms',
    objectsCovered: ['Emails', 'Drafts', 'Labels', 'Contacts'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
      authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev',
      scopes: [], scopeDelimiter: ' ' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'gmail',
      authConfigIds: { dev: 'ac_oqjgrEUZHFt_', prod: 'ac_Z7tkZX2Bl6i_' },
      mcpServerIds: { dev: 'dbe26a27-5e30-4681-86ff-85eaafa50e07', prod: '02153cfc-8063-43e7-820f-21697a47f88b' },
      transport: 'streamable-http',
      rollbackSidecar: { sidecarPath: '/google/mail', allowedEgressDomain: '*.googleapis.com' },
    },
    capabilities: [{ capability: 'email_communication', requiredScopes: ['https://www.googleapis.com/auth/gmail.modify'] }, { capability: 'support_helpdesk', requiredScopes: ['https://www.googleapis.com/auth/gmail.modify'] }],
    historyReads: [
      { entityType: 'thread', idDescription: 'Gmail thread ID (threadId field from event payload or read_email result)', description: 'Read all messages in a Gmail conversation thread by thread ID, returning decoded body content for every message in chronological order.' },
    ],
    polling: [{ entityType: 'Email', eventTopics: ['email.received', 'mail.received'], listImplemented: true, eventTrigger: { slug: 'GMAIL_NEW_GMAIL_MESSAGE', triggerConfig: { userId: 'me', labelIds: 'INBOX', interval: 1 } } }],
  },
  google_calendar: {
    type: 'google_calendar', displayName: 'Google Calendar', category: 'meetings_scheduling',
    objectsCovered: ['Events', 'Availability'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
      authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev',
      scopes: [], scopeDelimiter: ' ' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'googlecalendar',
      authConfigIds: { dev: 'ac_yHOl-7jzbl97', prod: 'ac_VdnHRqzXh-VP' },
      mcpServerIds: { dev: 'f2037ae1-6896-4a26-9031-6eba20ef6625', prod: 'b0a6fd28-1aea-4d13-8bd6-5c5d815fa17d' },
      transport: 'streamable-http',
      rollbackSidecar: { sidecarPath: '/google/calendar', allowedEgressDomain: '*.googleapis.com' },
    },
    capabilities: [{ capability: 'calendar', requiredScopes: [] }],
    polling: [{ entityType: 'CalendarEvent', eventTopics: ['calendar.event', 'meeting.scheduled', 'calendar.meeting_starting_soon'], listImplemented: true, eventTrigger: { slug: 'GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_CHANGE_TRIGGER' } }],
  },
  google_ads: {
    type: 'google_ads', displayName: 'Google Ads', category: 'marketing_comms',
    objectsCovered: ['Campaigns', 'Ad Groups', 'Keywords', 'Performance Reports'],
    // Routed through Composio because Composio operates its own approved
    // Google Ads developer token — the real blocker for shipping google_ads
    // is the developer token (not OAuth, which Liftoff already has). Rule 2
    // (don't split Google identity) does not apply here: the developer token
    // gates API access entirely and is independent of OAuth.
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
      authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev',
      scopes: [], scopeDelimiter: ' ' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'googleads',
      authConfigIds: { dev: 'ac_J-S4YWwQ_g1h', prod: 'ac_g5HKZBcIO_r6' },
      mcpServerIds: { dev: '9644faf2-f4fa-44ce-98c0-fdc4a8f944d7', prod: 'c1a50e49-65de-4ba3-be33-66ce6abc8e4b' },
      transport: 'streamable-http',
      // No rollbackSidecar: google_ads' Liftoff sidecar exists (clients/
      // google-ads.ts) but is blocked by the missing Google Ads developer
      // token — that's the whole reason we're routing through Composio's
      // approved token. Rolling back would re-encounter the same wall.
    },
    capabilities: [{ capability: 'advertising', requiredScopes: [] }],
    multiInstance: true,
  },
  google_docs: {
    type: 'google_docs', displayName: 'Google Docs', category: 'productivity_comms',
    objectsCovered: ['Documents', 'Comments', 'Suggestions'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
      authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev',
      scopes: [], scopeDelimiter: ' ' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'googledocs',
      authConfigIds: { dev: 'ac_BKpxpG92lzRN', prod: 'ac_9-KlDXAHlF7z' },
      mcpServerIds: { dev: 'a3c77d9e-ed82-49d8-a3ca-1c3eb50cb591', prod: '72af2269-8995-4bb5-bed0-e5294a2471cc' },
      transport: 'streamable-http',
      rollbackSidecar: { sidecarPath: '/google/docs', allowedEgressDomain: '*.googleapis.com' },
    },
    capabilities: [{ capability: 'documents', requiredScopes: ['https://www.googleapis.com/auth/documents.readonly'] }],
    polling: [{ entityType: 'Document', eventTopics: ['document.created', 'document.updated'], listImplemented: false, eventTrigger: { slug: 'GOOGLEDOCS_DOCUMENT_UPDATED_TRIGGER', triggerConfig: { interval: 1 } } }],
  },
  google_sheets: {
    type: 'google_sheets', displayName: 'Google Sheets', category: 'productivity_comms',
    objectsCovered: ['Spreadsheets', 'Sheets', 'Data Ranges'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
      authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev',
      scopes: [], scopeDelimiter: ' ' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'googlesheets',
      authConfigIds: { dev: 'ac_x6PfdrNmmdEN', prod: 'ac_xwTzAWK6s-di' },
      mcpServerIds: { dev: '81812774-34ba-489f-a6dc-d67245cc2f27', prod: 'fbe78e28-aad6-42c8-8642-51a25d2e02b2' },
      transport: 'streamable-http',
      rollbackSidecar: { sidecarPath: '/google/sheets', allowedEgressDomain: '*.googleapis.com' },
    },
    capabilities: [{ capability: 'data_table', requiredScopes: [] }],
    polling: [{ entityType: 'Sheet', eventTopics: ['spreadsheet.updated', 'sheet.updated'], listImplemented: false, eventTrigger: { slug: 'GOOGLESHEETS_NEW_ROWS_TRIGGER', triggerConfig: { interval: 1 } } }],
  },
  google_slides: {
    type: 'google_slides', displayName: 'Google Slides', category: 'productivity_comms',
    objectsCovered: ['Presentations', 'Slides', 'Speaker Notes'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
      authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev',
      scopes: [], scopeDelimiter: ' ' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'googleslides',
      authConfigIds: { dev: 'ac_2OYhVI35sBEO', prod: 'ac_kRVXc1HrHnf_' },
      mcpServerIds: { dev: 'cbfea13d-0757-4795-bd64-58ed6fe75a35', prod: 'c6e69e1f-f1d1-4699-a4d4-a20368a34b6c' },
      transport: 'streamable-http',
      rollbackSidecar: { sidecarPath: '/google/slides', allowedEgressDomain: '*.googleapis.com' },
    },
    polling: [{ entityType: 'Slide', eventTopics: ['document.updated', 'slides.updated'], listImplemented: false, eventTrigger: { slug: 'GOOGLESLIDES_SLIDE_ADDED_TRIGGER', triggerConfig: { interval: 1 } } }],
  },
  google_contacts: {
    type: 'google_contacts', displayName: 'Google Contacts', category: 'productivity_comms',
    objectsCovered: ['Contacts', 'Contact Groups'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'GOOGLE_CLIENT_ID', clientSecretEnvVar: 'GOOGLE_CLIENT_SECRET',
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: ['https://www.googleapis.com/auth/contacts', 'openid', 'email'], scopeDelimiter: ' ' },
    polling: [{ entityType: 'Contact', eventTopics: ['contact.created', 'contact.updated'], listImplemented: false }],
  },
  google_tasks: {
    type: 'google_tasks', displayName: 'Google Tasks', category: 'productivity_comms',
    objectsCovered: ['Tasks', 'Task Lists'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'GOOGLE_CLIENT_ID', clientSecretEnvVar: 'GOOGLE_CLIENT_SECRET',
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: ['https://www.googleapis.com/auth/tasks', 'openid', 'email'], scopeDelimiter: ' ' },
    polling: [{ entityType: 'Task', eventTopics: ['task.created', 'task.updated'], listImplemented: false }],
  },
  // YouTube ships via Composio (composio_managed) to bypass the 2-6 wk
  // Google sensitive-scope verification + tenant-runtime sidecar wiring.
  // Tradeoff: Composio's YouTube toolkit (14 tools) covers Data API
  // basics + video upload + captions + subscriptions but is MISSING the
  // Analytics v2 + Reporting v1 surfaces. The direct sidecar client
  // (src/clients/google-youtube.ts, 24 tools incl. Analytics + Reporting)
  // is kept in place as rollbackSidecar — flip COMPOSIO_DISABLED_CONNECTORS
  // to route through it again if/when Analytics matters more than reach.
  //
  // When/if you switch back to direct, you'll need to:
  //   1. submit Google sensitive-scope verification on the prod OAuth app at
  //      https://console.cloud.google.com/apis/credentials/consent?project=YOUR_CONTROL_PROJECT
  //   2. wire up the tenant-runtime side of /google/youtube
  // See the big comment block above GOOGLE_CONNECTOR_SCOPES in src/types.ts
  // for the full submission checklist and the dev/prod app split.
  youtube: {
    type: 'youtube', displayName: 'YouTube', category: 'social_messaging',
    objectsCovered: ['Videos', 'Channels', 'Playlists', 'Comments'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
      authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev',
      scopes: [], scopeDelimiter: ' ' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'youtube',
      authConfigIds: { dev: 'ac_3mzlp4JsAi9Z', prod: 'ac_LPTLmfH2Sx8P' },
      mcpServerIds: { dev: '6ca1a21f-9b7e-496f-a7cb-22f2dc74fd0f', prod: 'e59afc0c-90a5-4dd5-ae2f-b5ae4079e092' },
      transport: 'streamable-http',
      rollbackSidecar: { sidecarPath: '/google/youtube', allowedEgressDomain: '*.googleapis.com' },
    },
    capabilities: [{ capability: 'social_media', requiredScopes: [] }],
    // Event-only: reactivity comes from YOUTUBE_NEW_PLAYLIST_ITEM_TRIGGER. There is
    // no poll client or normalizer for youtube, so listImplemented stays false (a
    // true flag made the scheduler log "no normalizer — skipping" on every boot).
    polling: [{ entityType: 'Video', eventTopics: ['video.created'], listImplemented: false, eventTrigger: { slug: 'YOUTUBE_NEW_PLAYLIST_ITEM_TRIGGER', triggerConfig: { interval: 1 } } }],
  },

  // ── Microsoft 365 ────────────────────────────────────────────────────
  microsoft_outlook_mail: {
    type: 'microsoft_outlook_mail', displayName: 'Outlook Mail', category: 'productivity_comms',
    objectsCovered: ['Emails', 'Drafts', 'Folders', 'Attachments'], status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
      authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev',
      scopes: [], scopeDelimiter: ' ' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'outlook',
      authConfigIds: { dev: 'ac_0SrSf52RVVxH', prod: 'ac_EJmdrGfJgqvm' },
      mcpServerIds: { dev: '12d49e2a-328b-4184-82a9-043768eea663', prod: '414d09b9-8d29-42fa-9ea3-a396584239f4' },
      transport: 'streamable-http',
      rollbackSidecar: { sidecarPath: '/microsoft/outlook-mail', allowedEgressDomain: '*.microsoft.com' },
    },
    capabilities: [{ capability: 'email_communication', requiredScopes: ['Mail.ReadWrite'] }, { capability: 'support_helpdesk', requiredScopes: ['Mail.ReadWrite'] }],
    historyReads: [
      { entityType: 'conversation', idDescription: 'Outlook conversationId (from message metadata or event payload)', description: 'Read all messages in an Outlook Mail conversation thread by conversationId, returning every message in chronological order.' },
    ],
    polling: [{ entityType: 'Email', eventTopics: ['email.received', 'mail.received'], listImplemented: true, eventTrigger: { slug: 'OUTLOOK_MESSAGE_TRIGGER' } }],
  },
  microsoft_outlook_calendar: {
    type: 'microsoft_outlook_calendar', displayName: 'Outlook Calendar', category: 'meetings_scheduling',
    objectsCovered: ['Events', 'Calendars', 'Availability'], status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'MICROSOFT_CLIENT_ID', clientSecretEnvVar: 'MICROSOFT_CLIENT_SECRET',
      authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      scopes: ['Calendars.ReadWrite', 'offline_access'], scopeDelimiter: ' ' },
    mcp: { kind: 'sidecar', sidecarPath: '/microsoft/outlook-calendar', allowedEgressDomain: '*.microsoft.com' },
    capabilities: [{ capability: 'calendar', requiredScopes: [] }],
    polling: [{ entityType: 'CalendarEvent', eventTopics: ['calendar.event', 'meeting.scheduled', 'calendar.meeting_starting_soon'], listImplemented: true }],
  },
  microsoft_teams: {
    type: 'microsoft_teams', displayName: 'Microsoft Teams', category: 'productivity_comms',
    objectsCovered: ['Channels', 'Messages', 'Teams', 'Meetings'], status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'MICROSOFT_CLIENT_ID', clientSecretEnvVar: 'MICROSOFT_CLIENT_SECRET',
      authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      scopes: ['Team.ReadBasic.All', 'Channel.ReadBasic.All', 'ChannelMessage.Read.All', 'ChatMessage.Send', 'offline_access'], scopeDelimiter: ' ' },
    mcp: { kind: 'sidecar', sidecarPath: '/microsoft/teams', allowedEgressDomain: '*.microsoft.com' },
    historyReads: [
      { entityType: 'messages', idDescription: 'Channel identifier in format "teamId:channelId"', description: 'Read recent messages in a Microsoft Teams channel in chronological order, giving full conversation history.' },
      { entityType: 'thread', idDescription: 'Thread identifier in format "teamId:channelId:messageId"', description: 'Read all replies in a Microsoft Teams message thread by team, channel, and message ID, returning the full reply chain.' },
    ],
    capabilities: [{ capability: 'team_chat', requiredScopes: ['ChatMessage.Send'] }],
    polling: [{ entityType: 'Message', eventTopics: ['teams.message', 'chat.message'], listImplemented: true }],
  },
  microsoft_todo: {
    type: 'microsoft_todo', displayName: 'Microsoft To Do', category: 'productivity_comms',
    objectsCovered: ['Tasks', 'Lists', 'Reminders'], status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'MICROSOFT_CLIENT_ID', clientSecretEnvVar: 'MICROSOFT_CLIENT_SECRET',
      authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      scopes: ['Tasks.ReadWrite', 'offline_access'], scopeDelimiter: ' ' },
    mcp: { kind: 'sidecar', sidecarPath: '/microsoft/todo', allowedEgressDomain: '*.microsoft.com' },
    polling: [{ entityType: 'Task', eventTopics: ['task.created', 'task.updated'], listImplemented: true }],
  },
  microsoft_contacts: {
    type: 'microsoft_contacts', displayName: 'Microsoft Contacts', category: 'productivity_comms',
    objectsCovered: ['Contacts', 'Contact Folders', 'Organizations'], status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'MICROSOFT_CLIENT_ID', clientSecretEnvVar: 'MICROSOFT_CLIENT_SECRET',
      authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      scopes: ['Contacts.ReadWrite', 'offline_access'], scopeDelimiter: ' ' },
    mcp: { kind: 'sidecar', sidecarPath: '/microsoft/contacts', allowedEgressDomain: '*.microsoft.com' },
    polling: [{ entityType: 'Contact', eventTopics: ['contact.created', 'contact.updated'], listImplemented: true }],
  },
  microsoft_onenote: {
    type: 'microsoft_onenote', displayName: 'Microsoft OneNote', category: 'knowledge',
    objectsCovered: ['Notebooks', 'Sections', 'Pages'], status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'MICROSOFT_CLIENT_ID', clientSecretEnvVar: 'MICROSOFT_CLIENT_SECRET',
      authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      scopes: ['Notes.ReadWrite', 'offline_access'], scopeDelimiter: ' ' },
    mcp: { kind: 'sidecar', sidecarPath: '/microsoft/onenote', allowedEgressDomain: '*.microsoft.com' },
    capabilities: [{ capability: 'documents', requiredScopes: ['Notes.Read'] }],
    polling: [{ entityType: 'Page', eventTopics: ['note.created', 'note.updated'], listImplemented: true }],
  },
  microsoft_sharepoint: {
    type: 'microsoft_sharepoint', displayName: 'Microsoft SharePoint', category: 'knowledge',
    objectsCovered: ['Sites', 'Lists', 'Documents', 'Pages'], status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'MICROSOFT_CLIENT_ID', clientSecretEnvVar: 'MICROSOFT_CLIENT_SECRET',
      authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      scopes: ['Sites.ReadWrite.All', 'offline_access'], scopeDelimiter: ' ' },
    mcp: { kind: 'sidecar', sidecarPath: '/microsoft/sharepoint', allowedEgressDomain: '*.microsoft.com' },
    capabilities: [{ capability: 'cloud_storage', requiredScopes: ['Sites.ReadWrite.All'] }],
    polling: [{ entityType: 'Document', eventTopics: ['document.created', 'document.updated'], listImplemented: true }],
  },
  microsoft_planner: {
    type: 'microsoft_planner', displayName: 'Microsoft Planner', category: 'project_management',
    objectsCovered: ['Plans', 'Tasks', 'Buckets', 'Assignments'], status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'MICROSOFT_CLIENT_ID', clientSecretEnvVar: 'MICROSOFT_CLIENT_SECRET',
      authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      scopes: ['Group.ReadWrite.All', 'offline_access'], scopeDelimiter: ' ' },
    mcp: { kind: 'sidecar', sidecarPath: '/microsoft/planner', allowedEgressDomain: '*.microsoft.com' },
    polling: [{ entityType: 'Task', eventTopics: ['task.created', 'task.updated'], listImplemented: true }],
  },
  // Microsoft-Graph analog of google_sheets — live workbook (OneDrive/SharePoint)
  // read+write via Composio's managed OAuth app. Gives the data_table capability
  // a Microsoft provider so the data_table templates work for Microsoft-shop
  // tenants. IDs below are placeholders until `composio:bootstrap-toolkit
  // --slug=excel` is run; until then projections downgrade it to coming_soon.
  microsoft_excel: {
    type: 'microsoft_excel', displayName: 'Microsoft Excel', category: 'productivity_comms',
    objectsCovered: ['Workbooks', 'Worksheets', 'Tables', 'Ranges'], status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
      authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev',
      scopes: [], scopeDelimiter: ' ' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'excel',
      authConfigIds: { dev: 'ac_YNyrwxhb66ta', prod: 'ac_dYOGGNFg28k5' },
      mcpServerIds: { dev: '0bc159a7-f7b0-46cb-b36c-aab025c5dd14', prod: 'cba32424-5efc-4c6a-ae8f-ad27f4a3ea28' },
      transport: 'streamable-http',
      // No rollbackSidecar: Microsoft Excel never shipped a Liftoff sidecar.
    },
    capabilities: [{ capability: 'data_table', requiredScopes: [] }],
  },

  // ── Meetings / Scheduling ────────────────────────────────────────────
  zoom: {
    type: 'zoom', displayName: 'Zoom', category: 'meetings_scheduling',
    objectsCovered: ['Meetings', 'Recordings', 'Users', 'Webinars'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'ZOOM_CLIENT_ID', clientSecretEnvVar: 'ZOOM_CLIENT_SECRET',
      authUrl: 'https://zoom.us/oauth/authorize', tokenUrl: 'https://zoom.us/oauth/token',
      scopes: ['meeting:read', 'meeting:write', 'user:read', 'recording:read'], scopeDelimiter: ' ' },
    mcp: { kind: 'vendor_hosted', mcpUrl: 'https://mcp.zoom.us/mcp', transport: 'streamable-http' },
    capabilities: [{ capability: 'meeting_notes', requiredScopes: ['recording:read'] }],
    polling: [{ entityType: 'MeetingNotes', eventTopics: ['meeting.notes_available'], listImplemented: true }],
  },
  calendly: {
    type: 'calendly', displayName: 'Calendly', category: 'meetings_scheduling',
    objectsCovered: ['Events', 'Invitees', 'Availability'],
    status: 'available',
    auth: { kind: 'dcr_oauth', discoveryBaseUrl: 'https://mcp.calendly.com',
      clientIdEnvVar: 'CALENDLY_CLIENT_ID', clientSecretEnvVar: 'CALENDLY_CLIENT_SECRET',
      scopes: [], scopeDelimiter: ' ' },
    mcp: { kind: 'vendor_hosted', mcpUrl: 'https://mcp.calendly.com/mcp', transport: 'streamable-http' },
    capabilities: [{ capability: 'calendar', requiredScopes: [] }],
    polling: [{ entityType: 'Event', eventTopics: ['meeting.scheduled', 'calendar.event'], listImplemented: true }],
  },
  cal_com: {
    type: 'cal_com', displayName: 'Cal.com', category: 'meetings_scheduling',
    objectsCovered: ['Events', 'Bookings', 'Availability'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
      authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev',
      scopes: [], scopeDelimiter: ' ' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'cal',
      authConfigIds: { dev: 'ac_kBxIA8QRHXvk', prod: 'ac_PQG50X9n2B0n' },
      mcpServerIds: { dev: '7ed30414-2dfb-4ff5-9283-2df2b27cf685', prod: 'cb8f0f22-3bd9-4479-a284-9fb194e88d94' },
      transport: 'streamable-http',
      rollbackSidecar: { sidecarPath: '/cal-com', allowedEgressDomain: '*.cal.com' },
    },
    capabilities: [{ capability: 'calendar', requiredScopes: [] }],
    polling: [{ entityType: 'Event', eventTopics: ['meeting.scheduled', 'calendar.event'], listImplemented: true }],
    multiInstance: true,
  },
  granola: {
    type: 'granola', displayName: 'Granola', category: 'meetings_scheduling',
    objectsCovered: ['Meeting Notes', 'Meetings', 'Transcripts', 'Meeting Folders'],
    status: 'available',
    auth: { kind: 'dcr_oauth', discoveryBaseUrl: 'https://mcp.granola.ai',
      clientIdEnvVar: 'GRANOLA_CLIENT_ID', clientSecretEnvVar: 'GRANOLA_CLIENT_SECRET',
      // email is required for the identity fetcher's userinfo call so we
      // can populate config.externalAccountLabel for the Connected card.
      scopes: ['openid', 'email', 'offline_access'], scopeDelimiter: ' ' },
    mcp: { kind: 'vendor_hosted', mcpUrl: 'https://mcp.granola.ai/mcp', transport: 'streamable-http' },
    capabilities: [{ capability: 'meeting_notes', requiredScopes: [] }],
    polling: [{ entityType: 'MeetingNotes', eventTopics: ['meeting.notes_available'], listImplemented: true }],
  },
  docusign: {
    type: 'docusign', displayName: 'DocuSign', category: 'productivity_comms',
    objectsCovered: ['Envelopes', 'Templates', 'Recipients'],
    status: 'coming_soon',
    statusReason: 'DocuSign Partner Program approval pending. OAuth is fully wired (environment-scoped host + secrets); becomes available once the Partner Program account is approved.',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'DOCUSIGN_CLIENT_ID', clientSecretEnvVar: 'DOCUSIGN_CLIENT_SECRET',
      authUrl: `${DOCUSIGN_OAUTH_HOST}/oauth/auth`, tokenUrl: `${DOCUSIGN_OAUTH_HOST}/oauth/token`,
      scopes: ['signature', 'impersonation'], scopeDelimiter: ' ' },
    mcp: { kind: 'sidecar', sidecarPath: '/docusign', allowedEgressDomain: '*.docusign.net' },
    capabilities: [{ capability: 'e_sign', requiredScopes: [] }],
    polling: [{ entityType: 'Envelope', eventTopics: ['document.signed', 'document.sent'], listImplemented: false }],
  },

  // PandaDoc — e-signature + document automation. Native vendor MCP at
  // mcp.pandadoc.com/v1/mcp (DCR OAuth, PKCE S256, scope 'read+write').
  // Chosen over Composio's pandadoc toolkit because the latter's 14 tools
  // lack send-for-signature / signing-status / reminders — the core e_sign
  // surface. Zero per-call cost (vendor-hosted, not Composio-metered).
  pandadoc: {
    type: 'pandadoc', displayName: 'PandaDoc', category: 'productivity_comms',
    objectsCovered: ['Documents', 'Templates', 'Recipients', 'Signatures'],
    status: 'available',
    auth: { kind: 'dcr_oauth', discoveryBaseUrl: 'https://mcp.pandadoc.com',
      clientIdEnvVar: 'PANDADOC_CLIENT_ID', clientSecretEnvVar: 'PANDADOC_CLIENT_SECRET',
      scopes: ['read+write'], scopeDelimiter: ' ' },
    mcp: { kind: 'vendor_hosted', mcpUrl: 'https://mcp.pandadoc.com/v1/mcp', transport: 'streamable-http' },
    capabilities: [{ capability: 'e_sign', requiredScopes: [] }],
    polling: [{ entityType: 'Document', eventTopics: ['document.signed', 'document.sent'], listImplemented: false }],
  },

  // ── Data / Warehousing ───────────────────────────────────────────────
  google_bigquery: {
    type: 'google_bigquery', displayName: 'BigQuery', category: 'data',
    objectsCovered: ['Datasets', 'Tables', 'Queries'],
    status: 'available',
    // data_warehouse INTENTIONALLY UNBOUND (plan §8/§11/§12): the native client
    // ships in this change, but the keyless connect path (per-tenant SA
    // provisioning §5 + connect UX §3C) is not yet live/E2E-green. Binding a
    // warehouse a tenant cannot actually connect would let a capability-based
    // template assume depth that isn't reachable. Re-bind once §12 E2E passes.
    capabilities: [],
    // Keyless per-tenant model (plan §3C/§5): NO stored secret. The connect flow
    // captures config.projectId + config.serviceAccountEmail (the per-tenant SA
    // the customer grants bigquery.dataViewer + bigquery.jobUser on their
    // project) + optional config.dataset. The native client (clients/bigquery.ts)
    // queries via ADC → per-tenant SA impersonation. Replaces the prior
    // static_oauth Google app (which carried Google OAuth-verification exposure).
    //
    // auth.kind = 'iam_grant' (NOT 'none'): 'none' means instant-connect in the
    // UI (no config, routes to OAuth → broken here); 'iam_grant' routes the
    // connect UI to the grant→verify flow (/api/connectors/bigquery/connect +
    // /verify).
    auth: { kind: 'iam_grant' },
  },
  google_firestore: {
    type: 'google_firestore', displayName: 'Firestore', category: 'data',
    objectsCovered: ['Collections', 'Documents', 'Rules'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'GOOGLE_CLIENT_ID', clientSecretEnvVar: 'GOOGLE_CLIENT_SECRET',
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: ['https://www.googleapis.com/auth/datastore', 'openid', 'email'], scopeDelimiter: ' ' },
  },
  snowflake: {
    type: 'snowflake', displayName: 'Snowflake', category: 'data',
    objectsCovered: ['Databases', 'Schemas', 'Tables', 'Queries'],
    status: 'available',
    capabilities: [{ capability: 'data_warehouse', requiredScopes: [] }],
    auth: { kind: 'keypair' },
    mcp: { kind: 'vendor_hosted',
      // PER_WORKSPACE_TEMPLATE: snowflake URL is per-account; urlResolverKey
      // substitutes the account identifier at call time. This literal is a
      // sentinel — never used as a live endpoint.
      mcpUrl: 'https://placeholder.snowflakecomputing.com/api/2.0/mcp',
      transport: 'streamable-http',
      urlResolverKey: 'snowflake_account' },
  },
  databricks: {
    type: 'databricks', displayName: 'Databricks', category: 'data',
    objectsCovered: ['Notebooks', 'Jobs', 'Clusters', 'SQL Warehouses'],
    status: 'available',
    capabilities: [{ capability: 'data_warehouse', requiredScopes: [] }],
    auth: { kind: 'api_key' },
    mcp: { kind: 'vendor_hosted',
      // PER_WORKSPACE_TEMPLATE: databricks URL is per-workspace; urlResolverKey
      // substitutes the workspace URL at call time. This literal is a
      // sentinel — never used as a live endpoint.
      mcpUrl: 'https://placeholder.azuredatabricks.net/api/2.0/mcp/sql',
      transport: 'streamable-http',
      urlResolverKey: 'databricks_workspace' },
  },

  // ── Knowledge ────────────────────────────────────────────────────────
  notion: {
    type: 'notion', displayName: 'Notion', category: 'knowledge',
    objectsCovered: ['Pages', 'Databases', 'Comments'],
    status: 'available',
    auth: { kind: 'dcr_oauth', discoveryBaseUrl: 'https://mcp.notion.com',
      clientIdEnvVar: 'NOTION_CLIENT_ID', clientSecretEnvVar: 'NOTION_CLIENT_SECRET',
      scopes: [], scopeDelimiter: ' ' },
    mcp: { kind: 'vendor_hosted', mcpUrl: 'https://mcp.notion.com/mcp', transport: 'streamable-http' },
    capabilities: [{ capability: 'documents', requiredScopes: [] }, { capability: 'data_table', requiredScopes: [] }],
    polling: [{ entityType: 'Page', eventTopics: ['document.created', 'document.updated'], listImplemented: true }],
  },

  // Clay.com — GTM data enrichment & prospecting (find/enrich ICP contacts, account research,
  // Clay Functions). MCP at api.clay.com/v3/mcp; DCR-OAuth, scope 'mcp', PKCE S256. Seed env vars
  // are optional fallbacks (local dev) — prod uses pure dynamic client registration.
  // NOTE: agent-callable tools require a CLAY_FUNCTIONS registry entry authored from the live tool
  // list, which is enumerated after the first authenticated connect (tools/list is OAuth-gated).
  clay: {
    type: 'clay', displayName: 'Clay', category: 'crm_sales',
    objectsCovered: ['Contacts', 'Accounts', 'Enrichment'],
    status: 'available',
    auth: { kind: 'dcr_oauth', discoveryBaseUrl: 'https://api.clay.com',
      clientIdEnvVar: 'CLAY_CLIENT_ID', clientSecretEnvVar: 'CLAY_CLIENT_SECRET',
      scopes: ['mcp'], scopeDelimiter: ' ' },
    mcp: { kind: 'vendor_hosted', mcpUrl: 'https://api.clay.com/v3/mcp', transport: 'streamable-http' },
    capabilities: [{ capability: 'crm', requiredScopes: ['mcp'] }, { capability: 'enrichment', requiredScopes: ['mcp'] }],
  },

  // Mesh (formerly Clay.earth, now me.sh — Automattic) — personal relationship / contact manager.
  // This is the integration that previously shipped mislabeled as the "clay" connector.
  mesh: {
    type: 'mesh', displayName: 'Mesh', category: 'crm_sales',
    objectsCovered: ['Contacts', 'Groups', 'Interactions', 'Notes', 'Events'],
    status: 'available',
    auth: { kind: 'dcr_oauth', discoveryBaseUrl: 'https://mcp.clay.earth',
      clientIdEnvVar: 'MESH_CLIENT_ID', clientSecretEnvVar: 'MESH_CLIENT_SECRET',
      scopes: ['read', 'write'], scopeDelimiter: ' ' },
    mcp: { kind: 'vendor_hosted', mcpUrl: 'https://mcp.clay.earth/mcp', transport: 'streamable-http' },
    capabilities: [{ capability: 'crm', requiredScopes: ['read'] }],
    polling: [{ entityType: 'Contact', eventTopics: ['contact.created', 'contact.updated'], listImplemented: false }],
  },

  // ── Observability ────────────────────────────────────────────────────
  datadog: {
    type: 'datadog', displayName: 'Datadog', category: 'observability',
    objectsCovered: ['Metrics', 'Logs', 'Traces', 'Alerts'],
    status: 'available',
    // Datadog's DCR OAuth is unusable (account-locked client with an
    // unrecoverable redirect_uri), so we collect the user's API key +
    // application key + region. Those credentials are submitted to Composio
    // (auth.kind 'api_key' → ConnectApiKeyModal; the connect handler routes
    // composio_managed connectors to connectedAccounts.initiate instead of
    // Secret Manager). Composio exposes the full 42-tool Datadog surface to
    // agents, and reactive Alert polling runs through the DATADOG_LIST_EVENTS
    // action (see polling/scheduler.ts) since Composio has no Datadog trigger.
    auth: { kind: 'api_key' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'datadog',
      authConfigIds: { dev: 'ac_6decd1KVljJU', prod: 'ac_UsMcLzxqtQcI' },
      mcpServerIds: { dev: '222ebce9-1a2b-4a70-8364-26bf881a028f', prod: 'b70027f9-5b1e-4ee1-94ee-06983945ba8a' },
      transport: 'streamable-http',
    },
    capabilities: [{ capability: 'error_tracking', requiredScopes: ['metrics:read', 'events:read'] }],
    polling: [{ entityType: 'Alert', eventTopics: ['alert.fired'], listImplemented: true }],
  },
  sentry: {
    type: 'sentry', displayName: 'Sentry', category: 'observability',
    objectsCovered: ['Errors', 'Issues', 'Releases', 'Performance'],
    status: 'available',
    auth: { kind: 'api_key' },
    mcp: { kind: 'vendor_hosted', mcpUrl: 'https://mcp.sentry.dev/mcp', transport: 'streamable-http' },
    capabilities: [{ capability: 'error_tracking', requiredScopes: ['event:read', 'project:read', 'issue:read'] }],
    polling: [{ entityType: 'Issue', eventTopics: ['error.detected', 'issue.created'], listImplemented: true }],
  },
  // coming_soon — see "Composio-managed coming_soon batch" notes below the HR / ATS block.
  pagerduty: {
    type: 'pagerduty', displayName: 'PagerDuty', category: 'observability',
    objectsCovered: ['Incidents', 'Services', 'Escalation Policies', 'On-Call Schedules'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
      authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev',
      scopes: [], scopeDelimiter: ' ' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'pagerduty',
      authConfigIds: { dev: 'ac_a6uVS-H4OslR', prod: 'ac_KfvM3qsQu5aO' },
      mcpServerIds: { dev: 'c7b46c19-460f-44d1-b347-b2233505a51f', prod: '64d70bed-cb3f-426d-8ac4-0921b6d0980f' },
      transport: 'streamable-http',
      rollbackSidecar: { sidecarPath: '/pagerduty', allowedEgressDomain: '*.pagerduty.com' },
    },
    capabilities: [{ capability: 'incident_management', requiredScopes: [] }],
    polling: [{ entityType: 'Incident', eventTopics: ['incident.triggered', 'incident.resolved'], listImplemented: true }],
    multiInstance: true,
  },

  // ── Marketing / Communications ───────────────────────────────────────
  meta_ads: {
    type: 'meta_ads',
    displayName: 'Meta Ads',
    description: 'Manage campaigns, ad sets, ads, and audiences across Facebook, Instagram, and Messenger.',
    category: 'marketing_comms',
    objectsCovered: ['Campaigns', 'Ad Sets', 'Ads', 'Audiences', 'Performance Reports'],
    status: 'coming_soon',
    statusReason: 'Meta (Facebook) OAuth app registration pending at developers.facebook.com',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'META_CLIENT_ID', clientSecretEnvVar: 'META_CLIENT_SECRET',
      authUrl: 'https://www.facebook.com/dialog/oauth', tokenUrl: 'https://graph.facebook.com/oauth/access_token',
      scopes: ['ads_read', 'ads_management', 'business_management', 'leads_retrieval'], scopeDelimiter: ',' },
    mcp: { kind: 'vendor_hosted', mcpUrl: 'https://mcp.facebook.com/sse', transport: 'sse' },
  },
  mailchimp: {
    type: 'mailchimp', displayName: 'Mailchimp', category: 'marketing_comms',
    objectsCovered: ['Campaigns', 'Lists', 'Subscribers', 'Templates'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
      authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev',
      scopes: [], scopeDelimiter: ' ' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'mailchimp',
      authConfigIds: { dev: 'ac_az2QxZFS1r_x', prod: 'ac_7F36UqUiP7UE' },
      mcpServerIds: { dev: '352f2476-cb55-4819-af2b-ffdd3bdfcbaf', prod: '8bdbc52d-a2c6-4263-b0eb-a36d9d811f1f' },
      transport: 'streamable-http',
      rollbackSidecar: { sidecarPath: '/mailchimp', allowedEgressDomain: '*.api.mailchimp.com' },
    },
    capabilities: [{ capability: 'email_marketing', requiredScopes: [] }],
    polling: [
      { entityType: 'Campaign', eventTopics: ['campaign.sent'], listImplemented: true },
      { entityType: 'Subscriber', eventTopics: ['subscriber.created'], listImplemented: false, eventTrigger: { slug: 'MAILCHIMP_SUBSCRIBE_TRIGGER' } },
    ],
    multiInstance: true,
  },
  sendgrid: {
    type: 'sendgrid', displayName: 'SendGrid', category: 'marketing_comms',
    objectsCovered: ['Emails', 'Templates', 'Contacts', 'Lists'],
    status: 'available',
    auth: { kind: 'api_key' },
    mcp: { kind: 'sidecar', sidecarPath: '/sendgrid', allowedEgressDomain: '*.sendgrid.com' },
    capabilities: [{ capability: 'email_marketing', requiredScopes: ['mail.send', 'mail.read'] }],
    polling: [{ entityType: 'Contact', eventTopics: ['contact.created', 'contact.updated'], listImplemented: true }],
  },
  instantly: {
    // Poll-reactive via durableCursor (starting_after forward cursor persisted across cycles) — see composio-poll-spec.ts.
    type: 'instantly', displayName: 'Instantly', category: 'marketing_comms',
    objectsCovered: ['Campaigns', 'Leads', 'Email Accounts', 'Analytics'],
    status: 'available',
    // Composio-managed via API_KEY (user supplies their Instantly API key).
    auth: { kind: 'api_key' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'instantly',
      authConfigIds: { dev: 'ac_ltBPoKouh1N8', prod: 'ac_T_DSN8YNCs_e' },
      mcpServerIds: { dev: '55dce809-5999-4a66-a75c-5bc340ea01a2', prod: 'db4b6115-aa01-4148-880c-739d5c8193f3' },
      transport: 'streamable-http',
    },
    capabilities: [{ capability: 'email_marketing', requiredScopes: [] }],
    polling: [{ entityType: 'Lead', eventTopics: ['lead.created'], listImplemented: true }],
  },
  smartlead: {
    type: 'smartlead', displayName: 'Smartlead', category: 'marketing_comms',
    objectsCovered: ['Campaigns', 'Leads', 'Email Accounts', 'Analytics'],
    status: 'coming_soon',
    statusReason: 'Smartlead API integration pending (api.smartlead.ai)',
    auth: { kind: 'api_key' },
    mcp: { kind: 'sidecar', sidecarPath: '/smartlead', allowedEgressDomain: '*.smartlead.ai' },
    capabilities: [{ capability: 'email_marketing', requiredScopes: [] }],
  },
  marketo: {
    type: 'marketo', displayName: 'Marketo', category: 'marketing_comms',
    objectsCovered: ['Leads', 'Campaigns', 'Programs', 'Email Templates', 'Lists'],
    status: 'coming_soon',
    statusReason: 'Marketo OAuth app registration pending (developers.marketo.com)',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'MARKETO_CLIENT_ID', clientSecretEnvVar: 'MARKETO_CLIENT_SECRET',
      authUrl: 'https://MUNCHKIN.mktoweb.com/oauth/authorize', tokenUrl: 'https://MUNCHKIN.mktoweb.com/oauth/token',
      scopes: ['read_lead', 'read_activity', 'read_campaign'], scopeDelimiter: ' ' },
    mcp: { kind: 'sidecar', sidecarPath: '/marketo', allowedEgressDomain: '*.mktoweb.com' },
    capabilities: [{ capability: 'email_marketing', requiredScopes: ['read_lead', 'read_campaign'] }],
    polling: [{ entityType: 'Lead', eventTopics: ['lead.created', 'contact.created'], listImplemented: false }],
  },
  linkedin: {
    type: 'linkedin', displayName: 'LinkedIn', category: 'social_messaging',
    // Scope reflects Composio's actual toolkit — organic posting + comments
    // + org page management + organic analytics + ad-targeting metadata.
    // InMail / Sales Navigator / Recruiter / Marketing Developer Platform
    // campaign CRUD are NOT in this toolkit — those sit behind LinkedIn
    // partner programs that Composio doesn't bridge. Agents that need
    // those will still hit a wall here, but this is enough for organic-
    // social and ad-research workflows.
    objectsCovered: ['Posts', 'Comments', 'Profile', 'Organization Pages', 'Page Analytics', 'Ad Targeting Facets'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
      authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev',
      scopes: [], scopeDelimiter: ' ' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'linkedin',
      authConfigIds: { dev: 'ac_gVoUF7jquIDy', prod: 'ac_I9AGsqpNtkMo' },
      mcpServerIds: { dev: 'd410fdb6-963a-4916-9699-cdbe2046e43e', prod: '1242a40c-26f2-4210-89f0-f0f0e4fc1a94' },
      transport: 'streamable-http',
      // No rollbackSidecar — Liftoff has never operated a LinkedIn sidecar
      // (LinkedIn OAuth + ToS make a custom REST path more trouble than
      // it's worth). If Composio LinkedIn becomes unusable, disabling via
      // COMPOSIO_DISABLED_CONNECTORS marks the entry disabled rather than
      // falling back.
    },
    multiInstance: true,
  },
  // Meta-platform + YouTube — coming_soon Composio-managed batch.
  // Bypasses Meta App Review (Facebook/Instagram/WhatsApp) and Google sensitive-scope
  // audit (YouTube). These are the canonical "bypass app review" wins.
  facebook: {
    type: 'facebook', displayName: 'Facebook', category: 'social_messaging',
    objectsCovered: ['Pages', 'Posts', 'Ads', 'Insights'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
      authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev',
      scopes: [], scopeDelimiter: ' ' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'facebook',
      authConfigIds: { dev: 'ac_wQmZmCzZUqbC', prod: 'ac_zT33Zi8W6aDO' },
      mcpServerIds: { dev: '9aa24c3a-ce20-460d-8ff0-e4e6e49fb12a', prod: 'f0e8a8b8-620a-4acd-9375-edb7eb9591f3' },
      transport: 'streamable-http',
      rollbackSidecar: { sidecarPath: '/facebook', allowedEgressDomain: 'graph.facebook.com' },
    },
    capabilities: [{ capability: 'social_media', requiredScopes: [] }],
    // Not poll-addressable via the generic Composio poller: FACEBOOK_GET_PAGE_POSTS
    // requires a page_id (no global "my feed") the poller can't supply.
    polling: [{ entityType: 'Post', eventTopics: ['post.created'], listImplemented: false }],
    multiInstance: true,
  },
  instagram: {
    type: 'instagram', displayName: 'Instagram', category: 'social_messaging',
    objectsCovered: ['Media', 'Comments', 'Stories', 'Insights'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
      authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev',
      scopes: [], scopeDelimiter: ' ' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'instagram',
      authConfigIds: { dev: 'ac_PihblTBHOWu0', prod: 'ac_Q0uDc2PWsEV1' },
      mcpServerIds: { dev: '2efb8411-6cad-4ec5-a8d2-a0af64cee7bb', prod: '08ddc17a-3fbd-488e-bc46-29bd41934199' },
      transport: 'streamable-http',
      rollbackSidecar: { sidecarPath: '/instagram', allowedEgressDomain: 'graph.instagram.com' },
    },
    capabilities: [{ capability: 'social_media', requiredScopes: [] }],
    polling: [{ entityType: 'Media', eventTopics: ['post.created'], listImplemented: true }],
    multiInstance: true,
  },
  reddit: {
    type: 'reddit', displayName: 'Reddit', category: 'social_messaging',
    objectsCovered: ['Posts', 'Comments', 'Subreddits'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
      authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev',
      scopes: [], scopeDelimiter: ' ' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'reddit',
      authConfigIds: { dev: 'ac_YyvX0LRKDFpk', prod: 'ac_2_RDWsysKe7T' },
      mcpServerIds: { dev: '65ed2f5c-df02-47a8-ba36-688dda7f0bb8', prod: '9804dc75-1c89-4a47-bc52-a77e8be74974' },
      transport: 'streamable-http',
    },
    capabilities: [{ capability: 'social_media', requiredScopes: [] }],
    // Not poll-addressable via the generic Composio poller: Composio exposes no
    // global "authenticated user's posts" action — every post-list action needs a
    // subreddit/search arg the poller can't supply. The event topic declares intent.
    polling: [{ entityType: 'Post', eventTopics: ['post.created'], listImplemented: false }],
    multiInstance: true,
  },
  clickup: {
    type: 'clickup', displayName: 'ClickUp', category: 'project_management',
    objectsCovered: ['Tasks', 'Lists', 'Docs', 'Spaces'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
      authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev',
      scopes: [], scopeDelimiter: ' ' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'clickup',
      authConfigIds: { dev: 'ac_i-RzsecNk77s', prod: 'ac_HZwheONRy_WI' },
      mcpServerIds: { dev: '9a293b0b-fb51-460a-8e5f-ddafe36d05b1', prod: '5a4a5a94-f2e0-42d1-9ac3-589bfc4b7e56' },
      transport: 'streamable-http',
    },
    capabilities: [{ capability: 'project_management', requiredScopes: [] }],
    // Event-driven via the Composio CLICKUP_TASK_CREATED trigger.
    polling: [{ entityType: 'Task', eventTopics: ['task.created'], listImplemented: false, eventTrigger: { slug: 'CLICKUP_TASK_CREATED' } }],
  },
  todoist: {
    type: 'todoist', displayName: 'Todoist', category: 'project_management',
    objectsCovered: ['Tasks', 'Projects', 'Labels'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
      authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev',
      scopes: [], scopeDelimiter: ' ' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'todoist',
      authConfigIds: { dev: 'ac_iuf9wlBkTuwZ', prod: 'ac_VkvEhDWFJlYl' },
      mcpServerIds: { dev: 'b03039a1-3074-4f57-9268-e356ad819002', prod: 'd5438e77-d5c0-4db1-874d-0b42e033c48e' },
      transport: 'streamable-http',
    },
    capabilities: [{ capability: 'project_management', requiredScopes: [] }],
    // Event-driven via the Composio TODOIST_NEW_TASK_CREATED trigger.
    polling: [{ entityType: 'Task', eventTopics: ['task.created'], listImplemented: false, eventTrigger: { slug: 'TODOIST_NEW_TASK_CREATED' } }],
  },
  greenhouse: {
    type: 'greenhouse', displayName: 'Greenhouse', category: 'hr',
    objectsCovered: ['Candidates', 'Jobs', 'Applications', 'Scorecards'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
      authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev',
      scopes: [], scopeDelimiter: ' ' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'greenhouse',
      authConfigIds: { dev: 'ac_lI--rc8wym7P', prod: 'ac_AeJTDQL7HnfS' },
      mcpServerIds: { dev: '66b316f2-0058-402c-85bd-542eff5ce488', prod: 'c45bb95a-38f1-4e79-b3bd-076a2f19af9d' },
      transport: 'streamable-http',
    },
    capabilities: [{ capability: 'ats', requiredScopes: [] }],
    // Generic poller (GREENHOUSE_LIST_CANDIDATES) — see composio-poll-spec.ts.
    polling: [{ entityType: 'Candidate', eventTopics: ['candidate.created', 'candidate.updated'], listImplemented: true }],
  },
  fathom: {
    type: 'fathom', displayName: 'Fathom', category: 'meetings_scheduling',
    objectsCovered: ['Recordings', 'Transcripts', 'Summaries'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
      authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev',
      scopes: [], scopeDelimiter: ' ' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'fathom',
      authConfigIds: { dev: 'ac_FQZUJaH5bTUS', prod: 'ac_Ob8X8eosb4gG' },
      mcpServerIds: { dev: '967b8048-1828-4c9c-ba7d-ff002c540b81', prod: 'b4bd5317-7c3c-4f10-9138-73f0969fa75c' },
      transport: 'streamable-http',
    },
    capabilities: [{ capability: 'meeting_notes', requiredScopes: [] }, { capability: 'conversation_intelligence', requiredScopes: [] }],
    polling: [{ entityType: 'Meeting', eventTopics: ['meeting.created'], listImplemented: true }],
  },
  gumroad: {
    type: 'gumroad', displayName: 'Gumroad', category: 'e_commerce',
    objectsCovered: ['Products', 'Sales', 'Subscribers'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
      authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev',
      scopes: [], scopeDelimiter: ' ' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'gumroad',
      authConfigIds: { dev: 'ac_j3kVcoj3pL0m', prod: 'ac_lMpdIDPwBjgp' },
      mcpServerIds: { dev: 'f6c88f69-9577-4647-8b93-7658706cbba8', prod: '134b75c3-b602-4b18-9310-78dff266b570' },
      transport: 'streamable-http',
    },
    capabilities: [{ capability: 'e_commerce', requiredScopes: [] }],
    polling: [{ entityType: 'Sale', eventTopics: ['sale.created'], listImplemented: true }],
  },
  freshdesk: {
    type: 'freshdesk', displayName: 'Freshdesk', category: 'customer_support',
    objectsCovered: ['Tickets', 'Contacts', 'Agents'],
    status: 'available',
    auth: { kind: 'api_key' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'freshdesk',
      authConfigIds: { dev: 'ac_N6Wj2tREQ-8S', prod: 'ac_vmd6PJZwQHzn' },
      mcpServerIds: { dev: 'e16a96f8-6310-41fb-890e-6077635398ba', prod: '40aac5b4-837b-48de-9edc-2a40948a1a31' },
      transport: 'streamable-http',
    },
    capabilities: [{ capability: 'support_helpdesk', requiredScopes: [] }, { capability: 'support_ticketing', requiredScopes: [] }],
    polling: [{ entityType: 'Ticket', eventTopics: ['ticket.created', 'ticket.updated'], listImplemented: true }],
  },
  ashby: {
    // Poll-reactive via durableCursor (Ashby syncToken delta sync — creates + updates) — see composio-poll-spec.ts.
    type: 'ashby', displayName: 'Ashby', category: 'hr',
    objectsCovered: ['Candidates', 'Jobs', 'Interviews'],
    status: 'available',
    auth: { kind: 'api_key' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'ashby',
      authConfigIds: { dev: 'ac_5PHTj-nhoErb', prod: 'ac_gd4f4HrC1nUa' },
      mcpServerIds: { dev: 'e6773744-0d47-4c4f-b890-bdae82f31906', prod: 'cde7ca0c-07ad-46dc-9582-feacb0e6b2c2' },
      transport: 'streamable-http',
    },
    capabilities: [{ capability: 'ats', requiredScopes: [] }],
    polling: [{ entityType: 'Candidate', eventTopics: ['candidate.created', 'candidate.updated'], listImplemented: true }],
  },
  coda: {
    type: 'coda', displayName: 'Coda', category: 'knowledge',
    objectsCovered: ['Docs', 'Tables', 'Rows'],
    status: 'available',
    auth: { kind: 'api_key' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'coda',
      authConfigIds: { dev: 'ac_6nF7zlZk5VSB', prod: 'ac_u8JZsLR0M6iw' },
      mcpServerIds: { dev: '145b1275-a74d-4cb4-87cc-a12cb11bb237', prod: 'dfc37253-5d29-461f-ab67-3b39d8bab50d' },
      transport: 'streamable-http',
    },
    capabilities: [{ capability: 'documents', requiredScopes: [] }, { capability: 'data_table', requiredScopes: [] }],
    // Event-driven via the Composio CODA_NEW_CODA_PAGE trigger.
    polling: [{ entityType: 'Page', eventTopics: ['document.created'], listImplemented: false, eventTrigger: { slug: 'CODA_NEW_CODA_PAGE' } }],
  },
  missive: {
    type: 'missive', displayName: 'Missive', category: 'productivity_comms',
    objectsCovered: ['Conversations', 'Messages', 'Contacts'],
    status: 'available',
    auth: { kind: 'api_key' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'missive',
      authConfigIds: { dev: 'ac_QZ4Du7mxwSTz', prod: 'ac_h29G5Y05Crp5' },
      mcpServerIds: { dev: '8ddc9c0c-a108-45bb-97b7-11fa1fcda80c', prod: '27c35053-8af7-4673-ba9e-1a1d0f640337' },
      transport: 'streamable-http',
    },
    capabilities: [{ capability: 'email_communication', requiredScopes: [] }],
    polling: [{ entityType: 'Conversation', eventTopics: ['conversation.created', 'conversation.updated'], listImplemented: true }],
  },
  shopify: {
    type: 'shopify', displayName: 'Shopify', category: 'e_commerce',
    objectsCovered: ['Orders', 'Products', 'Customers'],
    status: 'available',
    auth: { kind: 'api_key' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'shopify',
      authConfigIds: { dev: 'ac_7FZwaIWwkyWc', prod: 'ac_gwGP7pb2T1cI' },
      mcpServerIds: { dev: 'ce38e285-a6dd-462b-8a0e-9b61a1c47dae', prod: 'afb8e219-dd6b-4dde-947c-808a54a06a31' },
      transport: 'streamable-http',
    },
    capabilities: [{ capability: 'e_commerce', requiredScopes: [] }],
    polling: [{ entityType: 'Order', eventTopics: ['order.created', 'order.updated'], listImplemented: true }],
  },
  fireflies: {
    type: 'fireflies', displayName: 'Fireflies', category: 'meetings_scheduling',
    objectsCovered: ['Transcripts', 'Meetings', 'Summaries'],
    status: 'available',
    auth: { kind: 'api_key' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'fireflies',
      authConfigIds: { dev: 'ac_xVWCex4KavAq', prod: 'ac_nQMlWinwBaK6' },
      mcpServerIds: { dev: '4369bcc6-e3d8-4435-8d3f-2719b0ad75a4', prod: '0cb6bafc-b877-41f9-a022-606817aab535' },
      transport: 'streamable-http',
    },
    capabilities: [{ capability: 'meeting_notes', requiredScopes: [] }, { capability: 'conversation_intelligence', requiredScopes: [] }],
    // Event-driven via the Composio FIREFLIES_TRANSCRIPTION_COMPLETE trigger.
    polling: [{ entityType: 'MeetingNotes', eventTopics: ['meeting.notes_available'], listImplemented: false, eventTrigger: { slug: 'FIREFLIES_TRANSCRIPTION_COMPLETE' } }],
  },
  close: {
    type: 'close', displayName: 'Close', category: 'crm_sales',
    objectsCovered: ['Leads', 'Contacts', 'Opportunities', 'Activities'],
    status: 'available',
    auth: { kind: 'api_key' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'close',
      authConfigIds: { dev: 'ac_YfRBl5uT6UFb', prod: 'ac_T3KVag3VKOE-' },
      mcpServerIds: { dev: '7bdaa4b9-8e24-4176-9345-1fb56601bb09', prod: '31e0a969-d9b1-4ff4-bf28-582eb7c177b5' },
      transport: 'streamable-http',
    },
    capabilities: [{ capability: 'crm', requiredScopes: [] }],
    // Composio ships no list action for Close leads/contacts, so reactive
    // polling routes through the Composio HTTP proxy (raw GET /api/v1/lead/).
    polling: [
      { entityType: 'Lead', eventTopics: ['lead.created'], listImplemented: true },
      { entityType: 'Contact', eventTopics: ['contact.created', 'contact.updated'], listImplemented: true },
    ],
  },
  browseai: {
    type: 'browseai', displayName: 'Browse AI', category: 'web_tools',
    objectsCovered: ['Robots', 'Tasks', 'Captures'],
    status: 'available',
    auth: { kind: 'api_key' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'browseai',
      authConfigIds: { dev: 'ac_645LX9NxIBGt', prod: 'ac_DPSlKuCZAzpq' },
      mcpServerIds: { dev: 'e4c28bf3-4411-4086-9fae-16a40f1dc7b9', prod: '2c37c03b-fa98-401d-849e-65ca50b1c2d1' },
      transport: 'streamable-http',
    },
    capabilities: [{ capability: 'web_scraping', requiredScopes: [] }],
  },
  documint: {
    type: 'documint', displayName: 'Documint', category: 'productivity_comms',
    objectsCovered: ['Templates', 'Documents'],
    status: 'available',
    auth: { kind: 'api_key' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'documint',
      authConfigIds: { dev: 'ac_riWZlhY37aR_', prod: 'ac_pTpY2NRxnRvR' },
      mcpServerIds: { dev: '7c0a28f9-a663-4376-8a2d-359d990e679c', prod: '6581eb9b-9683-40ff-8be2-7015de5da6e8' },
      transport: 'streamable-http',
    },
    capabilities: [{ capability: 'documents', requiredScopes: [] }],
  },
  posthog: {
    type: 'posthog', displayName: 'PostHog', category: 'data',
    objectsCovered: ['Insights', 'Events', 'Cohorts', 'Feature Flags', 'Experiments'],
    status: 'available',
    auth: { kind: 'api_key' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'posthog',
      authConfigIds: { dev: 'ac_AVRZV0-hMSI5', prod: 'ac_mDdZbO7KqSxz' },
      mcpServerIds: { dev: '7fbe83e8-9681-473d-983e-9d1c34390ec6', prod: '1f001eda-f855-4f21-983a-9d78a84cd5e5' },
      transport: 'streamable-http',
    },
    capabilities: [{ capability: 'product_analytics', requiredScopes: [] }],
  },
  mixpanel: {
    type: 'mixpanel', displayName: 'Mixpanel', category: 'data',
    objectsCovered: ['Events', 'Funnels', 'Retention', 'Cohorts', 'Insights'],
    status: 'available',
    // Composio-managed via BASIC auth (user supplies a Mixpanel service-account
    // username + secret; Composio sends the Basic header).
    auth: { kind: 'api_key' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'mixpanel',
      authConfigIds: { dev: 'ac_FH2kCD1_Nvzb', prod: 'ac_MVlRApZHMmmg' },
      mcpServerIds: { dev: 'dd6c3ee0-7c25-4be5-8e35-fdcd144fb40a', prod: '2fac26ad-2a4c-4e0d-9f5c-a154ebfa292d' },
      transport: 'streamable-http',
    },
    capabilities: [{ capability: 'product_analytics', requiredScopes: [] }],
  },
  whatsapp: {
    type: 'whatsapp', displayName: 'WhatsApp', category: 'social_messaging',
    objectsCovered: ['Messages', 'Templates', 'Contacts'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
      authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev',
      scopes: [], scopeDelimiter: ' ' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'whatsapp',
      authConfigIds: { dev: 'ac_7AtR-efi184J', prod: 'ac_ejxp_mPukkFr' },
      mcpServerIds: { dev: '9d1e29c4-9027-43a1-ac8a-1537fe0b08f5', prod: 'fac5f3ec-6ada-46ef-9a8b-3e44f51ac311' },
      transport: 'streamable-http',
      rollbackSidecar: { sidecarPath: '/whatsapp', allowedEgressDomain: 'graph.facebook.com' },
    },
    capabilities: [{ capability: 'messaging', requiredScopes: [] }],
    polling: [{ entityType: 'Message', eventTopics: ['message.received'], listImplemented: false, eventTrigger: { slug: 'WHATSAPP_MESSAGE_STATUS_UPDATED_TRIGGER' } }],
    multiInstance: true,
  },
  // youtube: deferred to the Google scope-extension batch (alongside
  // google_analytics and google_search_console). Keeping it on our existing
  // GOOGLE_CLIENT_ID app trades 2-6 wk Google sensitive-scope review for a
  // consent screen that says "Liftoff" instead of "Composio.dev".

  // ── Project Management ───────────────────────────────────────────────
  asana: {
    type: 'asana', displayName: 'Asana', category: 'project_management',
    objectsCovered: ['Tasks', 'Projects', 'Workspaces'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'ASANA_CLIENT_ID', clientSecretEnvVar: 'ASANA_CLIENT_SECRET',
      authUrl: 'https://app.asana.com/-/oauth_authorize',
      tokenUrl: 'https://app.asana.com/-/oauth_token',
      scopes: ['default'], scopeDelimiter: ' ', requiresPkce: true },
    mcp: { kind: 'vendor_hosted', mcpUrl: 'https://mcp.asana.com/v2/mcp', transport: 'streamable-http' },
    capabilities: [{ capability: 'project_management', requiredScopes: ['default'] }],
    polling: [{ entityType: 'Task', eventTopics: ['task.created', 'task.updated'], listImplemented: true }],
  },
  trello: {
    type: 'trello', displayName: 'Trello', category: 'project_management',
    objectsCovered: ['Boards', 'Lists', 'Cards'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
      authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev',
      scopes: [], scopeDelimiter: ' ' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'trello',
      authConfigIds: { dev: 'ac_zEq8Yq83pqra', prod: 'ac_y7FilGoAqwoD' },
      mcpServerIds: { dev: 'b6c2aaec-961f-4417-bb76-7461f5cfd1e0', prod: 'fd02aff4-3c43-4443-b2b2-d2bdd7f6b7ba' },
      transport: 'streamable-http',
      rollbackSidecar: { sidecarPath: '/trello', allowedEgressDomain: '*.trello.com' },
    },
    capabilities: [{ capability: 'project_management', requiredScopes: [] }],
    polling: [{ entityType: 'Card', eventTopics: ['task.created', 'task.updated'], listImplemented: false, eventTrigger: { slug: 'TRELLO_NEW_CARD_TRIGGER' } }],
    multiInstance: true,
  },

  // Net-new Composio-managed addition.
  airtable: {
    type: 'airtable', displayName: 'Airtable', category: 'data',
    objectsCovered: ['Bases', 'Tables', 'Records', 'Views'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
      authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev',
      scopes: [], scopeDelimiter: ' ' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'airtable',
      authConfigIds: { dev: 'ac_EPJh4VJxt_vg', prod: 'ac_jhTbxhrdcvpo' },
      mcpServerIds: { dev: '22b5ed69-3fe7-4f4a-8ba6-b77977c22011', prod: '9f92280d-bcde-4a62-8a23-42ba1572d992' },
      transport: 'streamable-http',
    },
    capabilities: [{ capability: 'data_table', requiredScopes: [] }],
    // No reactive path (record.* declares intent only): Composio ships NO
    // record-level Airtable trigger — only base/schema/view metadata triggers
    // (AIRTABLE_BASE_SCHEMA_CHANGED_TRIGGER, AIRTABLE_VIEW_CREATED_TRIGGER, ...),
    // none of which fire on record create/update. And poll-listing records
    // (AIRTABLE_LIST_RECORDS) requires base_id + table_id scope the generic poller
    // can't supply. Flip when Composio adds a record trigger.
    polling: [{ entityType: 'Record', eventTopics: ['record.created', 'record.updated'], listImplemented: false }],
    multiInstance: true,
  },

  // Net-new Composio-managed addition.
  typeform: {
    type: 'typeform', displayName: 'Typeform', category: 'marketing_comms',
    objectsCovered: ['Forms', 'Responses', 'Webhooks'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
      authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev',
      scopes: [], scopeDelimiter: ' ' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'typeform',
      authConfigIds: { dev: 'ac_RtVSES7cIF4C', prod: 'ac_e8MI97NJR3Ni' },
      mcpServerIds: { dev: '24c64153-e291-4974-a866-ea0aee45ca41', prod: '7c12ea19-b0fd-4205-aef3-9949d088a89d' },
      transport: 'streamable-http',
    },
    polling: [{ entityType: 'FormResponse', eventTopics: ['form.response'], listImplemented: false, eventTrigger: { slug: 'TYPEFORM_NEW_RESPONSE' } }],
    multiInstance: true,
  },

  // Net-new Composio-managed addition.
  discord: {
    type: 'discord', displayName: 'Discord', category: 'productivity_comms',
    objectsCovered: ['Servers', 'Channels', 'Messages', 'Members'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
      authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev',
      scopes: [], scopeDelimiter: ' ' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'discord',
      authConfigIds: { dev: 'ac_zx6DpKxWKnZN', prod: 'ac_sDIe_21UFHEN' },
      mcpServerIds: { dev: '5981357c-dbd0-4f8b-bb8e-2a4a35ca6e88', prod: 'd8a4eab1-600c-4f92-975b-6b03a45f7e88' },
      transport: 'streamable-http',
    },
    capabilities: [{ capability: 'team_chat', requiredScopes: [] }],
    polling: [{ entityType: 'Message', eventTopics: ['chat.message'], listImplemented: false, eventTrigger: { slug: 'DISCORD_NEW_MESSAGE_TRIGGER', triggerConfig: { interval: 1 } } }],
    multiInstance: true,
  },

  // ── E-commerce ───────────────────────────────────────────────────────
  woocommerce: {
    type: 'woocommerce', displayName: 'WooCommerce', category: 'e_commerce',
    objectsCovered: ['Orders', 'Products', 'Customers'],
    status: 'available',
    auth: { kind: 'api_key' },
    mcp: { kind: 'sidecar', sidecarPath: '/woocommerce' },
    capabilities: [{ capability: 'e_commerce', requiredScopes: [] }],
    polling: [{ entityType: 'Order', eventTopics: ['order.created', 'order.updated'], listImplemented: true }],
  },

  // ── Web tools (BYOK API key per tenant) ──────────────────────────────
  firecrawl: {
    type: 'firecrawl', displayName: 'Firecrawl', category: 'web_tools',
    description: 'Connect your Firecrawl account to enable advanced web scraping, structured extraction, and search.',
    objectsCovered: [], status: 'available',
    auth: { kind: 'api_key' },
    capabilities: [{ capability: 'web_scraping', requiredScopes: [] }], polling: [],
  },
  anchor_browser: {
    type: 'anchor_browser', displayName: 'Anchor Browser', category: 'web_tools',
    description: 'Connect your Anchor Browser account to enable hosted browser automation, identities, and saved sessions.',
    objectsCovered: [], status: 'available',
    auth: { kind: 'api_key' },
    capabilities: [{ capability: 'browser_automation', requiredScopes: [] }], polling: [],
  },
  browserbase: {
    type: 'browserbase', displayName: 'Browserbase', category: 'web_tools',
    description: 'Connect your Browserbase account to enable hosted browser fetch and structured extraction.',
    objectsCovered: [], status: 'available',
    auth: { kind: 'api_key' },
    capabilities: [{ capability: 'browser_automation', requiredScopes: [] }], polling: [],
  },
  tavily: {
    type: 'tavily', displayName: 'Tavily', category: 'web_tools',
    description: 'Connect your Tavily account to enable web search and content fetch.',
    objectsCovered: [], status: 'available',
    auth: { kind: 'api_key' },
    capabilities: [{ capability: 'web_research', requiredScopes: [] }], polling: [],
  },
  exa: {
    type: 'exa', displayName: 'Exa', category: 'web_tools',
    description: 'Connect your Exa account to enable neural web search and content fetch.',
    objectsCovered: [], status: 'available',
    auth: { kind: 'api_key' },
    capabilities: [{ capability: 'web_research', requiredScopes: [] }], polling: [],
  },
  webclaw: {
    type: 'webclaw', displayName: 'WebClaw', category: 'web_tools',
    description: 'Connect your WebClaw account to enable web scraping, structured extraction, search, and page diffs.',
    objectsCovered: [], status: 'available',
    auth: { kind: 'api_key' },
    capabilities: [{ capability: 'web_scraping', requiredScopes: [] }], polling: [],
  },
  browser_use: {
    type: 'browser_use', displayName: 'Browser Use', category: 'web_tools',
    description: 'Connect your Browser Use account to enable hosted browser automation and saved sessions.',
    objectsCovered: [], status: 'available',
    auth: { kind: 'api_key' },
    capabilities: [{ capability: 'browser_automation', requiredScopes: [] }], polling: [],
  },
  // Steel — hosted browser sessions with a live view a person can watch and
  // take over, CDP for the runtime's own agent loop, and saved profiles. The
  // same shape as browser_use: an api_key connector with no `mcp`, because the
  // tenant runtime drives the browser over CDP and embeds the live view; Steel's
  // MCP server is a local stdio wrapper for desktop LLM clients, not a hosted
  // endpoint, and adds nothing the pane needs. The platform also holds a Steel
  // key of its own (the runtime's web-tool secrets), so a workspace that connects
  // nothing browses on the platform account; a workspace that connects its own
  // key here browses on its own.
  steel: {
    type: 'steel', displayName: 'Steel', category: 'web_tools',
    description: 'Connect your Steel account to run hosted browser sessions, with a live view and saved logins, on your own account.',
    objectsCovered: [], status: 'available',
    auth: { kind: 'api_key' },
    capabilities: [{ capability: 'browser_automation', requiredScopes: [] }], polling: [],
  },
  // 1Password — the saved logins the browsers sign in with. An api_key connector
  // holding a service-account token (`ops_…`); the tenant runtime reads the
  // vault the person shared with that service account through @1password/sdk
  // and fills the sign-in form itself, on whichever of the four browser vendors
  // serves the session. No `mcp` and no capability: the connector has no tools
  // of its own (1Password's hosted MCP is a separate SaaS-management product,
  // and its Connect-server toolkit hands the password to the model), and it
  // lives in web_tools because it exists to serve the browsers beside it.
  onepassword: {
    type: 'onepassword', displayName: '1Password', category: 'web_tools',
    description: 'Connect a 1Password service account so your AI teams can sign in to the websites saved in the vault you share with it.',
    objectsCovered: [], status: 'available',
    auth: { kind: 'api_key' },
    capabilities: [], polling: [],
  },
  // Elicit — AI research assistant. Native sidecar over Elicit's REST API
  // (https://elicit.com/api/v1); user pastes an `elk_live_` key (Pro plan).
  // Tools = ELICIT_FUNCTIONS in connector-functions-registry.ts; dispatched via
  // the first-party ElicitClient. Chose the REST API over Elicit's first-party
  // MCP because the MCP exposes only paper-search + reports (4 tools), whereas
  // REST also covers clinical-trials search and the systematic-review pipeline.
  elicit: {
    type: 'elicit', displayName: 'Elicit', category: 'knowledge',
    description: 'Connect your Elicit account to search 138M+ academic papers and clinical trials, and run literature-review reports and systematic reviews.',
    objectsCovered: ['Papers', 'Reports', 'Clinical Trials', 'Systematic Reviews'],
    status: 'available',
    auth: { kind: 'api_key' },
    mcp: { kind: 'sidecar', sidecarPath: '/elicit', allowedEgressDomain: 'elicit.com' },
    capabilities: [{ capability: 'web_research', requiredScopes: [] }],
  },

  // ── Infrastructure ───────────────────────────────────────────────────
  // Tenant-registered MCP server (public URL or behind a Liftoff tunnel).
  // multiInstance: each tenant can register many independent custom MCP
  // servers under this one connector-type. The runtime resolves each
  // server's URL/auth from custom_mcp_servers at execution time.
  custom_mcp_server: {
    type: 'custom_mcp_server',
    displayName: 'MCP Server',
    category: 'infrastructure',
    status: 'available',
    auth: { kind: 'custom_mcp' },
    mcp: { kind: 'customer_hosted' },
    multiInstance: true,
  },

  // An API a workspace described and connected from a conversation: an
  // assistant reads the provider's own documentation, the person enters the
  // credential on a hosted page, and the provider's OpenAPI specification
  // becomes the operations the workspace's AI teams can be bound to.
  //
  // ONE generic type. The provider a workspace connects is never added to this
  // catalog and never becomes visible to anyone else — hosts, placement,
  // verification and operations live per instance on `custom_api_connectors`
  // in this service's own database. No `mcp`: the operations are dispatched by
  // the templated dispatcher through the Execute path, not over MCP.
  //
  // The tile this produces on the Connections page starts a conversation with
  // Liftoff rather than opening a Connect form: there is no static form behind
  // this type, because the fields only exist once an assistant has read a
  // particular provider's documentation.
  custom_api_connector: {
    type: 'custom_api_connector',
    displayName: 'Custom API',
    category: 'infrastructure',
    description: 'Connect an API we do not have a connector for. Liftoff reads the provider\'s own documentation, describes the connection, and gives you a link to enter the key.',
    status: 'available',
    auth: { kind: 'custom_api' },
    multiInstance: true,
  },

  // ── Net-new Composio-managed connectors ─────────────────────────────
  activecampaign: {
    type: 'activecampaign', displayName: 'ActiveCampaign', category: 'marketing_comms',
    objectsCovered: ['Contacts', 'Lists', 'Campaigns', 'Deals'],
    status: 'available',
    auth: { kind: 'api_key' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'active_campaign',
      authConfigIds: { dev: 'ac_tQfsD26BC5UK', prod: 'ac_gTQBAOjz8cJ-' },
      mcpServerIds: { dev: 'd101451c-ffbc-447c-81da-efb5a57aa451', prod: '7c423886-cbfc-401a-b59c-c743b59b74a3' },
      transport: 'streamable-http',
    },
    capabilities: [{ capability: 'email_marketing', requiredScopes: [] }],
    multiInstance: true,
  },
  apify: {
    type: 'apify', displayName: 'Apify', category: 'web_tools',
    description: 'Connect your Apify account to run Store actors on your own balance; without one, the platform runs them for you.',
    objectsCovered: ['Actors', 'Datasets', 'Runs'],
    status: 'available',
    auth: { kind: 'api_key' },
    // NATIVE. A connected key is the FIRST rung for a Store-actor run:
    // src/clients/apify.ts runs it on the workspace's own account, booked
    // tenant_key, so the platform charges no Operating Units for the vendor
    // part. Without a key the platform runs actors from platform-backend on
    // its x402 prepaid token, then its own account. Composio could not hand
    // the key back, which is why the toolkit went.
    capabilities: [{ capability: 'web_scraping', requiredScopes: [] }],
    multiInstance: true,
    polling: [],
  },
  // ── Capability-absorption data vendors ──────────────────────────
  // Two visibility tiers, one platform behaviour: 'internal' entries are fully
  // wired but filtered out of the user-facing catalog view, so no connector
  // card exists; the platform (distillation, assistants, provisioning) sees
  // and binds them exactly like 'available' ones. contactout and crunchbase
  // are user-visible BYO-key cards — no platform credential exists for either
  // (both are sales-gated vendors), so their credential resolution is
  // tenant-key-or-unavailable, never a platform fallback.
  contactout: {
    type: 'contactout', displayName: 'ContactOut', category: 'crm_sales',
    description: 'Connect your ContactOut account to find verified emails and phone numbers for professional profiles.',
    objectsCovered: ['People', 'Emails', 'Phones'], status: 'available',
    auth: { kind: 'api_key' },
    capabilities: [{ capability: 'enrichment', requiredScopes: [] }], polling: [],
  },
  crunchbase: {
    type: 'crunchbase', displayName: 'Crunchbase', category: 'data',
    description: 'Connect your Crunchbase account to look up companies, investors, and funding rounds.',
    objectsCovered: ['Companies', 'Investors', 'FundingRounds'], status: 'available',
    auth: { kind: 'api_key' },
    capabilities: [{ capability: 'enrichment', requiredScopes: [] }], polling: [],
  },
  tikhub: {
    type: 'tikhub', displayName: 'TikHub', category: 'web_tools',
    description: 'Public social media data across TikTok, Instagram, YouTube, X, Reddit, Douyin, and more through TikHub.',
    objectsCovered: ['Posts', 'Profiles', 'Comments'], status: 'internal',
    auth: { kind: 'api_key' },
    // Executes through the NATIVE executor (src/clients/tikhub.ts) driven by
    // the co-generated dispatch map, so the callable surface can never drift
    // from the functions the distiller sees. The vendor's own MCP server is
    // deliberately not used: its tool names are its own and reconciling two
    // catalogs buys nothing over dispatching the REST routes directly.
    capabilities: [
      { capability: 'social_media', requiredScopes: [] },
      { capability: 'web_scraping', requiredScopes: [] },
    ],
    polling: [],
  },
  pdl: {
    type: 'pdl', displayName: 'People Data Labs', category: 'data',
    description: 'Connect your People Data Labs account to enrich people and companies with your own key.',
    objectsCovered: ['People', 'Companies'], status: 'available',
    // DUAL-MODE. NATIVE REST executor (src/clients/pdl.ts) over PDL's v5 API
    // (api.peopledatalabs.com/v5) — bypasses Composio. Platform-funded by
    // DEFAULT via internal:pdl on PDL_PLATFORM_API_KEY (X-Api-Key header auth),
    // and 'available' so a workspace with its own PDL account can connect it and
    // run on its own key/quota (user-key-first, else platform). Every function
    // is a read (person/company enrich + search, ip, job title, autocomplete);
    // PDL is pay-per-match, a balance concern (fail-closed), not a gating one.
    auth: { kind: 'api_key' },
    capabilities: [{ capability: 'enrichment', requiredScopes: [] }], polling: [],
  },
  hunterio: {
    type: 'hunterio', displayName: 'Hunter', category: 'crm_sales',
    description: 'Connect your Hunter account to find and verify professional email addresses with your own key.',
    objectsCovered: ['Emails', 'Domains', 'Leads'], status: 'available',
    // DUAL-MODE. NATIVE REST executor (src/clients/hunter.ts) over Hunter's
    // enrichment/search API (api.hunter.io/v2) — bypasses Composio. Platform-
    // funded by DEFAULT via internal:hunterio on HUNTER_PLATFORM_API_KEY (so a
    // workspace needs no Hunter account), and 'available' so a workspace that
    // HAS one can connect it and run on its own key/quota (user-key-first, else
    // platform — resolveConnectedConnectorId). Only the lead-gen data surface is
    // exposed (domain search, email finder/verifier, enrichment, people
    // discovery, account) — NOT Hunter's CRM/campaign management. Every function
    // is a read; Hunter meters credits per call (no auto-reload), so a call
    // fails closed when the balance is exhausted.
    auth: { kind: 'api_key' },
    capabilities: [{ capability: 'enrichment', requiredScopes: [] }], polling: [],
  },
  saperly: {
    type: 'saperly', displayName: 'Saperly', category: 'social_messaging',
    description: 'Connect your Saperly account to give an agent a real phone number for outbound calls and SMS.',
    objectsCovered: ['PhoneNumbers', 'Calls', 'Messages'], status: 'available',
    // BYO-key, like contactout/crunchbase — a user-visible connector card, NOT
    // platform-provided. Telephony is identity-bound: US A2P 10DLC registration
    // must be under the WORKSPACE's own legal identity (brand + campaign), the
    // number is theirs, consent is theirs, and the monthly rental is theirs — so
    // there is no platform credential to fall back to. The workspace connects its
    // own Saperly key; execution runs on that key through the NATIVE REST executor
    // (src/clients/saperly.ts over api.saperly.com, the key as a Bearer), bypassing
    // Composio. The REST surface is the complete one — it carries the TCPA consent
    // tools and the connection/AI-persona model the MCP subset lacked. Outbound
    // call/SMS and number provisioning are write-class and gated for human approval
    // by their tool_classification_cache categories — a call or text reaches a real
    // person and costs money, so those never run without approval.
    auth: { kind: 'api_key' },
    capabilities: [{ capability: 'messaging', requiredScopes: [] }], polling: [],
  },
  strale: {
    type: 'strale', displayName: 'Strale', category: 'data',
    description: 'Connect your Strale account to run compliance checks, company lookups, and financial validation on your own balance; without one, the platform runs them for you.',
    objectsCovered: ['Companies', 'Checks'], status: 'available', platformServed: true,
    // Visible: a workspace may connect its
    // own Strale key, which runs its calls on its own account ahead of the
    // platform's x402 wallet. Absent a key the platform still serves every
    // function (src/clients/strale.ts), so the card is optional, never
    // required.
    auth: { kind: 'api_key' },
    // Executes through the NATIVE executor (src/clients/strale.ts): named
    // per-capability functions wrapping the vendor's one /v1/do endpoint.
    // The vendor's own MCP server was probed and is meta-tool
    // shaped — one strale_execute covering every capability — which is
    // exactly the one-classification-row-for-everything shape this estate
    // refuses, so it is deliberately not used.
    capabilities: [
      { capability: 'compliance_checks', requiredScopes: [] },
      { capability: 'company_intelligence', requiredScopes: [] },
    ],
    polling: [],
  },
  defillama: {
    type: 'defillama', displayName: 'DefiLlama', category: 'finance',
    description:
      'DeFi and on-chain market data: protocol and chain value locked, token prices, '
      + 'stablecoin supply, pool yields, decentralised-exchange volume and protocol fees.',
    objectsCovered: ['Protocols', 'Chains', 'Tokens', 'Stablecoins', 'Pools', 'Fees'], status: 'internal',
    // Keyless public data: the NATIVE executor (src/clients/defillama.ts) reads
    // the vendor's free open API across its four hosts, which needs no
    // credential and carries no per-call charge. `auth.kind` is cosmetic for an
    // internal-tier connector — it is never surfaced for a connect flow — so it
    // stays api_key to match the other internal vendors rather than introduce a
    // new kind.
    auth: { kind: 'api_key' },
    capabilities: [{ capability: 'market_data', requiredScopes: [] }], polling: [],
  },
  nasdaq: {
    type: 'nasdaq', displayName: 'Nasdaq', category: 'finance',
    description:
      'Live stock, ETF, fund and crypto quotes plus company financials, earnings, '
      + 'dividends, SEC filings, options, screeners and market movers from Nasdaq.',
    objectsCovered: ['Quotes', 'Financials', 'Earnings', 'Filings', 'Options'], status: 'internal',
    // Keyless public data: the NATIVE executor (src/clients/nasdaq.ts) reads
    // nasdaq.com's own public web API (api.nasdaq.com + www.nasdaq.com for
    // news), which needs no credential. `auth.kind` is cosmetic for an
    // internal-tier connector — it is never surfaced for a connect flow — so it
    // stays api_key to match the other internal vendors rather than introduce a
    // new kind. NOT the retired Data Link dataset API this connector used to
    // target.
    auth: { kind: 'api_key' },
    capabilities: [{ capability: 'market_data', requiredScopes: [] }], polling: [],
  },
  ycombinator: {
    type: 'ycombinator', displayName: 'Y Combinator', category: 'data',
    description: 'The Y Combinator company directory: search by keyword, batch, industry and status, and one company\'s profile by slug.',
    objectsCovered: ['Companies'], status: 'internal',
    // Keyless public data: the NATIVE executor (src/clients/ycombinator.ts)
    // reads YC's own public companies API, which needs no credential; the
    // auth kind is cosmetic for an internal-tier connector, as nasdaq's is.
    auth: { kind: 'api_key' },
    capabilities: [{ capability: 'enrichment', requiredScopes: [] }], polling: [],
  },
  gloria: {
    type: 'gloria', displayName: 'Gloria', category: 'data',
    description: 'Connect your Gloria account to run its real-time crypto and market news, recaps, and ticker summaries on your own plan; without one, the platform serves them.',
    objectsCovered: ['News', 'Recaps'], status: 'available', platformServed: true,
    // Visible: the BYO path below is how a
    // workspace runs the premium tools on its own Elite plan instead of the
    // platform's x402 wallet.
    // NATIVE MCP executor (src/clients/gloria-mcp.ts): the FREE tools are served
    // over Gloria's keyless public MCP (mcp.itsgloria.ai). auth.kind is api_key
    // for the OPTIONAL BYO path — a workspace may connect its own Gloria key,
    // which then rides as the MCP bearer to run on the tenant's own account;
    // absent, the platform default is the free (no-credential) MCP tools. The
    // 2 premium tools are x402-gated and served through the x402 transport:
    // paid per call in USDC from the platform wallet (src/x402/).
    auth: { kind: 'api_key' },
    capabilities: [{ capability: 'news_monitoring', requiredScopes: [] }], polling: [],
  },
  // ── x402 pay-per-call vendors ─────────────────────────────────────────────
  // No vendor account and no credential of any kind: each call's 402
  // challenge is paid in USDC from the platform x402 wallet (src/x402/) and
  // the settled amount books as the call's costUsd. auth.kind is cosmetic
  // for internal-tier entries, kept api_key to match the other internal
  // vendors. x402-ness is a TRANSPORT property chosen in each executor, not
  // a new tool shape.
  google_trends: {
    type: 'google_trends', displayName: 'Google Trends', category: 'data',
    description: 'Google Trends keyword interest, regional breakdowns, related queries and topics for SEO and market research.',
    objectsCovered: ['Trends', 'Keywords'], status: 'internal',
    auth: { kind: 'api_key' },
    capabilities: [{ capability: 'market_data', requiredScopes: [] }], polling: [],
  },
  browserbase_x402: {
    // DISTINCT from the BYOK 'browserbase' web-tool connector above: that is
    // a tenant's own Browserbase key driven from the tenant runtime; this is
    // browserbase's pay-per-use gateway (x402.browserbase.com), platform-
    // funded per call, serving only the request/response tools.
    type: 'browserbase_x402', displayName: 'Browserbase x402', category: 'data',
    description: 'Pay-per-use web search and page fetch through the Browserbase gateway.',
    objectsCovered: ['Search', 'Pages'], status: 'internal',
    auth: { kind: 'api_key' },
    capabilities: [{ capability: 'browser_automation', requiredScopes: [] }], polling: [],
  },
  kadec0: {
    type: 'kadec0', displayName: 'kadec0', category: 'data',
    description: 'Keyless web search, scraping, market and research data through the kadec0 pay-per-call API.',
    objectsCovered: ['Search', 'Markets', 'Papers', 'Domains'], status: 'internal',
    auth: { kind: 'api_key' },
    capabilities: [{ capability: 'web_research', requiredScopes: [] }], polling: [],
  },
  // ── Aggregator rungs (platform-funded, behind a workspace's own key) ──────
  // Two aggregators resell key-based vendors per call on a prepaid balance the
  // platform funds, so an enrichment need a workspace has no vendor account
  // for is served instead of refused. Both are internal: the vendor behind
  // each function is a dispatch detail, never a card a person sees, and a
  // workspace that holds its own account with the underlying vendor connects
  // THAT vendor's card, which discovery ranks first.
  locus: {
    type: 'locus', displayName: 'Locus', category: 'data',
    description: 'People and company search and enrichment, professional email find and verify, and public data on vehicles, homes, jobs, software reviews, markets, weather and AI models, resold per call on the platform\'s prepaid balance.',
    objectsCovered: ['People', 'Companies', 'Emails', 'Vehicles', 'Homes', 'Jobs', 'Reviews', 'Stocks', 'Weather'], status: 'internal',
    // REST on the platform's own Locus workspace key (LOCUS_API_KEY); the
    // charge rides on every response's headers. Every function is a read at
    // a listed price.
    auth: { kind: 'api_key' },
    capabilities: [{ capability: 'enrichment', requiredScopes: [] }], polling: [],
  },
  vaaya: {
    type: 'vaaya', displayName: 'Vaaya', category: 'data',
    description: 'Professional email find and verify, funding, M&A and hiring signals, and SEC, patent and court records, resold per call on the platform\'s prepaid balance.',
    objectsCovered: ['Emails', 'Signals', 'Filings', 'Patents', 'Cases'], status: 'internal',
    // REST bearer (VAAYA_API_KEY) on the platform's own Vaaya account; every
    // call carries a whole-cent ceiling Vaaya enforces before dispatch.
    auth: { kind: 'api_key' },
    capabilities: [{ capability: 'enrichment', requiredScopes: [] }, { capability: 'web_research', requiredScopes: [] }], polling: [],
  },
  // ── Media generation vendors (sequenced LAST in the absorption plan) ──────
  // Video and music generation are ASYNC JOB-SHAPED at these vendors: a
  // submit returns a job id, a poll reads status, a fetch returns the file.
  // The generated bytes reach chat through the ONE media attach seam
  // (platform-backend src/media/attach.ts; the tenant runtime posts to
  // POST /api/generated-files with outputType 'media') — no new display path.
  minimax: {
    type: 'minimax', displayName: 'MiniMax', category: 'data',
    description: 'Music, image, video, and speech generation through MiniMax.',
    objectsCovered: ['Generations'], status: 'internal',
    auth: { kind: 'api_key' },
    capabilities: [{ capability: 'media_generation', requiredScopes: [] }], polling: [],
  },
  bytedance: {
    type: 'bytedance', displayName: 'BytePlus ModelArk', category: 'data',
    description: 'Video generation with the Seedance models through BytePlus ModelArk.',
    objectsCovered: ['Generations'], status: 'internal',
    auth: { kind: 'api_key' },
    capabilities: [{ capability: 'media_generation', requiredScopes: [] }], polling: [],
  },
  alibaba: {
    type: 'alibaba', displayName: 'Alibaba Model Studio', category: 'data',
    description: 'Image and video generation with the Wan models through Alibaba Cloud Model Studio.',
    objectsCovered: ['Generations'], status: 'internal',
    auth: { kind: 'api_key' },
    capabilities: [{ capability: 'media_generation', requiredScopes: [] }], polling: [],
  },
  baserow: {
    type: 'baserow', displayName: 'Baserow', category: 'productivity_comms',
    objectsCovered: ['Databases', 'Tables', 'Rows'],
    status: 'available',
    auth: { kind: 'api_key' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'baserow',
      authConfigIds: { dev: 'ac_qGItOpvBorv8', prod: 'ac_lVkwDFYvMCHd' },
      mcpServerIds: { dev: 'c06eac35-b281-4429-9d9c-f6918c7b6617', prod: '5d645bfc-5863-4022-aedf-4d4ed09e750f' },
      transport: 'streamable-http',
    },
    capabilities: [{ capability: 'data_table', requiredScopes: [] }],
    multiInstance: true,
  },
  brevo: {
    type: 'brevo', displayName: 'Brevo', category: 'marketing_comms',
    objectsCovered: ['Contacts', 'Campaigns', 'Transactional Emails'],
    status: 'available',
    auth: { kind: 'api_key' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'brevo',
      authConfigIds: { dev: 'ac_GkSX9aauXNZZ', prod: 'ac_axMWh_Trg-79' },
      mcpServerIds: { dev: '70c4e13f-5fb2-495c-8a23-68fa00f89179', prod: '64cf67da-88e0-4f0d-a47b-d6db7006353f' },
      transport: 'streamable-http',
    },
    capabilities: [{ capability: 'email_marketing', requiredScopes: [] }],
    multiInstance: true,
    polling: [{ entityType: 'Contact', eventTopics: ['contact.created', 'contact.updated'], listImplemented: true }],
  },
  buildkite: {
    type: 'buildkite', displayName: 'Buildkite', category: 'engineering',
    objectsCovered: ['Pipelines', 'Builds', 'Jobs', 'Agents'],
    status: 'available',
    auth: { kind: 'api_key' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'buildkite',
      authConfigIds: { dev: 'ac_RFvhHlhTRmzj', prod: 'ac_cZXIVgsxdkTG' },
      mcpServerIds: { dev: 'b7b3d8de-9c6f-4ae8-8ef5-84c59e820722', prod: '9e10d300-e8e7-46ae-996c-33f2a171054e' },
      transport: 'streamable-http',
    },
    multiInstance: true,
  },
  codacy: {
    type: 'codacy', displayName: 'Codacy', category: 'engineering',
    objectsCovered: ['Repositories', 'Issues', 'Coverage'],
    status: 'available',
    auth: { kind: 'api_key' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'codacy',
      authConfigIds: { dev: 'ac_XTtRxhhV1RcW', prod: 'ac_dOjXMnFLQonz' },
      mcpServerIds: { dev: '8708ccb3-29aa-49ca-bc84-6bc72c8d0d53', prod: '6de39f36-6fc8-4179-9ca8-a81f3be2d54a' },
      transport: 'streamable-http',
    },
    multiInstance: true,
  },
  dovetail: {
    type: 'dovetail', displayName: 'Dovetail', category: 'knowledge',
    objectsCovered: ['Insights', 'Highlights', 'Notes', 'Projects'],
    status: 'available',
    auth: { kind: 'api_key' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'dovetail',
      authConfigIds: { dev: 'ac_Yp_rlPKjV2Kb', prod: 'ac_0XQRrjesM6dO' },
      mcpServerIds: { dev: 'a10442ae-5410-45ea-95f4-5fc43fe6d868', prod: '7e442a83-eca3-4f56-96a2-c8b7fc3a9f44' },
      transport: 'streamable-http',
    },
    multiInstance: true,
    polling: [{ entityType: 'Note', eventTopics: ['note.created'], listImplemented: true }],
  },
  elevenlabs: {
    type: 'elevenlabs', displayName: 'ElevenLabs', category: 'web_tools',
    objectsCovered: ['Voices', 'Speech', 'Models'],
    status: 'available',
    auth: { kind: 'api_key' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'elevenlabs',
      authConfigIds: { dev: 'ac_rld22UoWVCyT', prod: 'ac_OYFprSs1x1JX' },
      mcpServerIds: { dev: '59e47c3d-4943-42b6-a102-2f146b22c63b', prod: 'd849c529-ccfc-4743-83c8-bdbc09f682f2' },
      transport: 'streamable-http',
    },
    multiInstance: true,
    polling: [{ entityType: 'HistoryItem', eventTopics: ['historyItem.created'], listImplemented: true }],
  },
  fibery: {
    type: 'fibery', displayName: 'Fibery', category: 'project_management',
    objectsCovered: ['Entities', 'Databases', 'Documents'],
    status: 'available',
    auth: { kind: 'api_key' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'fibery',
      authConfigIds: { dev: 'ac_My-aRnf0Zg5S', prod: 'ac_AqZe94ovFduw' },
      mcpServerIds: { dev: '4889beb2-975b-4509-897c-1f1ea0c6a49d', prod: 'cffd42d5-93b3-42bc-a33f-6e6c01078223' },
      transport: 'streamable-http',
    },
    capabilities: [{ capability: 'project_management', requiredScopes: [] }],
    multiInstance: true,
  },
  fillout: {
    type: 'fillout', displayName: 'Fillout', category: 'productivity_comms',
    objectsCovered: ['Forms', 'Submissions'],
    status: 'available',
    auth: { kind: 'api_key' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'fillout_forms',
      authConfigIds: { dev: 'ac_nwgijRCP_v5t', prod: 'ac_nHWvspMRFxSd' },
      mcpServerIds: { dev: '0b5f5fb3-ac2f-4a9c-85ae-e04ebe2defa9', prod: '5ce0ab33-a200-4923-b278-be2a0e6dfce0' },
      transport: 'streamable-http',
    },
    multiInstance: true,
  },
  folk: {
    type: 'folk', displayName: 'Folk', category: 'crm_sales',
    objectsCovered: ['Contacts', 'Companies', 'Deals', 'Groups'],
    status: 'available',
    auth: { kind: 'api_key' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'folk',
      authConfigIds: { dev: 'ac_Tublco16Rg9e', prod: 'ac_o_kjWl-yLfLx' },
      mcpServerIds: { dev: '4d4844a2-a0bc-49ed-8d79-77e8f1f63cbb', prod: '7990f946-a157-4a5e-9973-9a8aa74d5554' },
      transport: 'streamable-http',
    },
    capabilities: [{ capability: 'crm', requiredScopes: [] }],
    // Reactive Contact polling via the Composio FOLK_LIST_PEOPLE action. Folk's
    // Person has createdAt but no updatedAt, so polling detects creates only.
    polling: [{ entityType: 'Contact', eventTopics: ['contact.created'], listImplemented: true }],
    multiInstance: true,
  },
  follow_up_boss: {
    type: 'follow_up_boss', displayName: 'Follow Up Boss', category: 'crm_sales',
    objectsCovered: ['Contacts', 'Deals', 'Events', 'Notes'],
    status: 'available',
    auth: { kind: 'api_key' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'follow_up_boss',
      authConfigIds: { dev: 'ac_lItz81lJXkYp', prod: 'ac_fYQksAy0Lxlc' },
      mcpServerIds: { dev: '0472d503-25a7-41eb-adfe-218a1166399b', prod: 'ce9e53f8-5fa7-4431-804b-42dff2a49d33' },
      transport: 'streamable-http',
    },
    capabilities: [{ capability: 'crm', requiredScopes: [] }],
    multiInstance: true,
    polling: [{ entityType: 'Deal', eventTopics: ['deal.created', 'deal.updated'], listImplemented: true }],
  },
  heygen: {
    type: 'heygen', displayName: 'HeyGen', category: 'web_tools',
    objectsCovered: ['Videos', 'Avatars', 'Voices'],
    status: 'available',
    auth: { kind: 'api_key' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'heygen',
      authConfigIds: { dev: 'ac_yoyw0h2YPhQl', prod: 'ac_gWcpAMrSOf-q' },
      mcpServerIds: { dev: 'bdb72c49-ac59-4a60-8a07-d6660ef20d51', prod: '5191147f-5256-4319-8fb9-cacd802eb778' },
      transport: 'streamable-http',
    },
    multiInstance: true,
  },
  imgbb: {
    type: 'imgbb', displayName: 'ImgBB', category: 'web_tools',
    objectsCovered: ['Images', 'Albums'],
    status: 'available',
    auth: { kind: 'api_key' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'imgbb',
      authConfigIds: { dev: 'ac_TwbXlV_ImcCm', prod: 'ac_F3TzFayJbbJq' },
      mcpServerIds: { dev: 'b23c8eb4-a439-44ed-964b-e2c9f8d65715', prod: 'b25dd065-97f9-4638-ba7d-4674e585c8a3' },
      transport: 'streamable-http',
    },
    multiInstance: true,
  },
  incident_io: {
    type: 'incident_io', displayName: 'Incident.io', category: 'observability',
    objectsCovered: ['Incidents', 'Alerts', 'Actions'],
    status: 'available',
    auth: { kind: 'api_key' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'incident_io',
      authConfigIds: { dev: 'ac_25and3sOag2v', prod: 'ac_CTJD25fRbhnN' },
      mcpServerIds: { dev: '4f600951-f559-4a6a-9fb3-7b06d419acd8', prod: '4984f232-941e-41ce-aed1-2c8cf017123b' },
      transport: 'streamable-http',
    },
    capabilities: [{ capability: 'incident_management', requiredScopes: [] }],
    // Generic poller (INCIDENT_IO_LIST_INCIDENTS_V2) — see composio-poll-spec.ts.
    polling: [{ entityType: 'Incident', eventTopics: ['incident.triggered', 'incident.resolved'], listImplemented: true }],
    multiInstance: true,
  },
  jotform: {
    type: 'jotform', displayName: 'Jotform', category: 'productivity_comms',
    objectsCovered: ['Forms', 'Submissions', 'Reports'],
    status: 'available',
    auth: { kind: 'api_key' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'jotform',
      authConfigIds: { dev: 'ac_aYBcliBVkdbb', prod: 'ac_-S9R7Cp8MjIX' },
      mcpServerIds: { dev: 'aac20650-6e8b-4637-a5e8-8ca529e642b8', prod: 'ac4ecd7a-01e7-4d83-aad8-4bbb9da6910c' },
      transport: 'streamable-http',
    },
    multiInstance: true,
    polling: [{ entityType: 'Submission', eventTopics: ['submission.created'], listImplemented: true }],
  },
  lemlist: {
    // Poll-reactive via LEMLIST_LIST_COMPANIES (sortBy=createdAt desc); the activities feed is unsortable — see composio-poll-spec.ts.
    type: 'lemlist', displayName: 'Lemlist', category: 'marketing_comms',
    objectsCovered: ['Campaigns', 'Leads', 'Activities'],
    status: 'available',
    auth: { kind: 'api_key' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'lemlist',
      authConfigIds: { dev: 'ac_LLTuL-MPjaNS', prod: 'ac_2BAPSh6ki_c0' },
      mcpServerIds: { dev: '355b7dd1-4842-405f-b843-1c6652aef608', prod: '778f3202-61c2-4992-aea1-221e82c10439' },
      transport: 'streamable-http',
    },
    capabilities: [{ capability: 'email_marketing', requiredScopes: [] }],
    multiInstance: true,
    polling: [{ entityType: 'Company', eventTopics: ['company.created'], listImplemented: true }],
  },
  lemon_squeezy: {
    // Poll-reactive via sortDesc (LIST_ALL_ORDERS default order is sort=-createdAt) — see composio-poll-spec.ts.
    type: 'lemon_squeezy', displayName: 'Lemon Squeezy', category: 'finance',
    objectsCovered: ['Orders', 'Products', 'Subscriptions', 'Customers'],
    status: 'available',
    auth: { kind: 'api_key' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'lemon_squeezy',
      authConfigIds: { dev: 'ac_98CpDVJ_FTRm', prod: 'ac_xhC_Se6x2B2J' },
      mcpServerIds: { dev: '1e26dd05-d9e8-4cd9-bcda-c64781e9d912', prod: '65075fca-3540-43ac-989c-db64e2503f5c' },
      transport: 'streamable-http',
    },
    capabilities: [{ capability: 'e_commerce', requiredScopes: [] }],
    multiInstance: true,
    polling: [{ entityType: 'Order', eventTopics: ['order.created'], listImplemented: true }],
  },
  loops: {
    type: 'loops', displayName: 'Loops', category: 'marketing_comms',
    objectsCovered: ['Contacts', 'Transactional', 'Events'],
    status: 'available',
    auth: { kind: 'api_key' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'loops_so',
      authConfigIds: { dev: 'ac_YcqE4c-BM9yy', prod: 'ac_uJYqcBAPBflw' },
      mcpServerIds: { dev: '5000dd51-c9cc-450f-bd0d-c68ca23fbf39', prod: 'd0863055-eb0f-4e6c-b3c8-c81c48b36833' },
      transport: 'streamable-http',
    },
    capabilities: [{ capability: 'email_marketing', requiredScopes: [] }],
    multiInstance: true,
  },
  mailerlite: {
    // Not poll-addressable: MAILERLITE_GET_SUBSCRIBERS has no server since, no sort, and a forward-only non-durable cursor (next_cursor null at end) — no incremental mechanism in the exposed API; a full-scan would drop new subscribers at scale.
    type: 'mailerlite', displayName: 'MailerLite', category: 'marketing_comms',
    objectsCovered: ['Subscribers', 'Campaigns', 'Groups', 'Forms'],
    status: 'available',
    auth: { kind: 'api_key' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'mailerlite',
      authConfigIds: { dev: 'ac_XAD0gcf6oz_i', prod: 'ac_XQH7fmiqkJDw' },
      mcpServerIds: { dev: '2a0df0d3-9c20-4f4c-b9c0-ed66575f5dcc', prod: '4b0b99ab-bc36-4392-9e63-7b9d7daff6c0' },
      transport: 'streamable-http',
    },
    capabilities: [{ capability: 'email_marketing', requiredScopes: [] }],
    multiInstance: true,
  },
  mailersend: {
    // Not poll-addressable: MAILERSEND_GET_MESSAGES has no working since (date_from/to are no-ops here — they belong to /v1/activity, which has no Composio action), an undocumented order, and a sparse list item (id+timestamps only).
    type: 'mailersend', displayName: 'MailerSend', category: 'marketing_comms',
    objectsCovered: ['Emails', 'Templates', 'Activity', 'Domains'],
    status: 'available',
    auth: { kind: 'api_key' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'mailersend',
      authConfigIds: { dev: 'ac_bLuacAbgDwKS', prod: 'ac_vZ8P9E8zOJnv' },
      mcpServerIds: { dev: 'da73e223-0118-4d76-b507-81d7f3796695', prod: '947c9123-d019-44a5-a433-4af152b48188' },
      transport: 'streamable-http',
    },
    capabilities: [{ capability: 'email_marketing', requiredScopes: [] }],
    multiInstance: true,
  },
  mem: {
    type: 'mem', displayName: 'Mem', category: 'knowledge',
    objectsCovered: ['Notes', 'Collections'],
    status: 'available',
    auth: { kind: 'api_key' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'mem',
      authConfigIds: { dev: 'ac_GjLSw2w8pMfl', prod: 'ac_xYw2jy0pht7l' },
      mcpServerIds: { dev: '41f7ca77-fda3-43fc-9311-66c7982ea453', prod: '5b2164b6-4806-49f6-82ec-554c5b2ca93e' },
      transport: 'streamable-http',
    },
    multiInstance: true,
    polling: [{ entityType: 'Note', eventTopics: ['note.created', 'note.updated'], listImplemented: true }],
  },
  new_relic: {
    type: 'new_relic', displayName: 'New Relic', category: 'observability',
    objectsCovered: ['Incidents', 'Alerts', 'Dashboards'],
    status: 'available',
    auth: { kind: 'api_key' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'new_relic',
      authConfigIds: { dev: 'ac_WHBMpz-KkJnz', prod: 'ac_wCXi9DXPmOtX' },
      mcpServerIds: { dev: 'afac317e-2036-44bb-b2f0-0ee5eef3ec9f', prod: '54f36d09-d994-4ba3-870b-a505bcd8d72e' },
      transport: 'streamable-http',
    },
    capabilities: [{ capability: 'incident_management', requiredScopes: [] }],
    multiInstance: true,
  },
  northflank: {
    type: 'northflank', displayName: 'Northflank', category: 'engineering',
    objectsCovered: ['Projects', 'Services', 'Deployments', 'Builds'],
    status: 'available',
    auth: { kind: 'api_key' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'northflank',
      authConfigIds: { dev: 'ac_03ClPsEgwTSg', prod: 'ac_GGD9YZoXbMuY' },
      mcpServerIds: { dev: '56bcc8cc-7458-4f93-ad55-e36244c2291e', prod: '0d84aeb2-9925-4a7f-839a-284c3be99420' },
      transport: 'streamable-http',
    },
    multiInstance: true,
  },
  paperform: {
    type: 'paperform', displayName: 'Paperform', category: 'productivity_comms',
    objectsCovered: ['Forms', 'Submissions'],
    status: 'available',
    auth: { kind: 'api_key' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'paperform',
      authConfigIds: { dev: 'ac_iHkSMRNAPMFa', prod: 'ac_hPYy-NP0-D0Q' },
      mcpServerIds: { dev: '849331bb-4b63-42a6-8711-78d6041e35a1', prod: '1cbd8aad-73a7-4bcb-b069-ad02042ac53a' },
      transport: 'streamable-http',
    },
    multiInstance: true,
  },
  scrapingbee: {
    type: 'scrapingbee', displayName: 'ScrapingBee', category: 'web_tools',
    objectsCovered: ['Requests', 'Pages', 'Screenshots'],
    status: 'available',
    auth: { kind: 'api_key' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'scrapingbee',
      authConfigIds: { dev: 'ac_FCrmVFhaFBpd', prod: 'ac_DwY8URLZPOpM' },
      mcpServerIds: { dev: 'd78e61d2-7141-4ae5-b26c-c8ef34a87ca9', prod: '8653ac51-31e5-40fc-a73e-b4bd8f6e6de8' },
      transport: 'streamable-http',
    },
    capabilities: [{ capability: 'web_scraping', requiredScopes: [] }],
    multiInstance: true,
  },
  supabase: {
    type: 'supabase', displayName: 'Supabase', category: 'data',
    objectsCovered: ['Projects', 'Migrations', 'Database', 'Edge Functions'],
    status: 'available',
    capabilities: [{ capability: 'data_warehouse', requiredScopes: [] }],
    auth: { kind: 'api_key' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'supabase',
      authConfigIds: { dev: 'ac_utpvl5-PaQ3A', prod: 'ac_QSo_5-U4BEP4' },
      mcpServerIds: { dev: 'b4200d66-7d81-4bb7-8838-871240f1ca65', prod: '5b6703a4-8707-4642-b5c5-7eaddae98fed' },
      transport: 'streamable-http',
    },
    multiInstance: true,
  },
  tally: {
    type: 'tally', displayName: 'Tally', category: 'productivity_comms',
    objectsCovered: ['Forms', 'Submissions', 'Responses'],
    status: 'available',
    auth: { kind: 'api_key' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'tally',
      authConfigIds: { dev: 'ac_-JR92OizhBC4', prod: 'ac_HYTSOFH9indQ' },
      mcpServerIds: { dev: '82df5677-833d-4ecd-8834-3e8b70cdda1b', prod: '9f5e0db3-e7cf-4d89-950c-6f6835f0b440' },
      transport: 'streamable-http',
    },
    multiInstance: true,
  },
  telegram: {
    type: 'telegram', displayName: 'Telegram', category: 'social_messaging',
    objectsCovered: ['Messages', 'Chats', 'Updates'],
    status: 'available',
    auth: { kind: 'api_key' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'telegram',
      authConfigIds: { dev: 'ac_BeCKRYLH7ZAV', prod: 'ac_A8F1oaeVKms6' },
      mcpServerIds: { dev: '0dffa8e4-24ae-409e-ace3-3415233fbabf', prod: '7715e581-8b1f-4e10-9964-e2d832753b63' },
      transport: 'streamable-http',
    },
    capabilities: [{ capability: 'messaging', requiredScopes: [] }],
    multiInstance: true,
  },
  toggl: {
    type: 'toggl', displayName: 'Toggl', category: 'productivity_comms',
    objectsCovered: ['Time Entries', 'Projects', 'Clients', 'Tags'],
    status: 'available',
    auth: { kind: 'api_key' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'toggl',
      authConfigIds: { dev: 'ac_lc4bfU46lUwn', prod: 'ac_gTgkj3zizsrv' },
      mcpServerIds: { dev: '08234d3f-95d6-49ec-be70-b40952911a5e', prod: '6688b15f-d7cf-400a-baac-76da31df9afe' },
      transport: 'streamable-http',
    },
    multiInstance: true,
    polling: [{ entityType: 'TimeEntry', eventTopics: ['timeentry.created', 'timeentry.updated'], listImplemented: true }],
  },
  clicksend: {
    // Not poll-addressable: CLICKSEND_GET_SMS_RECEIPTS has no server since and no sort (undocumented order); the only since (updated_after) is on list-contacts, which requires a list_id parent.
    type: 'clicksend', displayName: 'ClickSend', category: 'marketing_comms',
    objectsCovered: ['SMS', 'MMS', 'Voice'],
    status: 'available',
    auth: { kind: 'api_key' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'clicksend',
      authConfigIds: { dev: 'ac_CnuvCgbIGXKv', prod: 'ac_F88AO_WvU2Ka' },
      mcpServerIds: { dev: '96f12b0d-ae19-4677-871e-e326b8973a33', prod: 'ec1aed5b-7154-440f-96e7-72e74af72227' },
      transport: 'streamable-http',
    },
    multiInstance: true,
  },
  ticktick: {
    type: 'ticktick', displayName: 'TickTick', category: 'productivity_comms',
    objectsCovered: ['Tasks', 'Projects', 'Tags'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
      authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev', scopes: [], scopeDelimiter: ' ' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'ticktick',
      authConfigIds: { dev: 'ac_JnI-Va3Z2cu0', prod: 'ac_7OjCbxdLU0OF' },
      mcpServerIds: { dev: '49a4e8c1-18bf-4f1f-81fe-8cb762a91afb', prod: 'f18ffa14-1215-4a1b-84c2-12513ce5acfe' },
      transport: 'streamable-http',
    },
    capabilities: [{ capability: 'project_management', requiredScopes: [] }],
    multiInstance: true,
  },
  monday: {
    type: 'monday', displayName: 'Monday.com', category: 'project_management',
    objectsCovered: ['Boards', 'Items', 'Updates', 'Groups'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
      authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev', scopes: [], scopeDelimiter: ' ' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'monday',
      authConfigIds: { dev: 'ac_hRT1mcYOBmj6', prod: 'ac_6dWRBjMYuM9_' },
      mcpServerIds: { dev: '99012da5-3f7c-4c16-a7df-2a8794d0d6ec', prod: '21c2fb07-6218-4b9e-80d2-888f412bd041' },
      transport: 'streamable-http',
    },
    capabilities: [{ capability: 'project_management', requiredScopes: [] }],
    multiInstance: true,
  },
  dialpad: {
    type: 'dialpad', displayName: 'Dialpad', category: 'social_messaging',
    objectsCovered: ['Calls', 'SMS', 'Contacts', 'Users'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
      authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev', scopes: [], scopeDelimiter: ' ' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'dialpad',
      authConfigIds: { dev: 'ac_OIo-q6GjnFWF', prod: 'ac_R8Xt5eZfEW-A' },
      mcpServerIds: { dev: 'db69b3db-6cfb-49d9-a873-e1971f5a2a25', prod: '309676e5-eeea-422d-98d1-4fc9202022bf' },
      transport: 'streamable-http',
    },
    multiInstance: true,
    polling: [{ entityType: 'Call', eventTopics: ['call.completed'], listImplemented: true }],
  },
  harvest: {
    type: 'harvest', displayName: 'Harvest', category: 'productivity_comms',
    objectsCovered: ['Time Entries', 'Projects', 'Invoices', 'Clients'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
      authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev', scopes: [], scopeDelimiter: ' ' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'harvest',
      authConfigIds: { dev: 'ac_AXld2X0iA5Lr', prod: 'ac_qwjRmFgq2T4-' },
      mcpServerIds: { dev: 'b6a84cd3-cbf8-4f1d-8b71-098bd1917eae', prod: '3f2e08f4-d972-4762-82df-716dbbb9ba12' },
      transport: 'streamable-http',
    },
    multiInstance: true,
    polling: [{ entityType: 'TimeEntry', eventTopics: ['timeentry.created', 'timeentry.updated'], listImplemented: true }],
  },
  google_meet: {
    type: 'google_meet', displayName: 'Google Meet', category: 'meetings_scheduling',
    objectsCovered: ['Spaces', 'Conferences', 'Recordings'],
    status: 'available',
    auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
      authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev', scopes: [], scopeDelimiter: ' ' },
    mcp: {
      kind: 'composio_managed',
      toolkitSlug: 'googlemeet',
      authConfigIds: { dev: 'ac_yI4lsVnwxx6p', prod: 'ac_72Z1JhKjfppM' },
      mcpServerIds: { dev: '8558fec2-a3f8-40db-8274-eceb1e17a868', prod: 'f61a8217-f32e-4dbd-a337-4d7415e2d336' },
      transport: 'streamable-http',
    },
    multiInstance: true,
    polling: [{ entityType: 'ConferenceRecord', eventTopics: ['meeting.ended'], listImplemented: true }],
  },
};

// Native first-party HRIS connect shapes, baked into each catalog entry below. Every
// projection (frontend catalog, platform-backend static cache via sync:connectors, docs)
// reads CONNECTORS, so these mutations set the connect flow everywhere. The matching
// native executor + tool set live in src/clients/index.ts and
// src/catalog/connector-functions-registry.ts.
//
// Two native connect shapes:
//   • workday / oracle_hcm / sap_successfactors / namely / deel / … → api_key
//     direct-vault (customer-tenant-authorized). Fields in apikey-router.
//   • gusto / rippling / bamboohr → static_oauth with our OWN OAuth app. Standard
//     OAuth router handles connect.
const NATIVE_HRIS_EGRESS: Record<string, string> = {
  workday: '*.workday.com',
  oracle_hcm: '*.oraclecloud.com',
  sap_successfactors: '*.successfactors.com',
  namely: '*.namely.com',
  // Batch 2 (customer-credential natives).
  deel: 'api.letsdeel.com',
  factorial: '*.factorialhr.com',
  hibob: '*.hibob.com',
  personio: '*.personio.de',
  ukg_pro: '*.ultipro.com',
  ukg_ready: '*.saashr.com',
  dayforce: '*.dayforcehcm.com',
  adp_run: '*.adp.com',
  adp_workforce_now: '*.adp.com',
  warp: '*.joinwarp.com',
};
// All HRIS connectors are served by first-party native clients. These loops bake the
// native connect shape (api_key direct-vault, or static_oauth below) into each entry.
for (const [type, egress] of Object.entries(NATIVE_HRIS_EGRESS)) {
  const def = CONNECTORS[type];
  if (!def) continue;
  def.auth = { kind: 'api_key' };
  def.mcp = { kind: 'sidecar', sidecarPath: `/${type}`, allowedEgressDomain: egress };
  def.status = 'available';
  delete def.statusReason;
  // Keep capabilities (hris), category ('hr'), multiInstance — matches bamboohr,
  // the native api_key HRIS precedent. Native polling is out of scope.
  delete def.polling;
}

// Native HRIS — static_oauth flip (gusto, rippling). First-party OAuth via our own
// Gusto DevPortal / Rippling App-Shop app (partner review), NOT api_key. Dormant
// until flipped AND the OAuth app is provisioned. Gusto's OAuth+REST host is
// env-scoped (prod api.gusto.com / demo api.gusto-demo.com) — mirrors the gusto
// client's GUSTO_SANDBOX base and the DOCUSIGN_OAUTH_HOST precedent above. Rippling
// authorizes at app.rippling.com; its REST API is rest.ripplingapis.com (client base).
const GUSTO_OAUTH_HOST =
  process.env.GUSTO_SANDBOX === 'true' ? 'https://api.gusto-demo.com' : 'https://api.gusto.com';
// BambooHR developer-portal OAuth app — the full set of scopes granted to the app.
// Requested verbatim (scopeDelimiter '+') so the native client can reach the entire
// BambooHR API surface (employees, tables, time off, payroll, scheduling, performance,
// hiring, benefits, compensation, onboarding, webhooks, …).
const BAMBOOHR_SCOPES: string[] = [
  'background_checks', 'background_checks.write', 'benefit', 'benefit.write', 'email', 'openid',
  'ask_bamboohr:chat_messages', 'ask_bamboohr:chat_messages.write', 'ask_bamboohr:policy_documents', 'ask_bamboohr:policy_documents.write', 'ask_bamboohr:settings', 'ask_bamboohr:settings.write',
  'company:administration', 'company:administration.write', 'company:details', 'company:details.write', 'company:info',
  'company_file', 'company_file.write', 'customer_onboarding', 'customer_onboarding.write', 'data_cleaner', 'data_cleaner.write', 'data_hygiene', 'data_hygiene.write',
  'employee:tabs', 'employee:tabs.write', 'employee_wellbeing:settings', 'employee_wellbeing:settings.write', 'enps:settings', 'enps:settings.write',
  'error_management', 'error_management.write', 'job_organization', 'job_organization.write', 'performance:settings', 'performance:settings.write',
  'employee', 'employee.write', 'employee:assets', 'employee:assets.write', 'employee:compensation', 'employee:compensation.write', 'employee:contact', 'employee:contact.write',
  'employee:custom_fields', 'employee:custom_fields.write', 'employee:custom_fields_encrypted', 'employee:custom_fields_encrypted.write',
  'employee:demographic', 'employee:demographic.write', 'employee:dependent', 'employee:dependent.write', 'employee:dependent:ssn', 'employee:dependent:ssn.write',
  'employee:education', 'employee:education.write', 'employee:emergency_contacts', 'employee:emergency_contacts.write', 'employee:file', 'employee:file.write',
  'employee:identification', 'employee:identification.write', 'employee:job', 'employee:job.write', 'employee:management', 'employee:management.write',
  'employee:name', 'employee:name.write', 'employee:payroll', 'employee:payroll.write', 'employee:photo', 'employee:photo.write',
  'employee:providers', 'employee:providers.write', 'employee:providers:payroll', 'employee:providers:payroll.write', 'employee:vaccination', 'employee:vaccination.write',
  'employee_directory', 'employee_verifications', 'employee_verifications.write', 'esignature', 'goal', 'goal.write', 'onboarding', 'onboarding.write',
  'performance:assessments', 'performance:assessments.write', 'performance:feedback', 'performance:feedback.write', 'performance:one_on_ones', 'performance:one_on_ones.write',
  'sensitive_employee:address', 'sensitive_employee:address.write', 'sensitive_employee:creditcards', 'sensitive_employee:creditcards.write',
  'sensitive_employee:protected_info', 'sensitive_employee:protected_info.write', 'tasks', 'tasks.write',
  'hiring:applications', 'hiring:applications.write', 'hiring:checkr', 'hiring:checkr.write', 'hiring:job_openings', 'hiring:job_openings.write',
  'hiring:offers', 'hiring:offers.write', 'hiring:settings', 'hiring:settings.write', 'hiring:talent_pools', 'hiring:talent_pools.write',
  'access_level', 'alerts', 'alerts.write', 'approval_workflows', 'approval_workflows.write', 'benchmarking:compensation',
  'compensation_benchmarks', 'compensation_benchmarks.write', 'compensation_tools', 'equity', 'equity.write', 'esignature:instance', 'esignature:instance.write',
  'field', 'field.write', 'gridlets', 'gridlets.write', 'insights', 'insights.write', 'mcp', 'meta', 'offline_access',
  'pay_grades_and_bands', 'pay_grades_and_bands.write', 'planning_cycles', 'planning_cycles.write', 'public.integration', 'public.user',
  'total_rewards', 'total_rewards.write', 'training', 'training.write', 'user', 'user.write', 'user:management', 'user:management.write',
  'webhooks', 'webhooks.write', 'workflows:external_tasks', 'workflows:external_tasks.write', 'workflows:instances', 'workflows:instances.write',
  'deductions', 'deductions.write', 'payroll', 'payroll.write', 'payroll:ach_returns', 'payroll:ach_returns.write', 'payroll:beneficial_owners', 'payroll:beneficial_owners.write',
  'payroll:earnings', 'payroll:legal_entities', 'payroll:pay_cycles', 'payroll:pay_periods', 'payroll:pay_schedules', 'payroll:pay_stubs', 'payroll:payrolls', 'payroll:retirements',
  'report', 'report.write', 'recognitions:manage', 'recognitions:manage.write', 'recognitions:suggestions', 'recognitions:suggestions.write',
  'scheduling:schedules', 'scheduling:schedules.write', 'scheduling:shifts', 'scheduling:shifts.write', 'time_off', 'time_off.write',
  'time_tracking', 'time_tracking.write', 'time_tracking:breaks', 'time_tracking:breaks.write', 'time_tracking:project', 'time_tracking:project.write',
  'time_tracking:shift_differentials', 'time_tracking:shift_differentials.write', 'time_tracking:timesheets', 'time_tracking:timesheets.write',
];

const NATIVE_HRIS_OAUTH: Record<string, { auth: LocalConnectorDef['auth']; egress: string }> = {
  gusto: {
    auth: {
      kind: 'static_oauth',
      clientIdEnvVar: 'GUSTO_CLIENT_ID',
      clientSecretEnvVar: 'GUSTO_CLIENT_SECRET',
      authUrl: `${GUSTO_OAUTH_HOST}/oauth/authorize`,
      tokenUrl: `${GUSTO_OAUTH_HOST}/oauth/token`,
      // Gusto's refresh token is single-use + rotates; the OAuth callback persists the
      // rotated refresh_token on every exchange (carry-over path in oauth/router.ts).
      scopes: [
        'companies:read', 'employees:read', 'employees:write', 'jobs:read', 'jobs:write',
        'compensations:read', 'compensations:write', 'payrolls:read', 'pay_schedules:read',
        'time_off_policies:read',
      ],
      scopeDelimiter: ' ',
    },
    egress: 'api.gusto*.com',
  },
  rippling: {
    auth: {
      kind: 'static_oauth',
      clientIdEnvVar: 'RIPPLING_CLIENT_ID',
      clientSecretEnvVar: 'RIPPLING_CLIENT_SECRET',
      // `PLATFORM` is the App-Shop app slug — replace with our real app id when the
      // Rippling App-Shop app is provisioned. Endpoints recovered from this repo's
      // prior Rippling OAuth config (commit e50ee4d).
      authUrl: 'https://app.rippling.com/apps/PLATFORM/authorize',
      tokenUrl: 'https://app.rippling.com/api/o/token/',
      // Starter scopes; the full grant is configured on the App-Shop app at provisioning.
      scopes: ['employee:read', 'company:read'],
      scopeDelimiter: ' ',
    },
    egress: '*.ripplingapis.com',
  },
  // BambooHR: developer-portal OAuth app, per-company-subdomain authorize/token
  // (SUBDOMAIN-templated — same mechanism as Zendesk). Full app-granted scope set.
  bamboohr: {
    auth: {
      kind: 'static_oauth',
      clientIdEnvVar: 'BAMBOOHR_CLIENT_ID',
      clientSecretEnvVar: 'BAMBOOHR_CLIENT_SECRET',
      // buildAuthUrl (case 'bamboohr') appends request=authorize + response_type=code +
      // the '+'-delimited scope; SUBDOMAIN is substituted from the connect subdomain.
      authUrl: 'https://SUBDOMAIN.bamboohr.com/authorize.php',
      tokenUrl: 'https://SUBDOMAIN.bamboohr.com/token.php?request=token',
      scopes: BAMBOOHR_SCOPES,
      scopeDelimiter: '+',
    },
    egress: '*.bamboohr.com',
  },
};
for (const [type, cfg] of Object.entries(NATIVE_HRIS_OAUTH)) {
  const def = CONNECTORS[type];
  if (!def) continue;
  def.auth = cfg.auth;
  def.mcp = { kind: 'sidecar', sidecarPath: `/${type}`, allowedEgressDomain: cfg.egress };
  def.status = 'available';
  delete def.statusReason;
  // Keep capabilities (hris), category ('hr'), multiInstance — same as the api_key
  // flip above (the platform binds HRIS connectors by the hris capability). Native
  // polling is out of scope for the flip — EXCEPT bamboohr, which is a live connector
  // with a working directory poller + normalizer (its native client keeps list('Employee')).
  if (type !== 'bamboohr') delete def.polling;
}

// ── Category display labels ──────────────────────────────────────────
//
// Human-readable section headings for each category, shipped with the
// catalog endpoint response so the frontend picker never has to
// maintain its own enum→label map. Owned here so the enum and the
// label cannot drift.

import type { ConnectorCategory } from '@liftoffos/connector-types';

export const CATEGORY_DISPLAY_LABELS: Record<ConnectorCategory, string> = {
  crm_sales: 'CRM & Sales',
  productivity_comms: 'Productivity & Communication',
  engineering: 'Engineering',
  customer_support: 'Customer Support',
  finance: 'Finance & Payments',
  accounting: 'Accounting',
  hr: 'HR & Payroll',
  storage: 'Storage',
  meetings_scheduling: 'Meetings & Scheduling',
  data: 'Data & Analytics',
  knowledge: 'Knowledge',
  observability: 'Observability',
  marketing_comms: 'Marketing',
  social_messaging: 'Social & Messaging',
  project_management: 'Project Management',
  e_commerce: 'E-Commerce',
  error_tracking: 'Error Tracking',
  instant_connect: 'Instant Connect',
  incident_management: 'Incident Management',
  ats: 'Applicant Tracking',
  infrastructure: 'Infrastructure',
  web_tools: 'Web Tools',
};

// ── URL resolvers ────────────────────────────────────────────────────
//
// Vendor-hosted MCP URLs that depend on per-tenant config (Snowflake account,
// Databricks workspace) are keyed by `urlResolverKey` in the connector entry.
// The actual resolver functions live here so `ConnectorDef` stays fully
// serializable — the map crosses the HTTP boundary unchanged, and consumers
// call these functions with per-tenant connector.config to build the real URL.

export type UrlResolverKey = 'snowflake_account' | 'databricks_workspace';

export const URL_RESOLVERS: Record<
  UrlResolverKey,
  (connectorConfig: Record<string, unknown>) => string
> = {
  snowflake_account: (cfg) =>
    `https://${cfg.accountIdentifier}.snowflakecomputing.com/api/2.0/mcp`,
  databricks_workspace: (cfg) => `${cfg.workspaceUrl as string}/api/2.0/mcp/sql`,
};

/**
 * Opaque version string derived from the connectors map. Changes whenever
 * any connector entry changes. Used to invalidate caches in platform-backend
 * and the frontend without requiring a full response diff.
 *
 * Includes the Composio resource IDs in the hash so that running the
 * bootstrap script (which replaces `<from-phase-0>` placeholders with real
 * `ac_…` / `mcp_…` ids) bumps the version and forces frontend cache
 * invalidation. Otherwise an operator pasting new IDs would leave dashboards
 * stuck on the old "coming_soon" projection until users hard-refresh.
 */
export function computeCatalogVersion(): string {
  const sorted = Object.keys(CONNECTORS).sort();
  const parts: string[] = [];
  for (const k of sorted) {
    const c = CONNECTORS[k]!;
    let suffix = c.status;
    if (c.mcp?.kind === 'composio_managed') {
      // Hashing only the dev half is fine — when prod IDs change, dev
      // changes within the same commit (operator runs bootstrap twice).
      suffix += `:${c.mcp.authConfigIds.dev}:${c.mcp.mcpServerIds.dev}`;
    }
    parts.push(`${k}:${suffix}`);
  }
  const joined = parts.join('|');
  // djb2 — avoid Node crypto imports in this module.
  let hash = 5381;
  for (let i = 0; i < joined.length; i++) {
    hash = ((hash * 33) ^ joined.charCodeAt(i)) >>> 0;
  }
  return `v${hash.toString(16)}`;
}
