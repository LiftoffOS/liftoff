// Every SQL statement the referral programme runs.
//
// Two scopes, and which one a method uses is decided by whether a tenant is
// known yet:
//
//   withTenantScope — everything the referrer's own page reads or writes. The
//     RLS policy on `referrals` is keyed on referrer_tenant_id, so a scoped
//     read can only ever see that workspace's own rows.
//
//   withAdminScope — the pre-tenant-context paths. Binding runs during account
//     creation, when the referred person has no workspace and the REFERRER's
//     tenant is the thing the code has yet to resolve to; the code lookup is
//     what identifies the tenant, exactly like the token lookups in
//     mcp-server/mcp-auth.ts and the Slack webhook routers. Each one is a
//     narrow statement keyed by code, account or referral id, and no
//     cross-tenant data leaves the module.

import type { PoolClient } from 'pg';
import { withAdminScope, withTenantScope } from '../infrastructure/database';
import type { ReferralIneligibleReason, ReferralRow, ReferralStatus } from './types';

interface ReferralDbRow {
  id: string;
  referrer_tenant_id: string;
  referred_tenant_id: string | null;
  referred_account_id: string;
  code: string;
  clicked_at: Date | null;
  signed_up_at: Date;
  subscribed_at: Date | null;
  status: ReferralStatus;
  ineligible_reason: ReferralIneligibleReason | null;
}

function mapReferral(row: ReferralDbRow): ReferralRow {
  return {
    id: row.id,
    referrerTenantId: row.referrer_tenant_id,
    referredTenantId: row.referred_tenant_id,
    referredAccountId: row.referred_account_id,
    code: row.code,
    clickedAt: row.clicked_at,
    signedUpAt: row.signed_up_at,
    subscribedAt: row.subscribed_at,
    status: row.status,
    ineligibleReason: row.ineligible_reason,
  };
}

const REFERRAL_COLUMNS = `
  id, referrer_tenant_id, referred_tenant_id, referred_account_id, code,
  clicked_at, signed_up_at, subscribed_at, status, ineligible_reason
`;

/** One row of the referrer's list, joined to the referred person's account. */
export interface ReferralListRow extends ReferralRow {
  email: string;
  name: string | null;
}

export class ReferralRepository {
  // ── referral_codes ─────────────────────────────────────────────────────────

  /** The workspace's code, or null when one has never been issued. */
  async findCodeByTenant(tenantId: string): Promise<string | null> {
    return withTenantScope(tenantId, async (client) => {
      const { rows } = await client.query<{ code: string }>(
        `SELECT code FROM referral_codes WHERE tenant_id = $1`,
        [tenantId],
      );
      return rows[0]?.code ?? null;
    });
  }

  /**
   * Claims `code` for the workspace, returning whatever code the workspace ends
   * up holding.
   *
   * ON CONFLICT (tenant_id) DO NOTHING is what makes the code immutable: a
   * second issue attempt returns the first one rather than replacing it. A
   * conflict on the UNIQUE code — two workspaces drawing the same four hex
   * digits behind the same stem — raises 23505 and the caller retries with a
   * fresh candidate, which is the only way to settle that race honestly.
   */
  async issueCode(tenantId: string, code: string): Promise<string> {
    return withTenantScope(tenantId, async (client) => {
      await client.query(
        `INSERT INTO referral_codes (tenant_id, code) VALUES ($1, $2)
           ON CONFLICT (tenant_id) DO NOTHING`,
        [tenantId, code],
      );
      const { rows } = await client.query<{ code: string }>(
        `SELECT code FROM referral_codes WHERE tenant_id = $1`,
        [tenantId],
      );
      return rows[0].code;
    });
  }

  /**
   * Resolves a share code to the workspace that owns it and the account behind
   * it. Runs pre-tenant-context: the code IS what identifies the tenant.
   */
  async adminResolveCode(
    code: string,
  ): Promise<{ tenantId: string; accountId: string } | null> {
    const { rows } = await withAdminScope(
      {
        caller: 'ReferralRepository.adminResolveCode',
        reason: 'pre-tenant-context: a share code is what identifies the referring workspace',
      },
      (client) =>
        client.query<{ tenant_id: string; account_id: string }>(
          `SELECT rc.tenant_id, t.account_id
             FROM referral_codes rc
             JOIN tenants t ON t.id = rc.tenant_id
            WHERE rc.code = $1`,
          [code],
        ),
    );
    const row = rows[0];
    return row ? { tenantId: row.tenant_id, accountId: row.account_id } : null;
  }

  // ── referrals ──────────────────────────────────────────────────────────────

  /** Every referral already bound to this account, newest first. */
  async adminFindByReferredAccount(accountId: string): Promise<ReferralRow[]> {
    const { rows } = await withAdminScope(
      {
        caller: 'ReferralRepository.adminFindByReferredAccount',
        reason: 'binding runs at account creation, before the account has any workspace',
        actor: `account:${accountId}`,
      },
      (client) =>
        client.query<ReferralDbRow>(
          `SELECT ${REFERRAL_COLUMNS} FROM referrals
            WHERE referred_account_id = $1
            ORDER BY signed_up_at DESC`,
          [accountId],
        ),
    );
    return rows.map(mapReferral);
  }

  /**
   * Writes the attribution row.
   *
   * ON CONFLICT on (referrer_tenant_id, referred_account_id) returns the
   * existing row untouched: a retried signup must re-bind the same pair rather
   * than add a second row to the referrer's list, and must not overwrite an
   * ineligibility already recorded.
   */
  async adminBind(input: {
    referrerTenantId: string;
    referredAccountId: string;
    code: string;
    clickedAt: Date | null;
    ineligibleReason: ReferralIneligibleReason | null;
  }): Promise<ReferralRow> {
    const { rows } = await withAdminScope(
      {
        caller: 'ReferralRepository.adminBind',
        reason: 'binding runs at account creation, before the account has any workspace',
        actor: `account:${input.referredAccountId}`,
      },
      async (client) => {
        await client.query(
          `INSERT INTO referrals
             (referrer_tenant_id, referred_account_id, code, clicked_at, ineligible_reason)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (referrer_tenant_id, referred_account_id) DO NOTHING`,
          [
            input.referrerTenantId,
            input.referredAccountId,
            input.code,
            input.clickedAt,
            input.ineligibleReason,
          ],
        );
        return client.query<ReferralDbRow>(
          `SELECT ${REFERRAL_COLUMNS} FROM referrals
            WHERE referrer_tenant_id = $1 AND referred_account_id = $2`,
          [input.referrerTenantId, input.referredAccountId],
        );
      },
    );
    return mapReferral(rows[0]);
  }

  /**
   * Points a waiting referral at the workspace the referred account has just
   * provisioned.
   *
   * Three conditions, and each closes a different way of getting this wrong:
   *
   *   `referred_tenant_id IS NULL` plus the column's UNIQUE constraint enforce
   *   "a workspace can be referred once, ever" — a tenant id already claimed by
   *   another row cannot be written twice.
   *
   *   The FIRST-workspace check is what stops a later workspace inheriting an
   *   attribution that was never about it. Without it, an account that binds a
   *   second referral (marked `already_referred`) and then creates a second
   *   workspace would have that workspace recorded as referred — a row that
   *   earns nothing, but says something untrue about which workspace the link
   *   produced. Counted rather than assumed because provisioning is the only
   *   caller and it has just inserted the row it is asking about.
   *
   *   Oldest-first picks the binding that actually happened at signup when an
   *   account somehow carries more than one.
   */
  async adminAttachReferredTenant(accountId: string, tenantId: string): Promise<boolean> {
    const { rowCount } = await withAdminScope(
      {
        caller: 'ReferralRepository.adminAttachReferredTenant',
        reason: 'the referred workspace is created after the account the referral is bound to',
        actor: `account:${accountId}`,
      },
      (client) =>
        client.query(
          `UPDATE referrals
              SET referred_tenant_id = $2, updated_at = NOW()
            WHERE referred_account_id = $1
              AND referred_tenant_id IS NULL
              AND (SELECT COUNT(*) FROM tenants WHERE account_id = $1) = 1
              AND id = (
                SELECT id FROM referrals
                 WHERE referred_account_id = $1 AND referred_tenant_id IS NULL
                 ORDER BY signed_up_at ASC
                 LIMIT 1
              )`,
          [accountId, tenantId],
        ),
    );
    return (rowCount ?? 0) > 0;
  }

  /** The referral a referred workspace was signed up under, if any. */
  async adminFindByReferredTenant(tenantId: string): Promise<ReferralRow | null> {
    const { rows } = await withAdminScope(
      {
        caller: 'ReferralRepository.adminFindByReferredTenant',
        reason: 'liftoff-billing asks whether a paying workspace was referred; it knows only the tenant',
        actor: `tenant:${tenantId}`,
      },
      (client) =>
        client.query<ReferralDbRow>(
          `SELECT ${REFERRAL_COLUMNS} FROM referrals WHERE referred_tenant_id = $1`,
          [tenantId],
        ),
    );
    return rows[0] ? mapReferral(rows[0]) : null;
  }

  /** Records the conversion. Idempotent: subscribed_at is never moved once set. */
  async adminMarkSubscribed(referralId: string, subscribedAt: Date): Promise<ReferralRow | null> {
    const { rows } = await withAdminScope(
      {
        caller: 'ReferralRepository.adminMarkSubscribed',
        reason: 'the earning event is an invoice, and liftoff-billing is the only side that sees it',
        actor: `referral:${referralId}`,
      },
      (client) =>
        client.query<ReferralDbRow>(
          `UPDATE referrals
              SET status        = 'subscribed',
                  subscribed_at = COALESCE(subscribed_at, $2),
                  updated_at    = NOW()
            WHERE id = $1
            RETURNING ${REFERRAL_COLUMNS}`,
          [referralId, subscribedAt],
        ),
    );
    return rows[0] ? mapReferral(rows[0]) : null;
  }

  /**
   * Records why a referral earns nothing.
   *
   * COALESCE keeps the FIRST reason: a row already marked `existing_account` at
   * binding must not be relabelled `discounted_signup` when its invoice
   * arrives, because the earlier fact is the one that actually disqualified it.
   */
  async adminMarkIneligible(
    referralId: string,
    reason: ReferralIneligibleReason,
  ): Promise<ReferralRow | null> {
    const { rows } = await withAdminScope(
      {
        caller: 'ReferralRepository.adminMarkIneligible',
        reason: 'disqualification is decided where the invoice is seen, in liftoff-billing',
        actor: `referral:${referralId}`,
      },
      (client) =>
        client.query<ReferralDbRow>(
          `UPDATE referrals
              SET ineligible_reason = COALESCE(ineligible_reason, $2),
                  updated_at        = NOW()
            WHERE id = $1
            RETURNING ${REFERRAL_COLUMNS}`,
          [referralId, reason],
        ),
    );
    return rows[0] ? mapReferral(rows[0]) : null;
  }

  /**
   * One page of the referrer's list, newest signup first with ties broken on
   * id.
   *
   * The order is a correctness requirement rather than a preference: `hasMore`
   * and `nextCursor` describe cursor pagination, and cursor pagination over an
   * undefined order duplicates and skips rows. It sorts on signed_up_at rather
   * than each row's most recent event because a subscribe date can appear later
   * and would reorder a row underneath an existing cursor.
   *
   * `limit + 1` rows are fetched so hasMore is a fact rather than a second
   * COUNT that can disagree with the page beside it.
   */
  async listForReferrer(
    tenantId: string,
    limit: number,
    cursor: { signedUpAt: Date; id: string } | null,
  ): Promise<ReferralListRow[]> {
    return withTenantScope(tenantId, async (client) => {
      const params: unknown[] = [tenantId, limit + 1];
      let keyset = '';
      if (cursor) {
        params.push(cursor.signedUpAt, cursor.id);
        // Cast both halves explicitly. A row comparison leaves the parameter
        // types to inference, and an untyped pair against (timestamptz, uuid)
        // is exactly the shape that resolves differently than intended without
        // erroring — which on a paginated list means silently skipped rows.
        keyset = `AND (r.signed_up_at, r.id) < ($3::timestamptz, $4::uuid)`;
      }
      const { rows } = await client.query<ReferralDbRow & { email: string; first_name: string; last_name: string }>(
        `SELECT r.id, r.referrer_tenant_id, r.referred_tenant_id, r.referred_account_id,
                r.code, r.clicked_at, r.signed_up_at, r.subscribed_at, r.status,
                r.ineligible_reason,
                a.email, a.first_name, a.last_name
           FROM referrals r
           JOIN accounts a ON a.id = r.referred_account_id
          WHERE r.referrer_tenant_id = $1
          ${keyset}
          ORDER BY r.signed_up_at DESC, r.id DESC
          LIMIT $2`,
        params,
      );
      return rows.map((row) => {
        const name = `${(row.first_name ?? '').trim()} ${(row.last_name ?? '').trim()}`.trim();
        return { ...mapReferral(row), email: row.email, name: name.length > 0 ? name : null };
      });
    });
  }

  /**
   * Flips every signup that has sat past the horizon without converting.
   *
   * Cross-tenant by nature — "every stale signup in the estate" is not a
   * question one workspace's scope can ask — and a status change nobody's
   * request triggered, which is why it runs under admin scope rather than
   * inside a tenant's transaction. It is exactly one narrow UPDATE.
   *
   * Deliberately reversible: `adminMarkSubscribed` sets the status
   * unconditionally, so a workspace that subscribes on day 200 moves straight
   * back to `subscribed` and earns. This marks staleness, not disqualification.
   */
  async adminExpireStaleSignups(cutoff: Date): Promise<number> {
    const { rowCount } = await withAdminScope(
      {
        caller: 'ReferralRepository.adminExpireStaleSignups',
        reason: 'daily sweep over every tenant\'s stale signups; no single tenant scope can see them',
      },
      (client) =>
        client.query(
          `UPDATE referrals
              SET status = 'expired', updated_at = NOW()
            WHERE status = 'signed_up'
              AND signed_up_at < $1`,
          [cutoff],
        ),
    );
    return rowCount ?? 0;
  }

  /** Signed up on the link and not subscribed yet. */
  async countPending(tenantId: string): Promise<number> {
    return withTenantScope(tenantId, async (client) => {
      const { rows } = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM referrals
          WHERE referrer_tenant_id = $1 AND status = 'signed_up'`,
        [tenantId],
      );
      return Number(rows[0]?.count ?? 0);
    });
  }

  // ── referral_invites ───────────────────────────────────────────────────────

  /** Addresses this workspace has already invited, from the set asked about. */
  async findInvitedEmails(tenantId: string, emails: string[]): Promise<Set<string>> {
    if (emails.length === 0) return new Set();
    return withTenantScope(tenantId, async (client) => {
      const { rows } = await client.query<{ email: string }>(
        `SELECT email FROM referral_invites WHERE tenant_id = $1 AND email = ANY($2::text[])`,
        [tenantId, emails],
      );
      return new Set(rows.map((r) => r.email));
    });
  }

  /** How many invitations this workspace has sent since midnight UTC. */
  async countInvitesSentToday(tenantId: string): Promise<number> {
    return withTenantScope(tenantId, async (client) => {
      const { rows } = await client.query<{ count: string }>(
        // The day boundary is UTC, and says so twice on purpose. `NOW() AT TIME
        // ZONE 'UTC'` yields a timestamp WITHOUT a zone; comparing that against
        // a timestamptz column re-attaches the SESSION's zone, so a database
        // not set to UTC would move the cap's reset by hours with nothing
        // failing. The trailing `AT TIME ZONE 'UTC'` pins it back.
        `SELECT COUNT(*)::text AS count FROM referral_invites
          WHERE tenant_id = $1
            AND sent_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
        [tenantId],
      );
      return Number(rows[0]?.count ?? 0);
    });
  }

  /** Sent and accepted totals, all time, for the acceptance-ratio throttle. */
  async inviteAcceptanceStats(tenantId: string): Promise<{ sent: number; accepted: number }> {
    return withTenantScope(tenantId, async (client) => {
      const { rows } = await client.query<{ sent: string; accepted: string }>(
        `SELECT COUNT(*)::text AS sent,
                COUNT(accepted_at)::text AS accepted
           FROM referral_invites WHERE tenant_id = $1`,
        [tenantId],
      );
      return { sent: Number(rows[0]?.sent ?? 0), accepted: Number(rows[0]?.accepted ?? 0) };
    });
  }

  /** Records the invitations that were actually handed to the mailer. */
  async recordInvites(tenantId: string, emails: string[]): Promise<void> {
    if (emails.length === 0) return;
    await withTenantScope(tenantId, async (client) => {
      await client.query(
        `INSERT INTO referral_invites (tenant_id, email)
         SELECT $1, unnest($2::text[])
             ON CONFLICT (tenant_id, email) DO NOTHING`,
        [tenantId, emails],
      );
    });
  }

  /**
   * Marks the invitation this signup answers, if there was one.
   *
   * Scoped to the ONE workspace whose code was bound rather than every
   * workspace that ever emailed the address: the acceptance ratio is a measure
   * of whether a workspace's own invitations land, and crediting an acceptance
   * to a workspace whose link was not the one followed would let a spammer
   * launder their ratio through somebody else's successful referral.
   */
  async adminMarkInviteAccepted(tenantId: string, email: string): Promise<void> {
    await withAdminScope(
      {
        caller: 'ReferralRepository.adminMarkInviteAccepted',
        reason: 'the acceptance is recorded at account creation, before the new account has any tenant',
        actor: `tenant:${tenantId}`,
      },
      (client) =>
        client.query(
          `UPDATE referral_invites
              SET accepted_at = COALESCE(accepted_at, NOW())
            WHERE tenant_id = $1 AND email = $2`,
          [tenantId, email.toLowerCase()],
        ),
    );
  }

  // ── Cross-cutting ──────────────────────────────────────────────────────────

  /**
   * Whether an address already belongs to a Liftoff account. Backs the
   * `already_a_customer` invite rejection.
   *
   * `accounts` is platform-global rather than tenant-scoped, so this runs on
   * the plain pool via the tenant scope it is already inside.
   */
  async findAccountIdsByEmail(tenantId: string, emails: string[]): Promise<Set<string>> {
    if (emails.length === 0) return new Set();
    return withTenantScope(tenantId, async (client: PoolClient) => {
      const { rows } = await client.query<{ email: string }>(
        `SELECT LOWER(email) AS email FROM accounts WHERE LOWER(email) = ANY($1::text[])`,
        [emails],
      );
      return new Set(rows.map((r) => r.email));
    });
  }
}
