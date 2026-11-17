// Account Repository
// Per Section 1: Control plane owns accounts

import type { PoolClient } from 'pg';
import { getPool, withTenantScope } from '../infrastructure/database';
import { AccessStatus, Account, AccountPreferences, CreateAccountInput, UpdateAccountInput } from './types';
import { isInternalEmail } from './internal-domains';

// Minimal Querier interface: either a pool or a tx client. Both expose .query().
type Querier = { query: PoolClient['query'] };

export class AccountRepository {
  async create(
    input: CreateAccountInput & { id?: string; stripeCustomerId?: string | null },
  ): Promise<Account> {
    return this.createInTx(getPool() as unknown as Querier, input);
  }

  // Tx-aware variant — used by service methods that wrap entity mutation +
  // outbox enqueue in a single withAdminScope (plan §5.4).
  async createInTx(
    client: Querier,
    input: CreateAccountInput & {
      id?: string;
      stripeCustomerId?: string | null;
      // Born-approved path: a signup that spends a pre-approval (migration
      // 341) starts 'approved' instead of the column default 'pending', in the
      // same INSERT, so there is no window where the row exists ungranted.
      // accessDecidedBy carries the admin who cleared the address, which makes
      // the column mean exactly what it means on the Approve-button path.
      accessStatus?: AccessStatus;
      accessDecidedBy?: string | null;
    },
  ): Promise<Account> {
    // `is_platform_admin` is TRUE for the FIRST account and only for it.
    //
    // The column defaults to false (migration 037) and nothing in the signup
    // path would otherwise set it. Without this, a fresh deployment would need
    // someone to set it by hand and has no surface that would let them: every
    // admin route is behind the flag
    // the operator cannot grant themselves, so the install comes up with its
    // administration permanently out of reach.
    //
    // Decided in SQL, in the same statement as the INSERT, so the question
    // "is anybody here yet" cannot be answered stale by a concurrent signup.
    // It is also why this needs no billing provider and no environment
    // variable: on a deployment that already has accounts the subquery is
    // false and nothing changes.
    const result = await client.query(
      `INSERT INTO accounts (id, firebase_uid, first_name, last_name, email, timezone, version, stripe_customer_id, is_internal,
                             access_status, access_decided_by, access_decided_at, is_platform_admin)
       VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6, 1, $7, $8,
               COALESCE($9::text, 'pending'), $10::uuid,
               CASE WHEN $9::text IS NULL THEN NULL ELSE NOW() END,
               NOT EXISTS (SELECT 1 FROM accounts))
       RETURNING *`,
      [
        input.id ?? null,
        input.firebaseUid,
        input.firstName,
        input.lastName,
        input.email,
        input.timezone || 'America/Los_Angeles',
        input.stripeCustomerId ?? null,
        isInternalEmail(input.email),
        input.accessStatus ?? null,
        input.accessDecidedBy ?? null,
      ],
    );
    return this.mapRow(result.rows[0]);
  }

  async findById(id: string): Promise<Account | null> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT * FROM accounts WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    );
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  /**
   * Display fields for a set of accounts, restricted to members of one tenant.
   *
   * Backs the facepile in workforce-service's team-plan presence, which cannot
   * join `accounts` itself — it runs against the `workforce` database. The
   * tenant join is the access control: the caller may only ever learn about
   * people it already shares a workspace with, so a leaked service token cannot
   * be used to enumerate the accounts table.
   */
  async findProfilesByIds(
    tenantId: string,
    accountIds: string[],
  ): Promise<Array<{
    accountId: string;
    firstName: string | null;
    lastName: string | null;
    email: string;
    avatarUrl: string | null;
    /** The person's role in the tenant, as tenant_members holds it now. Read
     *  by the workforce service to run a continuation of a Chief AI Officer
     *  turn AS the person whose message started it, with their real role,
     *  when no request of theirs carries it. */
    role: string;
  }>> {
    if (accountIds.length === 0) return [];
    // withTenantScope, not getPool: `accounts` is one of migration 200's
    // platform-global exclusions, but `tenant_members` is not, so it carries
    // RLS + FORCE. On a raw pool the policy evaluates
    // current_setting('app.current_tenant_id') with nothing set and the whole
    // statement dies with 42704 — which is what put prod into a 500 loop here,
    // once per workforce-service facepile poll (~3.4s).
    //
    // The explicit `tm.tenant_id = $2` stays. It is the same tenant the scope
    // sets, so the policy makes it redundant rather than wrong, and leaving it
    // keeps the query readable on its own terms.
    const result = await withTenantScope(tenantId, (client) => client.query(
      `SELECT a.id, a.first_name, a.last_name, a.email, a.avatar_url, tm.role
       FROM accounts a
       JOIN tenant_members tm ON tm.account_id = a.id
       WHERE a.id = ANY($1::uuid[])
         AND tm.tenant_id = $2
         AND a.deleted_at IS NULL`,
      [accountIds, tenantId],
    ));
    return result.rows.map((row) => ({
      accountId: row.id as string,
      firstName: (row.first_name as string | null) ?? null,
      lastName: (row.last_name as string | null) ?? null,
      email: row.email as string,
      avatarUrl: (row.avatar_url as string | null) ?? null,
      role: row.role as string,
    }));
  }

  async findByEmail(email: string): Promise<Account | null> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT * FROM accounts WHERE email = $1 AND deleted_at IS NULL`,
      [email]
    );
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async findByFirebaseUid(firebaseUid: string): Promise<Account | null> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT * FROM accounts WHERE firebase_uid = $1 AND deleted_at IS NULL`,
      [firebaseUid]
    );
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async findAll(): Promise<Account[]> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT * FROM accounts WHERE deleted_at IS NULL ORDER BY created_at DESC`
    );
    return result.rows.map(this.mapRow);
  }

  async update(id: string, input: UpdateAccountInput): Promise<Account> {
    const pool = getPool();
    // Merge preferences with existing values (JSONB merge)
    const preferencesJson = input.preferences ? JSON.stringify(input.preferences) : null;
    // Handle avatarUrl - use special marker for explicit null vs undefined
    const avatarUrlValue = input.avatarUrl === null ? null : input.avatarUrl;
    const updateAvatarUrl = 'avatarUrl' in input;
    const result = await pool.query(
      `UPDATE accounts SET
        first_name = COALESCE($2, first_name),
        last_name = COALESCE($3, last_name),
        timezone = COALESCE($4, timezone),
        preferences = CASE
          WHEN $5::jsonb IS NOT NULL THEN preferences || $5::jsonb
          ELSE preferences
        END,
        avatar_url = CASE
          WHEN $7 THEN $6
          ELSE avatar_url
        END,
        version = version + 1,
        updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
      [id, input.firstName, input.lastName, input.timezone, preferencesJson, avatarUrlValue, updateAvatarUrl]
    );
    if (!result.rows[0]) {
      throw new Error(`Account not found: ${id}`);
    }
    return this.mapRow(result.rows[0]);
  }

  async setPendingEmailChange(
    id: string,
    pendingEmail: string,
    verificationToken: string,
    expiresAt: Date
  ): Promise<Account> {
    const pool = getPool();
    const result = await pool.query(
      `UPDATE accounts SET
        pending_email = $2,
        email_verification_token = $3,
        email_verification_expiry = $4,
        version = version + 1,
        updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
      [id, pendingEmail, verificationToken, expiresAt]
    );
    if (!result.rows[0]) {
      throw new Error(`Account not found: ${id}`);
    }
    return this.mapRow(result.rows[0]);
  }

  async findByVerificationToken(token: string): Promise<Account | null> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT * FROM accounts
       WHERE email_verification_token = $1
       AND email_verification_expiry > NOW()
       AND deleted_at IS NULL`,
      [token]
    );
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async confirmEmailChange(id: string): Promise<Account> {
    const pool = getPool();
    // Re-derive is_internal from the new email. SQL-side using LOWER + LIKE
    // over the configured domains keeps the rule colocated with the email
    // swap (atomic) — but we also recompute on the JS side after the row
    // returns to keep INTERNAL_EMAIL_DOMAINS as the single source of truth,
    // not duplicated SQL string literals.
    const result = await pool.query(
      `UPDATE accounts SET
        email = pending_email,
        pending_email = NULL,
        email_verification_token = NULL,
        email_verification_expiry = NULL,
        version = version + 1,
        updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
      [id]
    );
    if (!result.rows[0]) {
      throw new Error(`Account not found: ${id}`);
    }
    const newEmail = result.rows[0].email as string;
    const derivedInternal = isInternalEmail(newEmail);
    if (result.rows[0].is_internal !== derivedInternal) {
      const updated = await pool.query(
        `UPDATE accounts SET is_internal = $2, updated_at = NOW()
         WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
        [id, derivedInternal],
      );
      return this.mapRow(updated.rows[0]);
    }
    return this.mapRow(result.rows[0]);
  }

  async cancelPendingEmailChange(id: string): Promise<Account> {
    const pool = getPool();
    const result = await pool.query(
      `UPDATE accounts SET
        pending_email = NULL,
        email_verification_token = NULL,
        email_verification_expiry = NULL,
        version = version + 1,
        updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
      [id]
    );
    if (!result.rows[0]) {
      throw new Error(`Account not found: ${id}`);
    }
    return this.mapRow(result.rows[0]);
  }

  async updateStripeCustomerId(id: string, stripeCustomerId: string): Promise<Account> {
    const pool = getPool();
    const result = await pool.query(
      `UPDATE accounts SET stripe_customer_id = $2, version = version + 1, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id, stripeCustomerId]
    );
    if (!result.rows[0]) {
      throw new Error(`Account not found: ${id}`);
    }
    return this.mapRow(result.rows[0]);
  }

  // Set the per-user access approval state (signup Approve/Waitlist flow).
  // accounts has no RLS, so a plain pool UPDATE is correct. decidedBy is the
  // platform admin who made the decision (accounts.access_decided_by FK).
  async setAccessStatus(
    id: string,
    status: AccessStatus,
    // Nullable to match the column: an approval can be attributable to no
    // account row (a caller without a resolvable admin id) without the write
    // failing against the UUID FK.
    decidedBy: string | null,
  ): Promise<Account> {
    const pool = getPool();
    const result = await pool.query(
      `UPDATE accounts SET
        access_status = $2,
        access_decided_by = $3,
        access_decided_at = NOW(),
        version = version + 1,
        updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
      [id, status, decidedBy]
    );
    if (!result.rows[0]) {
      throw new Error(`Account not found: ${id}`);
    }
    return this.mapRow(result.rows[0]);
  }

  // Path-targeted preference write. Avoids the shallow JSONB merge in update()
  // (which would clobber siblings when a caller sends a nested partial like
  // { notificationTypes: { taskUpdates: false } }). Used by the unsubscribe
  // handler.
  async setPreferenceField(
    accountId: string,
    path: string[],
    value: unknown,
  ): Promise<void> {
    const pool = getPool();
    await pool.query(
      `UPDATE accounts
          SET preferences = jsonb_set(
                COALESCE(preferences, '{}'::jsonb),
                $2::text[],
                $3::jsonb,
                true
              ),
              updated_at = NOW()
        WHERE id = $1`,
      [accountId, `{${path.join(',')}}`, JSON.stringify(value)],
    );
  }

  async softDelete(id: string, deletedBy: string): Promise<boolean> {
    const pool = getPool();
    const result = await pool.query(
      `UPDATE accounts SET
        deleted_at = NOW(),
        deleted_by = $2,
        version = version + 1,
        updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING id`,
      [id, deletedBy]
    );
    return result.rowCount !== null && result.rowCount > 0;
  }

  // Get recently viewed internal agents for a tenant
  async getRecentlyViewedInternalAgents(
    accountId: string,
    tenantId: string
  ): Promise<Array<{ internalAgentId: string; viewedAt: string; source: string }>> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT recently_viewed_internal_agents->$2 as views FROM accounts WHERE id = $1`,
      [accountId, tenantId]
    );
    return result.rows[0]?.views || [];
  }

  // Record a view (read-modify-write)
  async recordInternalAgentView(
    accountId: string,
    tenantId: string,
    internalAgentId: string,
    source: string
  ): Promise<void> {
    const pool = getPool();
    // Get current views for this tenant
    const current = await this.getRecentlyViewedInternalAgents(accountId, tenantId);

    // Remove existing entry for this internal agent (if any) and add new one at front
    const filtered = current.filter(v => v.internalAgentId !== internalAgentId);
    const updated = [
      { internalAgentId, viewedAt: new Date().toISOString(), source },
      ...filtered
    ].slice(0, 10); // Keep max 10

    // Update the JSONB column
    await pool.query(
      `UPDATE accounts
       SET recently_viewed_internal_agents = jsonb_set(
         COALESCE(recently_viewed_internal_agents, '{}'),
         ARRAY[$2],
         $3::jsonb
       ),
       updated_at = NOW()
       WHERE id = $1`,
      [accountId, tenantId, JSON.stringify(updated)]
    );
  }

  // Tombstone ledger (Phase 7 abuse prevention). Writes are scoped to the
  // soft-scrub branch of AccountService.cascadeDelete; reads are scoped to
  // the HMAC-protected check-deletion-history endpoint called by liftoff-
  // billing's promo-eligibility helper.
  async insertDeletionLedger(input: {
    emailHash: string;
    phoneHash?: string;
    stripeCustomerId: string;
  }): Promise<{ id: string }> {
    const r = await getPool().query<{ id: string }>(
      `INSERT INTO accounts_deletion_ledger (email_sha256, phone_sha256, stripe_customer_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [input.emailHash, input.phoneHash ?? null, input.stripeCustomerId],
    );
    return r.rows[0];
  }

  async findDeletionLedgerByEmailHash(emailHash: string): Promise<{ id: string; deleted_at: Date } | null> {
    const r = await getPool().query<{ id: string; deleted_at: Date }>(
      `SELECT id, deleted_at FROM accounts_deletion_ledger
        WHERE email_sha256 = $1
        LIMIT 1`,
      [emailHash],
    );
    return r.rows[0] ?? null;
  }

  private mapRow(row: Record<string, unknown>): Account {
    return {
      id: row.id as string,
      firebaseUid: row.firebase_uid as string,
      firstName: row.first_name as string,
      lastName: row.last_name as string,
      email: row.email as string,
      timezone: row.timezone as string,
      avatarUrl: row.avatar_url as string | null,
      stripeCustomerId: row.stripe_customer_id as string | null,
      pendingEmail: row.pending_email as string | null,
      emailVerificationToken: row.email_verification_token as string | null,
      emailVerificationExpiry: row.email_verification_expiry as Date | null,
      preferences: (row.preferences as AccountPreferences) || {},
      version: row.version as number,
      createdAt: row.created_at as Date,
      updatedAt: row.updated_at as Date,
      deletedAt: (row.deleted_at as Date | null) ?? null,
      isInternal: (row.is_internal as boolean | null) ?? false,
      isPlatformAdmin: (row.is_platform_admin as boolean | null) ?? false,
      accessStatus: (row.access_status as AccessStatus | null) ?? 'pending',
    };
  }
}
