// Canonical list of connector types across Liftoff. Tenant-runtime and
// platform-backend both derive their ConnectorType union from this — the
// future connector-service (Phase 1) also returns it via the
// GetFunctionalTypes RPC.
//
// Grouped for readability; order is not semantically meaningful.
export const CONNECTOR_TYPES = [
  // CRM / Sales
  'salesforce',
  'hubspot',               // read-only via vendor MCP
  'hubspot_write',         // write operations via REST sidecar
  // Productivity / Comms
  'slack',
  'github',
  'gitlab',
  'linear',
  // Atlassian suite (shared OAuth provider)
  'atlassian_jira',
  'atlassian_confluence',
  // Customer Support
  'zendesk',
  'intercom',
  // Google Workspace
  'google_calendar',
  'google_drive',
  'google_mail',
  'google_contacts',
  'google_tasks',
  'google_docs',
  'google_sheets',
  'google_slides',
  // Microsoft 365
  'microsoft_onedrive',
  'microsoft_outlook_mail',
  'microsoft_outlook_calendar',
  'microsoft_teams',
  'microsoft_todo',
  'microsoft_contacts',
  'microsoft_onenote',
  'microsoft_sharepoint',
  'microsoft_planner',
  // Storage
  'dropbox',
  'box',
  // Finance / Payments
  'stripe',
  'plaid',
  'quickbooks',
  'xero',
  // HR / Payroll
  'bamboohr',
  'rippling',
  'gusto',
  // Legal
  'docusign',
  // Marketing / Knowledge
  'mailchimp',
  'notion',
  // Data warehouses (per-instance config)
  'snowflake',
  'databricks',
  // Observability / Monitoring
  'sentry',
  'datadog',
  // Video conferencing
  'zoom',
  // Web / general-purpose
  'web_search',
  // Registered but not yet implemented (disabled in MCP registry)
  'asana',
  'square',
  'paypal',
  'calendly',
  'pipedrive',
  'sendgrid',
  'trello',
  'cal_com',
  'woocommerce',
] as const;

export type ConnectorType = typeof CONNECTOR_TYPES[number];

export type ConnectorStatusValue = 'active' | 'paused' | 'error';

export interface Connector {
  id: string;
  tenantId: string;
  type: ConnectorType;
  name: string;
  status: ConnectorStatusValue;
  /** Per-instance config (e.g. Snowflake accountIdentifier, Databricks workspaceUrl). */
  config: Record<string, unknown>;
  lastSyncAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ConnectorHealthStatus = 'healthy' | 'degraded' | 'error';
export type SyncStatus = 'success' | 'partial' | 'failed';

export interface ConnectorStatus {
  connectorId: string;
  status: ConnectorHealthStatus;
  lastSyncAt: Date | null;
  lastSyncStatus: SyncStatus | null;
  recordsProcessed: number;
  errorCount: number;
}

export interface NormalizedRecord {
  connectorId: string;
  entityType: string;
  externalId: string;
  data: Record<string, unknown>;
  syncedAt: Date;
}
