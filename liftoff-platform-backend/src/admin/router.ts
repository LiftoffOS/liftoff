// Admin Router
// Per Section 1: Control plane owns internal admin operations
// Per Section 15: Platform kill switches
// Per Phase 0.1: SE-001 (Critical) - Admin router authorization middleware
//
// PR 0 conventions:
//   - URLs: account-scoped under /accounts/:accountId/<verb|noun>; resource
//     reads under /<resource>/:id/<noun>. Kill-switch grouping retained for
//     visibility.
//   - Success envelope: { data, audit, healthCheck? } via wrapAdminResponse.
//   - Error envelope: { error, detail?, field? } via adminError.
//   - Request shape via Zod (validateRequest middleware); handlers retain
//     business-invariant checks only.
//   - Audit action grammar: <domain>.<resource>.<verb>.
//   - 404 catch-all logs admin.api.404_legacy_url so retired URLs are
//     observable.
//
// See docs/admin-api.md for the canonical reference.

import { Router } from 'express';
import { z } from 'zod';
import { AdminService } from './service';
import { logAudit, log } from '../infrastructure/logging';
import { adminAuthMiddleware, logAdminAction } from './middleware';
import { withAdminScope, getPool } from '../infrastructure/database';
import { getBillingAdminClient } from '../billing/billing-admin-client';
import { infrastructureProvisioningService } from '../infrastructure/provisioning';
import { AccountService, AccountNotFoundError } from '../accounts/service';
import { AccountRepository } from '../accounts/repository';
import { verifySignupApprovalToken } from '../accounts/signup-approval-tokens';
import { SignupPreapprovalRepository, normalizeSignupEmail } from '../accounts/signup-preapprovals';
import { sendWelcomeEmail } from '../infrastructure/email';
import { enterpriseContractsRouter } from './enterprise-contract-handler';
import { assertGcpProjectIdMatchesEnv } from '../tenants/validate-gcp-project-id';
import { agentStatusRouter } from '../agent-status/router';
import { supportDelegationRouter } from '../support-delegation/router';
import { adminError, wrapAdminResponse, type AdminAuditRecord } from './conventions';
import { validateRequest } from './validate-request';
import { handleAccountStateRead, validateAccountStateRequest } from './account-state-handler';
import { handleEnterpriseSetup, validateEnterpriseSetupRequest } from './enterprise-setup-handler';
import { invalidateExecutionCache } from '../billing/execution-guard';
import { publishBillingSuspensionChange } from '../billing/billing-suspension-publisher';
import { referralsAdminRouter } from '../referrals/admin-router';
import { ouCreditAdminRouter } from './ou-credit-router';
import { platformVendorRouter } from './platform-vendor-router';
import { refundAdminRouter } from './refund-router';
import { operatorCooldownView } from '../capability-discovery/vendor-gate';
import {
  accountIdParam,
  connectorTypeParam,
  idParam,
  tenantIdParam,
  workflowTypeParam,
} from './zod-helpers';

export const adminRouter = Router();
const service = new AdminService();

// Public read-only state endpoints (formerly /check/*) used by service-to-
// service callers without Firebase auth. The path predicate below grants the
// same bypass to the renamed routes.
function isPublicStateEndpoint(path: string): boolean {
  // GET /admin/platform/state, GET /admin/connectors/:type/state,
  // GET /admin/workflow-types/:type/state.
  if (path === '/platform/state') return true;
  if (/^\/connectors\/[^/]+\/state$/.test(path)) return true;
  if (/^\/workflow-types\/[^/]+\/state$/.test(path)) return true;
  return false;
}

adminRouter.use((req, res, next) => {
  if (isPublicStateEndpoint(req.path)) return next();
  return adminAuthMiddleware(req, res, next);
});

// Enterprise contracts CRUD — sits behind the same admin auth gate.
adminRouter.use('/', enterpriseContractsRouter);

// Support delegation ("become user") — grant, list and revoke the sessions that
// let a platform admin operate a customer's workspace as that customer. Behind
// the same adminAuthMiddleware gate as everything else on this router.
adminRouter.use('/support-delegation', supportDelegationRouter);

// Agent status proxy — internal break-glass + admin UI surface for live
// invocation state (Phase 1B). Sits behind adminAuthMiddleware via the
// top-level adminRouter.use above.
adminRouter.use('/agent-status', agentStatusRouter);

// Referral programme enforcement — the operator half of "Liftoff may
// investigate and disqualify". That clause is what replaces automatic clawback,
// which was rejected for missing fraudsters and catching honest users, so
// without a surface behind it the terms would claim a right nothing exercises.
// Behind the same adminAuthMiddleware gate; every route audits its actor.
adminRouter.use('/referrals', referralsAdminRouter);
// Account-scoped, so it mounts at /accounts and falls through to the routes
// defined below for every path it does not claim.
// The four platform vendor levers — which vendor powers Liftoff's own
// assistants, team-shaping, background and safety work. NOT the workspace
// dropdown: that answers what a customer's teams run on.
adminRouter.use('/platform-vendors', platformVendorRouter);
adminRouter.use('/accounts', ouCreditAdminRouter);
adminRouter.use('/accounts', refundAdminRouter);

// ── Kill switches per Section 15 ──────────────────────────────────────────

const tenantKillSwitchSchema = { params: tenantIdParam };

adminRouter.post(
  '/kill-switch/tenant/:tenantId/disable',
  validateRequest(tenantKillSwitchSchema),
  async (req, res, next) => {
    try {
      const adminAccount = (req as { adminAccount?: { id: string; email: string } }).adminAccount;
      const { tenantId } = req.params;
      await service.disableTenant(tenantId);

      logAudit('admin.tenant.disabled', req.ctx, {
        tenantId,
        action: 'kill_switch',
        adminId: adminAccount?.id,
      });

      const audit = await logAdminAction(
        adminAccount?.id ?? 'admin:no-id',
        'tenant.kill_switch.disable',
        'tenant',
        tenantId,
        { action: 'kill_switch' },
        req,
      );

      res.json(wrapAdminResponse({ status: 'disabled', tenantId }, audit));
    } catch (error) {
      next(error);
    }
  },
);

adminRouter.post(
  '/kill-switch/tenant/:tenantId/enable',
  validateRequest(tenantKillSwitchSchema),
  async (req, res, next) => {
    try {
      const adminAccount = (req as { adminAccount?: { id: string; email: string } }).adminAccount;
      const { tenantId } = req.params;
      await service.enableTenant(tenantId);

      logAudit('admin.tenant.enabled', req.ctx, { tenantId, adminId: adminAccount?.id });

      const audit = await logAdminAction(
        adminAccount?.id ?? 'admin:no-id',
        'tenant.kill_switch.enable',
        'tenant',
        tenantId,
        null,
        req,
      );

      res.json(wrapAdminResponse({ status: 'enabled', tenantId }, audit));
    } catch (error) {
      next(error);
    }
  },
);

const connectorKillSwitchSchema = { params: connectorTypeParam };

adminRouter.post(
  '/kill-switch/connector/:connectorType/disable',
  validateRequest(connectorKillSwitchSchema),
  async (req, res, next) => {
    try {
      const adminAccount = (req as { adminAccount?: { id: string; email: string } }).adminAccount;
      const { connectorType } = req.params;
      const disabled = await service.disableConnector(connectorType);

      logAudit('admin.connector.disabled', req.ctx, {
        connectorType,
        action: 'kill_switch',
        adminId: adminAccount?.id,
      });

      const audit = await logAdminAction(
        adminAccount?.id ?? 'admin:no-id',
        'connector.kill_switch.disable',
        'connector',
        connectorType,
        { action: 'kill_switch' },
        req,
      );

      res.json(wrapAdminResponse({ status: 'disabled', connector: disabled }, audit));
    } catch (error) {
      next(error);
    }
  },
);

adminRouter.post(
  '/kill-switch/connector/:connectorType/enable',
  validateRequest(connectorKillSwitchSchema),
  async (req, res, next) => {
    try {
      const adminAccount = (req as { adminAccount?: { id: string; email: string } }).adminAccount;
      const { connectorType } = req.params;
      await service.enableConnector(connectorType);

      logAudit('admin.connector.enabled', req.ctx, { connectorType, adminId: adminAccount?.id });

      const audit = await logAdminAction(
        adminAccount?.id ?? 'admin:no-id',
        'connector.kill_switch.enable',
        'connector',
        connectorType,
        null,
        req,
      );

      res.json(wrapAdminResponse({ status: 'enabled', connectorType }, audit));
    } catch (error) {
      next(error);
    }
  },
);

const workflowKillSwitchSchema = { params: workflowTypeParam };

adminRouter.post(
  '/kill-switch/workflow-type/:workflowType/disable',
  validateRequest(workflowKillSwitchSchema),
  async (req, res, next) => {
    try {
      const adminAccount = (req as { adminAccount?: { id: string; email: string } }).adminAccount;
      const { workflowType } = req.params;
      const disabled = await service.disableWorkflowType(workflowType);

      logAudit('admin.workflow_type.disabled', req.ctx, {
        workflowType,
        action: 'kill_switch',
        adminId: adminAccount?.id,
      });

      const audit = await logAdminAction(
        adminAccount?.id ?? 'admin:no-id',
        'workflow_type.kill_switch.disable',
        'workflow_type',
        workflowType,
        { action: 'kill_switch' },
        req,
      );

      res.json(wrapAdminResponse({ status: 'disabled', workflowType: disabled }, audit));
    } catch (error) {
      next(error);
    }
  },
);

adminRouter.post(
  '/kill-switch/workflow-type/:workflowType/enable',
  validateRequest(workflowKillSwitchSchema),
  async (req, res, next) => {
    try {
      const adminAccount = (req as { adminAccount?: { id: string; email: string } }).adminAccount;
      const { workflowType } = req.params;
      await service.enableWorkflowType(workflowType);

      logAudit('admin.workflow_type.enabled', req.ctx, { workflowType, adminId: adminAccount?.id });

      const audit = await logAdminAction(
        adminAccount?.id ?? 'admin:no-id',
        'workflow_type.kill_switch.enable',
        'workflow_type',
        workflowType,
        null,
        req,
      );

      res.json(wrapAdminResponse({ status: 'enabled', workflowType }, audit));
    } catch (error) {
      next(error);
    }
  },
);

adminRouter.post('/kill-switch/global/freeze-writes', async (req, res, next) => {
  try {
    const adminAccount = (req as { adminAccount?: { id: string; email: string } }).adminAccount;
    const status = await service.freezeAllWrites();

    logAudit('admin.global.writes_frozen', req.ctx, {
      action: 'kill_switch',
      adminId: adminAccount?.id,
    });

    const audit = await logAdminAction(
      adminAccount?.id ?? 'admin:no-id',
      'platform.kill_switch.freeze_writes',
      'platform',
      'global',
      { action: 'kill_switch' },
      req,
    );

    res.json(wrapAdminResponse({ status: 'frozen', platformStatus: status }, audit));
  } catch (error) {
    next(error);
  }
});

adminRouter.post('/kill-switch/global/unfreeze-writes', async (req, res, next) => {
  try {
    const adminAccount = (req as { adminAccount?: { id: string; email: string } }).adminAccount;
    const status = await service.unfreezeAllWrites();

    logAudit('admin.global.writes_unfrozen', req.ctx, { adminId: adminAccount?.id });

    const audit = await logAdminAction(
      adminAccount?.id ?? 'admin:no-id',
      'platform.kill_switch.unfreeze_writes',
      'platform',
      'global',
      null,
      req,
    );

    res.json(wrapAdminResponse({ status: 'unfrozen', platformStatus: status }, audit));
  } catch (error) {
    next(error);
  }
});

// ── Public read-only state (formerly /status, /check/*, /disabled-*) ──────
//
// These bypass adminAuthMiddleware (per isPublicStateEndpoint above) because
// service-to-service callers without a Firebase identity read them. Replaces:
//   GET /status, GET /check/global-writes-frozen          → GET /platform/state
//   GET /check/connector/:type, GET /disabled-connectors  → GET /connectors/...
//   GET /check/workflow-type/:type, GET /disabled-workflow-types → /workflow-types/...

adminRouter.get('/platform/state', async (req, res, next) => {
  try {
    const status = await service.getPlatformStatus();
    const frozen = await service.areGlobalWritesFrozen();
    // Public read — no admin identity, no audit row written. Pass `null` so
    // wrapAdminResponse omits the `audit` field entirely.
    res.json(wrapAdminResponse({ platform: status, globalWritesFrozen: frozen }, null));
  } catch (error) {
    next(error);
  }
});

const connectorsQuerySchema = {
  query: z.object({ state: z.enum(['disabled']).optional() }),
};

adminRouter.get(
  '/connectors',
  validateRequest(connectorsQuerySchema),
  async (req, res, next) => {
    try {
      // Only "state=disabled" is supported today (replaces /disabled-connectors).
      // Without filter we return the same set; the URL signals intent.
      const disabled = await service.getDisabledConnectors();
      res.json(wrapAdminResponse({ connectors: disabled }, null));
    } catch (error) {
      next(error);
    }
  },
);

adminRouter.get(
  '/connectors/:connectorType/state',
  validateRequest({ params: connectorTypeParam }),
  async (req, res, next) => {
    try {
      const { connectorType } = req.params;
      const disabled = await service.isConnectorDisabled(connectorType);
      res.json(wrapAdminResponse({ connectorType, disabled }, null));
    } catch (error) {
      next(error);
    }
  },
);

const workflowTypesQuerySchema = {
  query: z.object({ state: z.enum(['disabled']).optional() }),
};

adminRouter.get(
  '/workflow-types',
  validateRequest(workflowTypesQuerySchema),
  async (req, res, next) => {
    try {
      const disabled = await service.getDisabledWorkflowTypes();
      res.json(wrapAdminResponse({ workflowTypes: disabled }, null));
    } catch (error) {
      next(error);
    }
  },
);

adminRouter.get(
  '/workflow-types/:workflowType/state',
  validateRequest({ params: workflowTypeParam }),
  async (req, res, next) => {
    try {
      const { workflowType } = req.params;
      const disabled = await service.isWorkflowTypeDisabled(workflowType);
      res.json(wrapAdminResponse({ workflowType, disabled }, null));
    } catch (error) {
      next(error);
    }
  },
);

// ── GET /api/admin/vendor-cooldowns ───────────────────────────────────────
// The credentials the capability path is currently NOT using, because they
// answered 401 or payment-required within the last few minutes
// (src/capability-discovery/vendor-gate.ts, migration 479). Read-only: a park
// lapses on its own, and an operator who wants a vendor off for longer uses
// the connector kill switch above. Behind adminAuthMiddleware like every
// route here that is not in isPublicStateEndpoint — this one names credential
// failure states and is deliberately NOT public. Platform-key parks come back
// individually (that a platform credential is parked, and why, is what an
// operator needs); workspaces' own connectors come back as counts by vendor,
// reason and time to lapse, never as tenant or connector ids.
adminRouter.get('/vendor-cooldowns', async (_req, res, next) => {
  try {
    const view = await operatorCooldownView();
    res.json(wrapAdminResponse(view, null));
  } catch (error) {
    next(error);
  }
});

// ── GET /api/admin/accounts/:accountId/state ──────────────────────────────
// PR 3 — consolidated read of all state relevant to an enterprise account.
// See src/admin/account-state-handler.ts + account-state-service.ts.
adminRouter.get(
  '/accounts/:accountId/state',
  validateAccountStateRequest,
  handleAccountStateRead,
);

// ── POST /api/admin/accounts/:accountId/enterprise-setup ──────────────────
// PR 5 — consolidated end-to-end enterprise-account setup. Cancels existing
// sub (opt-in default), upserts the contract, syncs rates, then re-provisions
// via liftoff-billing with cleanOrphanState=true. Partial-failure tolerant:
// returns a post-mutation snapshot with status + failedStep on partial paths.
// See src/admin/enterprise-setup-handler.ts.
adminRouter.post(
  '/accounts/:accountId/enterprise-setup',
  validateEnterpriseSetupRequest,
  handleEnterpriseSetup,
);

// ── POST /api/admin/accounts/:accountId/enterprise-provisioning ───────────
// Renamed from POST /api/admin/billing/accounts/:accountId/provision-enterprise.
// Admin-only: provisions an account as an enterprise pre-pay customer.
// Sets billing_tier = 'enterprise', plan_type = NULL, loads wallet, unsuspends.

adminRouter.post(
  '/accounts/:accountId/enterprise-provisioning',
  validateRequest({ params: accountIdParam }),
  async (req, res, next) => {
    try {
      const { accountId } = req.params;
      const adminAccount = (req as { adminAccount?: { id: string; email: string } }).adminAccount;

      const pool = getPool();

      // Contract terms come from the enterprise_contracts table — admin must
      // PUT /api/admin/accounts/:accountId/enterprise-contract before calling
      // this endpoint.
      const contractRes = await pool.query<{
        included_ous: string;
        precommit_extra_ous: string;
        included_rate_usd_per_ou: string;
        precommit_rate_usd_per_ou: string;
        reload_rate_usd_per_ou: string;
        stripe_billed: boolean;
        is_annual_plan: boolean;
        annual_total_usd_cents: string | null;
      }>(
        `SELECT included_ous, precommit_extra_ous,
                included_rate_usd_per_ou, precommit_rate_usd_per_ou, reload_rate_usd_per_ou,
                stripe_billed, is_annual_plan, annual_total_usd_cents
           FROM enterprise_contracts
          WHERE account_id = $1
            AND (effective_to IS NULL OR effective_to > NOW())
          ORDER BY effective_from DESC LIMIT 1`,
        [accountId],
      );
      if (!contractRes.rows[0]) {
        res.status(422).json(
          adminError(
            'no_enterprise_contract_on_file',
            'Save the contract via PUT /api/admin/accounts/:accountId/enterprise-contract first.',
          ),
        );
        return;
      }
      const c = contractRes.rows[0];
      const includedOus = Number(BigInt(c.included_ous));
      const precommitExtraOus = Number(BigInt(c.precommit_extra_ous));
      const includedRateUsdPerOu = parseFloat(c.included_rate_usd_per_ou);
      const precommitRateUsdPerOu = parseFloat(c.precommit_rate_usd_per_ou);
      const reloadRateUsdPerOu = parseFloat(c.reload_rate_usd_per_ou);
      const stripeBilled = c.stripe_billed;
      const isAnnualPlan = c.is_annual_plan;
      const annualTotalUsdCents =
        c.annual_total_usd_cents != null ? Number(BigInt(c.annual_total_usd_cents)) : null;

      // Resolve stripeCustomerId. Canonical source is accounts.stripe_customer_id.
      const accountResult = await pool.query<{ stripe_customer_id: string | null }>(
        `SELECT stripe_customer_id FROM accounts WHERE id = $1 AND deleted_at IS NULL`,
        [accountId],
      );
      if (!accountResult.rows[0]) {
        res.status(404).json(adminError('account_not_found'));
        return;
      }
      const stripeCustomerId = accountResult.rows[0].stripe_customer_id;
      if (!stripeCustomerId) {
        res.status(409).json(adminError('account_has_no_stripe_customer'));
        return;
      }

      // Resolve primary tenantId.
      const tenantResult = await pool.query<{ id: string }>(
        `SELECT id FROM tenants WHERE account_id = $1 ORDER BY created_at ASC LIMIT 1`,
        [accountId],
      );
      if (!tenantResult.rows[0]) {
        res.status(404).json(adminError('tenant_not_found'));
        return;
      }
      const tenantId = tenantResult.rows[0].id;

      // Ensure billing_controls row has stripe_customer_id populated. Idempotent.
      //
      // billing_exempt is seeded from accounts.is_internal on INSERT only — an
      // internal account must never be invoiced — and deliberately absent from
      // the DO UPDATE clause: an exemption set by an operator (contractor,
      // design partner, staff on a personal address) must survive re-init.
      await pool.query(
        `INSERT INTO billing_controls (account_id, stripe_customer_id, billing_exempt, updated_at)
         VALUES ($1, $2, COALESCE((SELECT is_internal FROM accounts WHERE id = $1), FALSE), NOW())
         ON CONFLICT (account_id) DO UPDATE
           SET stripe_customer_id = COALESCE(billing_controls.stripe_customer_id, EXCLUDED.stripe_customer_id),
               updated_at = NOW()`,
        [accountId, stripeCustomerId],
      );

      await getBillingAdminClient().provisionEnterprise({
        tenantId,
        stripeCustomerId,
        includedOus,
        precommitExtraOus,
        includedRateUsdPerOu,
        precommitRateUsdPerOu,
        reloadRateUsdPerOu,
        stripeBilled,
        isAnnualPlan,
        annualTotalUsdCents,
      });

      const audit = await logAdminAction(
        adminAccount?.id ?? 'admin:no-id',
        'account.enterprise_provisioning.create',
        'account',
        accountId,
        {
          includedOus,
          precommitExtraOus,
          includedRateUsdPerOu,
          precommitRateUsdPerOu,
          reloadRateUsdPerOu,
          stripeBilled,
          isAnnualPlan,
        },
        req,
      );

      res.status(200).json(
        wrapAdminResponse({ accountId, includedOus, precommitExtraOus, stripeBilled }, audit),
      );
    } catch (error) {
      next(error);
    }
  },
);

// ── POST /api/admin/accounts/:accountId/fraud-hold/clear ──────────────────
// The only writer of NULL to billing_controls.fraud_hold_at. An early fraud
// warning from the card's issuer placed the hold (liftoff-billing calls
// /api/internal/billing/controls/:cus/fraud-hold); an operator who has looked
// at the charge lifts it here.
//
// Clearing the column is the whole of it. The workspace is admitted again by
// the same predicate that refused it — prepaid-floor.billingStoppedSql, joined
// into the entitlement snapshot — and if it is ALSO out of credit or suspended
// it stays refused on those terms, which is correct: the hold never touched
// them, and lifting it must not hand out compute nobody has paid for.
adminRouter.post(
  '/accounts/:accountId/fraud-hold/clear',
  validateRequest({ params: accountIdParam }),
  async (req, res, next) => {
    try {
      const { accountId } = req.params;
      const adminAccount = (req as { adminAccount?: { id: string; email: string } }).adminAccount;

      // Read the reference first, because RETURNING sees the NEW row and the
      // audit entry should name the warning the operator dismissed. Two plain
      // statements rather than one clever one: the window between them can
      // only turn a hold into no hold, which the UPDATE's own WHERE already
      // treats as nothing to do.
      const pool = getPool();
      const held = await pool.query<{ fraud_hold_ref: string | null }>(
        `SELECT fraud_hold_ref FROM billing_controls
          WHERE account_id = $1 AND fraud_hold_at IS NOT NULL`,
        [accountId],
      );
      if (!held.rows[0]) {
        res.status(404).json(adminError('no_fraud_hold', 'This account is not on a fraud hold.'));
        return;
      }

      const cleared = await pool.query(
        `UPDATE billing_controls
            SET fraud_hold_at = NULL, fraud_hold_ref = NULL, updated_at = NOW()
          WHERE account_id = $1 AND fraud_hold_at IS NOT NULL`,
        [accountId],
      );
      if (cleared.rowCount === 0) {
        res.status(404).json(adminError('no_fraud_hold', 'This account is not on a fraud hold.'));
        return;
      }

      invalidateExecutionCache(accountId);
      await publishBillingSuspensionChange(accountId, 'unsuspended', 'fraud_hold_cleared');

      logAudit('admin.billing.fraud_hold_cleared', req.ctx, {
        accountId,
        ref: held.rows[0].fraud_hold_ref,
        adminId: adminAccount?.id,
      });

      const audit = await logAdminAction(
        adminAccount?.id ?? 'admin:no-id',
        'billing.fraud_hold.clear',
        'account',
        accountId,
        { ref: held.rows[0].fraud_hold_ref },
        req,
      );

      res.status(200).json(wrapAdminResponse({ accountId, cleared: true }, audit));
    } catch (error) {
      next(error);
    }
  },
);

// ── GET /api/admin/debug/agents?tenantId=<UUID> ───────────────────────────
adminRouter.get(
  '/debug/agents',
  validateRequest({ query: z.object({ tenantId: z.string().uuid() }) }),
  async (req, res, next) => {
    try {
      const tenantId = req.query.tenantId as string;

      const [internalAgents, externalAgents, proxyKeys, auditTotal, auditLast24h] =
        await withAdminScope(
          {
            caller: 'admin/router.debug/agents',
            reason: 'admin debug: inspect tenant agents and audit summary',
          },
          async (db) =>
            Promise.all([
              db.query<{
                id: string;
                role: string;
                agent_type: string;
                status: string;
              }>(
                `SELECT id, role, agent_type, status FROM internal_agents WHERE tenant_id = $1 ORDER BY created_at DESC`,
                [tenantId],
              ),
              db.query<{ id: string; name: string; status: string }>(
                `SELECT id, name, status FROM external_agents WHERE tenant_id = $1 ORDER BY created_at DESC`,
                [tenantId],
              ),
              // Post-BYOK-cutover identity surface. Migration 132
              // (byok_cutover_drop) DROPped claude_code_proxy_keys CASCADE and
              // moved the keys to the developer-proxy service, but this query
              // kept naming it — and because these run in a Promise.all, that
              // one dead query failed the WHOLE endpoint with
              // 'relation "claude_code_proxy_keys" does not exist'. A debug
              // endpoint that 500s is worse than one that reports nothing.
              //
              // mcp_tokens is the replacement the runtime-facing routes in
              // platform-tools-router already moved to, so the response keeps
              // its shape and `proxyKeys` stays populated.
              db.query<{ id: string; name: string }>(
                `SELECT id, name FROM mcp_tokens WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`,
                [tenantId],
              ),
              db.query<{ total: number }>(
                `SELECT COUNT(*)::int AS total FROM agent_audit_logs WHERE tenant_id = $1`,
                [tenantId],
              ),
              db.query<{ last24h: number }>(
                `SELECT COUNT(*)::int AS last24h FROM agent_audit_logs WHERE tenant_id = $1 AND created_at >= NOW() - INTERVAL '24 hours'`,
                [tenantId],
              ),
            ]),
        );

      // No audit row on this read endpoint (plan-literal: PR 0's audit-action
      // normalization table covers only routes that already wrote to
      // admin_action_audit on main). Pass `null` so wrapAdminResponse omits
      // the `audit` key.
      res.json(
        wrapAdminResponse(
          {
            internalAgents: internalAgents.rows.map((r) => ({
              id: r.id,
              role: r.role,
              agentType: r.agent_type,
              status: r.status,
            })),
            externalAgents: externalAgents.rows.map((r) => ({
              id: r.id,
              name: r.name,
              status: r.status,
            })),
            proxyKeys: proxyKeys.rows.map((r) => ({ id: r.id, name: r.name })),
            auditSummary: {
              total: auditTotal.rows[0]?.total ?? 0,
              last24h: auditLast24h.rows[0]?.last24h ?? 0,
            },
          },
          null,
        ),
      );
    } catch (error) {
      next(error);
    }
  },
);

// ── POST /api/admin/tenants/:id/upgrade-to-dedicated ──────────────────────
// Upgrade a shared-hosting tenant to dedicated hosting (its own GCP project).
//
// The FOR UPDATE row lock is held across the GCP provisioning call so a second
// concurrent caller blocks, then short-circuits with 409 idempotent. See
// upgrade-to-dedicated.test.ts for the concurrency contract.
adminRouter.post(
  '/tenants/:id/upgrade-to-dedicated',
  validateRequest({ params: idParam }),
  async (req, res, next) => {
    try {
      const tenantId = req.params.id;
      const environment = process.env.ENVIRONMENT || 'dev';
      const adminAccount = (req as { adminAccount?: { id: string; email: string } }).adminAccount;

      type UpgradeOutcome =
        | { kind: 'not_found' }
        | { kind: 'already_dedicated'; gcpProjectId: string | null }
        | { kind: 'not_allowlisted' }
        | { kind: 'provisioning_failed'; error?: string }
        | { kind: 'success'; gcpProjectId: string; buildId: string };

      const outcome: UpgradeOutcome = await withAdminScope(
        {
          caller: 'admin.upgrade-to-dedicated',
          actor: req.ctx?.adminId ?? 'admin:no-id',
          reason: 'row-lock + GCP provision + flip hosting_mode',
        },
        async (client) => {
          const r = await client.query<{
            id: string;
            account_id: string;
            name: string;
            hosting_mode: string;
            gcp_project_id: string | null;
          }>(
            `SELECT id, account_id, name, hosting_mode, gcp_project_id
             FROM tenants WHERE id = $1 FOR UPDATE`,
            [tenantId],
          );
          const locked = r.rows[0] ?? null;

          if (!locked) return { kind: 'not_found' };
          if (locked.hosting_mode === 'dedicated') {
            return { kind: 'already_dedicated', gcpProjectId: locked.gcp_project_id };
          }

          // Dedicated hosting is a premium tier, and provisioning it creates
          // real billable infrastructure that is awkward to unwind. Admin
          // authentication says the caller MAY run admin routes; it does not
          // say this customer was sold a dedicated project. That agreement is
          // recorded separately, by hand, in dedicated_hosting_allowlist —
          // read inside the same row lock so an approval revoked mid-flight
          // cannot be raced.
          const approval = await client.query<{ approved_by: string }>(
            `SELECT approved_by FROM dedicated_hosting_allowlist
              WHERE tenant_id = $1 AND revoked_at IS NULL`,
            [tenantId],
          );
          if (approval.rows.length === 0) {
            return { kind: 'not_allowlisted' };
          }

          const provisioningResult =
            await infrastructureProvisioningService.provisionTenantInfrastructure({
              tenantId: locked.id,
              accountId: locked.account_id,
              tenantName: locked.name,
              environment,
              tier: 'enterprise',
            });

          if (!provisioningResult.success || !provisioningResult.gcpProjectId) {
            return { kind: 'provisioning_failed', error: provisioningResult.error };
          }

          // Cross-env guard. Provisioning produces a project name like
          // `tenant-<slug>-${env}`; refuse to persist if its env suffix
          // doesn't match the current platform-backend's ENVIRONMENT.
          // See src/tenants/validate-gcp-project-id.ts for rationale.
          assertGcpProjectIdMatchesEnv(provisioningResult.gcpProjectId);

          await client.query(
            `UPDATE tenants
             SET hosting_mode = 'dedicated', gcp_project_id = $2, database_name = $3, updated_at = NOW()
             WHERE id = $1`,
            [tenantId, provisioningResult.gcpProjectId, `tenant-${tenantId}-db`],
          );

          return {
            kind: 'success',
            gcpProjectId: provisioningResult.gcpProjectId,
            buildId: provisioningResult.buildId ?? '',
          };
        },
      );

      if (outcome.kind === 'not_found') {
        return res.status(404).json(adminError('tenant_not_found'));
      }
      if (outcome.kind === 'already_dedicated') {
        return res.status(409).json(
          adminError(
            'tenant_already_dedicated',
            `gcpProjectId=${outcome.gcpProjectId ?? 'unknown'}`,
          ),
        );
      }
      if (outcome.kind === 'not_allowlisted') {
        // 409, not 403: the caller's admin rights are fine, the TENANT is not
        // approved. A 403 would send an operator hunting for a permissions
        // problem that does not exist.
        log.warn(
          { tenantId },
          'admin upgrade-to-dedicated: tenant is not on the dedicated-hosting allowlist',
        );
        return res.status(409).json(
          adminError(
            'tenant_not_allowlisted_for_dedicated',
            'Add a row to dedicated_hosting_allowlist (tenant_id, approved_by, reason) first. '
            + 'Dedicated hosting provisions billable infrastructure, so the commercial decision is '
            + 'recorded before the button works.',
          ),
        );
      }
      if (outcome.kind === 'provisioning_failed') {
        log.error(
          { tenantId, error: outcome.error },
          'admin upgrade-to-dedicated: provisioning failed',
        );
        return res.status(500).json(adminError('provisioning_failed', outcome.error));
      }

      logAudit('tenant.upgraded_to_dedicated', req.ctx, {
        tenantId,
        gcpProjectId: outcome.gcpProjectId,
        buildId: outcome.buildId,
      });

      const audit = await logAdminAction(
        adminAccount?.id ?? 'admin:no-id',
        'tenant.upgrade_to_dedicated',
        'tenant',
        tenantId,
        { gcpProjectId: outcome.gcpProjectId, buildId: outcome.buildId },
        req,
      );

      res.status(200).json(
        wrapAdminResponse(
          {
            tenantId,
            buildId: outcome.buildId,
            gcpProjectId: outcome.gcpProjectId,
          },
          audit,
        ),
      );
    } catch (error) {
      next(error);
    }
  },
);

// ── POST /api/admin/accounts/:id/reprovision ──────────────────────────────
// Heal an account orphaned by the pre-fix provisioning chain.
adminRouter.post(
  '/accounts/:id/reprovision',
  validateRequest({ params: idParam }),
  async (req, res, next) => {
    try {
      const accountId = req.params.id;
      const adminAccount = (req as { adminAccount?: { id: string; email: string } }).adminAccount;
      const accountService = new AccountService();
      const summary = await accountService.reprovision(accountId, req.ctx?.adminId ?? 'admin:no-id');

      logAudit('account.reprovisioned', req.ctx, {
        accountId,
        stripeCustomerCreated: summary.stripeCustomerCreated,
        tenantsReactivated: summary.tenantsReactivated.length,
      });

      const audit = await logAdminAction(
        adminAccount?.id ?? 'admin:no-id',
        'account.reprovision',
        'account',
        accountId,
        {
          stripeCustomerCreated: summary.stripeCustomerCreated,
          tenantsReactivated: summary.tenantsReactivated.length,
        },
        req,
      );

      res.status(200).json(wrapAdminResponse(summary, audit));
    } catch (error) {
      if (error instanceof AccountNotFoundError) {
        return res.status(404).json(adminError('account_not_found', `accountId=${error.accountId}`));
      }
      next(error);
    }
  },
);

// ── DELETE /api/admin/accounts/:id?cascade=true[&dryRun=true] ─────────────
// Hard-delete an account + all owned tenants. Case-insensitive booleans
// (see cascade-delete-route.test.ts for the parsing contract).
adminRouter.delete(
  '/accounts/:id',
  validateRequest({
    params: idParam,
    query: z.object({
      cascade: z.string().optional(),
      dryRun: z.string().optional(),
    }),
  }),
  async (req, res, next) => {
    try {
      const cascade = String(req.query.cascade ?? '').toLowerCase() === 'true';
      if (!cascade) {
        return res
          .status(400)
          .json(adminError('cascade_required', 'cascade=true required for hard delete'));
      }
      const dryRun = String(req.query.dryRun ?? '').toLowerCase() === 'true';
      const accountId = req.params.id;
      const adminAccount = (req as { adminAccount?: { id: string; email: string } }).adminAccount;

      const accountService = new AccountService();
      const summary = await accountService.cascadeDelete(
        accountId,
        req.ctx?.adminId ?? 'admin:no-id',
        { dryRun },
      );

      logAudit(dryRun ? 'account.cascade_delete.dry_run' : 'account.cascade_deleted', req.ctx, {
        accountId,
        tenantsAffected: summary.tenantsAffected,
        memberRowsAcrossOtherTenants: summary.memberRowsAcrossOtherTenants,
        stripeCustomerDeleted: summary.stripeCustomerDeleted,
        firebaseUserDeleted: summary.firebaseUserDeleted,
      });

      const audit = await logAdminAction(
        adminAccount?.id ?? 'admin:no-id',
        'account.cascade_delete',
        'account',
        accountId,
        {
          dryRun,
          tenantsAffected: summary.tenantsAffected,
          memberRowsAcrossOtherTenants: summary.memberRowsAcrossOtherTenants,
          stripeCustomerDeleted: summary.stripeCustomerDeleted,
          firebaseUserDeleted: summary.firebaseUserDeleted,
        },
        req,
      );

      res.status(200).json(wrapAdminResponse(summary, audit));
    } catch (error) {
      if (error instanceof AccountNotFoundError) {
        return res.status(404).json(adminError('account_not_found', `accountId=${error.accountId}`));
      }
      next(error);
    }
  },
);

// ── Signup approvals (email Approve/Waitlist front door) ────────────────────
// The emails sent to signups@example.com carry a signed token identifying the
// new signup. The Approve/Waitlist buttons open the authenticated
// /signup-approval page, which calls these endpoints as a logged-in platform
// admin (adminAuthMiddleware above). The token authenticates WHICH signup; the
// admin session authenticates WHO is deciding. Success uses the standard
// { data, audit } envelope (wrapAdminResponse); an expired token → 410, an
// invalid one → 400.

const signupApprovalTokenParam = { params: z.object({ token: z.string().min(1) }) };
const signupApprovalTokenBody = { body: z.object({ token: z.string().min(1) }) };

// Map a failed token verification to its HTTP status: expired links get 410 so
// the approval page can show a precise "expired" state, everything else 400.
function tokenErrorStatus(reason: 'invalid' | 'expired'): number {
  return reason === 'expired' ? 410 : 400;
}

// GET metadata for display on the approval page.
adminRouter.get(
  '/signup-approvals/:token',
  validateRequest(signupApprovalTokenParam),
  async (req, res, next) => {
    try {
      const verdict = verifySignupApprovalToken(req.params.token);
      if (!verdict.ok) {
        return res.status(tokenErrorStatus(verdict.reason)).json(adminError(`token_${verdict.reason}`));
      }
      const accountService = new AccountService();
      const account = await accountService.getById(verdict.accountId);
      if (!account) {
        return res.status(404).json(adminError('account_not_found', `accountId=${verdict.accountId}`));
      }
      const access = await accountService.computeAccess(account);
      res.json(
        wrapAdminResponse(
          {
            firstName: account.firstName,
            lastName: account.lastName,
            email: account.email,
            accessGranted: access.accessGranted,
          },
          null,
        ),
      );
    } catch (error) {
      next(error);
    }
  },
);

// Approve: grant access (access_status='approved') + welcome the user.
adminRouter.post(
  '/signup-approvals/approve',
  validateRequest(signupApprovalTokenBody),
  async (req, res, next) => {
    try {
      const verdict = verifySignupApprovalToken(req.body.token);
      if (!verdict.ok) {
        return res.status(tokenErrorStatus(verdict.reason)).json(adminError(`token_${verdict.reason}`));
      }
      const adminAccount = (req as { adminAccount?: { id: string; email: string } }).adminAccount;
      const adminId = adminAccount?.id ?? 'admin:no-id';

      const accountService = new AccountService();
      const account = await accountService.getById(verdict.accountId);
      if (!account) {
        return res.status(404).json(adminError('account_not_found', `accountId=${verdict.accountId}`));
      }

      // Grant is idempotent: only flip the status + write the audit row when the
      // account isn't already approved. A re-approve (e.g. a retry after the
      // welcome email below failed) skips the redundant write but STILL re-sends
      // the welcome, so the welcome is delivered at-least-once, never dropped.
      const alreadyApproved = account.accessStatus === 'approved';
      let audit: AdminAuditRecord | null = null;
      if (!alreadyApproved) {
        const accountRepository = new AccountRepository();
        await accountRepository.setAccessStatus(account.id, 'approved', adminId);
        audit = await logAdminAction(
          adminId,
          'account.signup_approval.approve',
          'account',
          account.id,
          { email: account.email },
          req,
        );
      }

      // Welcome email is transactional: sent inline with failures propagating
      // (→ 500), exactly like signup verification (accounts/router.ts). The
      // access grant already committed, so the admin's retry is a no-op on
      // access and simply re-sends the welcome — the send is never swallowed.
      await sendWelcomeEmail(account.email, account.firstName);

      res.json(wrapAdminResponse({ approved: true, alreadyApproved }, audit));
    } catch (error) {
      next(error);
    }
  },
);

// Waitlist: record the decision (access_status='waitlisted'); no access change.
adminRouter.post(
  '/signup-approvals/waitlist',
  validateRequest(signupApprovalTokenBody),
  async (req, res, next) => {
    try {
      const verdict = verifySignupApprovalToken(req.body.token);
      if (!verdict.ok) {
        return res.status(tokenErrorStatus(verdict.reason)).json(adminError(`token_${verdict.reason}`));
      }
      const adminAccount = (req as { adminAccount?: { id: string; email: string } }).adminAccount;
      const adminId = adminAccount?.id ?? 'admin:no-id';

      const accountService = new AccountService();
      const account = await accountService.getById(verdict.accountId);
      if (!account) {
        return res.status(404).json(adminError('account_not_found', `accountId=${verdict.accountId}`));
      }

      // "Waitlist" must never change an already-granted user's access. If the
      // account was already approved, downgrading to 'waitlisted' would REVOKE
      // access — so it's a no-op here (honors "no change for them").
      if (account.accessStatus === 'approved') {
        return res.json(wrapAdminResponse({ waitlisted: false, alreadyApproved: true }, null));
      }

      const accountRepository = new AccountRepository();
      await accountRepository.setAccessStatus(account.id, 'waitlisted', adminId);
      const audit = await logAdminAction(
        adminId,
        'account.signup_approval.waitlist',
        'account',
        account.id,
        { email: account.email },
        req,
      );

      res.json(wrapAdminResponse({ waitlisted: true }, audit));
    } catch (error) {
      next(error);
    }
  },
);

// ── Signup pre-approvals (the guest list) ───────────────────────────────────
// Clearing someone BEFORE they sign up. The Approve/Waitlist flow above can
// only run after the account row exists, which means a prospect you already
// know is coming still has to hit /request-invite and wait for a human. An
// entry here is spent by AccountService.create, so the matching signup is born
// approved and walks straight in.
//
// Entries are consumed rather than deleted (migration 341) — the spent row is
// the record of who cleared whom, and the one-shot semantics stop a
// delete-and-resignup from being auto-granted a second time.

const preapprovalBody = {
  body: z.object({
    // .trim() before .email() so a pasted address with trailing whitespace is
    // accepted rather than 400ing on something invisible. The handler still
    // runs normalizeSignupEmail for the lowercasing.
    email: z.string().trim().email(),
    note: z.string().max(500).optional(),
  }),
};
const preapprovalIdParam = { params: z.object({ id: z.string().uuid() }) };

// Add an address to the list — or, when the person has ALREADY signed up,
// approve them outright. Without that branch the row would sit here forever
// unspent (the check only fires at account creation) while the operator
// believed they had let someone in.
adminRouter.post(
  '/signup-preapprovals',
  validateRequest(preapprovalBody),
  async (req, res, next) => {
    try {
      const adminAccount = (req as { adminAccount?: { id: string; email: string } }).adminAccount;
      const adminId = adminAccount?.id ?? 'admin:no-id';
      // accounts.access_decided_by / signup_preapprovals.added_by are UUID FKs;
      // the 'admin:no-id' fallback is not a UUID, so it degrades to NULL rather
      // than failing the write.
      const adminUuid = adminAccount?.id ?? null;

      const email = normalizeSignupEmail(req.body.email);
      const note = req.body.note ?? null;

      const accountService = new AccountService();
      const existing = await accountService.getByEmail(email);

      if (existing) {
        const access = await accountService.computeAccess(existing);
        if (access.accessGranted) {
          // Already in — via domain, an earlier approval, or an invitation.
          // Nothing to do, and saying so beats a pre-approval that can never fire.
          return res.json(
            wrapAdminResponse(
              { mode: 'already_granted' as const, email, accountId: existing.id, accessReason: access.accessReason },
              null,
            ),
          );
        }

        const accountRepository = new AccountRepository();
        await accountRepository.setAccessStatus(existing.id, 'approved', adminUuid);
        const audit = await logAdminAction(
          adminId,
          'account.signup_preapproval.approve_existing',
          'account',
          existing.id,
          { email, note },
          req,
        );
        // Same contract as the Approve button: transactional, failures 500 so
        // the admin retries. The grant has committed, so a retry re-sends only.
        await sendWelcomeEmail(existing.email, existing.firstName);
        return res.json(
          wrapAdminResponse({ mode: 'approved_existing' as const, email, accountId: existing.id }, audit),
        );
      }

      const repo = new SignupPreapprovalRepository();
      const { entry, created } = await repo.add(email, adminUuid, note);
      const audit = created
        ? await logAdminAction(adminId, 'account.signup_preapproval.add', 'account', null, { email, note }, req)
        : null;
      res.status(created ? 201 : 200).json(
        wrapAdminResponse({ mode: 'preapproved' as const, created, entry }, audit),
      );
    } catch (error) {
      next(error);
    }
  },
);

// The list itself, live entries first. This is what makes consumption worth
// recording: "expected, not yet arrived" is only distinguishable from
// "arrived on the 12th" if somebody can see both.
adminRouter.get('/signup-preapprovals', async (_req, res, next) => {
  try {
    const repo = new SignupPreapprovalRepository();
    const entries = await repo.listAll();
    res.json(wrapAdminResponse({ entries }, null));
  } catch (error) {
    next(error);
  }
});

// Take a live entry back off the list. A consumed entry is history and cannot
// be revoked here — at that point the person has an account, and the lever is
// its access_status.
adminRouter.delete(
  '/signup-preapprovals/:id',
  validateRequest(preapprovalIdParam),
  async (req, res, next) => {
    try {
      const adminAccount = (req as { adminAccount?: { id: string; email: string } }).adminAccount;
      const adminId = adminAccount?.id ?? 'admin:no-id';

      const repo = new SignupPreapprovalRepository();
      const removed = await repo.revoke(req.params.id);
      if (!removed) {
        return res
          .status(404)
          .json(adminError('preapproval_not_found', 'no live pre-approval with that id'));
      }
      const audit = await logAdminAction(
        adminId,
        'account.signup_preapproval.revoke',
        'account',
        null,
        { email: removed.email },
        req,
      );
      res.json(wrapAdminResponse({ revoked: true, email: removed.email }, audit));
    } catch (error) {
      next(error);
    }
  },
);

// ── 404 catch-all ─────────────────────────────────────────────────────────
// Anything that didn't match a registered admin route. Logs the URL so we
// can spot stale runbooks via the admin_api_legacy_url_404 Cloud Logging
// alert (defined in liftoff-infrastructure-gcp).
adminRouter.all('*', (req, res) => {
  log.info(
    {
      msg: 'admin.api.404_legacy_url',
      path: req.originalUrl,
      method: req.method,
    },
    '404 on retired or unknown admin URL',
  );
  res.status(404).json(adminError('not_found'));
});
