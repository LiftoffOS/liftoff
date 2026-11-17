// Canonical Secret Manager storage shape for per-tenant connector
// credentials.
//
// Mirrors the pattern in `liftoff-connector-service/src/secrets/client.ts`
// (the original implementation for OAuth / API-key connectors). Replicated
// here (and intentionally also in tenant-runtime/src/infrastructure/
// connector-secrets.ts) so that platform-backend, connector-service, and
// tenant-runtime all read and write the same secret under the same name
// in the same project, regardless of which one of them owns the write
// path for a given connector type.
//
// All three implementations must stay byte-identical until a shared
// `@liftoffos/connector-secrets` package is published.
//
// Naming: `connector-{tenantId}-{connectorId}` (canonical contract).
// Project: per TENANT_HOSTING_MODE (shared / dedicated).

export type HostingMode = 'shared' | 'dedicated';

/** Resolve the GCP project that holds tenant connector secrets, based on
 *  hosting mode. `shared` (default) → YOUR_GCP_PROJECT.
 *  `dedicated` → tenant-{tenantId}-{env}. Matches resolveProjectId in
 *  connector-service/src/secrets/client.ts byte-for-byte. */
export function resolveSecretProjectId(tenantId: string, hostingMode?: HostingMode): string {
  const env = process.env.ENVIRONMENT ?? 'dev';
  const hm = hostingMode ?? ((process.env.TENANT_HOSTING_MODE as HostingMode | undefined) ?? 'shared');
  if (hm === 'dedicated') {
    return process.env.TENANT_GCP_PROJECT_ID ?? `tenant-${tenantId}-${env}`;
  }
  return process.env.GCP_PROJECT_ID ?? `YOUR_GCP_PROJECT`;
}

/** Canonical secret name for a per-tenant connector credential. */
export function getConnectorSecretName(tenantId: string, connectorId: string): string {
  return `connector-${tenantId}-${connectorId}`;
}
