// Connect-RPC router wiring for liftoff-billing.
//
// Mounts every BillingService RPC at `/liftoff.billing.v1.BillingService/
// <RpcName>`. Connect-RPC handles content-negotiation
// (connect+json / connect+proto / gRPC-Web).

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type Stripe from 'stripe';
import type { ConnectRouter } from '@connectrpc/connect';
import { Code, ConnectError } from '@connectrpc/connect';
import { BillingService } from '@liftoffos/proto-gen';
import { fastifyConnectPlugin } from '@connectrpc/connect-fastify';
import {
  getSubscription,
  reportUsage,
  listInvoices,
  createCheckoutSession,
  replayEvents,
} from './handlers.js';
import {
  exportTenantData,
  deleteTenantUserData,
  type DataSubjectRequest,
} from './data-subject.js';

export interface RpcRouteDeps {
  pool: Pool;
  stripe: Stripe;
}

export function registerRpcRoutes(app: FastifyInstance, deps: RpcRouteDeps): void {
  void app.register(fastifyConnectPlugin, {
    routes(router: ConnectRouter) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      router.service(BillingService, ({
        async getSubscription(req: { tenantContext?: { tenantId?: string } }) {
          const tenantId = requireTenant(req.tenantContext?.tenantId);
          const result = await getSubscription(tenantId);
          return { subscription: result.subscription, planId: result.planId, creditBalance: result.creditBalance } as never;
        },
        async reportUsage(req: {
          tenantContext?: { tenantId?: string; userId?: string };
          vendor: string;
          requestId: string;
          eventType: string;
          quantity: bigint;
          occurredAt?: { seconds: bigint };
          costMicros?: bigint;
          agentId?: string;
          actionId?: string;
        }) {
          const tenantId = requireTenant(req.tenantContext?.tenantId);
          const occurred = req.occurredAt
            ? new Date(Number(req.occurredAt.seconds) * 1000)
            : new Date();
          const r = await reportUsage({
            tenantId,
            userId: req.tenantContext?.userId ?? null,
            vendor: String(req.vendor),
            requestId: req.requestId,
            eventType: req.eventType,
            quantity: BigInt(req.quantity),
            occurredAt: occurred,
            costMicros: req.costMicros === undefined ? null : BigInt(req.costMicros),
            agentId: req.agentId ?? null,
            actionId: req.actionId ?? null,
          }, deps.stripe);
          return r as never;
        },
        async listInvoices(req: {
          tenantContext?: { tenantId?: string };
          pagination?: { pageSize?: number; pageToken?: string };
          statusFilter?: string;
          issuedAfter?: { seconds: bigint };
          issuedBefore?: { seconds: bigint };
        }) {
          const tenantId = requireTenant(req.tenantContext?.tenantId);
          const pageSize = Math.min(200, Math.max(1, req.pagination?.pageSize ?? 50));
          const r = await listInvoices(tenantId, {
            pageSize,
            pageToken: req.pagination?.pageToken ?? null,
            statusFilter: req.statusFilter ?? null,
            issuedAfter: req.issuedAfter ? new Date(Number(req.issuedAfter.seconds) * 1000) : null,
            issuedBefore: req.issuedBefore ? new Date(Number(req.issuedBefore.seconds) * 1000) : null,
          });
          return r as never;
        },
        async createCheckoutSession(
          req: {
            tenantContext?: { tenantId?: string };
            planId: string;
            successUrl: string;
            cancelUrl: string;
            promoCode?: string;
          },
          context: import('@connectrpc/connect').HandlerContext,
        ) {
          const tenantId = requireTenant(req.tenantContext?.tenantId);
          const stripeCustomerId = context.requestHeader.get('x-account-stripe-customer-id') ?? undefined;
          const r = await createCheckoutSession(deps.stripe, tenantId, {
            planId: req.planId,
            successUrl: req.successUrl,
            cancelUrl: req.cancelUrl,
            promoCode: req.promoCode || null,
            stripeCustomerId,
          });
          return r as never;
        },
        async *replayEvents(req: { consumerId: string; since?: { seconds: bigint }; eventTypes?: string[] }) {
          const since = req.since ? new Date(Number(req.since.seconds) * 1000) : new Date(0);
          for await (const env of replayEvents(req.consumerId, since, req.eventTypes ?? null)) {
            yield env as never;
          }
        },
        async *exportTenantData(req: {
          tenantId: string;
          subjectUserId?: string;
          scope: string;
          requestedBy: string;
          expiresAt?: { seconds: bigint };
          authorizationHmac: Uint8Array;
        }) {
          const subjectRequest: DataSubjectRequest = {
            tenantId: req.tenantId,
            subjectUserId: req.subjectUserId ?? null,
            scope: req.scope === 'DATA_SCOPE_USER' || req.scope === 'user' ? 'user' : 'tenant',
            requestedBy: req.requestedBy,
            expiresAt: req.expiresAt ? new Date(Number(req.expiresAt.seconds) * 1000) : new Date(0),
            authorizationHmac: Buffer.from(req.authorizationHmac),
          };
          for await (const rec of exportTenantData(subjectRequest)) {
            yield {
              recordType: rec.recordType,
              sequence: rec.sequence,
              record: Buffer.from(JSON.stringify(rec.record) + '\n', 'utf-8'),
            } as never;
          }
        },
        async deleteTenantUserData(req: {
          tenantId: string;
          subjectUserId?: string;
          scope: string;
          requestedBy: string;
          expiresAt?: { seconds: bigint };
          authorizationHmac: Uint8Array;
        }) {
          const subjectRequest: DataSubjectRequest = {
            tenantId: req.tenantId,
            subjectUserId: req.subjectUserId ?? null,
            scope: req.scope === 'DATA_SCOPE_USER' || req.scope === 'user' ? 'user' : 'tenant',
            requestedBy: req.requestedBy,
            expiresAt: req.expiresAt ? new Date(Number(req.expiresAt.seconds) * 1000) : new Date(0),
            authorizationHmac: Buffer.from(req.authorizationHmac),
          };
          return (await deleteTenantUserData(subjectRequest)) as never;
        },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any);
    },
  });
  // ServiceClient is intentionally not wired here; this is the server
  // side. Callers wrap RPC calls with CallPolicy (Phase 0q).
  void deps.pool;
}

function requireTenant(tenantId: string | undefined): string {
  if (!tenantId) {
    throw new ConnectError('tenant_context.tenantId is required', Code.InvalidArgument);
  }
  return tenantId;
}
