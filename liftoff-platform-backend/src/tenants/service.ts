// Tenant Service Implementation
// Per Section 1: Tenant provisioning

import { Tenant, ProvisionTenantInput, MigrationResponse } from './types';
import { TenantRepository } from './repository';
import { EntitlementRepository } from '../entitlements/repository';
import { EntitlementService } from '../entitlements/service';
import { TenantMembersRepository } from '../tenant-members/repository';
import { publishEvent } from '../events/publisher';
import { log } from '../infrastructure/logging';
import { getPool } from '../infrastructure/database';
import { mutateAndPublishEvent } from '../events/publisher';
import { NoPaymentMethodError } from '../billing/billing-admin-client';
import { getBillingProvider } from '../billing/provider';
import { enqueueProvisioningOutbox, kickProvisioningOutbox } from '../billing/provisioning-outbox-worker';
import { ensurePayAsYouGoControlsRow } from '../billing/prepay-provisioning';


export class TenantService {
  private repository = new TenantRepository();
  private entitlementRepo = new EntitlementRepository();
  private entitlementService = new EntitlementService();
  private membersRepo = new TenantMembersRepository();

  async provision(input: ProvisionTenantInput): Promise<Tenant> {
    // hosting_mode is INDEPENDENT of tier — default 'shared' for all new signups.
    // Dedicated hosting is a manual post-creation upgrade via the admin
    // upgrade-to-dedicated endpoint. tier is preserved on the tenant row but
    // does NOT drive provisioning decisions.
    const tier = input.tier || 'standard';

    // Validate path if asserted by the caller (auto-provision hero path).
    if (input.onboardingPath !== undefined && input.onboardingPath !== 'A' && input.onboardingPath !== 'B') {
      throw new Error('Invalid onboardingPath; expected "A" or "B"');
    }

    // Server-side workspace-name derivation. When the caller omits `name`,
    // we resolve it from path + the account's firstName so the client never
    // dictates the default. Path B → neutral 'Personal Workspace' (the user
    // will pick a real name later in the fused-onboarding workspace_name
    // step). Path A or unknown → '{firstName}'s Workspace', falling back to
    // 'Personal Workspace' if firstName is empty.
    let resolvedName = input.name;
    if (!resolvedName || resolvedName.trim().length === 0) {
      const { AccountRepository } = await import('../accounts/repository');
      const accountRepo = new AccountRepository();
      const account = await accountRepo.findById(input.accountId);
      const firstName = account?.firstName?.trim() ?? '';
      resolvedName = input.onboardingPath === 'B' || !firstName
        ? 'Personal Workspace'
        : `${firstName}'s Workspace`;
    }
    const inputWithName: ProvisionTenantInput = { ...input, name: resolvedName };

    // Atomic provision: tenant + member + entitlement in a single transaction.
    // Uses withAdminScope (BYPASSRLS via liftoff_admin) because we're inserting
    // rows for a brand-new tenant that doesn't have app.current_tenant_id set yet.
    // A failure in any step rolls back all three — no orphan rows.
    //
    // NOTE: withAdminScope (packages/database/src/tenant-scope.ts) already
    // wraps the callback in BEGIN/COMMIT and ROLLBACKs on thrown errors.
    // Do NOT add an inner BEGIN/COMMIT/ROLLBACK here — nesting would
    // prematurely close the outer transaction and break the wrapper's
    // ROLLBACK-on-error guarantee. Just throw on failure.
    let tenant: Tenant;
    let entitlementId: string;
    try {
      // Canonical pattern: tenant + member + entitlement INSERTs
      // and the tenant.provisioned outbox row enqueued in the SAME tx. If the
      // outbox INSERT fails, the entity inserts roll back.
      const result = await mutateAndPublishEvent<{ tenant: Tenant; entitlementId: string }>(
        {
          caller: 'TenantService.provision',
          actor: input.accountId,
          reason: 'new tenant signup + tenant.provisioned event',
        },
        async (client) => {
          const t = await this.repository.createInTx(client, inputWithName);
          await this.membersRepo.createMemberInTx(client, {
            tenantId: t.id,
            accountId: input.accountId,
            role: 'owner',
          });
          const e = await this.entitlementRepo.createInTx(client, {
            tenantId: t.id,
            tenantOperationalStatus: 'pending',
          });
          return {
            entity: { tenant: t, entitlementId: e.id },
            eventInput: {
              entityType: 'tenant',
              entityId: t.id,
              eventType: 'tenant.provisioned',
              entityVersion: 1,
              eventVersion: 1,
              tenantId: t.id,
              payload: {
                accountId: t.accountId,
                name: t.name,
                entitlementId: e.id,
                tier,
                hostingMode: t.hostingMode,
              },
            },
          };
        },
      );
      tenant = result.tenant;
      entitlementId = result.entitlementId;
    } catch (err) {
      log.error(
        { accountId: input.accountId, error: (err as Error).message },
        'tenant provision transaction rolled back',
      );
      throw err;
    }

    log.info(
      { tenantId: tenant.id, accountId: input.accountId, entitlementId },
      'Tenant + owner membership + entitlement + tenant.provisioned outbox row committed atomically',
    );

    // A referral bound at account creation has been waiting for a workspace to
    // point at. Filling it here is what makes `referrals.referred_tenant_id`
    // UNIQUE do its job: that one constraint is what enforces "a workspace can
    // be referred once, ever", and the earning event months later reads the
    // tenant, not the account.
    //
    // Only the account's FIRST workspace can claim it, which the repository
    // checks: a later one must not inherit an attribution that was never about
    // it. So this is a no-op for everyone except a genuinely referred signup.
    // Best-effort — attachReferredTenant never throws, because losing the
    // attribution must not fail provisioning.
    //
    // Imported here rather than at the top of the file for the same reason
    // AccountRepository is above: this module is loaded during startup wiring,
    // and the referral service pulls in the billing client and the mailer,
    // neither of which provisioning should drag into that graph.
    const { ReferralService } = await import('../referrals/service');
    await new ReferralService().attachReferredTenant(input.accountId, tenant.id);

    // Shared hosting is the default path for all new signups. Wire the runtime
    // URL + activate the tenant immediately (no infrastructure provisioning to wait for).
    const sharedRuntimeUrl = process.env.SHARED_RUNTIME_URL;
    if (sharedRuntimeUrl) {
      await this.repository.updateRuntimeUrl(tenant.id, sharedRuntimeUrl);
    }
    tenant = await this.activate(tenant.id);

    log.info(
      { tenantId: tenant.id, tier, hostingMode: tenant.hostingMode },
      'tenant provisioned and activated',
    );
    return tenant;
  }

  async getById(id: string): Promise<Tenant | null> {
    return this.repository.findById(id);
  }

  async getByAccountId(accountId: string): Promise<Tenant[]> {
    return this.repository.findByAccountId(accountId);
  }

  async listAll(): Promise<Tenant[]> {
    return this.repository.findAll();
  }

  async activate(id: string): Promise<Tenant> {
    const tenant = await this.repository.updateStatus(id, 'active');

    // Agents are gated on payment — only enabled once the Stripe subscription
    // becomes active. Set false here; the provisionSubscription call below
    // flips it to true if the subscription is already active (alreadyExists=true).
    // Otherwise the Stripe webhook subscription-activated handler flips it.
    //
    // Canonical pattern: entitlement update + tenant.activated
    // outbox enqueue commit in the same tx. publishOutboxRowInline fires
    // post-commit and never throws.
    await mutateAndPublishEvent(
      { caller: 'TenantService.activate', reason: 'entitlement → active + tenant.activated event' },
      async (client) => {
        await this.entitlementRepo.updateInTx(client, id, {
          tenantOperationalStatus: 'active',
          // False under Stripe, where the subscription webhook turns it on.
          // True when the deployment has no billing system, because nothing
          // else is ever going to — see src/billing/provider.ts.
          agentExecutionAllowed: getBillingProvider().executionAllowedOnActivation,
        });
        return {
          entity: undefined as void,
          eventInput: {
            entityType: 'tenant',
            entityId: id,
            eventType: 'tenant.activated',
            entityVersion: 1,
            eventVersion: 1,
            tenantId: id,
            payload: {},
          },
        };
      },
    );

    // Seed the billing_controls row BEFORE provisioning, because provisioning
    // is allowed to fail. A self-serve signup has no card yet, so the Stripe
    // call below throws NoPaymentMethodError by design and no row would ever be
    // written — leaving a workspace that cannot be funded and cannot subscribe
    // from anywhere except the plan picker.
    //
    // Not fatal to activation. The row is idempotent and subscribing creates an
    // equivalent one, so a failure here costs the ability to buy credit, not the
    // ability to sign up. Logged at error with a distinct event so it is
    // alertable rather than silent.
    await ensurePayAsYouGoControlsRow(tenant.accountId).catch((err: Error) =>
      log.error(
        { tenantId: id, accountId: tenant.accountId, err: err.message, event: 'billing.controls.payg_seed_failed' },
        'tenant activated without a billing_controls row — the workspace cannot buy credit until one exists',
      ),
    );

    // SYNCHRONOUS provisionSubscription on the happy path.
    // Per plan Decision B: the architecture must prevent unprovisioned tenants
    // from ever rendering the dashboard — so we wait for billing setup before
    // returning. On failure, enqueue outbox row and continue (the worker retries
    // with exponential backoff — see provisioning-outbox-worker.ts).
    let provisioned = false;
    try {
      const stripeCustomerId = await this.getAccountStripeCustomerId(tenant.accountId);
      const result = await getBillingProvider().provisionSubscription(tenant.id, stripeCustomerId);
      // null means there was nothing to provision, which is not a failure and
      // must not reach the catch below: the outbox would retry forever against
      // a deployment that has no billing system.
      if (result === null) {
        log.info({ tenantId: id }, 'billing: no billing system configured — nothing to provision');
      } else if (result.alreadyExists) {
        // Subscription already active — the subscription-activated webhook will
        // not re-fire, so enable execution here. Through the service, not a raw
        // UPDATE: the raw form left `version` unchanged and published nothing,
        // so nobody downstream could observe that this tenant had just been
        // cleared to run agents. The service opens its own tenant scope, so the
        // missing app.current_tenant_id on this connection is not a problem.
        await this.entitlementService.enableAgentExecution(id);
        log.info({ tenantId: id }, 'billing: subscription already exists — agent execution enabled directly');
      }
      provisioned = true;
    } catch (err) {
      // The customer has no card yet. That is the NORMAL state for a self-serve
      // signup: the fused-onboarding wizard collects payment at step 7 and this
      // runs at step 0, so Stripe can only reject. Do NOT enqueue — the outbox
      // would spend its full 10-attempt budget over ~2 days on a condition no
      // retry can fix, and the subscription the user actually wants is created
      // later by /subscribe with the plan they picked (this path hardcodes Core
      // monthly, which would be the wrong plan for Growth/Scale anyway).
      //
      // Tenants that legitimately provision without a card still work: the
      // test-account script attaches a 100%-off coupon, so the invoice is $0
      // and Stripe never raises this error.
      if (err instanceof NoPaymentMethodError) {
        log.info(
          { tenantId: id, accountId: tenant.accountId },
          'subscription provisioning deferred to the onboarding payment step — customer has no payment method yet',
        );
      } else {
        log.warn(
          { tenantId: id, err: (err as Error).message },
          'provisionSubscription failed inline — enqueueing outbox for retry',
        );
        // Belt-and-suspenders: if the outbox INSERT itself fails (DB outage at
        // exactly this moment), don't bubble the error up. The tenant row is
        // already status='active', but no retry mechanism is in place — log
        // CRITICAL so ops can manually call reprovision later.
        try {
          const { inserted } = await enqueueProvisioningOutbox(tenant.id, tenant.accountId);
          if (!inserted) {
            log.info(
              { tenantId: id, accountId: tenant.accountId },
              'outbox row already exists for this tenant+action, skipping enqueue',
            );
          }
          // Only kick when WE enqueued; an existing pending row will be picked up by the next poll.
          if (inserted) {
            kickProvisioningOutbox();
          }
        } catch (enqueueErr) {
          log.error(
            {
              tenantId: id,
              accountId: tenant.accountId,
              primaryError: (err as Error).message,
              enqueueError: (enqueueErr as Error).message,
            },
            'CRITICAL: provisionSubscription failed AND outbox enqueue also failed — tenant is active without billing; manual ops via POST /api/admin/accounts/:id/reprovision required',
          );
        }
      }
    }

    log.info({ tenantId: id, provisioned }, 'tenant activated');
    return tenant;
  }

  // Helper: read accounts.stripe_customer_id without depending on a request
  // tenant context. accounts is a platform-global table (no RLS) so getPool()
  // is safe here.
  private async getAccountStripeCustomerId(accountId: string): Promise<string | null> {
    const result = await getPool().query<{ stripe_customer_id: string | null }>(
      'SELECT stripe_customer_id FROM accounts WHERE id = $1',
      [accountId],
    );
    return result.rows[0]?.stripe_customer_id ?? null;
  }

  async suspend(id: string): Promise<Tenant> {
    const tenant = await this.repository.updateStatus(id, 'suspended');

    // Canonical pattern: entitlement update + tenant.suspended
    // outbox enqueue in same tx, inline publish post-commit.
    await mutateAndPublishEvent(
      { caller: 'TenantService.suspend', reason: 'entitlement → suspended + tenant.suspended event' },
      async (client) => {
        await this.entitlementRepo.updateInTx(client, id, {
          tenantOperationalStatus: 'suspended',
          agentExecutionAllowed: false,
        });
        return {
          entity: undefined as void,
          eventInput: {
            entityType: 'tenant',
            entityId: id,
            eventType: 'tenant.suspended',
            entityVersion: 1,
            eventVersion: 1,
            tenantId: id,
            payload: {},
          },
        };
      },
    );

    return tenant;
  }

  async reactivate(id: string): Promise<Tenant> {
    const tenant = await this.repository.updateStatus(id, 'active');

    await mutateAndPublishEvent(
      { caller: 'TenantService.reactivate', reason: 'entitlement → active + tenant.reactivated event' },
      async (client) => {
        await this.entitlementRepo.updateInTx(client, id, {
          tenantOperationalStatus: 'active',
          agentExecutionAllowed: true,
        });
        return {
          entity: undefined as void,
          eventInput: {
            entityType: 'tenant',
            entityId: id,
            eventType: 'tenant.reactivated',
            entityVersion: 1,
            eventVersion: 1,
            tenantId: id,
            payload: {},
          },
        };
      },
    );

    return tenant;
  }

  async updateName(id: string, name: string): Promise<Tenant> {
    return this.repository.updateName(id, name);
  }

  async updateOnboardingProgress(
    id: string,
    fields: import('./types').OnboardingProgressUpdate,
  ): Promise<Tenant> {
    return this.repository.updateOnboardingProgress(id, fields);
  }

  // updateFullDistillStatus lived here — the service wrapper for the
  // full-distill status columns. Gone with the deferred post-payment distill
  // (ADR-050).


  async updateMigrationStatus(id: string, status: 'pending' | 'in_progress' | 'completed' | 'failed'): Promise<Tenant> {
    const tenant = await this.repository.updateMigrationStatus(id, status);

    // Per Section 4: Publish migration events
    if (status === 'in_progress') {
      await publishEvent({
        entityType: 'tenant',
        entityId: id,
        eventType: 'tenant.migration.started',
        entityVersion: 1,
        eventVersion: 1,
        tenantId: id,
        payload: {},
      });
    } else if (status === 'completed') {
      await publishEvent({
        entityType: 'tenant',
        entityId: id,
        eventType: 'tenant.migration.completed',
        entityVersion: 1,
        eventVersion: 1,
        tenantId: id,
        payload: {},
      });
      // If migration completed, activate the tenant
      return this.activate(id);
    }

    return tenant;
  }

  async updateGcpProject(id: string, gcpProjectId: string, databaseName: string): Promise<Tenant> {
    return this.repository.updateGcpProject(id, gcpProjectId, databaseName);
  }

  async getMigrationInfo(tenantId: string): Promise<MigrationResponse | null> {
    const status = await this.repository.getMigrationStatus(tenantId);
    if (!status) {
      return null;
    }

    const history = await this.repository.getMigrationHistory(tenantId);

    return {
      status,
      history,
    };
  }
}
