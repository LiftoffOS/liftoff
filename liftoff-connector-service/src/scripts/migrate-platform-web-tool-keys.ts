// One-shot migration: lift the six BYOK web-tool platform Secret Manager
// values into per-tenant connector rows owned by the operator's platform tenant.
//
// Run it in a non-production environment first, verify, then in production.
//   1. node scripts/migrate-platform-web-tool-keys.js --dry-run
//   2. node scripts/migrate-platform-web-tool-keys.js
//   3. After successful tool calls under the platform tenant for each vendor,
//      node scripts/migrate-platform-web-tool-keys.js --delete-platform-secrets
//
// Perplexity is intentionally NOT migrated — its `perplexity-api-key`
// secret stays as the platform default.

import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { connectorCrudService } from '../crud/service.js';
import { credentialService } from '../credentials/service.js';
import { closeAllPools } from '../db/pool.js';
import { logger } from '../infra/logging.js';
import { fetchApiKeyIdentity } from '../oauth/api-key-identity-fetchers.js';
import { updateApiKeyHint } from '../oauth/connector-ops.js';
import type { ConnectorType } from '../types.js';

/** The operator's platform tenant, which holds the platform seed connectors. */
const PLATFORM_TENANT_ID = 'dd7d80bd-3b77-4677-817c-053fdb8668cd';
const ENV = process.env.ENVIRONMENT ?? 'dev';
const PLATFORM_CONTROL_PROJECT = `YOUR_GCP_PROJECT`;

type VendorSpec = {
  connectorType: ConnectorType;
  displayName: string;
  apiKeySecret: string;
  /** Additional Secret Manager entries copied into credential metadata.extraFields.
   *  Today: browserbase requires { projectId: 'browserbase-project-id' }. */
  extraSecrets?: Record<string, string>;
};

// Display names match the catalog's `displayName` for each connector type
// (src/catalog/connectors.ts). The platform tenant's connector rows are
// indistinguishable from those a normal tenant would create via
// /connections — the "platform tenant" status is metadata on the tenant,
// not on the connector name. Do NOT suffix with operator metadata.
const VENDORS: VendorSpec[] = [
  { connectorType: 'firecrawl',      displayName: 'Firecrawl',      apiKeySecret: 'firecrawl-api-key' },
  { connectorType: 'anchor_browser', displayName: 'Anchor Browser', apiKeySecret: 'anchor-api-key' },
  { connectorType: 'browserbase',    displayName: 'Browserbase',    apiKeySecret: 'browserbase-api-key',
    extraSecrets: { projectId: 'browserbase-project-id' } },
  { connectorType: 'tavily',         displayName: 'Tavily',         apiKeySecret: 'tavily-api-key' },
  { connectorType: 'exa',            displayName: 'Exa',            apiKeySecret: 'exa-api-key' },
  { connectorType: 'webclaw',        displayName: 'WebClaw',        apiKeySecret: 'webclaw-api-key' },
];

const sm = new SecretManagerServiceClient();

/** Read a platform Secret Manager value by short name (e.g. 'firecrawl-api-key').
 *  The connector-service's `getSecret(name)` helper validates against the
 *  `connector-<tenant>-<connector>` pattern, so we use the GCP SDK directly.
 *  Returns '' when the secret exists but has zero versions (NOT_FOUND on the
 *  `versions/latest` resource path). A secret that exists as an empty shell
 *  with no API key populated is treated as missing and skipped. */
async function readPlatformSecret(name: string): Promise<string> {
  const resource = `projects/${PLATFORM_CONTROL_PROJECT}/secrets/${name}/versions/latest`;
  try {
    const [resp] = await sm.accessSecretVersion({ name: resource });
    return resp.payload?.data?.toString() ?? '';
  } catch (err: unknown) {
    if ((err as { code?: number }).code === 5) {
      // gRPC NOT_FOUND — secret has no enabled versions.
      return '';
    }
    throw err;
  }
}

/** Delete the secret (including all versions) — irreversible. */
async function deletePlatformSecret(name: string): Promise<void> {
  const resource = `projects/${PLATFORM_CONTROL_PROJECT}/secrets/${name}`;
  await sm.deleteSecret({ name: resource });
}

async function migrateOne(vendor: VendorSpec): Promise<void> {
  logger.info({ vendor: vendor.connectorType }, 'migrating platform key into platform tenant');

  // Idempotency: if a connector of this type already exists for the platform
  // tenant, treat as a no-op rather than adding a second row. We filter by
  // type alone because any pre-existing row of this type is equivalent for
  // the runtime resolver's purposes.
  const existing = await connectorCrudService.findByTenantAndType(
    PLATFORM_TENANT_ID,
    vendor.connectorType,
  );
  if (existing) {
    logger.info(
      { vendor: vendor.connectorType, connectorId: existing.id },
      'connector already exists for platform tenant — skipping migration',
    );
    return;
  }

  const apiKey = await readPlatformSecret(vendor.apiKeySecret);
  if (!apiKey) {
    logger.warn(
      { vendor: vendor.connectorType, secret: vendor.apiKeySecret },
      'platform secret missing or empty — skipping',
    );
    return;
  }

  const extraFields: Record<string, string> = {};
  if (vendor.extraSecrets) {
    for (const [field, secretName] of Object.entries(vendor.extraSecrets)) {
      const v = await readPlatformSecret(secretName);
      if (!v) throw new Error(`platform secret ${secretName} missing — required for ${vendor.connectorType}`);
      extraFields[field] = v;
    }
  }

  // Identity-fetcher round-trip — mirrors the apikey-router's connect-time
  // flow so the migrated row has the same `externalAccountId` /
  // `externalAccountLabel` config that a /connections-driven row would
  // have. Without these the /connections UI falls back to the dreaded
  // "Reconnect to add account details" subtitle on the Connected card.
  // Fetcher failures are tolerated for the strict-validation vendors here
  // because the script is operator-driven (any 401 means the platform
  // secret holds a bad key — the operator needs to fix that source, not
  // abort migration of the other vendors).
  let identity: Awaited<ReturnType<typeof fetchApiKeyIdentity>> = null;
  try {
    identity = await fetchApiKeyIdentity(vendor.connectorType, { apiKey, ...extraFields });
  } catch (err) {
    logger.warn(
      { vendor: vendor.connectorType, err: (err as Error).message },
      'identity fetcher rejected — proceeding without externalAccountLabel; UI will fall back to apiKeyHint',
    );
  }

  // status='active' — non-OAuth seed, visible in /connections immediately.
  // This is the canonical "connected and usable" state in the connectors
  // table (per the ConnectorStatus enum). The runtime's
  // `getWebToolCredential` resolver and `getTenantConnectedWebVendors`
  // filter both accept 'active'; 'connected' is also accepted as a
  // forward-compat alias.
  const config: Record<string, unknown> = {
    migratedFromPlatform: true,
    migratedAt: new Date().toISOString(),
  };
  if (identity) {
    config.externalAccountId = identity.externalAccountId;
    config.externalAccountLabel = identity.externalAccountLabel;
  }
  const connector = await connectorCrudService.create({
    tenantId: PLATFORM_TENANT_ID,
    type: vendor.connectorType,
    name: vendor.displayName,
    status: 'active',
    config,
  });

  await credentialService.storeCredentials(
    PLATFORM_TENANT_ID,
    connector.id,
    'api_key',
    {
      apiKey,
      metadata: {
        authType: 'api_key',
        connectorType: vendor.connectorType,
        extraFields,
      },
    },
    [],
  );

  // Mirror apikey-router's masked hint so the UI shows "•••XXXX" on the
  // Connected card subtitle even when the identity fetcher failed.
  if (apiKey.length >= 4) {
    await updateApiKeyHint(PLATFORM_TENANT_ID, connector.id, `•••${apiKey.slice(-4)}`);
  }

  logger.info({ vendor: vendor.connectorType, connectorId: connector.id }, 'migrated');
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const deletePlatformSecrets = process.argv.includes('--delete-platform-secrets');

  for (const vendor of VENDORS) {
    if (dryRun) {
      logger.info({ vendor: vendor.connectorType }, 'DRY RUN — would migrate');
      continue;
    }
    await migrateOne(vendor);
  }

  if (deletePlatformSecrets && !dryRun) {
    for (const vendor of VENDORS) {
      await deletePlatformSecret(vendor.apiKeySecret);
      if (vendor.extraSecrets) {
        for (const secretName of Object.values(vendor.extraSecrets)) {
          await deletePlatformSecret(secretName);
        }
      }
    }
    logger.info('platform secrets deleted');
  }
}

main()
  .then(async () => {
    await closeAllPools();
    process.exit(0);
  })
  .catch(async (err) => {
    logger.error({ err: (err as Error).message }, 'migration failed');
    await closeAllPools().catch(() => {});
    process.exit(1);
  });
