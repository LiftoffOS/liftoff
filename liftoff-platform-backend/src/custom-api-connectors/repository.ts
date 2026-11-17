// `custom_api_capture_tokens` — the one table this repo owns for this feature.
//
// FORCE RLS (migration 530), so every read and write goes through
// withTenantScope and the policy is what enforces isolation rather than a
// WHERE clause in this file.
//
// The claim is the interesting part. Phase 3's whole shape is two conditional
// updates and an id on the wire:
//
//   claim      UPDATE … WHERE claimed_at IS NULL — one submit wins
//   settle     UPDATE … SET connector_id = … — written back when
//              connector-service returns one
//
// so a second submit resolves three ways rather than duplicating: the claim has
// a connector id and returns that result; the claim has none and the attempt is
// still in flight, so it reports in progress; the claim has none and the
// attempt died, so it is re-driven against the SAME attempt id, which
// connector-service keys its creation on.

import { withTenantScope } from '../infrastructure/database';
import type { CaptureToken, CustomApiSpec } from './types';

/** Sixty minutes — the person may have to go and create a key first, so ten
 *  minutes is too short. */
export const CAPTURE_TOKEN_TTL_SECONDS = 60 * 60;

/** How long a claim may sit with no connector id before a retry re-drives the
 *  attempt. Long enough to cover a slow registration (a specification fetch, a
 *  classification pass and a verification call), short enough that a person who
 *  reloads the page is not told "in progress" forever. */
export const CAPTURE_ATTEMPT_STALE_SECONDS = 180;

const COLUMNS = `id, tenant_id, requested_by_account_id, spec, spec_hash, attempt_id,
                 reconnect_connector_id, claimed_at, claimed_by_account_id, connector_id,
                 expires_at, created_at, updated_at`;

function mapRow(row: Record<string, any>): CaptureToken {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    requestedByAccountId: row.requested_by_account_id as string,
    spec: row.spec as CustomApiSpec,
    specHash: row.spec_hash as string,
    attemptId: row.attempt_id as string,
    reconnectConnectorId: (row.reconnect_connector_id as string | null) ?? null,
    claimedAt: row.claimed_at ? new Date(row.claimed_at as string) : null,
    claimedByAccountId: (row.claimed_by_account_id as string | null) ?? null,
    connectorId: (row.connector_id as string | null) ?? null,
    expiresAt: new Date(row.expires_at as string),
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

export async function createCaptureToken(input: {
  tenantId: string;
  requestedByAccountId: string;
  tokenHash: string;
  spec: CustomApiSpec;
  specHash: string;
  reconnectConnectorId?: string;
}): Promise<CaptureToken> {
  return withTenantScope(input.tenantId, async (client) => {
    const res = await client.query(
      `INSERT INTO custom_api_capture_tokens
         (tenant_id, token_hash, requested_by_account_id, spec, spec_hash,
          reconnect_connector_id, expires_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, NOW() + ($7::int * INTERVAL '1 second'))
       RETURNING ${COLUMNS}`,
      [
        input.tenantId,
        input.tokenHash,
        input.requestedByAccountId,
        JSON.stringify(input.spec),
        input.specHash,
        input.reconnectConnectorId ?? null,
        CAPTURE_TOKEN_TTL_SECONDS,
      ],
    );
    return mapRow(res.rows[0]);
  });
}

/** The row a token opens, whatever state it is in. Used by the capture page to
 *  render the declared fields, which is a read that discloses nothing: there is
 *  no stored value on it. */
export async function findCaptureTokenByHash(
  tenantId: string,
  tokenHash: string,
): Promise<CaptureToken | null> {
  return withTenantScope(tenantId, async (client) => {
    const res = await client.query(
      `SELECT ${COLUMNS} FROM custom_api_capture_tokens WHERE token_hash = $1`,
      [tokenHash],
    );
    return res.rows.length > 0 ? mapRow(res.rows[0]) : null;
  });
}

export type CaptureClaim =
  /** This submit owns the attempt: go and register. */
  | { kind: 'claimed'; token: CaptureToken }
  /** An earlier submit already finished: return its result. */
  | { kind: 'already_connected'; token: CaptureToken }
  /** An earlier submit is still running. Wait rather than start a second one. */
  | { kind: 'in_progress'; token: CaptureToken }
  /** An earlier submit claimed the token and died. Re-drive the SAME attempt
   *  id, which connector-service keys its creation on, so a connector it did
   *  create is found rather than duplicated. */
  | { kind: 'redrive'; token: CaptureToken }
  | { kind: 'expired' }
  | { kind: 'not_found' };

/**
 * Claim the capture token atomically, stamping the completing account.
 *
 * Platform-backend cannot record a connector id here — connector-service owns
 * connector-id creation and has not been called yet — so the claim carries the
 * attempt id this row was minted with, and the connector id is written back
 * onto it when connector-service returns one.
 */
export async function claimCaptureToken(args: {
  tenantId: string;
  tokenHash: string;
  accountId: string;
}): Promise<CaptureClaim> {
  return withTenantScope(args.tenantId, async (client) => {
    const claimed = await client.query(
      `UPDATE custom_api_capture_tokens
          SET claimed_at = NOW(), claimed_by_account_id = $2, updated_at = NOW()
        WHERE token_hash = $1
          AND claimed_at IS NULL
          AND expires_at > NOW()
        RETURNING ${COLUMNS}`,
      [args.tokenHash, args.accountId],
    );
    if (claimed.rows.length > 0) return { kind: 'claimed' as const, token: mapRow(claimed.rows[0]) };

    const existing = await client.query(
      `SELECT ${COLUMNS} FROM custom_api_capture_tokens WHERE token_hash = $1`,
      [args.tokenHash],
    );
    if (existing.rows.length === 0) return { kind: 'not_found' as const };
    const token = mapRow(existing.rows[0]);
    if (token.connectorId) return { kind: 'already_connected' as const, token };
    if (!token.claimedAt) return { kind: 'expired' as const };
    const ageSeconds = (Date.now() - token.claimedAt.getTime()) / 1000;
    return ageSeconds > CAPTURE_ATTEMPT_STALE_SECONDS
      ? { kind: 'redrive' as const, token }
      : { kind: 'in_progress' as const, token };
  });
}

/** Write the connector id back onto the claim, once connector-service has
 *  returned one. This is what turns a second submit from a duplicate into a
 *  replay of the first result. */
export async function recordCaptureConnector(args: {
  tenantId: string;
  tokenHash: string;
  connectorId: string;
}): Promise<void> {
  await withTenantScope(args.tenantId, async (client) => {
    await client.query(
      `UPDATE custom_api_capture_tokens
          SET connector_id = $2, updated_at = NOW()
        WHERE token_hash = $1 AND connector_id IS NULL`,
      [args.tokenHash, args.connectorId],
    );
  });
}

/** Release a claim that failed BEFORE connector-service was reached, so the
 *  person can use the same link again rather than being told an attempt is in
 *  flight that is not. Never called once a registration has been attempted:
 *  past that point the attempt id is the thing that makes a retry safe. */
export async function releaseCaptureClaim(args: {
  tenantId: string;
  tokenHash: string;
}): Promise<void> {
  await withTenantScope(args.tenantId, async (client) => {
    await client.query(
      `UPDATE custom_api_capture_tokens
          SET claimed_at = NULL, claimed_by_account_id = NULL, updated_at = NOW()
        WHERE token_hash = $1 AND connector_id IS NULL`,
      [args.tokenHash],
    );
  });
}
