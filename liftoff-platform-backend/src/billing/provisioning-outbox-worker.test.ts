// Provisioning Outbox Worker — unit tests
// Covers: enqueue (incl. duplicate), reaper, claim, success path, retry-backoff
// path, fail-after-max-attempts, alreadyExists entitlement flip, kick via
// setImmediate, finalize-failure resilience.

const mockAdminQuery = jest.fn();

jest.mock('../infrastructure/database', () => ({
  // withAdminScope passes a fake client whose .query delegates to mockAdminQuery.
  // The helper itself already owns the BEGIN/COMMIT — the worker no longer
  // issues explicit transaction control inside claimOne.
  withAdminScope: jest.fn(async (_ctx: unknown, fn: (c: { query: jest.Mock }) => unknown) =>
    fn({ query: mockAdminQuery }),
  ),
}));

jest.mock('../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockProvisionSubscription = jest.fn();
jest.mock('./billing-admin-client', () => ({
  // Spread the real module so NoPaymentMethodError is the SAME class the worker
  // imports. A hand-rolled stub would make `err instanceof NoPaymentMethodError`
  // false, and the deferred branch would silently never be taken — the test
  // would pass while testing nothing.
  ...jest.requireActual('./billing-admin-client'),
  getBillingAdminClient: jest.fn(() => ({
    provisionSubscription: mockProvisionSubscription,
  })),
}));

// Enabling execution goes through the entitlement service, not a raw UPDATE:
// the raw form left `version` unchanged and published no event, so the tenant
// runtime's cached entitlement never learned the tenant had been cleared to run
// agents.
const mockEnableAgentExecution = jest.fn().mockResolvedValue(undefined);
jest.mock('../entitlements/service', () => ({
  EntitlementService: jest.fn().mockImplementation(() => ({
    enableAgentExecution: mockEnableAgentExecution,
  })),
}));

import {
  enqueueProvisioningOutbox,
  kickProvisioningOutbox,
  runProvisioningOutboxOnce,
} from './provisioning-outbox-worker';
import { NoPaymentMethodError } from './billing-admin-client';

// Helper: every runProvisioningOutboxOnce invocation begins with a reaper
// UPDATE (returning rowCount=0 in most tests, since no stuck rows). Each test
// queues that first. The reaper now uses RETURNING id so rows=[] when
// rowCount=0.
function queueReaperNoop() {
  mockAdminQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });
}

describe('provisioning-outbox-worker', () => {
  beforeEach(() => {
    mockAdminQuery.mockReset();
    mockProvisionSubscription.mockReset();
    mockEnableAgentExecution.mockClear();
  });

  describe('enqueueProvisioningOutbox', () => {
    it('inserts a pending row with action=provision_subscription and returns inserted=true on rowCount=1', async () => {
      mockAdminQuery.mockResolvedValueOnce({ rowCount: 1 });
      const result = await enqueueProvisioningOutbox('tenant-1', 'account-1');
      expect(result).toEqual({ inserted: true });
      expect(mockAdminQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockAdminQuery.mock.calls[0];
      expect(sql).toMatch(/INSERT INTO provisioning_outbox/);
      expect(sql).toMatch(/'provision_subscription'/);
      expect(sql).toMatch(/ON CONFLICT/);
      expect(sql).toMatch(/DO NOTHING/);
      expect(params).toEqual(['tenant-1', 'account-1']);
    });

    it('handles a duplicate enqueue as a no-op (returns inserted=false on rowCount=0)', async () => {
      mockAdminQuery.mockResolvedValueOnce({ rowCount: 0 });
      await expect(
        enqueueProvisioningOutbox('tenant-1', 'account-1'),
      ).resolves.toEqual({ inserted: false });
      expect(mockAdminQuery).toHaveBeenCalledTimes(1);
    });
  });

  describe('reaper', () => {
    it('resets in_progress rows whose updated_at is older than threshold to pending', async () => {
      // Reaper UPDATE returns rowCount=2 (two stuck rows reset), then the
      // claim returns no due rows.
      mockAdminQuery
        .mockResolvedValueOnce({
          rowCount: 2,
          rows: [{ id: 'stuck-1' }, { id: 'stuck-2' }],
        }) // reaper
        .mockResolvedValueOnce({ rows: [] });    // claim returns nothing

      await runProvisioningOutboxOnce();

      const reapCall = mockAdminQuery.mock.calls[0];
      expect(reapCall[0]).toMatch(/UPDATE provisioning_outbox/);
      expect(reapCall[0]).toMatch(/status = 'pending'/);
      expect(reapCall[0]).toMatch(/status = 'in_progress'/);
      // Threshold is parameterized via $1 || ' minutes'.
      expect(reapCall[0]).toMatch(/\$1 \|\| ' minutes'/);
      expect(reapCall[0]).toMatch(/RETURNING id/);
      // Default threshold is 5 minutes; passed as a stringified integer.
      expect(reapCall[1]).toEqual(['5']);
    });

    it('honours OUTBOX_REAPER_THRESHOLD_MIN env var for the interval', async () => {
      const prev = process.env.OUTBOX_REAPER_THRESHOLD_MIN;
      process.env.OUTBOX_REAPER_THRESHOLD_MIN = '12';
      try {
        mockAdminQuery
          .mockResolvedValueOnce({ rowCount: 0, rows: [] })
          .mockResolvedValueOnce({ rows: [] });
        await runProvisioningOutboxOnce();
        const reapCall = mockAdminQuery.mock.calls[0];
        expect(reapCall[1]).toEqual(['12']);
      } finally {
        if (prev === undefined) delete process.env.OUTBOX_REAPER_THRESHOLD_MIN;
        else process.env.OUTBOX_REAPER_THRESHOLD_MIN = prev;
      }
    });

    it('reaped row is then re-claimed and processed', async () => {
      mockAdminQuery
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'outbox-stuck' }] }) // reaper resets 1 row
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'outbox-stuck',
              tenant_id: 'tenant-1',
              account_id: 'account-1',
              action: 'provision_subscription',
              attempts: 0,
              max_attempts: 10,
            },
          ],
        }) // claim picks it up
        .mockResolvedValueOnce({ rows: [{ stripe_customer_id: 'cus_abc' }] }) // SELECT
        .mockResolvedValueOnce({ rowCount: 1 }) // markCompleted
        .mockResolvedValueOnce({ rows: [] });    // next claim — empty

      mockProvisionSubscription.mockResolvedValueOnce({ alreadyExists: false });

      await runProvisioningOutboxOnce();

      expect(mockProvisionSubscription).toHaveBeenCalledWith('tenant-1', 'cus_abc');
    });
  });

  describe('runProvisioningOutboxOnce — claim + success path', () => {
    it('claims a due row, processes it, marks completed', async () => {
      queueReaperNoop();
      mockAdminQuery
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'outbox-1',
              tenant_id: 'tenant-1',
              account_id: 'account-1',
              action: 'provision_subscription',
              attempts: 0,
              max_attempts: 10,
            },
          ],
        }) // claim UPDATE
        .mockResolvedValueOnce({ rows: [{ stripe_customer_id: 'cus_abc' }] }) // SELECT
        .mockResolvedValueOnce({ rowCount: 1 }) // markCompleted UPDATE
        .mockResolvedValueOnce({ rows: [] }); // next claim — empty

      mockProvisionSubscription.mockResolvedValueOnce({ alreadyExists: false });

      await runProvisioningOutboxOnce();

      expect(mockProvisionSubscription).toHaveBeenCalledWith('tenant-1', 'cus_abc');
      const completedCall = mockAdminQuery.mock.calls.find((c) =>
        typeof c[0] === 'string' && c[0].includes("status = 'completed'"),
      );
      expect(completedCall).toBeDefined();
    });

    it('alreadyExists=true → enables agent execution through the entitlement service', async () => {
      queueReaperNoop();
      mockAdminQuery
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'outbox-1',
              tenant_id: 'tenant-1',
              account_id: 'account-1',
              action: 'provision_subscription',
              attempts: 0,
              max_attempts: 10,
            },
          ],
        }) // claim
        .mockResolvedValueOnce({ rows: [{ stripe_customer_id: 'cus_abc' }] }) // SELECT
        .mockResolvedValueOnce({ rowCount: 1 }) // markCompleted
        .mockResolvedValueOnce({ rows: [] }); // next claim — empty

      mockProvisionSubscription.mockResolvedValueOnce({ alreadyExists: true });

      await runProvisioningOutboxOnce();

      expect(mockEnableAgentExecution).toHaveBeenCalledWith('tenant-1');
      // Not as a raw UPDATE: that path bumped no version and published nothing.
      const rawUpdate = mockAdminQuery.mock.calls.find((c) =>
        typeof c[0] === 'string' && c[0].includes('UPDATE entitlements'),
      );
      expect(rawUpdate).toBeUndefined();
    });
  });

  describe('runProvisioningOutboxOnce — failure path', () => {
    it('retries with backoff when provisionSubscription throws (not final attempt)', async () => {
      queueReaperNoop();
      mockAdminQuery
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'outbox-1',
              tenant_id: 'tenant-1',
              account_id: 'account-1',
              action: 'provision_subscription',
              attempts: 0,
              max_attempts: 10,
            },
          ],
        }) // claim
        .mockResolvedValueOnce({ rows: [{ stripe_customer_id: 'cus_abc' }] }) // SELECT
        .mockResolvedValueOnce({ rowCount: 1 }) // markRetryOrFailed UPDATE
        .mockResolvedValueOnce({ rows: [] }); // next claim — empty

      mockProvisionSubscription.mockRejectedValueOnce(new Error('Stripe rate limited'));

      await runProvisioningOutboxOnce();

      const retryCall = mockAdminQuery.mock.calls.find((c) =>
        typeof c[0] === 'string' && c[0].includes("status = $2") && c[0].includes('next_attempt_at'),
      );
      expect(retryCall).toBeDefined();
      // status=pending (not 'failed' — attempts after increment will be 1, < max=10)
      expect(retryCall![1][1]).toBe('pending');
      // backoff seconds = 30 for first retry (BACKOFF_SECONDS[0])
      expect(retryCall![1][3]).toBe(30);
    });

    it('marks status=failed when attempts+1 reaches max_attempts', async () => {
      queueReaperNoop();
      mockAdminQuery
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'outbox-1',
              tenant_id: 'tenant-1',
              account_id: 'account-1',
              action: 'provision_subscription',
              attempts: 9, // next failure brings us to 10 = max_attempts
              max_attempts: 10,
            },
          ],
        }) // claim
        .mockResolvedValueOnce({ rows: [{ stripe_customer_id: 'cus_abc' }] }) // SELECT
        .mockResolvedValueOnce({ rowCount: 1 }) // markRetryOrFailed UPDATE
        .mockResolvedValueOnce({ rows: [] }); // next claim — empty

      mockProvisionSubscription.mockRejectedValueOnce(new Error('Stripe still down'));

      await runProvisioningOutboxOnce();

      const failCall = mockAdminQuery.mock.calls.find((c) =>
        typeof c[0] === 'string' && c[0].includes("status = $2") && c[0].includes('next_attempt_at'),
      );
      expect(failCall).toBeDefined();
      expect(failCall![1][1]).toBe('failed');
      // backoffSec is null on final attempt
      expect(failCall![1][3]).toBeNull();
    });

    // A customer with no payment method is the normal state for a self-serve
    // signup — the wizard collects payment at step 7, activate() runs at step 0.
    // Retrying cannot resolve it, so the row must close instead of spending its
    // remaining attempts over the following two days.
    it('marks status=deferred without incrementing attempts on NoPaymentMethodError', async () => {
      queueReaperNoop();
      mockAdminQuery
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'outbox-1',
              tenant_id: 'tenant-1',
              account_id: 'account-1',
              action: 'provision_subscription',
              attempts: 3,
              max_attempts: 10,
            },
          ],
        }) // claim
        .mockResolvedValueOnce({ rows: [{ stripe_customer_id: 'cus_abc' }] }) // SELECT
        .mockResolvedValueOnce({ rowCount: 1 }) // markDeferred UPDATE
        .mockResolvedValueOnce({ rows: [] }); // next claim — empty

      mockProvisionSubscription.mockRejectedValueOnce(
        new NoPaymentMethodError('tenant-1', 'no attached payment source or default payment method'),
      );

      await runProvisioningOutboxOnce();

      const deferCall = mockAdminQuery.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes("status = 'deferred'"),
      );
      expect(deferCall).toBeDefined();
      expect(deferCall![1][1]).toContain('no_payment_method');

      // The retry/fail path must NOT have run — no attempts bump, no backoff.
      const retryCall = mockAdminQuery.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('attempts = attempts + 1'),
      );
      expect(retryCall).toBeUndefined();
    });

    // The discriminator has to be the error TYPE, not the fact that provisioning
    // failed. A Stripe outage must still consume the retry budget.
    it('still retries a generic failure rather than deferring it', async () => {
      queueReaperNoop();
      mockAdminQuery
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'outbox-1',
              tenant_id: 'tenant-1',
              account_id: 'account-1',
              action: 'provision_subscription',
              attempts: 0,
              max_attempts: 10,
            },
          ],
        }) // claim
        .mockResolvedValueOnce({ rows: [{ stripe_customer_id: 'cus_abc' }] }) // SELECT
        .mockResolvedValueOnce({ rowCount: 1 }) // markRetryOrFailed UPDATE
        .mockResolvedValueOnce({ rows: [] }); // next claim — empty

      mockProvisionSubscription.mockRejectedValueOnce(new Error('Stripe rate limited'));

      await runProvisioningOutboxOnce();

      const deferCall = mockAdminQuery.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes("status = 'deferred'"),
      );
      expect(deferCall).toBeUndefined();

      const retryCall = mockAdminQuery.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('attempts = attempts + 1'),
      );
      expect(retryCall).toBeDefined();
      expect(retryCall![1][1]).toBe('pending');
    });

    it('throws when account has no stripe_customer_id', async () => {
      queueReaperNoop();
      mockAdminQuery
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'outbox-1',
              tenant_id: 'tenant-1',
              account_id: 'account-1',
              action: 'provision_subscription',
              attempts: 0,
              max_attempts: 10,
            },
          ],
        }) // claim
        .mockResolvedValueOnce({ rows: [{ stripe_customer_id: null }] }) // SELECT NULL
        .mockResolvedValueOnce({ rowCount: 1 }) // markRetryOrFailed
        .mockResolvedValueOnce({ rows: [] }); // next claim — empty

      await runProvisioningOutboxOnce();

      expect(mockProvisionSubscription).not.toHaveBeenCalled();
      const retryCall = mockAdminQuery.mock.calls.find((c) =>
        typeof c[0] === 'string' && c[0].includes("status = $2") && c[0].includes('next_attempt_at'),
      );
      expect(retryCall).toBeDefined();
      expect(retryCall![1][2]).toMatch(/missing stripe_customer_id/);
    });

    it('does not rethrow when markCompleted fails after a successful provision', async () => {
      queueReaperNoop();
      mockAdminQuery
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'outbox-1',
              tenant_id: 'tenant-1',
              account_id: 'account-1',
              action: 'provision_subscription',
              attempts: 0,
              max_attempts: 10,
            },
          ],
        }) // claim
        .mockResolvedValueOnce({ rows: [{ stripe_customer_id: 'cus_abc' }] }) // SELECT
        .mockRejectedValueOnce(new Error('db down on markCompleted')) // markCompleted
        .mockResolvedValueOnce({ rows: [] }); // next claim — empty

      mockProvisionSubscription.mockResolvedValueOnce({ alreadyExists: false });

      // Must not throw — outer loop has to keep going.
      await expect(runProvisioningOutboxOnce()).resolves.toBeUndefined();
    });
  });

  describe('runProvisioningOutboxOnce — claim semantics', () => {
    it('returns when no due rows are available', async () => {
      queueReaperNoop();
      mockAdminQuery.mockResolvedValueOnce({ rows: [] }); // claim returns empty

      await runProvisioningOutboxOnce();

      expect(mockProvisionSubscription).not.toHaveBeenCalled();
    });
  });

  describe('kickProvisioningOutbox', () => {
    it('schedules a poll via setImmediate', async () => {
      mockAdminQuery
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // reaper
        .mockResolvedValueOnce({ rows: [] }); // claim returns empty
      kickProvisioningOutbox();
      // Yield to let setImmediate fire
      await new Promise((resolve) => setImmediate(resolve));
      expect(mockAdminQuery).toHaveBeenCalled();
    });
  });
});
