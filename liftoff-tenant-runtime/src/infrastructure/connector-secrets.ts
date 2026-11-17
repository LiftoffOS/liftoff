// Canonical Secret Manager storage shape for per-tenant connector
// credentials. Read path counterpart of platform-backend/src/connectors/
// canonical-secret-storage.ts and connector-service/src/secrets/client.ts.
//
// All three implementations must stay byte-identical until a shared
// `@liftoffos/connector-secrets` package is published.
//
// Naming: `connector-{tenantId}-{connectorId}` (canonical contract).
// Project: per TENANT_HOSTING_MODE (shared / dedicated).

export type HostingMode = 'shared' | 'dedicated';

/** Resolve the GCP project that holds tenant connector secrets, based on
 *  hosting mode. `shared` (default) → YOUR_GCP_PROJECT.
 *  `dedicated` → tenant-{tenantId}-{env}. */
export function resolveSecretProjectId(tenantId: string, hostingMode?: HostingMode): string {
  const env = process.env.ENVIRONMENT ?? 'dev';
  const hm = hostingMode ?? ((process.env.TENANT_HOSTING_MODE as HostingMode | undefined) ?? 'shared');
  if (hm === 'dedicated') {
    return process.env.TENANT_GCP_PROJECT_ID ?? `tenant-${tenantId}-${env}`;
  }
  // Shared mode: secrets live in the platform control project, NOT in
  // the per-tenant project. tenant-runtime's compute SA already has
  // secretAccessor on that project for tokens like
  // `tenant-runtime-service-token` and `connector-service-token`.
  return process.env.CONTROL_PLANE_PROJECT_ID ?? `YOUR_GCP_PROJECT`;
}

/** Canonical secret name for a per-tenant connector credential. */
export function getConnectorSecretName(tenantId: string, connectorId: string): string {
  return `connector-${tenantId}-${connectorId}`;
}
