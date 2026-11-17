// Row access for tenant_ai_provider_keys.
//
// The table is FORCE RLS on tenant_id, so every statement here runs inside
// withTenantScope. There is no cross-tenant read in this module and there is no
// reason for one to exist: a key is only ever resolved for the tenant whose
// call is being served.

import { withTenantScope } from '../infrastructure/database';
import type { AiProviderKey, AiProviderKeyStatus, AiProviderKeyVendor } from './types';

export interface StoredProviderKey extends AiProviderKey {
  /** Secret Manager entry holding the raw key. Never leaves the server. */
  secretName: string;
}

interface Row {
  vendor: string;
  secret_name: string;
  hint: string;
  status: string;
  updated_at: Date;
  last_verified_at: Date | null;
}

function mapRow(row: Row): StoredProviderKey {
  return {
    vendor: row.vendor as AiProviderKeyVendor,
    secretName: row.secret_name,
    hint: row.hint,
    status: row.status as AiProviderKeyStatus,
    updatedAt: row.updated_at.toISOString(),
    lastVerifiedAt: row.last_verified_at ? row.last_verified_at.toISOString() : null,
  };
}

const SELECT_COLUMNS =
  'vendor, secret_name, hint, status, updated_at, last_verified_at';

/** Every key a tenant has stored, in the order the card offers the providers. */
export async function listKeys(tenantId: string): Promise<StoredProviderKey[]> {
  return withTenantScope(tenantId, async (client) => {
    const result = await client.query<Row>(
      `SELECT ${SELECT_COLUMNS}
         FROM tenant_ai_provider_keys
        WHERE tenant_id = $1
        ORDER BY vendor`,
      [tenantId],
    );
    return result.rows.map(mapRow);
  });
}

/** One tenant's key for one provider, or null when they have not supplied one. */
export async function getKey(
  tenantId: string,
  vendor: AiProviderKeyVendor,
): Promise<StoredProviderKey | null> {
  return withTenantScope(tenantId, async (client) => {
    const result = await client.query<Row>(
      `SELECT ${SELECT_COLUMNS}
         FROM tenant_ai_provider_keys
        WHERE tenant_id = $1 AND vendor = $2`,
      [tenantId, vendor],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  });
}

export interface UpsertInput {
  vendor: AiProviderKeyVendor;
  secretName: string;
  hint: string;
}

/**
 * Store or rotate one provider's key.
 *
 * Always lands `status = 'valid'` and a fresh `last_verified_at`, because the
 * only way to reach this function is past a live check against the provider.
 * That is also what clears a prior `revoked`: replacing a declined key is the
 * documented way to get the NEEDS ATTENTION pill off the card.
 *
 * Every submitted vendor is written in ONE transaction. A write that stored two
 * of three keys and failed the fourth would leave the customer unable to tell
 * what happened, which is the same reason validation rejects the whole write.
 */
export async function upsertKeys(
  tenantId: string,
  inputs: readonly UpsertInput[],
): Promise<StoredProviderKey[]> {
  if (inputs.length === 0) return listKeys(tenantId);

  // No BEGIN here, deliberately: withTenantScope ALREADY runs the callback
  // inside one transaction and rolls it back on a throw, which is exactly the
  // atomicity this needs. A nested BEGIN/COMMIT would be worse than redundant —
  // the tenant id is set with `set_config(..., is_local => true)`, so it is
  // TRANSACTION-scoped, and an inner COMMIT would end the outer transaction and
  // discard it. Every statement after that point would run with no
  // app.current_tenant_id, and the RLS policy would raise 42704 rather than
  // returning nothing.
  return withTenantScope(tenantId, async (client) => {
    for (const input of inputs) {
      await client.query(
        `INSERT INTO tenant_ai_provider_keys
           (tenant_id, vendor, secret_name, hint, status, updated_at, last_verified_at)
         VALUES ($1, $2, $3, $4, 'valid', NOW(), NOW())
         ON CONFLICT (tenant_id, vendor) DO UPDATE
           SET secret_name       = EXCLUDED.secret_name,
               hint              = EXCLUDED.hint,
               status            = 'valid',
               updated_at        = NOW(),
               last_verified_at  = NOW()`,
        [tenantId, input.vendor, input.secretName, input.hint],
      );
    }
    const result = await client.query<Row>(
      `SELECT ${SELECT_COLUMNS}
         FROM tenant_ai_provider_keys
        WHERE tenant_id = $1
        ORDER BY vendor`,
      [tenantId],
    );
    return result.rows.map(mapRow);
  });
}

/**
 * Drop rows outright. The removal half of the clear button.
 *
 * Returns the rows as they were BEFORE the delete, so the caller can name the
 * hint it destroyed in the audit row; after the statement there is nothing left
 * to read it from.
 *
 * Same withTenantScope-without-BEGIN reasoning as upsertKeys above: the helper
 * already runs this in one transaction, and an inner COMMIT would end it and
 * strip the transaction-scoped app.current_tenant_id that RLS depends on.
 */
export async function deleteKeys(
  tenantId: string,
  vendors: readonly AiProviderKeyVendor[],
): Promise<StoredProviderKey[]> {
  if (vendors.length === 0) return [];
  return withTenantScope(tenantId, async (client) => {
    const result = await client.query<Row>(
      `DELETE FROM tenant_ai_provider_keys
        WHERE tenant_id = $1 AND vendor = ANY($2::text[])
        RETURNING ${SELECT_COLUMNS}`,
      [tenantId, [...vendors]],
    );
    return result.rows.map(mapRow);
  });
}

/**
 * Mark a key declined. Idempotent, and deliberately narrow: it only ever moves
 * a row from 'valid' to 'revoked', so a 401 arriving after the customer has
 * already pasted a replacement cannot knock the new key out.
 *
 * `last_verified_at` is cleared rather than left: a revoked key was last
 * confirmed working at some point in the past, and leaving a timestamp there
 * would read as "we checked, and it works".
 *
 * Returns true when this call is what flipped the row, so the caller can log
 * the transition once rather than on every subsequent failed request.
 */
export async function markRevoked(
  tenantId: string,
  vendor: AiProviderKeyVendor,
): Promise<boolean> {
  return withTenantScope(tenantId, async (client) => {
    const result = await client.query(
      `UPDATE tenant_ai_provider_keys
          SET status = 'revoked', last_verified_at = NULL, updated_at = NOW()
        WHERE tenant_id = $1 AND vendor = $2 AND status = 'valid'`,
      [tenantId, vendor],
    );
    return (result.rowCount ?? 0) > 0;
  });
}

/**
 * Record that a provider honoured the key on a real call.
 *
 * Distinct from the save path: this is the only thing that keeps
 * `last_verified_at` current for a workspace whose key was pasted months ago,
 * which is what makes a stale 'valid' diagnosable. Status is not touched — a
 * revoked row does not un-revoke itself because one request happened to
 * succeed; only a replacement key does that.
 */
export async function touchVerified(
  tenantId: string,
  vendor: AiProviderKeyVendor,
): Promise<void> {
  await withTenantScope(tenantId, async (client) => {
    await client.query(
      `UPDATE tenant_ai_provider_keys
          SET last_verified_at = NOW()
        WHERE tenant_id = $1 AND vendor = $2 AND status = 'valid'`,
      [tenantId, vendor],
    );
  });
}
