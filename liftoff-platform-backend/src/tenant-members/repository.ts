// Tenant Members Repository
// Database queries for members and invitations

import type { PoolClient } from 'pg';
import { withTenantScope, withAdminScope } from '../infrastructure/database';
import { lockActiveGrants, retireGrantFamily } from '../oauth/grant-lifecycle';
import {
  TenantMember,
  TenantMemberWithAccount,
  TenantInvitation,
  TenantInvitationWithDetails,
  TenantMemberRole,
  TenantInviteStatus,
  TenantMemberAudit,
  PaginatedMembersResponse,
  PaginatedInvitationsResponse,
  PendingOwnershipTransfer,
  PendingOwnershipTransferWithDetails,
  OwnershipTransferStatus,
} from './types';

// One lapsed invitation, joined with its inviter and workspace, as returned by
// expireAndReturnPendingInvitations for the daily notification sweep.
export interface ExpiredInvitationRow {
  tenantId: string;
  invitedBy: string;
  inviteeEmail: string;
  invitedAt: Date;
  inviterEmail: string;
  inviterFirstName: string | null;
  tenantName: string;
}

// A still-pending invitation nearing expiry, for the day-5 reminder to its
// recipient. recipientEmail is where the reminder goes; the inviter name feeds
// the "{who} invited you" line (both columns are NOT NULL, but may be empty —
// the sender falls back gracefully).
export interface RemindableInvitation {
  id: string;
  recipientEmail: string;
  tenantId: string;
  tenantName: string;
  inviterFirstName: string;
  inviterLastName: string;
  inviterEmail: string;
  expiresAt: Date;
  inviterTimezone: string;
}

export class TenantMembersRepository {
  // Member queries

  async findMemberById(id: string, tenantId: string): Promise<TenantMember | null> {
    const result = await withTenantScope(tenantId, (client) => client.query(
      `SELECT * FROM tenant_members WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    ));
    return result.rows[0] ? this.mapMemberRow(result.rows[0]) : null;
  }

  // Auth-lookup path: called from pre-tenant-context handlers (agent-card-router,
  // generated-files PATCH, internal-agents router, claude-code-proxy router,
  // workforce-proxy) BEFORE the request is bound to a tenant scope. Uses
  // withAdminScope so RLS on tenant_members (enabled by migration 095) does
  // not deny the lookup when app.current_tenant_id is unset. The query itself
  // is naturally scoped by (tenant_id, account_id) so admin bypass is safe.
  async findMembership(tenantId: string, accountId: string): Promise<TenantMember | null> {
    const result = await withAdminScope(
      {
        caller: 'TenantMembersRepository.findMembership',
        reason: 'auth lookup — tenant context not yet established',
      },
      (client) =>
        client.query(
          `SELECT * FROM tenant_members WHERE tenant_id = $1 AND account_id = $2`,
          [tenantId, accountId],
        ),
    );
    return result.rows[0] ? this.mapMemberRow(result.rows[0]) : null;
  }

  // [BE-006] Paginated members query
  async listMembers(
    tenantId: string,
    options: { cursor?: string | null; limit?: number } = {}
  ): Promise<PaginatedMembersResponse> {
    const limit = options.limit || 50;
    const cursor = options.cursor;

    let query = `
      SELECT
        tm.*,
        a.id as account_id,
        a.first_name,
        a.last_name,
        a.email,
        a.avatar_url
      FROM tenant_members tm
      JOIN accounts a ON tm.account_id = a.id
      WHERE tm.tenant_id = $1
    `;
    const params: (string | number)[] = [tenantId];

    if (cursor) {
      query += ` AND tm.id > $2`;
      params.push(cursor);
    }

    query += ` ORDER BY tm.joined_at ASC, tm.id ASC LIMIT $${params.length + 1}`;
    params.push(limit + 1);

    const result = await withTenantScope(tenantId, (client) => client.query(query, params));
    const hasMore = result.rows.length > limit;
    // Use arrow function to preserve 'this' binding
    const members = result.rows.slice(0, limit).map((row) => this.mapMemberWithAccountRow(row));

    return {
      members,
      nextCursor: hasMore ? members[members.length - 1].id : null,
      hasMore,
    };
  }

  async createMember(data: {
    tenantId: string;
    accountId: string;
    role: TenantMemberRole;
    invitedBy?: string;
    invitedAt?: Date;
  }): Promise<TenantMember> {
    return withTenantScope(data.tenantId, (client) => this.insertMember(client, data));
  }

  // Transaction-scoped variant for use inside withAdminScope BEGIN/COMMIT.
  // TenantService.provision wraps tenant + member + entitlement inserts in
  // one tx so a failure in any step rolls back the others.
  async createMemberInTx(
    client: PoolClient,
    data: {
      tenantId: string;
      accountId: string;
      role: TenantMemberRole;
      invitedBy?: string;
      invitedAt?: Date;
    },
  ): Promise<TenantMember> {
    return this.insertMember(client, data);
  }

  private async insertMember(
    runner: { query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }> },
    data: {
      tenantId: string;
      accountId: string;
      role: TenantMemberRole;
      invitedBy?: string;
      invitedAt?: Date;
    },
  ): Promise<TenantMember> {
    const result = await runner.query(
      `INSERT INTO tenant_members (tenant_id, account_id, role, invited_by, invited_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [data.tenantId, data.accountId, data.role, data.invitedBy || null, data.invitedAt || null]
    );
    return this.mapMemberRow(result.rows[0] as Record<string, unknown>);
  }

  // By-PK role update. The caller (tenant-members service/router) has already
  // authorized against the member's tenant via findMemberById(id, tenantId),
  // which is tenant-scoped; the write itself carries no tenantId → withAdminScope
  // (same by-PK pattern as overage-rules.update).
  async updateMemberRole(id: string, role: TenantMemberRole): Promise<TenantMember> {
    const result = await withAdminScope(
      { caller: 'TenantMembersRepository.updateMemberRole', reason: 'by-PK member role update; tenant authorization enforced upstream' },
      (client) => client.query(
        `UPDATE tenant_members SET role = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
        [id, role]
      ),
    );
    if (!result.rows[0]) {
      throw new Error(`Member not found: ${id}`);
    }
    return this.mapMemberRow(result.rows[0]);
  }

  async deleteMember(id: string): Promise<void> {
    await withAdminScope(
      { caller: 'TenantMembersRepository.deleteMember', reason: 'by-PK member delete; tenant authorization enforced upstream' },
      (client) => client.query(`DELETE FROM tenant_members WHERE id = $1`, [id]),
    );
  }

  /**
   * Remove a membership AND every coding-tool credential the account holds in
   * this workspace, in ONE transaction. The OAuth verifier and the static-token
   * lookup only ask whether the grant and its anchor are active, never whether
   * the person is still a member, so a membership deleted on its own leaves the
   * removed person every MCP tool until their token expires. The two commit or
   * roll back together: a revocation that fails leaves the membership in place
   * and the caller answers 500, which is retryable.
   *
   * The OAuth grants go through the grant lifecycle's helpers (lockActiveGrants
   * in id order, then retireGrantFamily per grant — the lock discipline in
   * src/oauth/grant-lifecycle.ts), which retire each anchor. The static
   * liftoff_mcp_* tokens are mcp_tokens rows with no grant, so the statement
   * that follows matches those alone; `tokens` counts the anchors the helpers
   * retired plus the static tokens, the same number as before.
   */
  async deleteMemberAndRevokeAccess(
    tenantId: string,
    memberId: string,
    accountId: string,
  ): Promise<{ tokens: number; grants: number }> {
    return withTenantScope(tenantId, async (client) => {
      // The last-owner trigger fires inside this transaction.
      await client.query(
        `DELETE FROM tenant_members WHERE id = $1 AND tenant_id = $2`,
        [memberId, tenantId],
      );
      const grants = await lockActiveGrants(client, { accountId, tenantId });
      let anchors = 0;
      for (const family of grants) {
        anchors += (await retireGrantFamily(client, family)).anchorRetired;
      }
      const tokens = await client.query(
        `UPDATE mcp_tokens SET status = 'revoked', deleted_at = NOW()
         WHERE tenant_id = $1 AND account_id = $2 AND status = 'active' AND deleted_at IS NULL
         RETURNING id`,
        [tenantId, accountId],
      );
      const tokenIds = tokens.rows.map((r: { id: string }) => r.id);
      await client.query(
        `UPDATE person_agent_assignments SET deleted_at = NOW()
         WHERE tenant_id = $1 AND agent_id = ANY($2::uuid[]) AND deleted_at IS NULL`,
        [tenantId, tokenIds],
      );
      return { tokens: anchors + tokenIds.length, grants: grants.length };
    });
  }

  async countOwners(tenantId: string): Promise<number> {
    const result = await withTenantScope(tenantId, (client) => client.query(
      `SELECT COUNT(*) as count FROM tenant_members WHERE tenant_id = $1 AND role = 'owner'`,
      [tenantId]
    ));
    return parseInt(result.rows[0].count, 10);
  }

  // Returns tenant IDs where this account is an owner per tenant_members
  // (NOT via tenants.account_id — that column does not move on ownership
  // transfer, so it loses workspaces that were transferred to this user).
  // Consumed by AccountService.cascadeDelete enumeration and the user-facing
  // deletion preflight so both sides agree on what "owned" means for a
  // user-initiated cascade.
  async findOwnedTenantIds(accountId: string): Promise<Array<{ id: string }>> {
    const r = await withAdminScope(
      {
        caller: 'TenantMembersRepository.findOwnedTenantIds',
        reason: 'pre-tenant-context enumeration for cascade-delete preflight',
      },
      (client) => client.query<{ id: string }>(
        `SELECT DISTINCT t.id
           FROM tenants t
           JOIN tenant_members tm ON tm.tenant_id = t.id
          WHERE tm.account_id = $1 AND tm.role = 'owner'`,
        [accountId],
      ),
    );
    return r.rows;
  }

  // All tenant memberships for an account regardless of role. Used by the
  // deletion preflight to compute memberOfWorkspaceCount.
  async findTenantsForAccount(accountId: string): Promise<Array<{ tenant_id: string; role: TenantMemberRole }>> {
    const r = await withAdminScope(
      {
        caller: 'TenantMembersRepository.findTenantsForAccount',
        reason: 'pre-tenant-context enumeration for deletion preflight',
      },
      (client) => client.query<{ tenant_id: string; role: TenantMemberRole }>(
        `SELECT tenant_id, role FROM tenant_members WHERE account_id = $1`,
        [accountId],
      ),
    );
    return r.rows;
  }

  // Every member of a tenant (account_id + role). Used by the deletion
  // preflight to count other members affected when an owner deletes.
  async findAllByTenant(tenantId: string): Promise<Array<{ account_id: string; role: TenantMemberRole }>> {
    const r = await withAdminScope(
      {
        caller: 'TenantMembersRepository.findAllByTenant',
        reason: 'pre-tenant-context enumeration for deletion preflight',
      },
      (client) => client.query<{ account_id: string; role: TenantMemberRole }>(
        `SELECT account_id, role FROM tenant_members WHERE tenant_id = $1`,
        [tenantId],
      ),
    );
    return r.rows;
  }

  // Check if user has any non-owner membership (for access gate)
  // Rows only exist in tenant_members after invitation acceptance, so no status filter needed
  async hasNonOwnerMembership(accountId: string): Promise<boolean> {
    // Account-keyed cross-tenant access gate (spans every tenant this account
    // belongs to), no single tenant scope → withAdminScope.
    const result = await withAdminScope(
      { caller: 'TenantMembersRepository.hasNonOwnerMembership', reason: 'cross-tenant access-gate check by account (no tenant scope)' },
      (client) => client.query(
        `SELECT 1 FROM tenant_members WHERE account_id = $1 AND role != 'owner' LIMIT 1`,
        [accountId]
      ),
    );
    return result.rows.length > 0;
  }

  // Get all tenants a user is a member of (for my-memberships endpoint)
  // Returns full tenant data with role for TenantWithRole interface
  async findMembershipsByAccountId(accountId: string): Promise<{
    tenant: {
      id: string;
      accountId: string;
      name: string;
      status: string;
      gcpProjectId: string | null;
      databaseName: string | null;
      migrationStatus: string;
      hasCreatedInternalAgent: boolean;
      onboardingStep: number;
      onboardingPersona: string | null;
      onboardingCompletedAt: Date | null;
      createdAt: Date;
      updatedAt: Date;
    };
    role: TenantMemberRole;
    joinedAt: Date;
  }[]> {
    // "My memberships" — account-keyed enumeration across every tenant the
    // account belongs to (no single tenant scope) → withAdminScope.
    const result = await withAdminScope(
      { caller: 'TenantMembersRepository.findMembershipsByAccountId', reason: 'cross-tenant my-memberships enumeration by account (no tenant scope)' },
      (client) => client.query(
      `SELECT
        tm.role,
        tm.joined_at,
        t.id as tenant_id,
        t.account_id as tenant_account_id,
        t.name as tenant_name,
        t.status as tenant_status,
        t.gcp_project_id as tenant_gcp_project_id,
        t.database_name as tenant_database_name,
        t.migration_status as tenant_migration_status,
        t.has_created_internal_agent as tenant_has_created_internal_agent,
        t.onboarding_step as tenant_onboarding_step,
        t.onboarding_persona as tenant_onboarding_persona,
        t.onboarding_completed_at as tenant_onboarding_completed_at,
        t.created_at as tenant_created_at,
        t.updated_at as tenant_updated_at
       FROM tenant_members tm
       JOIN tenants t ON tm.tenant_id = t.id
       WHERE tm.account_id = $1
       ORDER BY tm.joined_at DESC`,
      [accountId]
    ));
    return result.rows.map((row) => ({
      tenant: {
        id: row.tenant_id as string,
        accountId: row.tenant_account_id as string,
        name: row.tenant_name as string,
        status: row.tenant_status as string,
        gcpProjectId: row.tenant_gcp_project_id as string | null,
        databaseName: row.tenant_database_name as string | null,
        migrationStatus: row.tenant_migration_status as string,
        hasCreatedInternalAgent: row.tenant_has_created_internal_agent as boolean,
        onboardingStep: (row.tenant_onboarding_step as number) ?? 0,
        onboardingPersona: (row.tenant_onboarding_persona as string | null) ?? null,
        onboardingCompletedAt: (row.tenant_onboarding_completed_at as Date | null) ?? null,
        createdAt: row.tenant_created_at as Date,
        updatedAt: row.tenant_updated_at as Date,
      },
      role: row.role as TenantMemberRole,
      joinedAt: row.joined_at as Date,
    }));
  }

  // Invitation queries

  async findInvitationById(id: string): Promise<TenantInvitation | null> {
    // By-PK invitation lookup, no tenant context → withAdminScope.
    const result = await withAdminScope(
      { caller: 'TenantMembersRepository.findInvitationById', reason: 'by-PK invitation lookup (no tenant scope)' },
      (client) => client.query(
        `SELECT * FROM tenant_invitations WHERE id = $1`,
        [id]
      ),
    );
    return result.rows[0] ? this.mapInvitationRow(result.rows[0]) : null;
  }

  async findInvitationByTokenHash(tokenHash: string): Promise<TenantInvitationWithDetails | null> {
    // Invite-acceptance lookup by opaque token, before the caller is bound to
    // any tenant scope → withAdminScope.
    const result = await withAdminScope(
      { caller: 'TenantMembersRepository.findInvitationByTokenHash', reason: 'pre-tenant-context invite lookup by token hash' },
      (client) => client.query(
        `SELECT
        ti.*,
        t.name as tenant_name,
        a.id as inviter_id,
        a.first_name as inviter_first_name,
        a.last_name as inviter_last_name
       FROM tenant_invitations ti
       JOIN tenants t ON ti.tenant_id = t.id
       JOIN accounts a ON ti.invited_by = a.id
       WHERE ti.invite_token_hash = $1 OR ti.reminder_token_hash = $1`,
        [tokenHash]
      ),
    );
    return result.rows[0] ? this.mapInvitationWithDetailsRow(result.rows[0]) : null;
  }

  async findPendingInvitationByEmail(tenantId: string, email: string): Promise<TenantInvitation | null> {
    const result = await withTenantScope(tenantId, (client) => client.query(
      `SELECT * FROM tenant_invitations
       WHERE tenant_id = $1 AND LOWER(email) = LOWER($2) AND status = 'pending'`,
      [tenantId, email]
    ));
    return result.rows[0] ? this.mapInvitationRow(result.rows[0]) : null;
  }

  async listInvitations(
    tenantId: string,
    options: { cursor?: string | null; limit?: number; status?: TenantInviteStatus } = {}
  ): Promise<PaginatedInvitationsResponse> {
    const limit = options.limit || 50;
    const cursor = options.cursor;

    let query = `
      SELECT
        ti.*,
        t.name as tenant_name,
        a.id as inviter_id,
        a.first_name as inviter_first_name,
        a.last_name as inviter_last_name
      FROM tenant_invitations ti
      JOIN tenants t ON ti.tenant_id = t.id
      JOIN accounts a ON ti.invited_by = a.id
      WHERE ti.tenant_id = $1
    `;
    const params: (string | number)[] = [tenantId];

    if (options.status) {
      params.push(options.status);
      query += ` AND ti.status = $${params.length}`;
    }

    if (cursor) {
      params.push(cursor);
      query += ` AND ti.id > $${params.length}`;
    }

    query += ` ORDER BY ti.created_at DESC, ti.id ASC LIMIT $${params.length + 1}`;
    params.push(limit + 1);

    const result = await withTenantScope(tenantId, (client) => client.query(query, params));
    const hasMore = result.rows.length > limit;
    // Use arrow function to preserve 'this' binding
    const invitations = result.rows.slice(0, limit).map((row) => this.mapInvitationWithDetailsRow(row));

    return {
      invitations,
      nextCursor: hasMore ? invitations[invitations.length - 1].id : null,
      hasMore,
    };
  }

  async createInvitation(data: {
    tenantId: string;
    email: string;
    role: TenantMemberRole;
    inviteTokenHash: string;
    invitedBy: string;
    expiresAt: Date;
  }): Promise<TenantInvitation> {
    const result = await withTenantScope(data.tenantId, (client) => client.query(
      `INSERT INTO tenant_invitations (tenant_id, email, role, invite_token_hash, invited_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [data.tenantId, data.email, data.role, data.inviteTokenHash, data.invitedBy, data.expiresAt]
    ));
    return this.mapInvitationRow(result.rows[0]);
  }

  async updateInvitationStatus(
    id: string,
    status: TenantInviteStatus,
    accountId?: string
  ): Promise<TenantInvitation> {
    // By-PK invitation status change (accept/decline/revoke), invoked from the
    // acceptance flow with no tenant scope → withAdminScope.
    const result = await withAdminScope(
      { caller: 'TenantMembersRepository.updateInvitationStatus', reason: 'by-PK invitation status update (no tenant scope)' },
      (client) => client.query(
        `UPDATE tenant_invitations
       SET status = $2::tenant_invite_status, account_id = $3, accepted_at = CASE WHEN $2 = 'accepted' THEN NOW() ELSE accepted_at END, updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
        [id, status, accountId || null]
      ),
    );
    if (!result.rows[0]) {
      throw new Error(`Invitation not found: ${id}`);
    }
    return this.mapInvitationRow(result.rows[0]);
  }

  async updateInvitationRole(
    id: string,
    role: TenantMemberRole
  ): Promise<TenantInvitation> {
    const result = await withAdminScope(
      { caller: 'TenantMembersRepository.updateInvitationRole', reason: 'by-PK invitation role update (no tenant scope)' },
      (client) => client.query(
        `UPDATE tenant_invitations
       SET role = $2::tenant_member_role, updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
        [id, role]
      ),
    );
    if (!result.rows[0]) {
      throw new Error(`Invitation not found: ${id}`);
    }
    return this.mapInvitationRow(result.rows[0]);
  }

  // [BE-007] Cleanup expired invitations
  async expireOldInvitations(): Promise<number> {
    // Cross-tenant maintenance sweep (all pending expired invitations) → withAdminScope.
    const result = await withAdminScope(
      { caller: 'TenantMembersRepository.expireOldInvitations', reason: 'cross-tenant maintenance sweep of expired invitations' },
      (client) => client.query(
        `UPDATE tenant_invitations
       SET status = 'expired', updated_at = NOW()
       WHERE status = 'pending' AND expires_at < NOW()`
      ),
    );
    return result.rowCount || 0;
  }

  // Flip every pending invitation that lapsed on a COMPLETED day IN THE
  // INVITER'S OWN TIME ZONE to 'expired' and return the lapsed ones joined with
  // their inviter and workspace, for the daily notification sweep
  // (jobs/invite-expiry-sweep.ts).
  //
  // The boundary is the inviter's local day (accounts.timezone — set from the
  // browser at signup, never null, defaulting to America/Los_Angeles), not UTC,
  // so "after that day's last expiration" means after THEIR day. A whole local
  // day's expirations settle before the inviter is told: everything that lapsed
  // yesterday-their-time is caught by the same run and aggregated into ONE email,
  // sent after their day's last expiration. An invitation that lapses today,
  // their time, waits for the next run past their local midnight — the lazy
  // accept-time check still rejects accepting it meanwhile, so the deferred flip
  // opens no gap. pg_timezone_names validates the stored zone; an unrecognized
  // value falls back to the column default rather than erroring the whole sweep.
  //
  // The status flip IS the dedupe: a given invitation is returned by exactly one
  // run, because the next run's `status = 'pending'` no longer matches it — so no
  // inviter is emailed twice, even if the job runs more than once a day or on
  // multiple instances. Invitations whose inviter account is missing or deleted
  // are neither flipped here nor emailed (no one to notify); the lazy accept
  // check still guards them. Cross-tenant sweep with no single tenant to scope
  // against → withAdminScope.
  async expireAndReturnPendingInvitations(): Promise<ExpiredInvitationRow[]> {
    const result = await withAdminScope(
      {
        caller: 'TenantMembersRepository.expireAndReturnPendingInvitations',
        reason: 'cross-tenant maintenance sweep: flip expired invitations and collect them for the inviter notification',
      },
      (client) => client.query<{
        tenant_id: string;
        invited_by: string;
        email: string;
        created_at: Date;
        inviter_email: string;
        inviter_first_name: string | null;
        tenant_name: string;
      }>(
        `WITH expired AS (
           UPDATE tenant_invitations ti
              SET status = 'expired', updated_at = NOW()
             FROM accounts inviter
             LEFT JOIN pg_timezone_names ptz ON ptz.name = inviter.timezone
            WHERE ti.invited_by = inviter.id
              AND inviter.deleted_at IS NULL
              AND ti.status = 'pending'
              AND ti.expires_at
                    < date_trunc('day', now() AT TIME ZONE COALESCE(ptz.name, 'America/Los_Angeles'))
                        AT TIME ZONE COALESCE(ptz.name, 'America/Los_Angeles')
          RETURNING ti.tenant_id, ti.invited_by, ti.email, ti.created_at,
                    inviter.email      AS inviter_email,
                    inviter.first_name AS inviter_first_name
         )
         SELECT e.tenant_id, e.invited_by, e.email, e.created_at,
                e.inviter_email, e.inviter_first_name,
                t.name AS tenant_name
           FROM expired e
           JOIN tenants t ON t.id = e.tenant_id
          ORDER BY e.invited_by, e.tenant_id, e.created_at`,
      ),
    );
    return result.rows.map((r) => ({
      tenantId: r.tenant_id,
      invitedBy: r.invited_by,
      inviteeEmail: r.email,
      invitedAt: r.created_at,
      inviterEmail: r.inviter_email,
      inviterFirstName: r.inviter_first_name,
      tenantName: r.tenant_name,
    }));
  }

  // Still-pending, not-yet-reminded invitations that are 2 to 3 days from expiry
  // (48-72h out), for the reminder sweep (jobs/invite-reminder-sweep.ts). The
  // lower bound matters: we deliberately do NOT remind inside 2 days, so a
  // recipient gets a comfortable lead instead of a same-day nudge (an invitation
  // already closer than that just expires, and its inviter gets the expiry
  // notice). It is a time-until-expiry window, not a day boundary, so no time
  // zone enters here. reminded_at IS NULL is the not-yet-reminded filter, and the
  // daily sweep lands exactly one run in the 24h-wide window; claimReminder sets
  // reminded_at. Cross-tenant sweep → withAdminScope.
  async findRemindableInvitations(): Promise<RemindableInvitation[]> {
    const result = await withAdminScope(
      {
        caller: 'TenantMembersRepository.findRemindableInvitations',
        reason: 'cross-tenant maintenance sweep: collect invitations nearing expiry to remind their recipients',
      },
      (client) => client.query<{
        id: string;
        email: string;
        tenant_id: string;
        tenant_name: string;
        inviter_first_name: string;
        inviter_last_name: string;
        inviter_email: string;
        expires_at: Date;
        inviter_timezone: string;
      }>(
        `SELECT ti.id, ti.email, ti.tenant_id, ti.expires_at,
                t.name             AS tenant_name,
                inviter.first_name AS inviter_first_name,
                inviter.last_name  AS inviter_last_name,
                inviter.email      AS inviter_email,
                inviter.timezone   AS inviter_timezone
           FROM tenant_invitations ti
           JOIN accounts inviter ON inviter.id = ti.invited_by AND inviter.deleted_at IS NULL
           JOIN tenants  t       ON t.id = ti.tenant_id
          WHERE ti.status = 'pending'
            AND ti.reminded_at IS NULL
            AND ti.expires_at > now() + INTERVAL '2 days'
            AND ti.expires_at <= now() + INTERVAL '3 days'
          ORDER BY ti.expires_at`,
      ),
    );
    return result.rows.map((r) => ({
      id: r.id,
      recipientEmail: r.email,
      tenantId: r.tenant_id,
      tenantName: r.tenant_name,
      inviterFirstName: r.inviter_first_name,
      inviterLastName: r.inviter_last_name,
      inviterEmail: r.inviter_email,
      expiresAt: r.expires_at,
      inviterTimezone: r.inviter_timezone,
    }));
  }

  // Atomically claim an invitation for its reminder: stamp reminded_at (the
  // dedupe) and store the reminder's OWN token hash alongside the untouched
  // original, so both accept links validate. Returns true if THIS call claimed
  // it, false if another run already did (reminded_at was not NULL) — the caller
  // sends the email only when it claimed. Cross-tenant → withAdminScope.
  async claimReminder(invitationId: string, reminderTokenHash: string): Promise<boolean> {
    const result = await withAdminScope(
      {
        caller: 'TenantMembersRepository.claimReminder',
        reason: 'cross-tenant maintenance sweep: mark an invitation reminded and store its reminder token hash',
      },
      (client) => client.query(
        `UPDATE tenant_invitations
            SET reminder_token_hash = $2, reminded_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND reminded_at IS NULL
          RETURNING id`,
        [invitationId, reminderTokenHash],
      ),
    );
    return (result.rowCount ?? 0) > 0;
  }

  async archiveOldInvitations(daysOld: number = 90): Promise<number> {
    // Cross-tenant maintenance sweep (all archivable invitations) → withAdminScope.
    const result = await withAdminScope(
      { caller: 'TenantMembersRepository.archiveOldInvitations', reason: 'cross-tenant maintenance sweep of archivable invitations' },
      (client) => client.query(
        `DELETE FROM tenant_invitations
       WHERE status IN ('expired', 'declined', 'revoked')
       AND updated_at < NOW() - INTERVAL '${daysOld} days'`
      ),
    );
    return result.rowCount || 0;
  }

  // Audit queries

  async createAuditEntry(data: {
    tenantId: string;
    accountId?: string;
    action: string;
    changes?: Record<string, unknown>;
    actorId?: string;
    previousState?: Record<string, unknown>;
    newState?: Record<string, unknown>;
  }): Promise<TenantMemberAudit> {
    const result = await withTenantScope(data.tenantId, (client) => client.query(
      `INSERT INTO tenant_member_audit (tenant_id, account_id, action, changes, actor_id, previous_state, new_state)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        data.tenantId,
        data.accountId || null,
        data.action,
        data.changes ? JSON.stringify(data.changes) : null,
        data.actorId || null,
        data.previousState ? JSON.stringify(data.previousState) : null,
        data.newState ? JSON.stringify(data.newState) : null,
      ]
    ));
    return this.mapAuditRow(result.rows[0]);
  }

  // Row mappers

  private mapMemberRow(row: Record<string, unknown>): TenantMember {
    return {
      id: row.id as string,
      tenantId: row.tenant_id as string,
      accountId: row.account_id as string,
      role: row.role as TenantMemberRole,
      invitedBy: row.invited_by as string | null,
      invitedAt: row.invited_at as Date | null,
      joinedAt: row.joined_at as Date,
      createdAt: row.created_at as Date,
      updatedAt: row.updated_at as Date,
    };
  }

  private mapMemberWithAccountRow(row: Record<string, unknown>): TenantMemberWithAccount {
    return {
      ...this.mapMemberRow(row),
      account: {
        id: row.account_id as string,
        firstName: row.first_name as string | null,
        lastName: row.last_name as string | null,
        email: row.email as string,
        avatarUrl: row.avatar_url as string | null,
      },
    };
  }

  private mapInvitationRow(row: Record<string, unknown>): TenantInvitation {
    return {
      id: row.id as string,
      tenantId: row.tenant_id as string,
      email: row.email as string,
      role: row.role as TenantMemberRole,
      inviteTokenHash: row.invite_token_hash as string,
      status: row.status as TenantInviteStatus,
      invitedBy: row.invited_by as string,
      expiresAt: row.expires_at as Date,
      acceptedAt: row.accepted_at as Date | null,
      accountId: row.account_id as string | null,
      createdAt: row.created_at as Date,
      updatedAt: row.updated_at as Date,
    };
  }

  private mapInvitationWithDetailsRow(row: Record<string, unknown>): TenantInvitationWithDetails {
    return {
      ...this.mapInvitationRow(row),
      tenantName: row.tenant_name as string,
      invitedByAccount: {
        id: row.inviter_id as string,
        firstName: row.inviter_first_name as string | null,
        lastName: row.inviter_last_name as string | null,
      },
    };
  }

  private mapAuditRow(row: Record<string, unknown>): TenantMemberAudit {
    return {
      id: row.id as string,
      tenantId: row.tenant_id as string,
      accountId: row.account_id as string | null,
      action: row.action as string,
      changes: row.changes as Record<string, unknown> | null,
      actorId: row.actor_id as string | null,
      previousState: row.previous_state as Record<string, unknown> | null,
      newState: row.new_state as Record<string, unknown> | null,
      createdAt: row.created_at as Date,
    };
  }

  // [SE-007] Pending ownership transfer queries

  async findPendingTransfer(tenantId: string): Promise<PendingOwnershipTransfer | null> {
    const result = await withTenantScope(tenantId, (client) => client.query(
      `SELECT * FROM pending_ownership_transfers
       WHERE tenant_id = $1 AND status = 'pending'`,
      [tenantId]
    ));
    return result.rows[0] ? this.mapPendingTransferRow(result.rows[0]) : null;
  }

  async findPendingTransferByToken(tokenHash: string): Promise<PendingOwnershipTransferWithDetails | null> {
    // Ownership-transfer confirmation by opaque token, before tenant scope is
    // established → withAdminScope.
    const result = await withAdminScope(
      { caller: 'TenantMembersRepository.findPendingTransferByToken', reason: 'pre-tenant-context ownership-transfer lookup by token hash' },
      (client) => client.query(
        `SELECT
        pot.*,
        t.name as tenant_name,
        co.id as current_owner_account_id,
        co.first_name as current_owner_first_name,
        co.last_name as current_owner_last_name,
        co.email as current_owner_email,
        no.id as new_owner_account_id,
        no.first_name as new_owner_first_name,
        no.last_name as new_owner_last_name,
        no.email as new_owner_email
       FROM pending_ownership_transfers pot
       JOIN tenants t ON pot.tenant_id = t.id
       JOIN accounts co ON pot.current_owner_id = co.id
       JOIN accounts no ON pot.new_owner_id = no.id
       WHERE pot.confirmation_token_hash = $1 AND pot.status = 'pending'`,
        [tokenHash]
      ),
    );
    return result.rows[0] ? this.mapPendingTransferWithDetailsRow(result.rows[0]) : null;
  }

  async createPendingTransfer(data: {
    tenantId: string;
    currentOwnerId: string;
    newOwnerId: string;
    confirmationTokenHash: string;
    expiresAt: Date;
  }): Promise<PendingOwnershipTransfer> {
    const result = await withTenantScope(data.tenantId, async (client) => {
      // Cancel any existing pending transfers for this tenant first
      await client.query(
        `UPDATE pending_ownership_transfers
       SET status = 'canceled', updated_at = NOW()
       WHERE tenant_id = $1 AND status = 'pending'`,
        [data.tenantId]
      );

      return client.query(
        `INSERT INTO pending_ownership_transfers
         (tenant_id, current_owner_id, new_owner_id, confirmation_token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
        [data.tenantId, data.currentOwnerId, data.newOwnerId, data.confirmationTokenHash, data.expiresAt]
      );
    });
    return this.mapPendingTransferRow(result.rows[0]);
  }

  async updatePendingTransferStatus(id: string, status: OwnershipTransferStatus): Promise<void> {
    // By-PK transfer status change (confirm/cancel), invoked from the
    // confirmation flow with no tenant scope → withAdminScope.
    await withAdminScope(
      { caller: 'TenantMembersRepository.updatePendingTransferStatus', reason: 'by-PK ownership-transfer status update (no tenant scope)' },
      (client) => client.query(
        `UPDATE pending_ownership_transfers
       SET status = $2, updated_at = NOW()
       WHERE id = $1`,
        [id, status]
      ),
    );
  }

  async expirePendingTransfers(): Promise<number> {
    // Cross-tenant maintenance sweep of expired transfers → withAdminScope.
    const result = await withAdminScope(
      { caller: 'TenantMembersRepository.expirePendingTransfers', reason: 'cross-tenant maintenance sweep of expired ownership transfers' },
      (client) => client.query(
        `UPDATE pending_ownership_transfers
       SET status = 'expired', updated_at = NOW()
       WHERE status = 'pending' AND expires_at < NOW()`
      ),
    );
    return result.rowCount || 0;
  }

  private mapPendingTransferRow(row: Record<string, unknown>): PendingOwnershipTransfer {
    return {
      id: row.id as string,
      tenantId: row.tenant_id as string,
      currentOwnerId: row.current_owner_id as string,
      newOwnerId: row.new_owner_id as string,
      confirmationTokenHash: row.confirmation_token_hash as string,
      status: row.status as OwnershipTransferStatus,
      expiresAt: row.expires_at as Date,
      createdAt: row.created_at as Date,
      updatedAt: row.updated_at as Date,
    };
  }

  private mapPendingTransferWithDetailsRow(row: Record<string, unknown>): PendingOwnershipTransferWithDetails {
    return {
      ...this.mapPendingTransferRow(row),
      tenantName: row.tenant_name as string,
      currentOwner: {
        id: row.current_owner_account_id as string,
        firstName: row.current_owner_first_name as string | null,
        lastName: row.current_owner_last_name as string | null,
        email: row.current_owner_email as string,
      },
      newOwner: {
        id: row.new_owner_account_id as string,
        firstName: row.new_owner_first_name as string | null,
        lastName: row.new_owner_last_name as string | null,
        email: row.new_owner_email as string,
      },
    };
  }
}

export const tenantMembersRepository = new TenantMembersRepository();
