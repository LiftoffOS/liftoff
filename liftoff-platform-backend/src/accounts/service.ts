// Account Service Implementation
// Per Section 1: Control plane owns accounts

import crypto from 'crypto';
import type { PoolClient } from 'pg';
import Stripe from 'stripe';
import { Account, AccountResponse, CreateAccountInput, UpdateAccountInput } from './types';
import { AccountRepository } from './repository';
import { SignupPreapprovalRepository } from './signup-preapprovals';
import { TenantRepository } from '../tenants/repository';
import { TenantMembersRepository } from '../tenant-members/repository';
import { isEmailDomainAllowed } from '../config/allowedDomains';
import { getStripeSecretKey } from '../infrastructure/secrets';
import { getBillingProvider } from '../billing/provider';
import { publishEvent, mutateAndPublishEvent, publishEventInTx } from '../events/publisher';
import { sendEmailVerification } from '../infrastructure/email';
import { log } from '../infrastructure/logging';
import { withAdminScope } from '../infrastructure/database';

// Result of a cascadeDelete call. dryRun=true → no actual deletes happened.
export interface CascadeDeleteSummary {
  dryRun: boolean;
  tenantsAffected: number;
  rowsByTable: Record<string, number>;
  memberRowsAcrossOtherTenants: number;
  // Per-column counts from the account-scoped FK sweep. Keys are
  // `${table}.${column}` (e.g. "subscriptions.account_id",
  // "tenant_members.invited_by"). Values are rows DELETEd (for NOT NULL
  // FKs) or UPDATEd to NULL (for NULLABLE FKs), or — under dryRun — the
  // matching row count without mutating.
  fkSweepCounts: Record<string, number>;
  accountRowDeleted: boolean;
  stripeCustomerDeleted: boolean;
  firebaseUserDeleted: boolean;
  // Soft-scrub additions (Phase 3). Optional so existing admin callers
  // (scrubMode='hard') see the same shape.
  stripeCustomerScrubbed?: boolean;
  deletionLedgerRowId?: string;
  connectorsRevoked?: number;
}

// Result of a reprovision call. Lists what was healed.
export interface ReprovisionSummary {
  accountId: string;
  stripeCustomerCreated: boolean;
  stripeCustomerId: string | null;
  tenantsReactivated: string[];
}

/**
 * Thrown by AccountService methods when the requested account row doesn't
 * exist. Admin endpoints catch this and respond 404 instead of the global
 * error handler's 500 default.
 */
export class AccountNotFoundError extends Error {
  readonly accountId: string;
  constructor(accountId: string) {
    super(`account ${accountId} not found`);
    this.name = 'AccountNotFoundError';
    this.accountId = accountId;
  }
}

let stripe: Stripe | null = null;

async function getStripe(): Promise<Stripe> {
  if (!stripe) {
    const secretKey = await getStripeSecretKey();
    stripe = new Stripe(secretKey);
  }
  return stripe;
}

export class AccountService {
  private repository = new AccountRepository();
  private tenantRepo = new TenantRepository();
  private tenantMembersRepo = new TenantMembersRepository();
  private preapprovalRepo = new SignupPreapprovalRepository();

  async create(input: CreateAccountInput): Promise<Account> {
    // Stripe-first pattern: generate the account UUID client-side so the
    // Stripe customer can carry the final accountId in metadata in a single
    // API call, then INSERT account + stripe_customer_id atomically.
    //
    // Re-signup customer reuse (Phase 6): before creating a new Stripe
    // customer, look up any soft-scrubbed customer whose
    // metadata.email_sha256 matches this new signup's email hash. If one
    // exists, re-attach PII to the prior customer (preserving the deletion
    // hashes) and reuse its ID. This keeps Stripe-native abuse heuristics
    // (times_redeemed, Radar fingerprints) anchored to the same customer
    // across delete-and-resignup cycles.
    //
    // Failure modes:
    //   - Stripe call throws → no DB write, function throws.
    //     Caller can retry; no orphans created.
    //   - DB INSERT throws after Stripe succeeded → compensating
    //     stripe.customers.del (new customers only) / metadata clear-down
    //     is intentionally NOT performed when reusing — the prior customer
    //     remains a soft-scrubbed tombstone for the next retry.
    const accountId = crypto.randomUUID();

    const { hashEmail } = await import('./hashing');
    const billing = getBillingProvider();
    const { customerId, createdFresh: createdFreshCustomer } = await billing.ensureCustomer({
      accountId,
      email: input.email,
      name: `${input.firstName} ${input.lastName}`,
      firebaseUid: input.firebaseUid,
      emailHash: hashEmail(input.email),
    });

    let account: Account;
    try {
      // Canonical pattern (plan §5.4): INSERT accounts + enqueue
      // account.created outbox row in the same tx; publish inline post-commit.
      // If either step fails, the Stripe customer is cleaned up (compensating
      // action below) and the caller sees the error.
      account = await mutateAndPublishEvent<Account>(
        { caller: 'AccountService.create', actor: accountId, reason: 'create account + account.created event' },
        async (client) => {
          // Guest list (migration 341). An address an admin cleared BEFORE
          // signup is spent here, so the row is born 'approved' and the person
          // walks into the product instead of bouncing off /request-invite.
          //
          // Lookup, INSERT and consume share this transaction on purpose: if
          // any step fails the entry stays live and the next attempt spends it,
          // rather than the entry being burned by a signup that never landed.
          const preapproval = await this.preapprovalRepo.findLiveByEmail(client, input.email);
          const a = await this.repository.createInTx(client, {
            ...input,
            id: accountId,
            stripeCustomerId: customerId,
            ...(preapproval
              ? { accessStatus: 'approved' as const, accessDecidedBy: preapproval.addedBy }
              : {}),
          });
          if (preapproval) {
            await this.preapprovalRepo.consumeInTx(client, preapproval.id, a.id);
            log.info(
              { accountId: a.id, preapprovalId: preapproval.id },
              'AccountService.create: signup spent a pre-approval — account born approved',
            );
          }
          return {
            entity: a,
            eventInput: {
              entityType: 'account',
              entityId: a.id,
              eventType: 'account.created',
              entityVersion: a.version,
              eventVersion: 1,
              payload: {
                firstName: a.firstName,
                lastName: a.lastName,
                email: a.email,
                stripeCustomerId: customerId,
              },
            },
          };
        },
      );
    } catch (err) {
      // Compensating action: only delete the Stripe customer if we just
      // created it — reused tombstones must remain so the next retry can
      // find them again.
      if (createdFreshCustomer && customerId) {
        await billing.discardCustomer(customerId);
      }
      throw err;
    }

    return account;
  }

  // Compute access decision for an account
  async computeAccess(account: Account): Promise<{ accessGranted: boolean; accessReason: 'domain' | 'approved' | 'invitation' | null }> {
    // Short-circuit: whitelisted domain — skip membership query
    if (isEmailDomainAllowed(account.email)) {
      return { accessGranted: true, accessReason: 'domain' };
    }

    // Email-level whitelist: an admin explicitly approved this specific signup
    // (accounts.access_status; migration 304). No extra query — the status rides
    // on the already-loaded account row.
    if (account.accessStatus === 'approved') {
      return { accessGranted: true, accessReason: 'approved' };
    }

    // Check for non-owner membership (invitation-based access)
    const hasInvitation = await this.tenantMembersRepo.hasNonOwnerMembership(account.id);
    if (hasInvitation) {
      return { accessGranted: true, accessReason: 'invitation' };
    }

    return { accessGranted: false, accessReason: null };
  }

  // Build account response with access fields
  // Uses req.accessGranted from gate middleware if available, otherwise computes fresh
  async toResponse(account: Account, cachedAccess?: { accessGranted: boolean; accessReason: 'domain' | 'approved' | 'invitation' | null }): Promise<AccountResponse> {
    const access = cachedAccess ?? await this.computeAccess(account);
    return {
      ...account,
      accessGranted: access.accessGranted,
      accessReason: access.accessReason,
    };
  }

  async getById(id: string): Promise<Account | null> {
    return this.repository.findById(id);
  }

  async getByEmail(email: string): Promise<Account | null> {
    return this.repository.findByEmail(email);
  }

  async getByFirebaseUid(firebaseUid: string): Promise<Account | null> {
    return this.repository.findByFirebaseUid(firebaseUid);
  }

  async listAll(): Promise<Account[]> {
    return this.repository.findAll();
  }

  async update(id: string, input: UpdateAccountInput): Promise<Account> {
    const account = await this.repository.update(id, input);

    // Update Stripe customer if name changed
    if ((input.firstName || input.lastName) && account.stripeCustomerId) {
      const stripeClient = await getStripe();
      await stripeClient.customers.update(account.stripeCustomerId, {
        name: `${account.firstName} ${account.lastName}`,
      });
    }

    // Update personal workspace name if firstName changed
    // Personal workspace = tenant where account_id matches (tenant created by this account)
    if (input.firstName) {
      try {
        const tenants = await this.tenantRepo.findByAccountId(id);
        // Should only be one tenant per account (personal workspace)
        // but iterate just in case
        for (const tenant of tenants) {
          const newName = `${account.firstName}'s Workspace`;
          await this.tenantRepo.updateName(tenant.id, newName);
          log.info({ tenantId: tenant.id, accountId: id, newName }, 'Updated personal workspace name');
        }
      } catch (error) {
        // Don't fail account update if workspace name update fails
        log.error({ error, accountId: id }, 'Failed to update personal workspace name');
      }
    }

    await publishEvent({
      entityType: 'account',
      entityId: account.id,
      eventType: 'account.updated',
      entityVersion: account.version,
      eventVersion: 1,
      payload: {
        firstName: account.firstName,
        lastName: account.lastName,
        email: account.email,
        timezone: account.timezone,
      },
    });

    return account;
  }

  async initiateEmailChange(id: string, newEmail: string, baseUrl: string): Promise<void> {
    // Check if new email domain is whitelisted
    if (!isEmailDomainAllowed(newEmail)) {
      throw new Error('Email must use a company domain');
    }

    // Check if email is already in use
    const existingAccount = await this.repository.findByEmail(newEmail);
    if (existingAccount && existingAccount.id !== id) {
      throw new Error('Email address is already in use');
    }

    // Get the account for the name
    const account = await this.repository.findById(id);
    if (!account) {
      throw new Error(`Account not found: ${id}`);
    }

    // Generate verification token
    const verificationToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    // Store pending email change
    await this.repository.setPendingEmailChange(id, newEmail, verificationToken, expiresAt);

    // Send verification email
    const verificationUrl = `${baseUrl}/verify-email?token=${verificationToken}`;
    await sendEmailVerification(newEmail, verificationUrl, account.firstName);
  }

  async confirmEmailChange(token: string): Promise<Account> {
    // Find account by token
    const account = await this.repository.findByVerificationToken(token);
    if (!account) {
      throw new Error('Invalid or expired verification token');
    }

    if (!account.pendingEmail) {
      throw new Error('No pending email change');
    }

    // Re-validate domain whitelist (may have changed since initiation)
    if (!isEmailDomainAllowed(account.pendingEmail)) {
      await this.repository.cancelPendingEmailChange(account.id);
      throw new Error('Email domain is no longer allowed');
    }

    // Update email
    const updatedAccount = await this.repository.confirmEmailChange(account.id);

    // Update Stripe customer email
    if (updatedAccount.stripeCustomerId) {
      const stripeClient = await getStripe();
      await stripeClient.customers.update(updatedAccount.stripeCustomerId, {
        email: updatedAccount.email,
      });
    }

    await publishEvent({
      entityType: 'account',
      entityId: updatedAccount.id,
      eventType: 'account.email_changed',
      entityVersion: updatedAccount.version,
      eventVersion: 1,
      payload: {
        email: updatedAccount.email,
      },
    });

    return updatedAccount;
  }

  async cancelEmailChange(id: string): Promise<Account> {
    return this.repository.cancelPendingEmailChange(id);
  }

  async delete(id: string, deletedBy: string): Promise<boolean> {
    // Get account to check if it exists and get Stripe customer ID
    const account = await this.repository.findById(id);
    if (!account) {
      return false;
    }

    // Soft delete account in database
    const deleted = await this.repository.softDelete(id, deletedBy);
    if (!deleted) {
      return false;
    }

    // Close the sign-in. Marking the row stops the API resolving this
    // account, but it does not touch the identity provider, so without this
    // the person could still authenticate with Firebase and arrive at an
    // application where every call 404s - signed in to a deleted account.
    //
    // Both halves are needed and they do different things: revoking the
    // refresh tokens ends sessions that already exist (verifyIdToken runs
    // with checkRevoked), and disabling the user stops a NEW sign-in. The
    // user is disabled rather than deleted because the grace period is meant
    // to be reversible; the purge deletes the identity when it runs the full
    // cascade.
    //
    // Best-effort: the account is already unreachable through the API, so an
    // identity-provider outage must not leave it undeleted. The failure is
    // logged at error, and the purge is the backstop.
    if (account.firebaseUid) {
      try {
        const { isFirebaseInitialized, initFirebase } = await import('../infrastructure/firebase');
        if (!isFirebaseInitialized()) await initFirebase();
        const { getAuth } = await import('firebase-admin/auth');
        await getAuth().revokeRefreshTokens(account.firebaseUid);
        await getAuth().updateUser(account.firebaseUid, { disabled: true });
      } catch (err) {
        log.error(
          { accountId: id, error: (err as Error).message },
          'delete: could not close the sign-in for a deleted account — it can still authenticate '
          + 'until the purge cascade runs, though the API will refuse it',
        );
      }
    }

    // Archive Stripe customer (don't hard delete to preserve invoice history)
    if (account.stripeCustomerId) {
      const stripeClient = await getStripe();
      await stripeClient.customers.update(account.stripeCustomerId, {
        metadata: {
          accountId: id,
          deletedAt: new Date().toISOString(),
          deletedBy,
        },
      });
    }

    await publishEvent({
      entityType: 'account',
      entityId: id,
      eventType: 'account.deleted',
      entityVersion: account.version + 1,
      eventVersion: 1,
      payload: {
        deletedBy,
      },
    });

    return true;
  }

  /**
   * Hard-delete an account and every workspace it owns. Used by the admin
   * endpoint DELETE /api/admin/accounts/:id?cascade=true. Cascades:
   *   1. For each tenant where this account is owner: delete every row in
   *      every table with a tenant_id column (enumerated at runtime from
   *      information_schema), then the tenant row.
   *   2. Delete tenant_members where this account is a non-owner member of
   *      other tenants.
   *   3. Delete Stripe customer (if any).
   *   4. Delete Firebase Auth user.
   *   5. Delete the account row.
   *
   * In dry-run mode, the transaction ROLLBACKs (no DB mutations), Stripe
   * and Firebase steps are SKIPPED, and the returned counts reflect what
   * *would* have been deleted.
   *
   * Uses topological FK ordering (children deleted before parents) — no
   * SUPERUSER or session_replication_role override needed.
   */
  async cascadeDelete(
    accountId: string,
    actor: string,
    opts: {
      dryRun: boolean;
      // 'hard' (default) preserves the existing admin behavior: delete the
      // Stripe customer + Firebase user outright. 'soft' is the user-
      // initiated path: strip PII on the Stripe customer, write a
      // tombstone row to accounts_deletion_ledger, still delete the
      // Firebase user (the email_sha256 ledger enforces abuse prevention).
      scrubMode?: 'hard' | 'soft';
      // Informational, audit-log only. true when the deletion was kicked
      // off by the account-holder themselves (DELETE /api/accounts/me).
      actorIsAccount?: boolean;
    } = { dryRun: false },
  ): Promise<CascadeDeleteSummary> {
    const account = await this.repository.findById(accountId);
    if (!account) {
      throw new AccountNotFoundError(accountId);
    }

    // Step 1+2 in one transaction: delete tenant-scoped data + cross-tenant
    // memberships, but NOT the account row yet. Account row stays alive until
    // Stripe + Firebase have been cleaned up, so re-running this endpoint can
    // retry the external deletions using the account's stored stripe_customer_id
    // and firebase_uid. Plan section 2.5: account row last.
    // NOTE: withAdminScope (packages/database/src/tenant-scope.ts) owns the
    // transaction — BEGIN before the callback, COMMIT on success, ROLLBACK
    // on thrown errors. Do NOT issue an inner BEGIN/COMMIT/ROLLBACK here
    // (it would prematurely close the wrapper's tx and defeat the
    // ROLLBACK-on-error guarantee).
    //
    // Dry-run behaviour: every statement inside the callback below is a SELECT
    // (the dry-run branches of countOrDeleteTenantData / the cross-tenant
    // membership count). The wrapper's COMMIT is therefore harmless — no
    // mutations exist to commit.
    // Capture owned tenant IDs in outer scope so the connector-revoke loop +
    // soft-scrub tenantIds (Phase 3) can reference them AFTER the dbSummary
    // block has already deleted the tenants. Re-querying after the cascade
    // would yield an empty result.
    const capturedOwnedTenantIds: string[] = [];

    const dbSummary = await withAdminScope(
      {
        caller: 'AccountService.cascadeDelete',
        actor,
        reason: opts.dryRun ? 'dry-run' : 'cascade delete (DB rows)',
      },
      async (client) => {
        // Owned-workspace enumeration is anchored in tenant_members.role='owner',
        // not tenants.account_id. The latter is the *creator* and never moves
        // when ownership is transferred (TenantMembersService.transferOwnership
        // updates tenant_members rows only). Joining on tenant_members catches
        // workspaces that were transferred to this user; without it, the
        // demote-then-cascade trick below fails to fire for those workspaces
        // and `DELETE FROM tenant_members WHERE account_id = $1` later trips
        // the `prevent_last_owner_removal` trigger.
        const owned = await client.query<{ id: string }>(
          `SELECT DISTINCT t.id
             FROM tenants t
             JOIN tenant_members tm ON tm.tenant_id = t.id
            WHERE tm.account_id = $1 AND tm.role = 'owner'`,
          [accountId],
        );
        capturedOwnedTenantIds.push(...owned.rows.map(r => r.id));

        // F9: enumerate tables + FK topology ONCE, reuse across every owned
        // tenant. Previously this fired three pg_catalog queries per tenant
        // inside the loop.
        const tableOrder = owned.rows.length > 0
          ? await this.computeTenantTableOrder(client)
          : [];

        const perTableCounts: Record<string, number> = {};
        for (const t of owned.rows) {
          // Demote owners to 'member' on owned tenants before the topological
          // delete. The `prevent_last_owner_removal` BEFORE-DELETE trigger
          // (function check_last_owner) blocks deletion of the last owner —
          // a correct safety net for normal mutations, but it fires per-row
          // and doesn't recognize that the entire tenant is being cascaded
          // away. Demoting first turns owner→member, the trigger only blocks
          // OLD.role='owner', so the subsequent DELETE proceeds. The whole
          // operation is in a single withAdminScope transaction; if anything
          // throws, the demotion rolls back too.
          if (!opts.dryRun) {
            await client.query(
              `UPDATE tenant_members SET role = 'member' WHERE tenant_id = $1 AND role = 'owner'`,
              [t.id],
            );
          }
          const tableCounts = await this.countOrDeleteTenantData(
            client, t.id, opts.dryRun, tableOrder,
          );
          for (const [tbl, n] of Object.entries(tableCounts)) {
            perTableCounts[tbl] = (perTableCounts[tbl] ?? 0) + n;
          }
          // Enqueue `tenant.deleted` in the same transaction as the row delete
          // so the event is atomically bound to the cascade. tenant-runtime
          // subscribes and scrubs vendor sessions / identities.
          //
          // tenantId is intentionally null: control_plane_outbox.tenant_id has
          // a FK to tenants(id) ON DELETE CASCADE. Setting it to t.id here
          // would either fail the insert (FK violation, because countOrDeleteTenantData
          // above already removed the tenants row) or, if reordered, cascade
          // the just-enqueued outbox row away with the tenant. entity_id
          // already carries the tenant uuid for the consumer to act on.
          if (!opts.dryRun) {
            await publishEventInTx(client, {
              entityType: 'tenant',
              entityId: t.id,
              eventType: 'tenant.deleted',
              entityVersion: 1,
              eventVersion: 1,
              tenantId: null,
              payload: { actor, scrubMode: opts.scrubMode ?? 'hard', tenantId: t.id },
            });
          }
        }

        // Memberships in OTHER tenants (where this account is a member but not owner).
        // Owned-tenant memberships are handled by step 1's per-tenant cleanup.
        const memDel = opts.dryRun
          ? (await client.query<{ n: number }>(
              `SELECT COUNT(*)::int AS n FROM tenant_members tm
               WHERE tm.account_id = $1
                 AND NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = tm.tenant_id AND t.account_id = $1)`,
              [accountId],
            )).rows[0].n
          : (await client.query(
              `DELETE FROM tenant_members WHERE account_id = $1`,
              [accountId],
            )).rowCount ?? 0;

        // F12: Account-scoped FK sweep. Every NO-ACTION/RESTRICT FK referencing
        // accounts(id) — there are ~25 such columns across ~20 tables (subscriptions,
        // subscription_items, billing_controls, enterprise_contracts, staff_roles,
        // tenant_members.invited_by, admin_action_audit.admin_id, the various
        // *_audit.actor_id columns, etc.) — would block the final account row
        // delete with a 23503 FK violation otherwise. Discovery is dynamic so
        // future FK additions Just Work without a code change. Policy:
        //
        //   • NOT NULL FK column  → DELETE the dependent row
        //       (the row depends on the account existing: account's own
        //        subscription and billing controls rows)
        //   • NULLABLE FK column  → UPDATE the column to NULL, keep the row
        //       (the column is an actor reference; the row is still
        //        meaningful — e.g. admin_action_audit.admin_id, the audit
        //        record of a past action; we preserve history with the
        //        actor anonymized)
        //
        // ON DELETE CASCADE / SET NULL FKs are excluded — they handle themselves
        // when the accounts row finally deletes. Only confdeltype IN ('a','r')
        // need this manual sweep.
        //
        // Special case: `tenants.account_id` (NOT NULL, NO ACTION) is the
        // *creator* column. The per-tenant loop above already deleted tenants
        // this account currently *owns* (via tenant_members.role='owner'). Any
        // surviving rows pointing back at this account belong to workspaces
        // that were transferred to someone else — TenantMembersService.transferOwnership
        // updates tenant_members but never tenants.account_id. Wiping those
        // tenants would destroy innocent workspaces. So we skip the FK and
        // throw downstream if any such rows remain (operator must transfer
        // creator metadata before deleting the account).
        const fkRefs = (await client.query<{
          table_name: string;
          column_name: string;
          is_nullable: boolean;
        }>(`
          SELECT
            cl.relname  AS table_name,
            a.attname   AS column_name,
            NOT a.attnotnull AS is_nullable
          FROM pg_constraint c
          JOIN pg_class cl ON cl.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = cl.relnamespace
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
          WHERE c.contype = 'f'
            AND c.confrelid = 'public.accounts'::regclass
            AND n.nspname = 'public'
            AND c.confdeltype IN ('a','r')
            AND array_length(c.conkey, 1) = 1
        `)).rows;

        const fkSweepCounts: Record<string, number> = {};
        for (const fk of fkRefs) {
          // tenants.account_id: see special-case note above.
          if (fk.table_name === 'tenants' && fk.column_name === 'account_id') {
            continue;
          }
          const key = `${fk.table_name}.${fk.column_name}`;
          if (opts.dryRun) {
            const r = await client.query<{ n: number }>(
              `SELECT COUNT(*)::int AS n FROM ${quoteIdent(fk.table_name)} WHERE ${quoteIdent(fk.column_name)} = $1`,
              [accountId],
            );
            fkSweepCounts[key] = r.rows[0].n;
          } else if (fk.is_nullable) {
            const r = await client.query(
              `UPDATE ${quoteIdent(fk.table_name)} SET ${quoteIdent(fk.column_name)} = NULL WHERE ${quoteIdent(fk.column_name)} = $1`,
              [accountId],
            );
            fkSweepCounts[key] = r.rowCount ?? 0;
          } else {
            const r = await client.query(
              `DELETE FROM ${quoteIdent(fk.table_name)} WHERE ${quoteIdent(fk.column_name)} = $1`,
              [accountId],
            );
            fkSweepCounts[key] = r.rowCount ?? 0;
          }
        }

        // tenants.account_id residual check (creator orphans). Run in both
        // dry-run and real mode so the operator sees the problem before the
        // real cascade gets partway and stalls.
        const creatorOrphans = (await client.query<{ n: number }>(
          `SELECT COUNT(*)::int AS n FROM tenants WHERE account_id = $1`,
          [accountId],
        )).rows[0].n;
        if (creatorOrphans > 0) {
          throw new Error(
            `cascadeDelete: account ${accountId} is the creator (tenants.account_id) of ${creatorOrphans} tenant(s) ` +
            `that are owned by other accounts. Transfer creator metadata before deletion ` +
            `(UPDATE tenants SET account_id = <new_owner> WHERE account_id = '${accountId}').`,
          );
        }

        return {
          tenantsAffected: owned.rows.length,
          rowsByTable: perTableCounts,
          memberRowsAcrossOtherTenants: memDel,
          fkSweepCounts,
        };
      },
    );

    if (opts.dryRun) {
      // Dry-run: no Stripe/Firebase calls. The account row count is what
      // *would* be deleted in step 5.
      return {
        dryRun: true,
        ...dbSummary,
        accountRowDeleted: false,
        stripeCustomerDeleted: false,
        firebaseUserDeleted: false,
      };
    }

    const scrubMode: 'hard' | 'soft' = opts.scrubMode ?? 'hard';

    // Step 2.5: Connector enumeration + revoke. Fires under BOTH scrub modes
    // so admin-initiated deletions also revoke third-party OAuth grants.
    // Iterates the IDs captured before the cascade ran — re-querying now would
    // miss everything because the tenants table has already been emptied.
    // Best-effort: failures logged, deletion continues.
    let connectorsRevoked = 0;
    if (capturedOwnedTenantIds.length > 0) {
      const { listConnectorsForTenant, deleteConnectorForTenant } =
        await import('../connectors/connector-service-client');
      for (const tenantId of capturedOwnedTenantIds) {
        try {
          const conns = await listConnectorsForTenant(tenantId, accountId);
          for (const c of conns) {
            try {
              await deleteConnectorForTenant(c.id, accountId);
              connectorsRevoked += 1;
            } catch (err) {
              log.warn(
                { accountId, tenantId, connectorId: c.id, error: (err as Error).message },
                'cascadeDelete: connector delete failed (non-fatal)',
              );
            }
          }
        } catch (err) {
          log.warn(
            { accountId, tenantId, error: (err as Error).message },
            'cascadeDelete: connector enumeration failed (non-fatal)',
          );
        }
      }
    }

    // Step 3: Stripe customer. If this fails, the account row is still alive,
    // operator can retry by re-running the endpoint.
    //
    // L-6 retry-safety: classify "not found" errors as success. After a partial
    // success (Firebase/Stripe deleted but DB tx crashed before the account row
    // delete), the next retry MUST treat the external resource as
    // already-deleted instead of preserving the account row forever. Stripe
    // signals this with `code='resource_missing'`; Firebase signals it with
    // `code='auth/user-not-found'`. All other errors keep the prior contract
    // (preserve the account row for retry).
    let stripeCustomerDeleted = false;
    let stripeCustomerScrubbed = false;
    let deletionLedgerRowId: string | undefined;

    if (scrubMode === 'hard') {
      if (account.stripeCustomerId) {
        try {
          const stripeClient = await getStripe();
          await stripeClient.customers.del(account.stripeCustomerId);
          stripeCustomerDeleted = true;
        } catch (err) {
          const stripeCode = (err as { code?: string; rawType?: string }).code;
          if (stripeCode === 'resource_missing') {
            log.info(
              { accountId, stripeCustomerId: account.stripeCustomerId },
              'cascadeDelete: Stripe customer already deleted — treating as success (idempotent retry)',
            );
            stripeCustomerDeleted = true;
          } else {
            log.error(
              { accountId, stripeCustomerId: account.stripeCustomerId, error: (err as Error).message, stripeCode },
              'cascadeDelete: Stripe customer deletion failed — account row preserved for retry',
            );
          }
        }
      } else {
        stripeCustomerDeleted = true;  // nothing to delete
      }
    } else {
      // scrubMode === 'soft' — strip PII via billing scrub + write ledger row.
      if (account.stripeCustomerId) {
        const { hashEmail } = await import('./hashing');
        const emailHash = hashEmail(account.email);
        // Account type has no phone column today; phone_sha256 stays NULL.
        const phoneHash: string | undefined = undefined;

        // Use the IDs captured before the DB cascade — the tenants table is
        // empty by this point, so a fresh query against tenant_members would
        // return nothing.
        const tenantIds = capturedOwnedTenantIds;

        try {
          const { getBillingAdminClient } = await import('../billing/billing-admin-client');
          await getBillingAdminClient().scrubCustomer(account.stripeCustomerId, {
            emailHash, phoneHash, accountId, tenantIds,
          });
          stripeCustomerScrubbed = true;
        } catch (err) {
          log.error(
            { accountId, error: (err as Error).message },
            'cascadeDelete: billing scrub failed — account row preserved for retry',
          );
        }

        if (stripeCustomerScrubbed) {
          const r = await this.repository.insertDeletionLedger({
            emailHash,
            phoneHash,
            stripeCustomerId: account.stripeCustomerId,
          });
          deletionLedgerRowId = r.id;
        }
      } else {
        stripeCustomerScrubbed = true; // nothing to scrub
      }
    }

    // Step 3b: Session revocation. Fires under BOTH scrub modes so other open
    // tabs / devices for this user lose their session on next API call. The
    // existing "Log out of all devices" path uses the same call; piping it
    // here means the deletion-success caller doesn't have to invoke it
    // separately.
    if (account.firebaseUid) {
      try {
        const { isFirebaseInitialized, initFirebase } = await import('../infrastructure/firebase');
        if (!isFirebaseInitialized()) await initFirebase();
        const { getAuth } = await import('firebase-admin/auth');
        await getAuth().revokeRefreshTokens(account.firebaseUid);
      } catch (err) {
        log.warn(
          { accountId, error: (err as Error).message },
          'cascadeDelete: revokeRefreshTokens failed (non-fatal)',
        );
      }
    }

    // Step 4: Firebase user. Same retry-friendly contract. Fires under BOTH
    // scrub modes — in the soft-scrub path, the email_sha256 row in
    // accounts_deletion_ledger is what enforces abuse prevention on re-signup;
    // the Firebase user being absent lets the email re-register cleanly.
    //
    // Lazy-init Firebase Admin if not already done. The main HTTP server
    // calls initFirebase() at startup, but one-off Cloud Run Jobs that
    // invoke cascadeDelete directly (via `node -e`) skip that bootstrap.
    // The check is no-op when Firebase is already initialized.
    let firebaseUserDeleted = false;
    if (account.firebaseUid) {
      try {
        const { isFirebaseInitialized, initFirebase } = await import('../infrastructure/firebase');
        if (!isFirebaseInitialized()) {
          await initFirebase();
        }
        const { getAuth } = await import('firebase-admin/auth');
        await getAuth().deleteUser(account.firebaseUid);
        firebaseUserDeleted = true;
      } catch (err) {
        const firebaseCode = (err as { code?: string }).code;
        if (firebaseCode === 'auth/user-not-found') {
          log.info(
            { accountId, firebaseUid: account.firebaseUid },
            'cascadeDelete: Firebase user already deleted — treating as success (idempotent retry)',
          );
          firebaseUserDeleted = true;
        } else {
          log.error(
            { accountId, firebaseUid: account.firebaseUid, error: (err as Error).message, firebaseCode },
            'cascadeDelete: Firebase user deletion failed — account row preserved for retry',
          );
        }
      }
    } else {
      firebaseUserDeleted = true;  // nothing to delete
    }

    // Step 5: Account row last. Only delete if external cleanup
    // (hard-delete OR soft-scrub) + Firebase both succeeded. Otherwise
    // leave the row alive for the next retry.
    //
    // Wrap the DELETE in mutateAndPublishEvent so an account.deleted outbox
    // row commits with the row delete (mirrors the create-side pattern
    // upstream).
    let accountRowDeleted = false;
    const externalOk = scrubMode === 'hard' ? stripeCustomerDeleted : stripeCustomerScrubbed;
    if (externalOk && firebaseUserDeleted) {
      accountRowDeleted = await mutateAndPublishEvent<boolean>(
        {
          caller: 'AccountService.cascadeDelete',
          actor,
          reason: 'delete account row + emit account.deleted',
        },
        async (client) => {
          const r = await client.query(`DELETE FROM accounts WHERE id = $1`, [accountId]);
          const deleted = (r.rowCount ?? 0) === 1;
          return {
            entity: deleted,
            eventInput: {
              entityType: 'account',
              entityId: accountId,
              eventType: 'account.deleted',
              entityVersion: 1,
              eventVersion: 1,
              payload: {
                stripeCustomerId: account.stripeCustomerId ?? null,
                scrubMode,
                deletionLedgerRowId: deletionLedgerRowId ?? null,
                actorIsAccount: opts.actorIsAccount === true,
              },
            },
          };
        },
      );
    } else {
      log.warn(
        { accountId, scrubMode, stripeCustomerDeleted, stripeCustomerScrubbed, firebaseUserDeleted },
        'cascadeDelete: external cleanup incomplete — account row preserved',
      );
    }

    return {
      dryRun: false,
      ...dbSummary,
      accountRowDeleted,
      stripeCustomerDeleted,
      firebaseUserDeleted,
      stripeCustomerScrubbed,
      deletionLedgerRowId,
      connectorsRevoked,
    };
  }

  /**
   * Enumerate all tenant-scoped tables and topologically sort them
   * children-first. Pulled out of countOrDeleteTenantData so cascadeDelete
   * runs the three pg_catalog queries once across N owned tenants instead
   * of N times.
   *
   * Implementation:
   *   1. Enumerate all tables with a tenant_id column from information_schema.
   *   2. Drop partition children (DELETE on the parent cascades).
   *   3. Enumerate FK edges via pg_constraint (information_schema's
   *      constraint_column_usage is unreliable: under multi-column FKs it
   *      returns column rows that may not correspond to the constrained
   *      table, leading to phantom edges. pg_constraint joins the child
   *      and parent class OIDs directly).
   *   4. Topological sort (Kahn's algorithm): children first, parents last.
   *      Tables with no incoming child→parent edges are emitted first so
   *      they get DELETEd before the rows they reference.
   *
   * Cycles in the FK graph (which shouldn't exist) throw a loud error.
   */
  private async computeTenantTableOrder(client: PoolClient): Promise<string[]> {
    // Filter to BASE TABLE (and partitioned-table parents) only. Excluding
    // views is critical: a view like `active_prompt_rollouts` is built over
    // a base table that has tenant_id, so information_schema.columns lists
    // it — but DELETE FROM <view> raises `cannot delete from view`. Joining
    // information_schema.tables narrows to relkind in ('r','p') equivalents.
    const tables = (await client.query<{ table_name: string }>(`
      SELECT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public'
        AND c.column_name = 'tenant_id'
        AND t.table_type = 'BASE TABLE'
    `)).rows.map((r) => r.table_name);

    const partitions = new Set((await client.query<{ partition: string }>(`
      SELECT c.relname AS partition
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
    `)).rows.map((r) => r.partition));

    const eligibleTables = tables.filter((t) => !partitions.has(t) && t !== 'tenants');

    // FK edges via pg_constraint. Each constraint with contype='f' has
    // exactly one (conrelid, confrelid) — the child and parent relation
    // OIDs. No multi-column FK fan-out, no false positives.
    //
    // Schema-filter both endpoints to 'public' — pg_class is global across
    // schemas and a same-named table in (e.g.) the migrations schema would
    // otherwise inject phantom edges. The eligibleTables list itself came
    // from information_schema filtered to schema='public', so the join must
    // be schema-aligned to stay consistent.
    const fks = (await client.query<{ child: string; parent: string }>(`
      SELECT cl.relname AS child, pl.relname AS parent
      FROM pg_constraint c
      JOIN pg_class cl ON cl.oid = c.conrelid
      JOIN pg_class pl ON pl.oid = c.confrelid
      JOIN pg_namespace ns_c ON ns_c.oid = cl.relnamespace
      JOIN pg_namespace ns_p ON ns_p.oid = pl.relnamespace
      WHERE c.contype = 'f'
        AND ns_c.nspname = 'public'
        AND ns_p.nspname = 'public'
        AND cl.relname = ANY($1::text[])
        AND pl.relname = ANY($1::text[])
    `, [eligibleTables])).rows;

    return topologicalChildrenFirst(eligibleTables, fks);
  }

  /**
   * Delete (or count, if dryRun) every row in every table with a tenant_id
   * column where tenant_id matches. Caller supplies the precomputed order
   * (children before parents) so we don't re-query pg_catalog per tenant.
   * Finally DELETE FROM tenants WHERE id = $1 (or count it).
   */
  private async countOrDeleteTenantData(
    client: PoolClient,
    tenantId: string,
    dryRun: boolean,
    order: string[],
  ): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const table of order) {
      if (dryRun) {
        const r = await client.query<{ n: number }>(
          `SELECT COUNT(*)::int AS n FROM ${quoteIdent(table)} WHERE tenant_id = $1`,
          [tenantId],
        );
        counts[table] = r.rows[0].n;
      } else {
        const r = await client.query(
          `DELETE FROM ${quoteIdent(table)} WHERE tenant_id = $1`,
          [tenantId],
        );
        counts[table] = r.rowCount ?? 0;
      }
    }

    if (dryRun) {
      counts['tenants'] = 1;
    } else {
      const r = await client.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
      counts['tenants'] = r.rowCount ?? 0;
    }
    return counts;
  }

  /**
   * Heal an account that was orphaned by the pre-fix provisioning chain:
   * (a) create a Stripe customer if accounts.stripe_customer_id is NULL;
   * (b) for each tenant owned by the account that is still `pending` or
   *     missing billing_controls, invoke tenantService.activate() — the new
   *     synchronous chain creates the subscription via billing-admin-client
   *     and flips entitlement.agent_execution_allowed = TRUE on success.
   *
   * Used to backfill operator2's existing tenant via the same code path new
   * signups now use (plan section 1.2 / Decision A).
   *
   * Idempotent: callable multiple times; only heals what's missing.
   */
  async reprovision(accountId: string, actor: string): Promise<ReprovisionSummary> {
    // Lazy import to avoid circular dep (TenantService also imports types from accounts).
    const { TenantService } = await import('../tenants/service');
    const tenantService = new TenantService();

    const account = await this.repository.findById(accountId);
    if (!account) {
      throw new AccountNotFoundError(accountId);
    }

    // (a) Ensure Stripe customer exists. If accounts.stripe_customer_id is
    // NULL (the operator2 state), create it and update the row.
    //
    // Same compensating-delete pattern as AccountService.create: if the DB
    // update fails after the Stripe customer was created, delete the Stripe
    // customer to avoid orphans. Without this, retrying reprovision after a
    // DB failure would create multiple orphaned Stripe customers.
    let stripeCustomerId = account.stripeCustomerId;
    let stripeCustomerCreated = false;
    if (!stripeCustomerId) {
      const stripeClient = await getStripe();
      const customer = await stripeClient.customers.create({
        email: account.email,
        name: `${account.firstName ?? ''} ${account.lastName ?? ''}`.trim() || account.email,
        metadata: {
          accountId: account.id,
          firebaseUid: account.firebaseUid,
          reprovision: 'true',
          reprovisionActor: actor,
        },
      });
      try {
        // accounts has no RLS so getPool() is fine.
        await this.repository.updateStripeCustomerId(account.id, customer.id);
      } catch (err) {
        // Compensating action: roll back the Stripe customer.
        await stripeClient.customers.del(customer.id).catch((delErr) => {
          log.error(
            { accountId, stripeCustomerId: customer.id, error: (delErr as Error).message },
            'CRITICAL: reprovision failed to delete orphan Stripe customer after DB update failure — requires manual reconciliation',
          );
        });
        throw err;
      }
      stripeCustomerId = customer.id;
      stripeCustomerCreated = true;
      log.info(
        { accountId, stripeCustomerId },
        'reprovision: created Stripe customer',
      );
    }

    // (b) For each tenant owned by this account that needs reactivation, call
    // tenantService.activate(). activate() is idempotent — it sets status='active',
    // updates entitlement, publishes the event, and synchronously calls
    // provisionSubscription (which returns alreadyExists=true for tenants
    // whose subscription is already live, and otherwise creates one).
    //
    // Skip rules:
    //   - 'active' AND agent_execution_allowed=TRUE — post-condition of a
    //     successful activate(); nothing to heal. Re-running would
    //     re-publish tenant.activated and double-call Stripe.
    //   - 'suspended' or 'churned' — deliberate operator states. reprovision
    //     must NOT silently un-suspend / un-churn them. Admins reactivate
    //     explicitly via the dedicated endpoint.
    //
    // Anything else (e.g. 'pending', or 'active' with agent_execution_allowed
    // = FALSE / NULL) still gets the activate() retry.
    const ownedTenants = await this.tenantRepo.findByAccountId(accountId);
    const reactivated: string[] = [];
    for (const t of ownedTenants) {
      // Read status + provisioned-state in one admin-scope query. entitlements
      // has RLS; we don't have app.current_tenant_id set at this point in the
      // call stack, so the admin scope is required.
      const provisioned = await withAdminScope(
        {
          caller: 'AccountService.reprovision.precheck',
          actor,
          reason: 'check tenant status + entitlement before re-activate',
        },
        async (client) => {
          const r = await client.query<{
            status: string;
            agent_execution_allowed: boolean | null;
          }>(
            `SELECT t.status, e.agent_execution_allowed
             FROM tenants t
             LEFT JOIN entitlements e ON e.tenant_id = t.id
             WHERE t.id = $1`,
            [t.id],
          );
          return r.rows[0] ?? null;
        },
      );

      if (
        provisioned &&
        provisioned.status === 'active' &&
        provisioned.agent_execution_allowed === true
      ) {
        log.info(
          { accountId, tenantId: t.id },
          'reprovision: tenant already active and provisioned — skipping activate()',
        );
        continue;
      }

      if (
        provisioned &&
        (provisioned.status === 'suspended' || provisioned.status === 'churned')
      ) {
        log.info(
          { accountId, tenantId: t.id, status: provisioned.status },
          `tenant ${t.id} in status=${provisioned.status}, skipping activate during reprovision; admin must explicitly reactivate`,
        );
        continue;
      }

      try {
        await tenantService.activate(t.id);
        reactivated.push(t.id);
      } catch (err) {
        log.error(
          { accountId, tenantId: t.id, error: (err as Error).message },
          'reprovision: tenantService.activate failed (continuing with next tenant)',
        );
      }
    }

    return {
      accountId,
      stripeCustomerCreated,
      stripeCustomerId,
      tenantsReactivated: reactivated,
    };
  }
}

// Kahn's algorithm: children before parents. Throws on cycles.
function topologicalChildrenFirst(
  tables: string[],
  fks: Array<{ child: string; parent: string }>,
): string[] {
  // Edges are (child → parent). For DELETE we need children emitted FIRST,
  // so we track each table's "incoming-edge count" — the number of edges
  // pointing AT it as a parent. A table whose in-degree is zero has no other
  // tenant-scoped table referencing it; it is safe to DELETE first. Each
  // time we emit a table, we decrement the in-degree of every parent it
  // referenced; once a parent's in-degree falls to zero, it joins the queue.
  // This is Kahn's algorithm with the edge direction interpreted as
  // "this child must be deleted before that parent".
  const tablesSet = new Set(tables);
  const inDegree = new Map<string, number>();
  for (const t of tables) inDegree.set(t, 0);
  for (const fk of fks) {
    if (tablesSet.has(fk.parent) && tablesSet.has(fk.child) && fk.child !== fk.parent) {
      inDegree.set(fk.parent, (inDegree.get(fk.parent) ?? 0) + 1);
    }
  }
  const queue: string[] = [];
  for (const t of tables) {
    if ((inDegree.get(t) ?? 0) === 0) queue.push(t);
  }
  const out: string[] = [];
  while (queue.length) {
    const t = queue.shift()!;
    out.push(t);
    for (const fk of fks) {
      if (fk.child === t && tablesSet.has(fk.parent) && fk.child !== fk.parent) {
        const newDeg = (inDegree.get(fk.parent) ?? 0) - 1;
        inDegree.set(fk.parent, newDeg);
        if (newDeg === 0) queue.push(fk.parent);
      }
    }
  }
  if (out.length !== tables.length) {
    throw new Error(
      `topological sort failed — FK cycle detected. Emitted ${out.length} of ${tables.length} tables. ` +
      `Remaining: ${tables.filter((t) => !out.includes(t)).join(', ')}`,
    );
  }
  return out;
}

// Quote an identifier for safe interpolation in DELETE FROM <ident>.
// Table names come from information_schema so are inherently trusted, but
// quote defensively against PG keywords/reserved words.
function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}
