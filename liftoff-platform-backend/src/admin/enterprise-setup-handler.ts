// PR 5 — Consolidated POST /api/admin/accounts/:accountId/enterprise-setup.
//
// One request that collapses the prior 8-step manual runbook into a single
// admin operation:
//
//   Pre.    readAccountState(accountId)                    → pre snapshot / 404
//   Step A. Cancel existing Stripe sub (if configured)     [opt-out via body]
//   Step B. Upsert enterprise_contracts row                 [shared helper, PR 0]
//   Step C. Sync rates to billing_controls + Stripe         [shared helper, PR 1]
//   Step D. Provision via liftoff-billing /provision-enterprise
//                with cleanOrphanState: true               [PR 4 flag]
//   Step E. Re-snapshot + respond with full envelope        [success or partial_failure]
//
// Per Q15: every mutation step is wrapped to catch its own failure. The catch
// records `failedStep` + `failureError`, does NOT rethrow, and short-circuits
// subsequent steps (we don't provision when contract upsert failed). Step E
// runs unconditionally so the operator always gets a useful response —
// {data: snapshot, audit: {..., status, failedStep}, healthCheck: {ok, issues[]}}.
//
// Per Q6: cancelExistingSubscription defaults to true. Re-running this
// endpoint on an account with a matching enterprise sub still cancels and
// re-provisions — intentional "known-clean" re-provision path.
//
// Per Q11: total request time can be 10–30s under normal load (Stripe ops
// dominate). Documented in docs/admin-api.md.

import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import Stripe from 'stripe';
import { getPool } from '../infrastructure/database';
import { getStripeSecretKey } from '../infrastructure/secrets';
import { log } from '../infrastructure/logging';
import { logAdminAction } from './middleware';
import { wrapAdminResponse, adminError, type AdminAuditRecord, type AdminHealthCheck } from './conventions';
import { accountIdParam } from './zod-helpers';
import { validateRequest } from './validate-request';
import { readAccountState, inferHealthIssues, type AccountStateSnapshot } from './account-state-service';
import {
  enterpriseContractBodySchema,
  upsertEnterpriseContract,
  syncRatesToBillingAndStripe,
  type EnterpriseContractBody,
} from './enterprise-contract-handler';
import { AccountNotFoundError } from '../accounts/service';
import { getBillingAdminClient } from './../billing/billing-admin-client';

// PR 5 body schema: extends enterprise-contract body with one operator-facing
// option. Default true per Q6.
export const enterpriseSetupBodySchema = enterpriseContractBodySchema.extend({
  cancelExistingSubscription: z.boolean().default(true),
});

export type EnterpriseSetupBody = z.infer<typeof enterpriseSetupBodySchema>;

export const enterpriseSetupSchema = {
  params: accountIdParam,
  body: enterpriseSetupBodySchema,
};

export const validateEnterpriseSetupRequest = validateRequest(enterpriseSetupSchema);

let _stripe: Stripe | null = null;
async function getStripe(): Promise<Stripe> {
  if (!_stripe) _stripe = new Stripe(await getStripeSecretKey());
  return _stripe;
}

type FailedStep =
  | 'cancel_existing'
  | 'upsert_contract'
  | 'sync_rates'
  | 'provision_enterprise'
  | null;

// Helpers extracted for testability. Exported under a name-spaced object so
// the test file can swap timing without monkey-patching globals.
const POLL_INTERVAL_MS = 1_000;
const POLL_MAX_ATTEMPTS = 10;

// Poll the local subscriptions mirror for status='canceled' on the given
// stripe_subscription_id. If it doesn't flip within ~10s, the caller does a
// direct UPDATE — webhook lag shouldn't block a synchronous admin operation.
async function waitForLocalCancel(
  stripeSubscriptionId: string,
  deps: { pool?: { query: (sql: string, params: unknown[]) => Promise<{ rows: Array<{ status: string }> }> }; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ canceled: boolean; lastStatus: string | null }> {
  const pool = deps.pool ?? getPool();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let lastStatus: string | null = null;
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    const { rows } = await pool.query(
      `SELECT status FROM subscriptions WHERE stripe_subscription_id = $1`,
      [stripeSubscriptionId],
    );
    if (rows.length === 0) return { canceled: true, lastStatus: 'missing' };
    lastStatus = rows[0].status;
    if (lastStatus === 'canceled') return { canceled: true, lastStatus };
    if (attempt < POLL_MAX_ATTEMPTS - 1) await sleep(POLL_INTERVAL_MS);
  }
  return { canceled: false, lastStatus };
}

export async function handleEnterpriseSetup(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { accountId } = req.params;
    const body = req.body as EnterpriseSetupBody;
    const adminAccount = (req as Request & { adminAccount?: { id: string; email: string } })
      .adminAccount;
    const adminId = adminAccount?.id ?? 'admin:no-id';

    // ── Pre — pre-mutation snapshot (404 if account missing) ────────────
    let snapshot: AccountStateSnapshot;
    try {
      snapshot = await readAccountState(accountId);
    } catch (err) {
      if (err instanceof AccountNotFoundError) {
        res.status(404).json(adminError('account_not_found', `accountId=${err.accountId}`));
        return;
      }
      throw err;
    }

    let failedStep: FailedStep = null;
    let failureError: Error | null = null;

    // ── Step A — Cancel existing Stripe sub (per Q6 default true) ──────
    // Fires only when cancelExistingSubscription AND there's an active Stripe
    // sub on the canonical customer. Same-customer guard prevents accidentally
    // touching an orphan (those go through PR 4's cleanOrphanState path).
    //
    // Plan-literal: canonical customer is `snapshot.account.stripeCustomerId`.
    // No fallback to billing_controls — if accounts.stripe_customer_id is null,
    // there's no canonical customer for this account and the cancel step is
    // skipped. (The provision step downstream still needs a customer; it
    // surfaces that as a Step-D partial failure.)
    const active = snapshot.stripe.activeSubscription;
    const canonicalCustomer = snapshot.account.stripeCustomerId;
    const shouldCancel =
      body.cancelExistingSubscription &&
      active !== null &&
      canonicalCustomer !== null &&
      active.customer === canonicalCustomer;
    if (shouldCancel && active) {
      try {
        const stripe = await getStripe();
        await stripe.subscriptions.cancel(active.id, { prorate: false });
        // Wait for the local mirror to catch up (webhook-driven). If the
        // webhook lags, flip the local row directly so subsequent steps
        // (and Step D's provision) see canceled state.
        const waitResult = await waitForLocalCancel(active.id);
        if (!waitResult.canceled) {
          log.warn(
            { accountId, subscriptionId: active.id, lastStatus: waitResult.lastStatus },
            'admin.enterprise_setup.mirror_wait_timeout',
          );
          await getPool().query(
            `UPDATE subscriptions
                SET status     = 'canceled',
                    version    = version + 1,
                    updated_at = NOW()
              WHERE stripe_subscription_id = $1`,
            [active.id],
          );
        }
      } catch (err) {
        failedStep = 'cancel_existing';
        failureError = err instanceof Error ? err : new Error(String(err));
        log.error(
          { err, accountId, subscriptionId: active.id },
          'admin.enterprise_setup.cancel_existing_failed',
        );
      }
    }

    // ── Step B — Upsert enterprise contract ────────────────────────────
    if (failedStep === null) {
      try {
        const contractBody: EnterpriseContractBody = {
          includedOus: body.includedOus,
          precommitExtraOus: body.precommitExtraOus,
          includedRateUsdPerOu: body.includedRateUsdPerOu,
          precommitRateUsdPerOu: body.precommitRateUsdPerOu,
          reloadRateUsdPerOu: body.reloadRateUsdPerOu,
          stripeBilled: body.stripeBilled,
          isAnnualPlan: body.isAnnualPlan,
          annualTotalUsdCents: body.annualTotalUsdCents,
          effectiveFrom: body.effectiveFrom,
          contractReference: body.contractReference,
          notes: body.notes,
        };
        await upsertEnterpriseContract(accountId, contractBody);
      } catch (err) {
        failedStep = 'upsert_contract';
        failureError = err instanceof Error ? err : new Error(String(err));
        log.error(
          { err, accountId },
          'admin.enterprise_setup.upsert_contract_failed',
        );
      }
    }

    // ── Step C — Sync rates to billing_controls + Stripe ───────────────
    if (failedStep === null) {
      try {
        await syncRatesToBillingAndStripe(accountId, {
          includedOus: body.includedOus,
          precommitExtraOus: body.precommitExtraOus ?? 0,
          includedRateUsdPerOu: body.includedRateUsdPerOu,
          precommitRateUsdPerOu: body.precommitRateUsdPerOu,
          reloadRateUsdPerOu: body.reloadRateUsdPerOu,
          stripeBilled: body.stripeBilled ?? true,
          isAnnualPlan: body.isAnnualPlan ?? false,
          annualTotalUsdCents: body.annualTotalUsdCents ?? null,
        });
      } catch (err) {
        failedStep = 'sync_rates';
        failureError = err instanceof Error ? err : new Error(String(err));
        log.error(
          { err, accountId },
          'admin.enterprise_setup.sync_rates_failed',
        );
      }
    }

    // ── Step D — Provision via liftoff-billing (with PR 4 cleanOrphanState) ─
    if (failedStep === null) {
      try {
        // Need a tenantId for the billing call. Use the primary tenant from
        // the pre-mutation snapshot. If no tenants exist, surface as a
        // partial failure at this step rather than throwing into next(err).
        const primaryTenantId = snapshot.tenants[0]?.id ?? null;
        if (!primaryTenantId) {
          throw new Error('account has no tenants — cannot provision');
        }
        if (!canonicalCustomer) {
          throw new Error('account has no stripe_customer_id — cannot provision');
        }
        await getBillingAdminClient().provisionEnterprise({
          tenantId: primaryTenantId,
          stripeCustomerId: canonicalCustomer,
          includedOus: body.includedOus,
          precommitExtraOus: body.precommitExtraOus ?? 0,
          includedRateUsdPerOu: body.includedRateUsdPerOu,
          precommitRateUsdPerOu: body.precommitRateUsdPerOu,
          reloadRateUsdPerOu: body.reloadRateUsdPerOu,
          stripeBilled: body.stripeBilled ?? true,
          isAnnualPlan: body.isAnnualPlan ?? false,
          annualTotalUsdCents: body.annualTotalUsdCents ?? null,
          cleanOrphanState: true,
        });
      } catch (err) {
        failedStep = 'provision_enterprise';
        failureError = err instanceof Error ? err : new Error(String(err));
        log.error(
          { err, accountId },
          'admin.enterprise_setup.provision_failed',
        );
      }
    }

    // ── Step E — Audit-first ordering, then re-snapshot + respond ──────
    //
    // We write the audit row BEFORE the post-snapshot read so the audit
    // trail of the mutation work (Steps A–D + their failedStep + failureError)
    // is preserved even if the post-snapshot read itself fails. This matters
    // because:
    //   - If we wrote the audit after the post-snapshot and the snapshot
    //     read failed, the operator would get a 500 with NO record of which
    //     mutation steps ran or failed.
    //   - The audit row's `details` payload doesn't depend on the post-
    //     snapshot — it's entirely derived from the input body + failure
    //     state, so the audit can be written immediately after the mutation
    //     loop closes.
    //
    // Per Q3: logAdminAction exceptions bubble (audit-log loss IS a 500).
    const auditRow = await logAdminAction(
      adminId,
      'billing.enterprise.setup',
      'account',
      accountId,
      {
        includedOus: body.includedOus,
        precommitExtraOus: body.precommitExtraOus,
        includedRateUsdPerOu: body.includedRateUsdPerOu,
        precommitRateUsdPerOu: body.precommitRateUsdPerOu,
        reloadRateUsdPerOu: body.reloadRateUsdPerOu,
        stripeBilled: body.stripeBilled,
        isAnnualPlan: body.isAnnualPlan,
        annualTotalUsdCents: body.annualTotalUsdCents,
        contractReference: body.contractReference,
        cancelExistingSubscription: body.cancelExistingSubscription,
        failedStep,
        failureError: failureError?.message ?? null,
      },
      req,
    );

    // Post-mutation snapshot so the operator sees current state, including
    // any inconsistencies that survived (e.g. partial-failure side effects).
    // If THIS fails, the audit row is already on disk — surface as 500.
    let postSnapshot: AccountStateSnapshot;
    try {
      postSnapshot = await readAccountState(accountId);
    } catch (err) {
      log.error({ err, accountId }, 'admin.enterprise_setup.post_snapshot_failed');
      next(err);
      return;
    }

    const inferredIssues = inferHealthIssues(postSnapshot);
    const partialFailureMsg = failedStep
      ? [`step:${failedStep} failed: ${failureError?.message ?? 'unknown'}`]
      : [];
    const healthCheck: AdminHealthCheck = {
      ok: failedStep === null,
      issues: [...inferredIssues, ...partialFailureMsg],
    };

    const audit: AdminAuditRecord = {
      ...auditRow,
      status: failedStep === null ? 'success' : 'partial_failure',
      failedStep,
    };

    res.status(200).json(wrapAdminResponse(postSnapshot, audit, healthCheck));
  } catch (err) {
    next(err);
  }
}
