// The grant lifecycle (ADR-032): the one place a grant for (client, person,
// workspace, resource) comes into being, and the one place a grant family is
// retired.
//
//   - active grant + live anchor  -> REUSE (create nothing)
//   - anything else               -> retire old grant / tokens / anchor /
//                                    assignment, then create anchor +
//                                    assignment + grant
//
// Called inside a caller-owned transaction by both approval paths: the
// consent page (authorization code flow) and the /activate page (device
// flow). Both must produce the same grant for the same tuple, and the
// retire-then-recreate branch is the one that retires a possibly stolen
// refresh family, so it lives once. Every revoking statement is bound to one
// grant or anchor (INV-PB-014).
//
// ── The lock discipline ───────────────────────────────────────────────
//
// Rows are locked in ascending tier, never descending; a row a grant owns is
// never locked on its own; a multi-row lock within a tier is taken in `id`
// order; a request path locks and writes only live rows; the sweep deletes
// only rows dead for an hour or more.
//
//   1. `oauth_clients` row. FOR UPDATE by deprovisioning. FOR SHARE by both
//      approvals (through `ensureGrant`; the device route also takes it
//      before its code lock) and, for one statement, by the two pending-row
//      inserts. The modes conflict, so an approval or a pending insert and a
//      DELETE of the same client never overlap.
//   2. Pending rows with no grant yet: `oauth_authorization_requests`, pending
//      `oauth_device_codes`. Locked by DELETE (UPDATE, live rows only), device
//      approval (FOR UPDATE, a live pending row only), a poll on a
//      still-pending code (FOR UPDATE, a live row only; a dead one is re-read
//      without a lock so the poll can still answer its terminal state). A
//      device code changes tier at approval, so a tier-2 locker that acquires
//      it after the transition holds a row the grant owns and MUST NOT climb
//      to the grant: another poll may hold the grant and be writing that row.
//      It answers what it can under its own lock (authorization_pending) and
//      leaves the grant path to the next poll.
//   3. `oauth_grants` row. FOR UPDATE by everything that writes anything the
//      grant owns: code redemption, refresh (rotate and replay), device
//      redemption of an approved code, revoke, DELETE, `ensureGrant` (both
//      branches), Archive, membership removal. Multi-row: `lockActiveGrants`
//      (ORDER BY id FOR UPDATE). Owned rows — authorization codes, access and
//      refresh tokens, approved device codes, the anchor, the assignment —
//      are written under the grant lock and never locked on their own.
//
// Live rows only. Every request-path lock and write on a swept table carries
// its liveness predicate: tokens `expires_at > NOW()`, codes `expires_at >
// NOW()` (checked before any poll bookkeeping), consent requests
// `LIVE_PREDICATE`. A write that decides an outcome is checked by its
// rowCount, so a row that lapsed between the recheck and the write answers
// as expired rather than issuing anything.
// The sweep deletes only `expires_at < NOW() - INTERVAL '1 hour'`,
// `revoked_at < NOW() - INTERVAL '7 days'`, or `consumed_at` / `used_at` older
// than an hour — rows no request path writes. Any row is on one side or in
// the gap for any two statements whose start times differ by less than an
// hour, so a sweep statement and a request statement never wait on each
// other.
//
// Outside the tiers: the client `last_used_at` stamp runs after commit on
// `pool`; the verifier's anchor stamp is a one-lock transaction; membership
// removal's own `tenant_members` DELETE and static-token statements touch
// tables no OAuth path locks. Paths that start from a credential follow one
// pattern: identify without locks → lock the grant → re-read the credential
// → recheck every condition → act; a recheck that disagrees with the
// identify answers what the recheck says.

import type { PoolClient } from 'pg';

/**
 * A consent request is live until its own expiry, or for sixty minutes after
 * it was parked for onboarding — whichever is later. One predicate, used by
 * the consent GET, the parking UPDATE, the single-use claim and the
 * deprovisioning close, so none of them can disagree. The sweep's
 * `expires_at < NOW() - INTERVAL '1 hour'` is exactly this window's outer
 * bound: a request is parked only while live, so `parked_at < expires_at`
 * and it dies by `expires_at + 60 min`. Bound to the alias `r`.
 */
export const LIVE_PREDICATE = `(r.expires_at > NOW() OR (r.parked_for_onboarding_at IS NOT NULL AND r.parked_for_onboarding_at > NOW() - INTERVAL '60 minutes'))`;

export interface GrantSubject {
  tenantId: string;
  accountId: string;
  clientId: string;
  /** What the anchor is named after: the client's registered name. */
  clientName: string;
  resource: string;
}

export interface GrantFamily {
  grantId: string;
  anchorId: string;
}

/**
 * Retire one grant family: the grant, its live access and refresh tokens, its
 * anchor and the anchor's assignment, each statement bound to that grant or
 * anchor. Runs under the grant's tier-3 lock, which every caller already
 * holds. The anchor UPDATE matches only an active, undeleted anchor, so the
 * statement is idempotent and its rowCount says whether this call retired the
 * anchor (membership removal adds that to its static-token count).
 */
export async function retireGrantFamily(
  client: PoolClient,
  { grantId, anchorId }: GrantFamily,
): Promise<{ anchorRetired: 0 | 1 }> {
  await client.query(
    `UPDATE oauth_grants SET status = 'revoked', revoked_at = NOW() WHERE id = $1`,
    [grantId],
  );
  await client.query(
    `UPDATE oauth_access_tokens SET revoked_at = NOW() WHERE grant_id = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
    [grantId],
  );
  await client.query(
    `UPDATE oauth_refresh_tokens SET revoked_at = NOW() WHERE grant_id = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
    [grantId],
  );
  const anchor = await client.query(
    `UPDATE mcp_tokens SET status = 'revoked', deleted_at = NOW() WHERE id = $1 AND status = 'active' AND deleted_at IS NULL`,
    [anchorId],
  );
  await client.query(
    `UPDATE person_agent_assignments SET deleted_at = NOW() WHERE agent_id = $1 AND deleted_at IS NULL`,
    [anchorId],
  );
  return { anchorRetired: (anchor.rowCount ?? 0) > 0 ? 1 : 0 };
}

export type ActiveGrantsPredicate = { clientId: string } | { accountId: string; tenantId: string };

/**
 * Lock every active grant matching the predicate, in id order (the tier-3
 * multi-row lock), and return each with its anchor for `retireGrantFamily`.
 */
export async function lockActiveGrants(
  client: PoolClient,
  predicate: ActiveGrantsPredicate,
): Promise<GrantFamily[]> {
  const r = 'clientId' in predicate
    ? await client.query(
      `SELECT id, mcp_token_id FROM oauth_grants WHERE client_id = $1 AND status = 'active' ORDER BY id FOR UPDATE`,
      [predicate.clientId],
    )
    : await client.query(
      `SELECT id, mcp_token_id FROM oauth_grants WHERE account_id = $1 AND tenant_id = $2 AND status = 'active' ORDER BY id FOR UPDATE`,
      [predicate.accountId, predicate.tenantId],
    );
  return r.rows.map((row: { id: string; mcp_token_id: string }) => ({ grantId: row.id, anchorId: row.mcp_token_id }));
}

/**
 * Returns the id of the grant the subject now holds, creating or reusing it;
 * `null` when the client has been deprovisioned (or does not exist), in which
 * case nothing else was issued.
 *
 * Tier 1 first: the client row FOR SHARE, so a DELETE of the client
 * (FOR UPDATE) and an approval never overlap. Then tier 3: the existing grant
 * FOR UPDATE, under which branch A reuses it and branch B retires it and
 * creates the new one.
 */
export async function ensureGrant(client: PoolClient, subject: GrantSubject): Promise<string | null> {
  const { tenantId, accountId, clientId, clientName, resource } = subject;

  const registration = await client.query(
    `SELECT deleted_at FROM oauth_clients WHERE client_id = $1 FOR SHARE`,
    [clientId],
  );
  if (registration.rows.length === 0 || registration.rows[0].deleted_at !== null) return null;

  const existing = await client.query(
    `SELECT g.id AS grant_id, g.mcp_token_id,
            t.status AS anchor_status, t.deleted_at AS anchor_deleted_at, t.expires_at AS anchor_expires_at
     FROM oauth_grants g
     JOIN mcp_tokens t ON t.id = g.mcp_token_id
     WHERE g.client_id = $1 AND g.account_id = $2 AND g.tenant_id = $3
       AND g.resource = $4 AND g.status = 'active'
     FOR UPDATE OF g`,
    [clientId, accountId, tenantId, resource],
  );

  const live = existing.rows[0] &&
    existing.rows[0].anchor_status === 'active' &&
    existing.rows[0].anchor_deleted_at === null &&
    new Date(existing.rows[0].anchor_expires_at as string) > new Date();

  if (live) {
    // Branch A: REUSE — create nothing (no orphan anchors/assignments).
    return existing.rows[0].grant_id as string;
  }

  // Branch B: retire-then-recreate. Covers 365-day anchor expiry re-consent
  // AND theft re-consent (the possibly-attacker-held refresh family dies
  // here).
  if (existing.rows[0]) {
    await retireGrantFamily(client, {
      grantId: existing.rows[0].grant_id as string,
      anchorId: existing.rows[0].mcp_token_id as string,
    });
  }

  // New anchor: auth_kind='oauth', NO credentials (NOT createMcpToken —
  // that mints an unused static key + setup token).
  const anchor = await client.query(
    `INSERT INTO mcp_tokens (tenant_id, account_id, token_hash, token_prefix, name, auth_kind)
     VALUES ($1, $2, NULL, NULL, $3, 'oauth')
     RETURNING id`,
    [tenantId, accountId, clientName],
  );
  const anchorId = anchor.rows[0].id as string;

  await client.query(
    `INSERT INTO person_agent_assignments (tenant_id, account_id, agent_id, agent_origin, created_by)
     VALUES ($1, $2, $3, 'external', $2)
     ON CONFLICT DO NOTHING`,
    [tenantId, accountId, anchorId],
  );

  const grant = await client.query(
    `INSERT INTO oauth_grants (tenant_id, client_id, account_id, mcp_token_id, resource)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [tenantId, clientId, accountId, anchorId, resource],
  );
  return grant.rows[0].id as string;
}
