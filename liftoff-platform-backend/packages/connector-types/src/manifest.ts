import type { ConnectorType } from './connector.js';

// ConnectorManifest is PURE per-tenant metadata. Tool function schemas
// live in the connector functions registry (in-memory, keyed by
// connectorType), not on the manifest itself — so code changes to fix
// bad schemas don't have to wait for credentials_stored re-fires.

export interface ConnectorManifest {
  id: string;
  tenantId: string;
  connectorType: ConnectorType;
  alias: string;
  displayName: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  /**
   * Composio cutover-completion: per-tenant per-toolkit Composio
   * connectedAccountId, mirrored from connector-service's
   * connectors.config.composioConnectedAccountId at manifest sync time.
   * REQUIRED for composio_managed connectors so tenant-runtime's
   * dispatcher can disambiguate multi-account tenants (OAuth uses
   * allowMultiple: true, see composio-client.ts:68). Absent for native
   * connectors and pre-cutover legacy rows.
   */
  externalAccountId?: string;
}

export interface ConnectorManifestCreate {
  tenantId: string;
  connectorType: ConnectorType;
  alias: string;
  displayName: string;
  enabled?: boolean;
  externalAccountId?: string;
}
