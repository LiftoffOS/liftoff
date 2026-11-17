// Secret Manager wrapper for connector-service.
//
// Secret naming convention for connector credentials:
//   connector-{tenantId}-{connectorId}
//
// Hosting modes:
//   - 'shared'    → secrets live in YOUR_GCP_PROJECT
//   - 'dedicated' → secrets live in tenant-{tenantId}-{env}
//
// Callers supply the tenantId + connectorId and hostingMode is resolved
// from the service's TENANT_HOSTING_MODE env (default 'shared' at the
// platform level, 'dedicated' when the service is deployed into a
// per-tenant project).

import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { logger } from '../infra/logging.js';

export type HostingMode = 'shared' | 'dedicated';

export interface ConnectorSecretData {
  accessToken?: string;
  refreshToken?: string;
  apiKey?: string;
  privateKey?: string;
  instanceUrl?: string;
  expiresAt?: string;
  tokenType?: string;
  scopes?: string[];
  metadata?: Record<string, unknown>;
}

let clientInstance: SecretManagerServiceClient | null = null;

function getClient(): SecretManagerServiceClient {
  if (!clientInstance) {
    clientInstance = new SecretManagerServiceClient();
  }
  return clientInstance;
}

// Visible-for-testing — lets tests inject a mock client.
export function __setSecretManagerClient(
  client: SecretManagerServiceClient | null,
): void {
  clientInstance = client;
}

function resolveProjectId(tenantId: string, hostingMode: HostingMode): string {
  const env = process.env.ENVIRONMENT ?? 'dev';
  if (hostingMode === 'dedicated') {
    return process.env.TENANT_GCP_PROJECT_ID ?? `tenant-${tenantId}-${env}`;
  }
  return process.env.GCP_PROJECT_ID ?? `YOUR_GCP_PROJECT`;
}

export function getSecretName(tenantId: string, connectorId: string): string {
  return `connector-${tenantId}-${connectorId}`;
}

function resolveHostingMode(): HostingMode {
  return (process.env.TENANT_HOSTING_MODE as HostingMode | undefined) ?? 'shared';
}

export async function getSecret(
  secretName: string,
  opts: { hostingMode?: HostingMode; tenantId?: string; version?: string } = {},
): Promise<string> {
  const SECRET_NAME_RE = /^connector-[a-zA-Z0-9_-]+-[a-zA-Z0-9_-]+$/;
  if (!SECRET_NAME_RE.test(secretName)) {
    logger.error({ secretName }, 'secret name failed pattern validation');
    throw new Error(`Secret name does not match expected pattern: ${secretName}`);
  }
  const hostingMode = opts.hostingMode ?? resolveHostingMode();
  const projectId = resolveProjectId(opts.tenantId ?? '__platform__', hostingMode);
  const version = opts.version ?? 'latest';
  const name = `projects/${projectId}/secrets/${secretName}/versions/${version}`;
  try {
    const [response] = await getClient().accessSecretVersion({ name });
    const payload = response.payload?.data?.toString() ?? '';
    return payload;
  } catch (err) {
    logger.error({ err: (err as Error).message, secretName }, 'secret access failed');
    throw new Error(`Failed to load secret: ${secretName}`);
  }
}

const SECRET_NAME_SEGMENT_RE = /^[a-zA-Z0-9_-]+$/;

function assertSafeSecretSegment(value: string, label: string): void {
  if (!SECRET_NAME_SEGMENT_RE.test(value)) {
    logger.error({ [label]: value }, 'secret path segment failed validation — aborting credential fetch');
    throw new Error(`Invalid ${label} for secret access: contains disallowed characters`);
  }
}

export async function getConnectorCredential(
  tenantId: string,
  connectorId: string,
  hostingMode?: HostingMode,
): Promise<ConnectorSecretData> {
  assertSafeSecretSegment(tenantId, 'tenantId');
  assertSafeSecretSegment(connectorId, 'connectorId');
  const secretName = getSecretName(tenantId, connectorId);
  const raw = await getSecret(secretName, { hostingMode, tenantId });
  try {
    return JSON.parse(raw) as ConnectorSecretData;
  } catch {
    throw new Error(`Connector secret ${secretName} is not valid JSON`);
  }
}

export async function deleteConnectorCredential(
  tenantId: string,
  connectorId: string,
  hostingMode?: HostingMode,
): Promise<boolean> {
  const hm = hostingMode ?? resolveHostingMode();
  const projectId = resolveProjectId(tenantId, hm);
  const secretName = getSecretName(tenantId, connectorId);
  const name = `projects/${projectId}/secrets/${secretName}`;
  try {
    await getClient().deleteSecret({ name });
    return true;
  } catch (err) {
    // NOT_FOUND → nothing to delete, treat as idempotent success.
    if ((err as { code?: number }).code === 5) {
      return false;
    }
    logger.error(
      { err: (err as Error).message, tenantId, connectorId },
      'delete connector credential failed',
    );
    throw err;
  }
}

export async function storeConnectorCredential(
  tenantId: string,
  connectorId: string,
  credential: ConnectorSecretData,
  hostingMode?: HostingMode,
): Promise<string> {
  const hm = hostingMode ?? resolveHostingMode();
  const projectId = resolveProjectId(tenantId, hm);
  const secretName = getSecretName(tenantId, connectorId);
  const parent = `projects/${projectId}/secrets/${secretName}`;
  const payload = { data: Buffer.from(JSON.stringify(credential)) };

  try {
    const [version] = await getClient().addSecretVersion({ parent, payload });
    return version.name ?? secretName;
  } catch (err) {
    // NOT_FOUND → create the secret then add the version.
    if ((err as { code?: number }).code === 5) {
      await getClient().createSecret({
        parent: `projects/${projectId}`,
        secretId: secretName,
        secret: { replication: { automatic: {} } },
      });
      const [version] = await getClient().addSecretVersion({ parent, payload });
      return version.name ?? secretName;
    }
    logger.error(
      { err: (err as Error).message, tenantId, connectorId },
      'store connector credential failed',
    );
    throw err;
  }
}
