// Backfill connector-pg from control-plane-pg.
//
// Phase 2b ported the OAuth callback into connector-service, but any connector
// that was created via the old platform-backend OAuth flow has its data in two
// legacy locations:
//
//   DB rows   → control-plane-pg  (platform-backend's connectors +
//               connector_credentials tables)
//   Secrets   → YOUR_TENANT_PROJECT  secret named
//               "tenant-{tenantId}-connector-{connectorId}"
//               (shared-tenancy format from platform-backend getSecretName())
//
// Connector-service expects:
//   DB rows   → connector-pg
//   Secrets   → YOUR_GCP_PROJECT  secret named
//               "connector-{tenantId}-{connectorId}"
//
// This script (run as a Cloud Run Job after every deploy) closes that gap:
//
//   1. Reads every connector + credential row from control-plane-pg.
//   2. For credential rows: tries all known legacy secret locations, reads
//      the raw JSON value, and writes it to the canonical path in
//      YOUR_GCP_PROJECT. Idempotent — skips if the canonical
//      secret already exists.
//   3. Inserts connector + credential rows into connector-pg (ON CONFLICT DO
//      NOTHING — safe to re-run on every deploy).
//
// Exit codes:
//   0  — all connectors and secrets migrated (or already present).
//   1  — at least one OAuth/API-key connector could not have its secret
//        located. This is a hard failure: callers will get NOT_FOUND when
//        they try to fetch credentials for that connector.
//
// Env vars:
//   ENVIRONMENT              dev | prod
//   SOURCE_DB_HOST           private IP / Unix socket of control-plane-pg
//   SOURCE_DB_NAME           default: liftoff_control
//   SOURCE_DB_USER           default: liftoff_app
//   SOURCE_DB_PASSWORD       secret
//   DB_HOST / DB_NAME / DB_USER / DB_PASSWORD   connector-pg (destination)
//   DRY_RUN                  true (default) | false
//   TENANT_SECRET_PROJECTS   tenantId:projectId,... overrides for dedicated
//                            tenants whose secrets are in custom projects

import { Pool } from 'pg';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

interface SourceConnectorRow {
  id: string;
  tenant_id: string;
  type: string;
  status: string;
  name: string | null;
  config: Record<string, unknown>;
  api_key_hint: string | null;
  last_sync_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface SourceCredentialRow {
  connector_id: string;
  credential_type: string;
  secret_name: string;
  scopes: unknown;
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function toFlowKind(credentialType: string): string {
  switch (credentialType) {
    case 'oauth2':
    case 'oauth':
      return 'static_oauth';
    case 'dcr':
    case 'dynamic_client_registration':
      return 'dynamic_client_registration';
    case 'api_key':
    case 'apikey':
      return 'api_key';
    case 'keypair':
      return 'keypair';
    default:
      return 'none';
  }
}

function needsSecret(credentialType: string): boolean {
  const k = toFlowKind(credentialType);
  return k !== 'none';
}

function toTextArray(scopesJson: unknown): string[] {
  if (Array.isArray(scopesJson)) return scopesJson.map((s) => String(s));
  if (scopesJson && typeof scopesJson === 'object') {
    const maybe = (scopesJson as { scopes?: unknown }).scopes;
    if (Array.isArray(maybe)) return maybe.map((s) => String(s));
  }
  return [];
}

function toEpochSec(d: Date | null): number | null {
  return d ? Math.floor(d.getTime() / 1000) : null;
}

const env = process.env.ENVIRONMENT || 'dev';
const CANONICAL_SECRET_PROJECT = `YOUR_GCP_PROJECT`;

function canonicalSecretName(tenantId: string, connectorId: string): string {
  return `connector-${tenantId}-${connectorId}`;
}

// Returns all candidate source locations for a connector's secret, ordered
// from most-likely to least-likely. The IAM binding in connector-iam/main.tf
// must cover all patterns used here.
function candidateSources(
  tenantId: string,
  connectorId: string,
  legacySecretName: string,
): Array<{ project: string; name: string }> {
  const tenantRuntimeProject = `YOUR_TENANT_PROJECT`;
  const platformControlProject = `YOUR_GCP_PROJECT`;

  const overrides = (process.env.TENANT_SECRET_PROJECTS ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((acc, pair) => {
      const [id, project] = pair.split(':');
      if (id && project) acc[id] = project;
      return acc;
    }, {});

  const tenantProject = overrides[tenantId] ?? tenantRuntimeProject;

  // All naming formats known to have existed:
  //
  //  1. platform-backend shared-tenant format (the most common legacy case):
  //     project: YOUR_TENANT_PROJECT
  //     name:    tenant-{tenantId}-connector-{connectorId}
  //
  //  2. Whatever the source DB's secret_name column contains (may match #1
  //     or may be a legacy value from an older migration):
  //     project: YOUR_TENANT_PROJECT
  //     name:    <legacySecretName from DB>
  //
  //  3. Dedicated-tenant format (flipped IDs):
  //     project: tenant-{tenantId}-{env}  (or TENANT_SECRET_PROJECTS override)
  //     name:    connector-{connectorId}-{tenantId}
  //
  //  4. Canonical format already at the destination (idempotent re-runs):
  //     project: YOUR_GCP_PROJECT
  //     name:    connector-{tenantId}-{connectorId}

  const candidates: Array<{ project: string; name: string }> = [];

  // Primary: shared-tenant platform-backend format
  candidates.push({
    project: tenantProject,
    name: `tenant-${tenantId}-connector-${connectorId}`,
  });

  // DB's recorded secret_name (often matches above, but use it as-is in case
  // a legacy migration left a different value)
  if (
    legacySecretName &&
    legacySecretName !== `tenant-${tenantId}-connector-${connectorId}`
  ) {
    candidates.push({ project: tenantProject, name: legacySecretName });
    candidates.push({ project: platformControlProject, name: legacySecretName });
  }

  // Dedicated-tenant flipped format
  candidates.push({
    project: tenantProject,
    name: `connector-${connectorId}-${tenantId}`,
  });
  candidates.push({
    project: platformControlProject,
    name: `connector-${connectorId}-${tenantId}`,
  });

  // Canonical path (idempotent — already migrated on a previous run)
  candidates.push({
    project: platformControlProject,
    name: canonicalSecretName(tenantId, connectorId),
  });

  return candidates;
}

async function tryAccessSecret(
  sm: SecretManagerServiceClient,
  project: string,
  name: string,
): Promise<string | null> {
  try {
    const [resp] = await sm.accessSecretVersion({
      name: `projects/${project}/secrets/${name}/versions/latest`,
    });
    const payload = resp.payload?.data?.toString();
    return payload ?? null;
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code === 5 /* NOT_FOUND */ || code === 7 /* PERMISSION_DENIED */) return null;
    throw err;
  }
}

async function main(): Promise<void> {
  const dryRun = (process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false';
  console.log(
    `[backfill] environment=${env} dryRun=${dryRun} canonicalProject=${CANONICAL_SECRET_PROJECT}`,
  );

  // ── Source DB connection ────────────────────────────────────────────────
  // In some environments (e.g. prod before control-plane-pg is reachable from
  // the connector-service VPC) the source DB may not be accessible. Treat
  // that as a skip — not a failure — and exit 0 so it doesn't block deploys.
  const sourcePool = new Pool({
    host: process.env.SOURCE_DB_HOST,
    database: process.env.SOURCE_DB_NAME ?? 'liftoff_control',
    user: process.env.SOURCE_DB_USER ?? 'liftoff_app',
    password: process.env.SOURCE_DB_PASSWORD,
    connectionTimeoutMillis: 10_000,
  });

  try {
    await sourcePool.query('SELECT 1');
  } catch (err) {
    console.warn(
      `[backfill] SKIP: cannot reach source DB (${(err as Error).message}). ` +
        `This is expected if control-plane-pg is not yet accessible from this environment.`,
    );
    await sourcePool.end();
    return;
  }

  const destPool = new Pool({
    host: process.env.DB_HOST,
    database: process.env.DB_NAME ?? 'connector_service',
    user: process.env.DB_USER ?? 'connector_app',
    password: process.env.DB_PASSWORD,
  });

  const sm = new SecretManagerServiceClient();

  let connectorsInserted = 0;
  let connectorsSkipped = 0;
  let credentialsInserted = 0;
  let credentialsSkipped = 0;
  let secretsCopied = 0;
  let secretsAlreadyPresent = 0;
  let secretsMissing = 0;
  const missingSecretConnectors: Array<{ tenantId: string; connectorId: string; type: string }> = [];

  try {
    // control-plane-pg's `connectors` table has FORCE ROW LEVEL SECURITY with a
    // tenant-isolation policy `tenant_id = current_setting('app.current_tenant_id')`
    // (platform-backend migration 095). The backfill user `liftoff_app` is subject to
    // it (FORCE applies even to the owner) and the policy uses the STRICT
    // current_setting form (no missing_ok), so a plain cross-tenant
    // `SELECT * FROM connectors` throws 42704 ("unrecognized configuration
    // parameter"). 095's sanctioned cross-tenant mechanism is the BYPASSRLS
    // `liftoff_admin` role, but its password secret isn't provisioned in every
    // environment — so instead we enumerate tenants (the `tenants` table is
    // RLS-excluded) and read connectors per-tenant with the RLS GUC set.
    // `connector_credentials` has no RLS, so it's still read in one shot below.
    const connectorRows: SourceConnectorRow[] = [];
    const tenantsRes = await sourcePool.query<{ id: string }>('SELECT id::text AS id FROM tenants');
    const srcClient = await sourcePool.connect();
    try {
      for (const { id: tenantId } of tenantsRes.rows) {
        // set_config (session scope) — parameterized, unlike SET which can't bind.
        await srcClient.query(`SELECT set_config('app.current_tenant_id', $1, false)`, [tenantId]);
        const res = await srcClient.query<SourceConnectorRow>(
          `SELECT id, tenant_id::text AS tenant_id, type, status, name, config,
                  api_key_hint, last_sync_at, created_at, updated_at
             FROM connectors`,
        );
        connectorRows.push(...res.rows);
      }
    } finally {
      srcClient.release();
    }
    const connectorsRes = { rows: connectorRows };
    console.log(`[backfill] source: ${connectorsRes.rows.length} connectors across ${tenantsRes.rows.length} tenants`);

    const credentialsRes = await sourcePool.query<SourceCredentialRow>(
      `SELECT connector_id, credential_type, secret_name, scopes, expires_at,
              created_at, updated_at
         FROM connector_credentials`,
    );
    const credByConnector = new Map<string, SourceCredentialRow>();
    for (const row of credentialsRes.rows) credByConnector.set(row.connector_id, row);
    console.log(`[backfill] source: ${credentialsRes.rows.length} credentials`);

    for (const c of connectorsRes.rows) {
      const canonicalName = canonicalSecretName(c.tenant_id, c.id);
      const credential = credByConnector.get(c.id);

      // ── 1. Secret migration ───────────────────────────────────────────────
      if (credential && needsSecret(credential.credential_type)) {
        const destSecretFullName = `projects/${CANONICAL_SECRET_PROJECT}/secrets/${canonicalName}`;

        // Check if canonical secret already exists.
        const destValue = await tryAccessSecret(sm, CANONICAL_SECRET_PROJECT, canonicalName);
        if (destValue !== null) {
          console.log(`[backfill] secret already canonical: ${canonicalName}`);
          secretsAlreadyPresent++;
        } else {
          // Try every candidate source location.
          let sourceValue: string | null = null;
          let sourceLocation = '';

          for (const candidate of candidateSources(c.tenant_id, c.id, credential.secret_name)) {
            const val = await tryAccessSecret(sm, candidate.project, candidate.name);
            if (val) {
              sourceValue = val;
              sourceLocation = `${candidate.project}/${candidate.name}`;
              break;
            }
          }

          if (!sourceValue) {
            console.error(
              `[backfill] ERROR: no secret found for connector=${c.id} type=${c.type} ` +
                `tenant=${c.tenant_id} — tried all candidate paths. ` +
                `Connector will be broken until secret is restored or user reconnects.`,
            );
            secretsMissing++;
            missingSecretConnectors.push({ tenantId: c.tenant_id, connectorId: c.id, type: c.type });
          } else if (dryRun) {
            console.log(`[backfill] DRY_RUN: would copy ${sourceLocation} → ${CANONICAL_SECRET_PROJECT}/${canonicalName}`);
          } else {
            // Write to canonical path. storeConnectorCredential auto-creates.
            try {
              await sm.createSecret({
                parent: `projects/${CANONICAL_SECRET_PROJECT}`,
                secretId: canonicalName,
                secret: { replication: { automatic: {} } },
              });
            } catch (err) {
              if ((err as { code?: number }).code !== 6 /* ALREADY_EXISTS */) throw err;
            }
            await sm.addSecretVersion({
              parent: destSecretFullName,
              payload: { data: Buffer.from(sourceValue, 'utf8') },
            });
            console.log(`[backfill] migrated secret: ${sourceLocation} → ${canonicalName}`);
            secretsCopied++;
          }
        }
      }

      // ── 2. Connector row ──────────────────────────────────────────────────
      if (dryRun) {
        console.log(`[backfill] DRY_RUN: connector ${c.id} (${c.type}) tenant=${c.tenant_id}`);
      } else {
        // Bare `ON CONFLICT DO NOTHING` (no target column) catches a
        // conflict on ANY unique constraint, not just the primary key.
        // `connectors` has two unique rules we must honour here:
        //   - PRIMARY KEY (id)
        //   - one row per (tenant_id, type, externalAccountId) — the partial
        //     index from migration 016
        // The second fires when the destination already has the same account
        // under a DIFFERENT id (e.g. a user disconnected + reconnected after
        // this backfill's source snapshot was captured, producing a new row
        // with a fresh id for the same account). The destination row is the
        // canonical one in that case; skipping the backfill insert is correct.
        const r = await destPool.query(
          `INSERT INTO connectors (id, tenant_id, type, status, name, config,
                                   api_key_hint, last_sync_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT DO NOTHING`,
          [c.id, c.tenant_id, c.type, c.status, c.name, c.config,
           c.api_key_hint, c.last_sync_at, c.created_at, c.updated_at],
        );
        if ((r.rowCount ?? 0) > 0) connectorsInserted++;
        else connectorsSkipped++;
      }

      // ── 3. Credential row ─────────────────────────────────────────────────
      if (credential) {
        if (dryRun) {
          console.log(
            `[backfill] DRY_RUN: credential ${c.id} flow_kind=${toFlowKind(credential.credential_type)}`,
          );
        } else {
          const r = await destPool.query(
            `INSERT INTO connector_credentials
               (connector_id, tenant_id, flow_kind, secret_name, scopes,
                expires_at_epoch_sec, extra, created_at, updated_at)
             VALUES ($1, $2, $3::auth_flow_kind, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (connector_id) DO NOTHING`,
            [
              c.id, c.tenant_id, toFlowKind(credential.credential_type),
              canonicalName, toTextArray(credential.scopes),
              toEpochSec(credential.expires_at), {},
              credential.created_at, credential.updated_at,
            ],
          );
          if ((r.rowCount ?? 0) > 0) credentialsInserted++;
          else credentialsSkipped++;
        }
      }
    }

    // ── Summary ─────────────────────────────────────────────────────────────
    console.log('[backfill] ─── SUMMARY ───');
    console.log(`  dryRun:               ${dryRun}`);
    console.log(`  connectors inserted:  ${connectorsInserted} (skipped: ${connectorsSkipped})`);
    console.log(`  credentials inserted: ${credentialsInserted} (skipped: ${credentialsSkipped})`);
    console.log(`  secrets migrated:     ${secretsCopied}`);
    console.log(`  secrets already OK:   ${secretsAlreadyPresent}`);
    console.log(`  secrets MISSING:      ${secretsMissing}`);

    if (secretsMissing > 0) {
      console.error('[backfill] FAILED: the following connectors are missing their secrets:');
      for (const m of missingSecretConnectors) {
        console.error(`  tenant=${m.tenantId} connector=${m.connectorId} type=${m.type}`);
      }
      console.error(
        '[backfill] These connectors will return NOT_FOUND when credentials are fetched. ' +
          'Options: (a) verify the IAM binding in connector-iam/main.tf covers the legacy ' +
          'secret naming format; (b) have the affected users reconnect via /Connections.',
      );
      process.exit(1);
    }
  } finally {
    await sourcePool.end();
    await destPool.end();
  }
}

main().catch((err) => {
  console.error('[backfill] FATAL', err);
  process.exit(1);
});
