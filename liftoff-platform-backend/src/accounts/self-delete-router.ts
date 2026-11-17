// User-initiated account deletion + preflight router.
//
// Mounted under /api/accounts alongside the existing accountsRouter. The
// existing auth + access middlewares are applied upstream (see src/index.ts:
// authMiddleware → accessGateMiddleware → app.use('/api/accounts', …)). So
// when handlers here run, req.user.uid is the Firebase UID of the caller.
//
// Endpoints:
//   GET    /me/deletion-preflight — drives the DeleteAccountModal scenario.
//   DELETE /me                    — runs cascadeDelete with scrubMode='soft'.

import { Router } from 'express';
import { AccountService } from './service';
import { TenantMembersRepository } from '../tenant-members/repository';
import { getBillingAdminClient } from '../billing/billing-admin-client';
import { logAudit } from '../infrastructure/logging';

export const selfDeleteRouter = Router();

const accountService = new AccountService();
const tenantMembersRepo = new TenantMembersRepository();

// GET /api/accounts/me/deletion-preflight
// Combines billing-side preflight (active subs + outstanding invoices) with
// PB-side workspace member counts. The frontend modal uses the response to
// pick its shape (block_sub / block_invoice / confirm_delete) and to compose
// the consequence sentences.
selfDeleteRouter.get('/me/deletion-preflight', async (req, res, next) => {
  try {
    const firebaseUid = req.user?.uid;
    if (!firebaseUid) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    const account = await accountService.getByFirebaseUid(firebaseUid);
    if (!account) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }
    const accountId = account.id;

    // PB-side enumeration — owned = workspaces where this user is an owner
    // in tenant_members. Matches cascadeDelete's enumeration so both sides
    // agree on what "owned" means, including transferred workspaces.
    const ownedTenants = await tenantMembersRepo.findOwnedTenantIds(accountId);
    const memberOfTenants = await tenantMembersRepo.findTenantsForAccount(accountId);
    const ownedTenantIds = new Set(ownedTenants.map(t => t.id));
    const memberOfWorkspaceCount = memberOfTenants
      .filter(tm => !ownedTenantIds.has(tm.tenant_id))
      .length;

    // Aggregate across ALL owned workspaces.
    //   orphanWorkspaceCount = workspaces user solely owns where members > 0
    //     (these cascade-delete on the user's deletion, kicking other
    //      members out)
    //   lostAccessCount     = sum of those orphan workspaces' members
    // Workspaces with members + another owner aren't orphans; they continue
    // unaffected and don't appear in the modal copy.
    let orphanWorkspaceCount = 0;
    let lostAccessCount = 0;
    for (const t of ownedTenants) {
      const members = await tenantMembersRepo.findAllByTenant(t.id);
      const others = members.filter(m => m.account_id !== accountId);
      const otherOwners = others.filter(m => m.role === 'owner').length;
      if (others.length > 0 && otherOwners === 0) {
        orphanWorkspaceCount += 1;
        lostAccessCount += others.length;
      }
    }

    // Billing-side preflight
    let hasActiveSubscription = false;
    let hasOutstandingInvoice = false;
    if (ownedTenantIds.size > 0) {
      const pre = await getBillingAdminClient().preflightDeletion(Array.from(ownedTenantIds));
      hasActiveSubscription = pre.hasActiveSubscription;
      hasOutstandingInvoice = pre.hasOutstandingInvoice;
    }

    res.status(200).json({
      hasActiveSubscription,
      hasOutstandingInvoice,
      orphanWorkspaceCount,
      lostAccessCount,
      memberOfWorkspaceCount,
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/accounts/me — authenticated user deletes their own account.
//
// Preflight: blocks if the account has active subscriptions or outstanding
// invoices on any of its owned tenants. Delegates to cascadeDelete with
// scrubMode='soft' (strip PII, preserve Stripe customer for abuse prevention).
selfDeleteRouter.delete('/me', async (req, res, next) => {
  try {
    const firebaseUid = req.user?.uid;
    if (!firebaseUid) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    const account = await accountService.getByFirebaseUid(firebaseUid);
    if (!account) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }
    const accountId = account.id;

    const ownedTenants = await tenantMembersRepo.findOwnedTenantIds(accountId);
    const tenantIds = ownedTenants.map(t => t.id);

    if (tenantIds.length > 0) {
      const pre = await getBillingAdminClient().preflightDeletion(tenantIds);
      if (pre.hasActiveSubscription) {
        res.status(409).json({ error: 'has_active_subscription' });
        return;
      }
      if (pre.hasOutstandingInvoice) {
        res.status(409).json({ error: 'has_outstanding_invoice' });
        return;
      }
    }

    const summary = await accountService.cascadeDelete(accountId, accountId, {
      dryRun: false,
      scrubMode: 'soft',
      actorIsAccount: true,
    });

    logAudit('account.self_deleted', req.ctx, {
      accountId,
      tenantsAffected: summary.tenantsAffected,
      stripeCustomerScrubbed: summary.stripeCustomerScrubbed,
      deletionLedgerRowId: summary.deletionLedgerRowId,
      connectorsRevoked: summary.connectorsRevoked,
    });

    res.status(200).json({ ok: true });
  } catch (error) {
    next(error);
  }
});
