// billing-accounts-router scrub + preflight-deletion tests — covers the
// internal HMAC-protected endpoints introduced for user-initiated account
// deletion (Phase 2 of the deletion plan).

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import type Stripe from 'stripe';
import { createHmac } from 'node:crypto';

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockFn = (): any => (jest.fn as any)();
/* eslint-enable @typescript-eslint/no-explicit-any */

let __testPool: Pool | null = null;
function setBillingTestPool(p: Pool): void { __testPool = p; }
jest.mock('./infrastructure/database.js', () => ({
  getPool: () => {
    if (!__testPool) throw new Error('scrub test pool not set');
    return __testPool;
  },
  withBillingTenant: async (_tenantId: string, fn: (client: PoolClient) => Promise<unknown>) => {
    if (!__testPool) throw new Error('scrub test pool not set');
    const client = await __testPool.connect();
    try { return await fn(client); } finally { client.release(); }
  },
  closePool: async () => undefined,
}));

import { registerBillingAccountsRouter } from './billing-accounts-router';
import type { PlatformBackendClient } from './infrastructure/platform-backend-client.js';

const TOKEN = 'test-billing-token';
const STRIPE_CUSTOMER = 'cus_scrub_test';
const ACCOUNT_ID = 'acc_scrub_test';
const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';
const EMAIL_HASH = 'a'.repeat(64);
const PHONE_HASH = 'b'.repeat(64);

interface FpRow {
  fingerprint: string;
  stripe_customer_id: string;
  customer_status: 'active' | 'deleted';
}

interface PmRow {
  id: string;
  tenant_id: string;
}

interface ScrubMockState {
  fingerprintRows: FpRow[];
  paymentMethodRows: PmRow[];
}

function signRequest(method: string, path: string, body: object): { timestamp: string; signature: string } {
  const ts = String(Date.now());
  const bodyStr = JSON.stringify(body ?? {});
  const signingString = `${method}\n${path}\n${ts}\n${bodyStr}`;
  const signature = createHmac('sha256', TOKEN).update(signingString).digest('hex');
  return { timestamp: ts, signature };
}

function mockPool(state: ScrubMockState, opts: {
  hasActiveSub?: boolean;
  hasOutstandingInvoice?: boolean;
} = {}): Pool {
  const queryFn = mockFn().mockImplementation((sql: string, params?: unknown[]) => {
    if (/^(BEGIN|COMMIT|ROLLBACK|SELECT set_config)/i.test(sql.trim())) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    if (sql.includes('UPDATE payment_method_fingerprints_seen')) {
      const customerId = (params as string[])[0];
      let count = 0;
      const returning: { fingerprint: string }[] = [];
      for (const row of state.fingerprintRows) {
        if (row.stripe_customer_id === customerId) {
          row.customer_status = 'deleted';
          count += 1;
          returning.push({ fingerprint: row.fingerprint });
        }
      }
      return Promise.resolve({ rows: returning, rowCount: count });
    }
    if (sql.includes('DELETE FROM payment_methods')) {
      const tenantIds = (params as string[][])[0];
      const before = state.paymentMethodRows.length;
      state.paymentMethodRows = state.paymentMethodRows.filter(r => !tenantIds.includes(r.tenant_id));
      return Promise.resolve({ rows: [], rowCount: before - state.paymentMethodRows.length });
    }
    if (sql.includes('FROM subscriptions') && sql.includes("status IN ('active','trialing','past_due','incomplete')")) {
      return Promise.resolve({ rows: opts.hasActiveSub ? [{}] : [], rowCount: opts.hasActiveSub ? 1 : 0 });
    }
    if (sql.includes('FROM invoices') && sql.includes("status IN ('open','past_due')")) {
      return Promise.resolve({ rows: opts.hasOutstandingInvoice ? [{}] : [], rowCount: opts.hasOutstandingInvoice ? 1 : 0 });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
  return {
    connect: mockFn().mockResolvedValue({ query: queryFn, release: mockFn() }),
    query: queryFn,
  } as unknown as Pool;
}

function mockStripe(overrides: {
  customersUpdate?: any;
  subsList?: any;
  subsCancel?: any;
} = {}): Stripe {
  return {
    customers: {
      update: overrides.customersUpdate ?? mockFn().mockResolvedValue({ id: STRIPE_CUSTOMER }),
    },
    subscriptions: {
      list: overrides.subsList ?? mockFn().mockResolvedValue({ data: [] }),
      cancel: overrides.subsCancel ?? mockFn().mockResolvedValue({}),
    },
  } as unknown as Stripe;
}

async function buildApp(args: {
  state: ScrubMockState;
  stripe?: Stripe;
  hasActiveSub?: boolean;
  hasOutstandingInvoice?: boolean;
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const pool = mockPool(args.state, { hasActiveSub: args.hasActiveSub, hasOutstandingInvoice: args.hasOutstandingInvoice });
  setBillingTestPool(pool);
  registerBillingAccountsRouter(app, {
    pool,
    stripe: args.stripe ?? mockStripe(),
    pbClient: {} as unknown as PlatformBackendClient,
    billingServiceToken: TOKEN,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  await app.ready();
  return app;
}

describe('POST /api/internal/billing/accounts/:stripeCustomerId/scrub', () => {
  let state: ScrubMockState;
  beforeEach(() => {
    state = {
      fingerprintRows: [
        { fingerprint: 'fp_1', stripe_customer_id: STRIPE_CUSTOMER, customer_status: 'active' },
        { fingerprint: 'fp_2', stripe_customer_id: STRIPE_CUSTOMER, customer_status: 'active' },
      ],
      paymentMethodRows: [
        { id: 'pm_db_1', tenant_id: TENANT_A },
        { id: 'pm_db_2', tenant_id: TENANT_A },
        { id: 'pm_db_3', tenant_id: TENANT_B },
      ],
    };
  });

  const PATH = `/api/internal/billing/accounts/${STRIPE_CUSTOMER}/scrub`;
  const BODY = { emailHash: EMAIL_HASH, phoneHash: PHONE_HASH, accountId: ACCOUNT_ID, tenantIds: [TENANT_A, TENANT_B] };

  it('scrub strips PII and writes hash metadata on the Stripe customer', async () => {
    const customersUpdate = mockFn().mockResolvedValue({ id: STRIPE_CUSTOMER });
    const stripe = mockStripe({ customersUpdate });
    const app = await buildApp({ state, stripe });
    try {
      const { timestamp, signature } = signRequest('POST', PATH, BODY);
      const res = await app.inject({
        method: 'POST',
        url: PATH,
        headers: { 'x-billing-timestamp': timestamp, 'x-billing-signature': signature },
        payload: BODY,
      });
      expect(res.statusCode).toBe(200);
      expect(customersUpdate).toHaveBeenCalledWith(STRIPE_CUSTOMER, expect.objectContaining({
        // Empty string clears scalar fields via Stripe's REST API; null
        // clears the address. The eligibility helper reads only metadata,
        // so the wire-level clearing values are what matters.
        email: '',
        name: '',
        phone: '',
        address: null,
        metadata: expect.objectContaining({
          email_sha256: EMAIL_HASH,
          phone_sha256: PHONE_HASH,
          accountId: ACCOUNT_ID,
        }),
      }));
    } finally {
      await app.close();
    }
  });

  it('scrub flips fingerprint rows from active to deleted', async () => {
    const app = await buildApp({ state });
    try {
      const { timestamp, signature } = signRequest('POST', PATH, BODY);
      const res = await app.inject({
        method: 'POST',
        url: PATH,
        headers: { 'x-billing-timestamp': timestamp, 'x-billing-signature': signature },
        payload: BODY,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().fingerprintsMarked).toBe(2);
      expect(state.fingerprintRows.every(r => r.customer_status === 'deleted')).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('scrub deletes payment_methods rows scoped to the passed tenantIds', async () => {
    const app = await buildApp({ state });
    try {
      const { timestamp, signature } = signRequest('POST', PATH, BODY);
      const res = await app.inject({
        method: 'POST',
        url: PATH,
        headers: { 'x-billing-timestamp': timestamp, 'x-billing-signature': signature },
        payload: BODY,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().paymentMethodsDeleted).toBe(3);
      expect(state.paymentMethodRows.length).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('scrub defensively cancels any active subscription', async () => {
    const subsCancel = mockFn().mockResolvedValue({});
    const stripe = mockStripe({
      subsList: mockFn().mockResolvedValue({ data: [{ id: 'sub_live' }] }),
      subsCancel,
    });
    const app = await buildApp({ state, stripe });
    try {
      const { timestamp, signature } = signRequest('POST', PATH, BODY);
      const res = await app.inject({
        method: 'POST',
        url: PATH,
        headers: { 'x-billing-timestamp': timestamp, 'x-billing-signature': signature },
        payload: BODY,
      });
      expect(res.statusCode).toBe(200);
      expect(subsCancel).toHaveBeenCalledWith('sub_live', expect.objectContaining({ invoice_now: false, prorate: false }));
      expect(res.json().subsCancelled).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('scrub is idempotent — second call on already-scrubbed customer is a no-op', async () => {
    const app = await buildApp({ state });
    try {
      for (let i = 0; i < 2; i++) {
        const { timestamp, signature } = signRequest('POST', PATH, BODY);
        const res = await app.inject({
          method: 'POST',
          url: PATH,
          headers: { 'x-billing-timestamp': timestamp, 'x-billing-signature': signature },
          payload: BODY,
        });
        expect(res.statusCode).toBe(200);
      }
    } finally {
      await app.close();
    }
  });

  it('scrub rejects request without valid HMAC headers (401)', async () => {
    const app = await buildApp({ state });
    try {
      const res = await app.inject({
        method: 'POST',
        url: PATH,
        headers: { 'x-billing-timestamp': String(Date.now()), 'x-billing-signature': 'deadbeef' },
        payload: BODY,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('scrub rejects request missing required body fields (400)', async () => {
    const app = await buildApp({ state });
    try {
      const badBody = { accountId: ACCOUNT_ID } as unknown as typeof BODY;
      const { timestamp, signature } = signRequest('POST', PATH, badBody);
      const res = await app.inject({
        method: 'POST',
        url: PATH,
        headers: { 'x-billing-timestamp': timestamp, 'x-billing-signature': signature },
        payload: badBody,
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

describe('POST /api/internal/billing/accounts/preflight-deletion', () => {
  const PATH = '/api/internal/billing/accounts/preflight-deletion';

  it('reports hasActiveSubscription=false / hasOutstandingInvoice=false when tenantIds empty', async () => {
    const app = await buildApp({ state: { fingerprintRows: [], paymentMethodRows: [] } });
    try {
      const body = { tenantIds: [] };
      const { timestamp, signature } = signRequest('POST', PATH, body);
      const res = await app.inject({
        method: 'POST',
        url: PATH,
        headers: { 'x-billing-timestamp': timestamp, 'x-billing-signature': signature },
        payload: body,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ hasActiveSubscription: false, hasOutstandingInvoice: false });
    } finally {
      await app.close();
    }
  });

  it('reports hasActiveSubscription=true when subscriptions table has an active row', async () => {
    const app = await buildApp({ state: { fingerprintRows: [], paymentMethodRows: [] }, hasActiveSub: true });
    try {
      const body = { tenantIds: [TENANT_A] };
      const { timestamp, signature } = signRequest('POST', PATH, body);
      const res = await app.inject({
        method: 'POST',
        url: PATH,
        headers: { 'x-billing-timestamp': timestamp, 'x-billing-signature': signature },
        payload: body,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().hasActiveSubscription).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('reports hasOutstandingInvoice=true when invoices table has open/past_due rows', async () => {
    const app = await buildApp({ state: { fingerprintRows: [], paymentMethodRows: [] }, hasOutstandingInvoice: true });
    try {
      const body = { tenantIds: [TENANT_A] };
      const { timestamp, signature } = signRequest('POST', PATH, body);
      const res = await app.inject({
        method: 'POST',
        url: PATH,
        headers: { 'x-billing-timestamp': timestamp, 'x-billing-signature': signature },
        payload: body,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().hasOutstandingInvoice).toBe(true);
    } finally {
      await app.close();
    }
  });
});
