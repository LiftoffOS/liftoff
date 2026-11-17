// `custom_api_connectors` — read and written through withTenantScope, so RLS
// (`app.tenant_id`, migration 028) enforces isolation rather than a WHERE
// clause in this file. Note the session variable: this service uses
// `app.tenant_id`, NOT platform-backend's `app.current_tenant_id`.

import { withAdminScope, withTenantScope } from '../db/pool.js';
import type {
  CustomApiAuthPlacement,
  CustomApiConnectorRow,
  CustomApiOperation,
  CustomApiVerification,
} from './types.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

function mapRow(row: Record<string, any>): CustomApiConnectorRow {
  return {
    connectorId: row.connector_id as string,
    tenantId: row.tenant_id as string,
    name: row.name as string,
    providerSlug: row.provider_slug as string,
    baseUrl: row.base_url as string,
    apiHosts: (row.api_hosts as string[]) ?? [],
    authScheme: row.auth_scheme as CustomApiConnectorRow['authScheme'],
    authPlacement: (row.auth_placement as CustomApiAuthPlacement) ?? { scheme: row.auth_scheme },
    verification: (row.verification as CustomApiVerification) ?? { method: 'GET', path: '/' },
    ops: (row.ops as CustomApiOperation[]) ?? [],
    specSourceUrl: (row.spec_source_url as string | null) ?? null,
    specHash: row.spec_hash as string,
    specFetchedAt: row.spec_fetched_at ? new Date(row.spec_fetched_at as string) : null,
    specDriftHash: (row.spec_drift_hash as string | null) ?? null,
    specDriftCheckedAt: row.spec_drift_checked_at ? new Date(row.spec_drift_checked_at as string) : null,
    verifiedAt: row.verified_at ? new Date(row.verified_at as string) : null,
    completedByAccountId: (row.completed_by_account_id as string | null) ?? null,
    attemptId: (row.attempt_id as string | null) ?? null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

const COLUMNS = `connector_id, tenant_id, name, provider_slug, base_url, api_hosts,
                 auth_scheme, auth_placement, verification, ops, spec_source_url,
                 spec_hash, spec_fetched_at, spec_drift_hash, spec_drift_checked_at,
                 verified_at, completed_by_account_id,
                 attempt_id, created_at, updated_at`;

export async function getCustomApiConnector(
  tenantId: string,
  connectorId: string,
): Promise<CustomApiConnectorRow | null> {
  return withTenantScope(tenantId, async (client) => {
    const res = await client.query(
      `SELECT ${COLUMNS} FROM custom_api_connectors WHERE connector_id = $1`,
      [connectorId],
    );
    return res.rows.length > 0 ? mapRow(res.rows[0]) : null;
  });
}

/** The row an earlier attempt at this capture already produced, if any.
 *
 *  This is the end-to-end half of the idempotency. A platform-backend claim
 *  alone is not enough: if this service creates the connector and the response
 *  is lost, a retry with the same token would ask it to create a second one.
 *  Keyed on the attempt id, the retry finds the FIRST connector instead. */
export async function findByAttemptId(
  tenantId: string,
  attemptId: string,
): Promise<CustomApiConnectorRow | null> {
  return withTenantScope(tenantId, async (client) => {
    const res = await client.query(
      `SELECT ${COLUMNS} FROM custom_api_connectors WHERE attempt_id = $1`,
      [attemptId],
    );
    return res.rows.length > 0 ? mapRow(res.rows[0]) : null;
  });
}

export async function listCustomApiConnectors(
  tenantId: string,
): Promise<CustomApiConnectorRow[]> {
  return withTenantScope(tenantId, async (client) => {
    const res = await client.query(
      `SELECT ${COLUMNS} FROM custom_api_connectors ORDER BY created_at`,
    );
    return res.rows.map(mapRow);
  });
}

export interface UpsertCustomApiConnectorInput {
  tenantId: string;
  connectorId: string;
  name: string;
  providerSlug: string;
  baseUrl: string;
  apiHosts: string[];
  authPlacement: CustomApiAuthPlacement;
  verification: CustomApiVerification;
  ops: CustomApiOperation[];
  specSourceUrl: string;
  specHash: string;
  completedByAccountId: string | null;
  attemptId: string | null;
}

/** Create or replace the description for one connector id.
 *
 *  A reconnect keeps the connector id — every bound team recovers at once —
 *  so this is an upsert on the PK rather than a delete and a re-create. */
export async function upsertCustomApiConnector(
  input: UpsertCustomApiConnectorInput,
): Promise<CustomApiConnectorRow> {
  return withTenantScope(input.tenantId, async (client) => {
    const res = await client.query(
      `INSERT INTO custom_api_connectors (
         connector_id, tenant_id, name, provider_slug, base_url, api_hosts,
         auth_scheme, auth_placement, verification, ops, spec_source_url,
         spec_hash, spec_fetched_at, completed_by_account_id, attempt_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), $13, $14)
       ON CONFLICT (connector_id) DO UPDATE SET
         name = EXCLUDED.name,
         provider_slug = EXCLUDED.provider_slug,
         base_url = EXCLUDED.base_url,
         api_hosts = EXCLUDED.api_hosts,
         auth_scheme = EXCLUDED.auth_scheme,
         auth_placement = EXCLUDED.auth_placement,
         verification = EXCLUDED.verification,
         ops = EXCLUDED.ops,
         spec_source_url = EXCLUDED.spec_source_url,
         spec_hash = EXCLUDED.spec_hash,
         spec_fetched_at = NOW(),
         completed_by_account_id = COALESCE(EXCLUDED.completed_by_account_id, custom_api_connectors.completed_by_account_id),
         attempt_id = COALESCE(EXCLUDED.attempt_id, custom_api_connectors.attempt_id),
         -- A replaced description is NOT a verified one. Cleared here and set
         -- again only by a verification call that actually succeeded, so
         -- "connected" can never be read as "verified" off a stale stamp.
         verified_at = NULL
       RETURNING ${COLUMNS}`,
      [
        input.connectorId,
        input.tenantId,
        input.name,
        input.providerSlug,
        input.baseUrl,
        input.apiHosts,
        input.authPlacement.scheme,
        JSON.stringify(input.authPlacement),
        JSON.stringify(input.verification),
        JSON.stringify(input.ops),
        input.specSourceUrl,
        input.specHash,
        input.completedByAccountId,
        input.attemptId,
      ],
    );
    return mapRow(res.rows[0]);
  });
}

/** Stamp the row as verified. Called only after the declared verification call
 *  has actually succeeded. */
export async function markVerified(
  tenantId: string,
  connectorId: string,
): Promise<void> {
  await withTenantScope(tenantId, async (client) => {
    await client.query(
      `UPDATE custom_api_connectors SET verified_at = NOW() WHERE connector_id = $1`,
      [connectorId],
    );
  });
}

/** Phase 7: hosts, placement and verification are EDITABLE IN PLACE.
 *
 *  A description that was slightly wrong is a description to correct, not a
 *  connection to delete and build again. The connector id is what every bound
 *  AI team holds and what the manifest alias is derived from, so re-creating
 *  it to change one field would break every binding to fix nothing.
 *
 *  The credential is untouched: editing where a request goes is not a reason to
 *  ask somebody for the key again. `verified_at` IS cleared, because a
 *  description that has changed has not been proven against the provider yet —
 *  the caller re-runs the verification and the row is stamped again only if it
 *  passes. */
/**
 * Drop the verification stamp, because the key it was made with is gone.
 *
 * `verified_at` means "the provider accepted this key", so a connection that
 * has no key cannot carry one. It is cleared when a description is replaced
 * and when one is edited; it was NOT cleared when the credential itself left,
 * which left a connection with nothing in custody still reporting the moment
 * its key was last checked.
 */
/**
 * Replace the operations and the hash they were read from.
 *
 * Deliberately narrow: the description a person approved is untouched, because
 * re-reading a specification answers "what does this API offer now", never
 * "where does it live" or "how does it sign in". `verified_at` is untouched
 * for the same reason — the key was not involved and is as good as it was.
 */
/** One connection the drift sweep should look at. */
export interface CustomApiDriftCandidate {
  tenantId: string;
  connectorId: string;
  specSourceUrl: string;
  specHash: string;
}

/**
 * Connections whose specification has not been read lately, oldest first.
 *
 * Enumerated with the admin scope because a sweep is cross-tenant by nature
 * and the policy on this table is per tenant; every WRITE that follows goes
 * through the tenant scope like every other write here. Only connections with
 * a published specification: one without cannot drift, and sweeping it would
 * burn the budget on a connection that can never produce a result.
 */
export async function listCustomApiConnectionsToCheck(args: {
  notCheckedFor: string;
  limit: number;
}): Promise<CustomApiDriftCandidate[]> {
  return withAdminScope(
    {
      caller: 'custom-api/spec-drift-sweep',
      reason: 'Enumerate custom API connections across tenants to re-read their specifications',
    },
    async (client) => {
    const res = await client.query(
      `SELECT a.tenant_id, a.connector_id, a.spec_source_url, a.spec_hash
         FROM custom_api_connectors a
         JOIN connectors c ON c.id = a.connector_id
        WHERE a.spec_source_url IS NOT NULL
          AND c.status = 'active'
          AND (a.spec_drift_checked_at IS NULL
               OR a.spec_drift_checked_at < NOW() - $1::interval)
        ORDER BY a.spec_drift_checked_at ASC NULLS FIRST
        LIMIT $2`,
      [args.notCheckedFor, args.limit],
    );
    return res.rows.map((row) => ({
      tenantId: row.tenant_id as string,
      connectorId: row.connector_id as string,
      specSourceUrl: row.spec_source_url as string,
      specHash: row.spec_hash as string,
    }));
    },
  );
}

/**
 * Record what the sweep saw.
 *
 * `checkedAt` moves whether or not anything changed, because "we looked" and
 * "it moved" are different facts and the sweep paces itself on the first. A
 * hash equal to `spec_hash` is stored as-is rather than nulled: drift is the
 * two being DIFFERENT, so an up-to-date connection reads as no drift without
 * anything having to clear a flag.
 */
export async function recordCustomApiSpecCheck(args: {
  tenantId: string;
  connectorId: string;
  driftHash: string | null;
}): Promise<void> {
  await withTenantScope(args.tenantId, async (client) => {
    await client.query(
      `UPDATE custom_api_connectors
          SET spec_drift_hash = $2, spec_drift_checked_at = NOW()
        WHERE connector_id = $1`,
      [args.connectorId, args.driftHash],
    );
  });
}

export async function replaceCustomApiOperations(args: {
  tenantId: string;
  connectorId: string;
  ops: CustomApiOperation[];
  specHash: string;
}): Promise<void> {
  await withTenantScope(args.tenantId, async (client) => {
    await client.query(
      `UPDATE custom_api_connectors
          SET ops = $2::jsonb, spec_hash = $3, spec_fetched_at = NOW(),
              -- The connection IS the document now, so there is no drift to
              -- report and the sweep has just been done for us.
              spec_drift_hash = $3, spec_drift_checked_at = NOW(), updated_at = NOW()
        WHERE connector_id = $1`,
      [args.connectorId, JSON.stringify(args.ops), args.specHash],
    );
  });
}

export async function clearCustomApiVerification(
  tenantId: string,
  connectorId: string,
): Promise<void> {
  await withTenantScope(tenantId, async (client) => {
    await client.query(
      `UPDATE custom_api_connectors SET verified_at = NULL WHERE connector_id = $1`,
      [connectorId],
    );
  });
}

export async function updateCustomApiConnection(
  tenantId: string,
  connectorId: string,
  changes: {
    name?: string;
    baseUrl?: string;
    apiHosts?: string[];
    authPlacement?: CustomApiAuthPlacement;
    verification?: CustomApiVerification;
    /** Written only when the base address moved: the paths are relative to it. */
    ops?: CustomApiOperation[];
  },
): Promise<CustomApiConnectorRow | null> {
  const sets: string[] = [];
  const values: unknown[] = [connectorId];
  const push = (column: string, value: unknown): void => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };
  if (changes.name !== undefined) push('name', changes.name);
  if (changes.baseUrl !== undefined) push('base_url', changes.baseUrl);
  if (changes.apiHosts !== undefined) push('api_hosts', changes.apiHosts);
  if (changes.authPlacement !== undefined) {
    push('auth_scheme', changes.authPlacement.scheme);
    push('auth_placement', JSON.stringify(changes.authPlacement));
  }
  if (changes.verification !== undefined) push('verification', JSON.stringify(changes.verification));
  if (changes.ops !== undefined) push('ops', JSON.stringify(changes.ops));
  // Nothing asked for is nothing to write. Returning the row rather than null
  // keeps an empty edit a no-op instead of a not-found.
  if (sets.length === 0) return getCustomApiConnector(tenantId, connectorId);

  return withTenantScope(tenantId, async (client) => {
    const res = await client.query(
      `UPDATE custom_api_connectors
          SET ${sets.join(', ')}, verified_at = NULL
        WHERE connector_id = $1
       RETURNING ${COLUMNS}`,
      values,
    );
    return res.rows.length > 0 ? mapRow(res.rows[0]) : null;
  });
}

// There is deliberately no delete here. Removing the connection removes the
// `connectors` row, and this table's foreign key cascades — a second way to
// delete half of a connection is a way for the two halves to disagree.
