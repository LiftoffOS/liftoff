// platform-backend → liftoff-billing, for the referral programme.
//
// Two reads and one scheduled job. The reads exist because every money figure
// on /dashboard/refer has to come from the money authority: the control plane
// serves the page but computes none of its amounts, and `creditRedeemable` /
// `canSendInvites` are the two flags the contract is most explicit about,
// because a local "does this workspace have a subscription" check would be
// wrong for billing-exempt tenants, enterprise contracts, and anyone whose
// subscription activated by webhook after they skipped the plan step.
//
// Authenticated with the same per-request HMAC as every other internal route
// here.

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { validateInboundBillingHmac } from '../infrastructure/platform-backend-client.js';
import type { ReferralCreditService } from './service.js';

export function registerReferralsInternalRouter(
  app: FastifyInstance,
  deps: {
    service: ReferralCreditService;
    billingServiceToken: string;
    log: { info: (msg: string, meta?: object) => void; error: (msg: string, meta?: object) => void };
  },
): void {
  const hmacPreHandler = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const valid = validateInboundBillingHmac(
      req.method,
      req.url.split('?')[0],
      JSON.stringify((req.body as object) ?? {}),
      {
        timestamp: req.headers['x-billing-timestamp'] as string | undefined,
        signature: req.headers['x-billing-signature'] as string | undefined,
      },
      deps.billingServiceToken,
    );
    if (!valid) return reply.code(401).send({ error: 'unauthorized' });
  };

  // ── POST /api/internal/referrals/summary ───────────────────────────────────
  //
  // The programme payload's money half, plus whether there is a subscription to
  // spend it against.

  app.post(
    '/api/internal/referrals/summary',
    { preHandler: hmacPreHandler },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { tenantId } = (req.body ?? {}) as { tenantId?: string };
      if (!tenantId) return reply.code(400).send({ error: 'tenantId_required' });
      try {
        return reply.code(200).send(await deps.service.summary(tenantId));
      } catch (err) {
        deps.log.error('referrals.summary_failed', {
          tenantId,
          error: err instanceof Error ? err.message : String(err),
        });
        return reply.code(500).send({ error: 'summary_failed' });
      }
    },
  );

  // ── POST /api/internal/referrals/credits ───────────────────────────────────
  //
  // The credit rows behind one page of the referrer's list. A page at a time
  // rather than in bulk, because the list is cursor-paginated and those are the
  // only rows the page can render.

  app.post(
    '/api/internal/referrals/credits',
    { preHandler: hmacPreHandler },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { tenantId, referralIds } = (req.body ?? {}) as {
        tenantId?: string;
        referralIds?: string[];
      };
      if (!tenantId) return reply.code(400).send({ error: 'tenantId_required' });
      try {
        const credits = await deps.service.creditsByReferral(tenantId, referralIds ?? []);
        return reply.code(200).send({ credits });
      } catch (err) {
        deps.log.error('referrals.credits_failed', {
          tenantId,
          error: err instanceof Error ? err.message : String(err),
        });
        return reply.code(500).send({ error: 'credits_failed' });
      }
    },
  );

  // ── POST /api/internal/referrals/credits/:referralId/disqualify ────────────
  //
  // The investigate-and-disqualify clause, reaching the money. platform-backend
  // owns the operator surface and the audit record; this is the half that can
  // actually move the credit, because billing is the only side that holds it.

  app.post<{ Params: { referralId: string } }>(
    '/api/internal/referrals/credits/:referralId/disqualify',
    { preHandler: hmacPreHandler },
    async (req: FastifyRequest<{ Params: { referralId: string } }>, reply: FastifyReply) => {
      const { referralId } = req.params;
      try {
        const result = await deps.service.disqualifyReferral(referralId);
        if (!result.found) return reply.code(404).send({ error: 'credit_not_found' });
        return reply.code(200).send(result);
      } catch (err) {
        deps.log.error('referrals.disqualify_failed', {
          referralId,
          error: err instanceof Error ? err.message : String(err),
        });
        return reply.code(500).send({ error: 'disqualify_failed' });
      }
    },
  );

  // ── POST /api/internal/referrals/tenants/:tenantId/forfeit ─────────────────
  //
  // Termination for cause or a terms violation: the workspace's whole unspent
  // balance, immediately and with no grace period.

  app.post<{ Params: { tenantId: string } }>(
    '/api/internal/referrals/tenants/:tenantId/forfeit',
    { preHandler: hmacPreHandler },
    async (req: FastifyRequest<{ Params: { tenantId: string } }>, reply: FastifyReply) => {
      const { tenantId } = req.params;
      try {
        return reply.code(200).send(await deps.service.forfeitForTermsViolation(tenantId));
      } catch (err) {
        deps.log.error('referrals.forfeit_failed', {
          tenantId,
          error: err instanceof Error ? err.message : String(err),
        });
        return reply.code(500).send({ error: 'forfeit_failed' });
      }
    },
  );

  // ── POST /api/internal/jobs/referral-credit-maintenance ────────────────────
  //
  // Daily Cloud Scheduler job, doing the two things that happen to a credit
  // purely because time passed: vesting and expiry.
  //
  // One job rather than two, run in that order on purpose. Vesting stamps the
  // expiry date, so a credit that vests today is not a candidate for expiry
  // until its own timer runs — and running expiry first would mean a full day
  // where a newly vested credit had an expiry nothing had checked.
  //
  // X-Service-Auth rather than HMAC, matching the other scheduled jobs here:
  // the caller is Cloud Scheduler, which cannot sign a body.

  app.post(
    '/api/internal/jobs/referral-credit-maintenance',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const token = req.headers['x-service-auth'];
      if (!token || token !== deps.billingServiceToken) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      try {
        const { vested } = await deps.service.runVesting();
        const { expired } = await deps.service.runExpiry();
        deps.log.info('referrals.maintenance_complete', { vested, expired });
        return reply.code(200).send({ vested, expired });
      } catch (err) {
        deps.log.error('referrals.maintenance_failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        return reply.code(500).send({ error: 'maintenance_failed' });
      }
    },
  );
}
