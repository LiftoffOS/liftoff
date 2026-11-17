// Connector catalog types — the shape of each connector entry returned by
// connector-service's GET /api/connectors/catalog endpoint.
//
// Single source of truth for connector metadata. Every other representation
// (OAuth flow config, MCP registry, functional-types set, capability map,
// frontend UI catalog, generated docs) is a projection of CONNECTORS in
// liftoff-connector-service/src/catalog/connectors.ts — consumers read these
// types and the endpoint response, never a hand-maintained mirror.

/**
 * Lifecycle state exposed in the UI.
 *
 *   available   — OAuth app registered (if needed) + client implementation
 *                 working + surfaced in the connector picker. User can
 *                 connect immediately.
 *
 *   coming_soon — Client code exists but the prerequisite is not yet
 *                 provisioned (commonly: vendor OAuth app not registered
 *                 or secret not set in Secret Manager). Renders in the UI
 *                 as "coming soon"; `supportsConnection()` is false.
 *
 *   beta        — Functional but rough edges acknowledged. Surfaced with
 *                 a beta badge.
 *
 *   deprecated  — Legacy; do not offer for new connections.
 */
/** 'internal' is live-but-hidden: fully wired and callable by the platform
 *  (assistants, distillation, provisioning), filtered OUT of the catalog
 *  response the dashboard receives, so no connector card exists. Everything
 *  that is not the user-facing catalog view must treat it exactly like
 *  'available' — a poll scheduler or OAuth flow that special-cases it has a
 *  bug. */
export type ConnectorCatalogStatus = 'available' | 'coming_soon' | 'beta' | 'deprecated' | 'internal';

/**
 * High-level grouping used to organize the connector picker UI.
 *
 * Human-readable labels for each category are defined in
 * `liftoff-connector-service/src/catalog/connectors.ts::CATEGORY_DISPLAY_LABELS`
 * and shipped alongside the catalog in `ConnectorCatalogResponse.categoryLabels`.
 */
export type ConnectorCategory =
  | 'crm_sales'
  | 'productivity_comms'
  | 'engineering'
  | 'customer_support'
  | 'finance'
  | 'accounting'
  | 'hr'
  | 'storage'
  | 'meetings_scheduling'
  | 'data'
  | 'knowledge'
  | 'observability'
  | 'marketing_comms'
  | 'social_messaging'
  | 'project_management'
  | 'e_commerce'
  | 'error_tracking'
  | 'instant_connect'
  | 'incident_management'
  | 'ats'
  | 'infrastructure'
  | 'web_tools';

// ── Auth configurations ────────────────────────────────────────────────

export interface StaticOauthAuth {
  kind: 'static_oauth';
  /** Env var the service reads for OAuth client ID (e.g. 'GITHUB_CLIENT_ID'). */
  clientIdEnvVar: string;
  /** Env var for OAuth client secret. */
  clientSecretEnvVar: string;
  /** Authorization endpoint. */
  authUrl: string;
  /** Token endpoint. */
  tokenUrl: string;
  scopes: string[];
  scopeDelimiter: string;
  /** Whether the provider requires PKCE. */
  requiresPkce?: boolean;
}

export interface DcrOauthAuth {
  kind: 'dcr_oauth';
  /** Base URL for .well-known OAuth discovery. */
  discoveryBaseUrl: string;
  /** Env var clientId fallback (local dev only). */
  clientIdEnvVar: string;
  /** Env var clientSecret fallback (local dev only). */
  clientSecretEnvVar: string;
  scopes: string[];
  scopeDelimiter: string;
}

export interface ApiKeyAuth {
  kind: 'api_key';
}

export interface KeypairAuth {
  kind: 'keypair';
}

export interface NoAuth {
  kind: 'none';
}

/**
 * Custom MCP Server connector — tenant-registered MCP endpoint (public URL
 * or tunnel-routed). Auth credentials are stored per-instance in Secret
 * Manager; this catalog entry just marks the connector type as the inline
 * Custom MCP Server flow in the UI.
 */
export interface CustomMcpAuth {
  kind: 'custom_mcp';
}

/**
 * Custom API connector — an API a workspace described and connected from a
 * conversation. The credential is API-key-shaped (bearer header, named header,
 * query parameter, path segment) and stored per instance in Secret Manager;
 * the hosts, the placement, the verification call and the operations live on
 * `custom_api_connectors` in connector-service's own database.
 *
 * Deliberately NOT `api_key`: an `api_key` connector has a static connect form
 * (`API_KEY_CONNECTOR_CONFIGS`, asserted by `apikey-router.test.ts`), and this
 * family's form is dynamic by design — the fields only exist once an assistant
 * has read a particular provider's documentation. The Connections tile for it
 * starts a conversation rather than opening a form.
 */
export interface CustomApiAuth {
  kind: 'custom_api';
}

export type ConnectorAuth =
  | StaticOauthAuth
  | DcrOauthAuth
  | ApiKeyAuth
  | KeypairAuth
  | CustomMcpAuth
  | CustomApiAuth
  | NoAuth;

// ── MCP configurations ────────────────────────────────────────────────

export type McpTransport = 'sse' | 'streamable-http' | 'stdio';

export interface VendorHostedMcp {
  kind: 'vendor_hosted';
  /** Template URL — may contain placeholder substrings resolved at runtime. */
  mcpUrl: string;
  transport: McpTransport;
  /** Optional per-tenant URL rewriter (for Snowflake account URLs, Databricks workspaces). */
  urlResolverKey?: 'snowflake_account' | 'databricks_workspace';
  discoveryTimeoutMs?: number;
}

export interface SidecarMcp {
  kind: 'sidecar';
  /** Path segment on the sidecar service (e.g. '/github', '/google/sheets'). */
  sidecarPath: string;
  /** Host glob allowed through the sandbox egress policy. */
  allowedEgressDomain?: string;
  transport?: McpTransport;
}

/**
 * Customer-hosted MCP — the URL is resolved at runtime from each tenant's
 * registered custom_mcp_servers row (public URL or *.tunnels.example.com
 * tunnel route). No URL template on the catalog entry itself.
 */
export interface CustomerHostedMcp {
  kind: 'customer_hosted';
  transport?: McpTransport;
}

/**
 * Composio-managed MCP — Composio operates a pre-approved OAuth app for the
 * underlying toolkit and exposes per-tenant MCP at
 * `mcp.composio.dev/composio/server/<mcpServerId>?user_id=<tenant_id>`. The
 * tenant identity is supplied as a query param (not a Bearer header) and the
 * tokens never leave Composio.
 */
export interface ComposioManagedMcp {
  kind: 'composio_managed';
  /** Composio toolkit slug, e.g. 'gong', 'dynamics365'. */
  toolkitSlug: string;
  /** Per-env Composio auth_config IDs (managed mode). */
  authConfigIds: { dev: string; prod: string };
  /** Per-env Composio MCP server IDs. */
  mcpServerIds: { dev: string; prod: string };
  /** Composio MCP servers only support streamable-http. */
  transport: 'streamable-http';
  /**
   * For rollback safety: if set, mcp-server-registry can fall back to this
   * sidecar config when the connector type appears in
   * COMPOSIO_DISABLED_CONNECTORS env var. Phase 7 deletes this field once
   * the migration is settled.
   */
  rollbackSidecar?: { sidecarPath: string; allowedEgressDomain?: string };
}

export type ConnectorMcp = VendorHostedMcp | SidecarMcp | CustomerHostedMcp | ComposioManagedMcp;

// ── Capability binding ────────────────────────────────────────────────

export interface ConnectorCapabilityBinding {
  /** Capability identifier (e.g. 'crm', 'accounting', 'support_ticketing'). */
  capability: string;
  /** OAuth scopes required for this connector to satisfy the capability. */
  requiredScopes: string[];
}

export interface ConnectorPollingConfig {
  /** Entity type polled (e.g. 'Email', 'Issue', 'CalendarEvent'). */
  entityType: string;
  /** Exact Pub/Sub topic strings agents subscribe to for this entity type. */
  eventTopics: string[];
  /**
   * true  = list() is implemented and actually fetches records.
   *         Scheduler will run this connector; distillation will suggest its topics.
   * false = polling metadata defined but list() not yet implemented.
   *         Scheduler skips; distillation omits. Flip to true when list() is ready.
   */
  listImplemented: boolean;
  /**
   * Optional Composio trigger for EVENT-driven delivery of this entity (as an
   * alternative/complement to polling). When set, connector-service arms
   * `composio.triggers.create(slug)` on webhook enable, and tenant-runtime
   * derives its slug→(source, entityType) dispatch from this — the single
   * source of truth that replaces the two hand-synced trigger tables. An entity
   * may be event-only (`listImplemented:false` + `eventTrigger` set).
   */
  eventTrigger?: {
    /** Composio trigger slug, e.g. 'TODOIST_NEW_TASK_CREATED'. */
    slug: string;
    /** Per-trigger config Composio merges (e.g. { interval: 1 } for pollers). */
    triggerConfig?: Record<string, unknown>;
  };
}

// ── Main shape ────────────────────────────────────────────────────────

/**
 * Single authoritative definition of a connector. Written once in
 * liftoff-connector-service's CONNECTORS map; consumed everywhere else
 * via GET /api/connectors/catalog.
 */
export interface ConnectorDef {
  /** Canonical type identifier (e.g. 'github', 'google_sheets'). */
  type: string;
  /** Human-readable name shown in the UI. */
  displayName: string;
  /** One-line description rendered in the connector card. */
  description?: string;
  category: ConnectorCategory;
  /** Object kinds the connector exposes, for UI display. */
  objectsCovered?: string[];
  /** Lifecycle state — drives both UI gating and `supportsConnection()`. */
  status: ConnectorCatalogStatus;
  /** Human-readable reason when `status !== 'available'`. */
  statusReason?: string;
  auth: ConnectorAuth;
  /** Absent when the connector has no MCP surface (pure REST). */
  mcp?: ConnectorMcp;
  /** Capabilities satisfied by this connector. */
  capabilities?: ConnectorCapabilityBinding[];
  /**
   * Present when this connector supports polling.
   * Connectors without this field are tool-only (no event trigger capability).
   */
  polling?: ConnectorPollingConfig[];
  /**
   * Whether a tenant may hold several independent connections of this type.
   *
   * WHAT IT ACTUALLY CONTROLS: on a RECONNECT of a Composio-managed connector,
   * connector-service retires the previously linked Composio account for a
   * single-instance connector and keeps sibling accounts for a multi-instance
   * one (`oauth/apikey-router.ts`). That is the only behaviour that turns on
   * this flag.
   *
   * WHAT IT DOES NOT CONTROL, despite what it may look like:
   * it does NOT keep the "Add" tile persistent, and it does NOT cause one
   * Connected tile per instance. The dashboard does both of those for EVERY
   * connector type regardless — the Available list is built from the catalog and
   * its status never depends on whether an instance is connected, and the
   * Connected list maps over live connector rows rather than over the catalog.
   * Its only effect in the dashboard is the React key (`<type>:<connectorId>`
   * versus the bare connector id); both are unique, so that is presentational.
   *
   * The old wording was believed and acted on before anyone traced it, which is
   * the reason for this correction: it ships in `dist/catalog.d.ts` and is what
   * every consumer sees on hover, so a wrong sentence here propagates silently.
   * Do not set or clear this flag to change anything about connector tiles.
   */
  multiInstance?: boolean;
  /**
   * Per-entityType JSON-Schema-7 declarations exposed by this connector.
   * Each connector author calls `registerConnectorEntitySchemas` from its
   * own module; the platform reads this map generically when building
   * distill prompt context and when validating reactive subscription
   * `path` references. Optional on the static catalog entry — the
   * runtime catalog projection in connector-service attaches it for
   * every entry (empty object when undeclared) before serving the
   * response.
   */
  entitySchemas?: Record<string, Record<string, unknown>>;
}

/**
 * Response shape for GET /api/connectors/catalog.
 *
 * `categoryLabels` is included so the frontend never has to maintain its
 * own ConnectorCategory → display-string map; consumers just look up
 * `response.categoryLabels[connector.category]`.
 */
export interface ConnectorCatalogResponse {
  connectors: ConnectorDef[];
  /** Opaque version string that changes whenever any connector entry changes. */
  version: string;
  /** Category enum → human-readable section label. */
  categoryLabels: Record<ConnectorCategory, string>;
}
