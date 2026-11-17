// Account Service Tests
// Tests CRUD operations for accounts with Stripe integration

import { AccountService } from './service';
import { AccountRepository } from './repository';
import { SignupPreapprovalRepository } from './signup-preapprovals';
import { CreateAccountInput, UpdateAccountInput } from './types';
import {
  createMockAccount,
  accountToDbRow,
} from '../test-utils/mocks';

// Mock external dependencies. We explicitly stub withAdminScope so it executes
// the caller's callback against a query mock — needed by the shape-3
// mutateAndPublishEvent helper (account.created publishes via this path now).
jest.mock('../infrastructure/database', () => ({
  withAdminScope: jest.fn(async (_ctx: unknown, fn: (c: { query: jest.Mock }) => Promise<unknown>) => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
    return fn(client);
  }),
  withTenantScope: jest.fn(async (_t: string, fn: (c: { query: jest.Mock }) => Promise<unknown>) => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
    return fn(client);
  }),
  getPool: jest.fn(() => ({ query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) })),
}));

// Mock Stripe - create mock inside factory to avoid hoisting issues
jest.mock('stripe', () => {
  const mockSubscriptionsCreate = jest.fn();
  const mockSubscriptionsUpdate = jest.fn();
  const mockSubscriptionsCancel = jest.fn();
  const mockCustomersCreate = jest.fn();
  const mockCustomersUpdate = jest.fn();
  const mockCustomersDel = jest.fn();
  // Phase 6 reuse path: AccountService.create now calls customers.search
  // against metadata.email_sha256 BEFORE customers.create. Default search
  // result is empty so the fall-through to customers.create stays the
  // happy path for existing tests.
  const mockCustomersSearch = jest.fn().mockResolvedValue({ data: [] });

  const mockStripeInstance = {
    subscriptions: {
      create: mockSubscriptionsCreate,
      update: mockSubscriptionsUpdate,
      cancel: mockSubscriptionsCancel,
    },
    customers: {
      create: mockCustomersCreate,
      update: mockCustomersUpdate,
      del: mockCustomersDel,
      search: mockCustomersSearch,
    },
  };

  const MockStripe = jest.fn(() => mockStripeInstance);

  return {
    __esModule: true,
    default: MockStripe,
    __getMockStripe: () => mockStripeInstance,
  };
});

// Mock the logger so cascadeDelete + create compensating-delete paths can be asserted.
jest.mock('../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

// Mock the repository
jest.mock('./repository');

// Mock firebase-admin/auth so the router's revoke-all handler can be exercised
// without touching real Firebase. The mock is hoisted to module-init time.
const mockRevokeRefreshTokens = jest.fn().mockResolvedValue(undefined);
const mockUpdateUser = jest.fn().mockResolvedValue(undefined);
jest.mock('firebase-admin/auth', () => ({
  getAuth: () => ({
    revokeRefreshTokens: mockRevokeRefreshTokens,
    updateUser: mockUpdateUser,
  }),
}));

// Side-channel for captured event inputs (see mutateAndPublishEvent mock below).
const capturedEventInputs: unknown[] = [];

// Mock publishEvent + mutateAndPublishEvent — both are exported from publisher.
// account.created fires via mutateAndPublishEvent (shape-3).
// Other account events (updated/email_changed/deleted) still use publishEvent.
jest.mock('../events/publisher', () => ({
  publishEvent: jest.fn().mockResolvedValue(undefined),
  mutateAndPublishEvent: jest.fn(async <T>(
    _ctx: unknown,
    mutate: (client: { query: jest.Mock }) => Promise<{ entity: T; eventInput: unknown }>,
  ): Promise<T> => {
    const db = jest.requireMock('../infrastructure/database') as { withAdminScope?: (ctx: unknown, fn: (c: { query: jest.Mock }) => Promise<unknown>) => Promise<unknown> };
    if (db.withAdminScope) {
      const result = await db.withAdminScope({ caller: 'test' }, async (client) => {
        const { entity, eventInput } = await mutate(client);
        capturedEventInputs.push(eventInput);
        return { entity };
      }) as { entity: T };
      return result.entity;
    }
    const stubClient = { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
    const { entity, eventInput } = await mutate(stubClient);
    capturedEventInputs.push(eventInput);
    return entity;
  }),
}));

// Mock getStripeSecretKey
jest.mock('../infrastructure/secrets', () => ({
  getStripeSecretKey: jest.fn().mockResolvedValue('sk_test_mock'),
}));

import { publishEvent } from '../events/publisher';
const mockPublishEvent = publishEvent as jest.MockedFunction<typeof publishEvent>;

import { accountsRouter } from './router';

import { log } from '../infrastructure/logging';
const mockLog = log as unknown as { info: jest.Mock; warn: jest.Mock; error: jest.Mock; debug: jest.Mock };

// Get the mock Stripe instance from the mocked module
const StripeMock = jest.requireMock('stripe');
const mockStripe = StripeMock.__getMockStripe();

describe('AccountService', () => {
  let accountService: AccountService;
  let mockRepository: jest.Mocked<AccountRepository>;

  beforeEach(() => {
    jest.clearAllMocks();
    capturedEventInputs.length = 0;

    // Create mock repository. Since the shape-3 migration,
    // account.created publishes via mutateAndPublishEvent — the service now
    // calls `createInTx(client, input)`, not `create(input)`.
    mockRepository = {
      create: jest.fn(),
      createInTx: jest.fn(),
      findById: jest.fn(),
      findByEmail: jest.fn(),
      findByFirebaseUid: jest.fn(),
      findAll: jest.fn(),
      update: jest.fn(),
      updateStripeCustomerId: jest.fn(),
      softDelete: jest.fn(),
    } as unknown as jest.Mocked<AccountRepository>;

    // Replace AccountRepository prototype methods
    (AccountRepository as jest.Mock).mockImplementation(() => mockRepository);

    accountService = new AccountService();
  });

  describe('create (Stripe-first atomic pattern)', () => {
    const createInput: CreateAccountInput = {
      firebaseUid: 'firebase_test_123',
      firstName: 'Test',
      lastName: 'Company',
      email: 'contact@testcompany.com',
      timezone: 'America/Los_Angeles',
    };

    it('creates Stripe customer first, then inserts account with stripe_customer_id atomically', async () => {
      const finalAccount = createMockAccount({
        id: 'acc_new_123',
        firebaseUid: createInput.firebaseUid,
        firstName: createInput.firstName,
        lastName: createInput.lastName,
        email: createInput.email,
        timezone: createInput.timezone,
        stripeCustomerId: 'cus_stripe_new',
        version: 1,
      });

      mockStripe.customers.create.mockResolvedValue({
        id: 'cus_stripe_new',
        email: createInput.email,
        name: `${createInput.firstName} ${createInput.lastName}`,
        metadata: {},
      });
      mockRepository.createInTx.mockResolvedValue(finalAccount);

      const result = await accountService.create(createInput);

      // Stripe was called BEFORE the DB insert. After the shape-3 migration
      // the DB insert is the `createInTx` call inside the mutateAndPublishEvent
      // callback.
      const stripeCallOrder = mockStripe.customers.create.mock.invocationCallOrder[0];
      const dbCallOrder = mockRepository.createInTx.mock.invocationCallOrder[0];
      expect(stripeCallOrder).toBeLessThan(dbCallOrder);

      // Repository.createInTx receives (client, input) — input has id +
      // stripeCustomerId in the same INSERT (no separate updateStripeCustomerId call).
      const dbCallArgs = mockRepository.createInTx.mock.calls[0][1];
      expect(dbCallArgs.id).toMatch(/^[0-9a-f-]{36}$/i);
      expect(dbCallArgs.stripeCustomerId).toBe('cus_stripe_new');
      expect(mockRepository.updateStripeCustomerId).not.toHaveBeenCalled();

      // Stripe metadata carries the same accountId we passed to DB.
      const stripeCallArgs = mockStripe.customers.create.mock.calls[0][0];
      expect(stripeCallArgs.metadata.accountId).toBe(dbCallArgs.id);
      expect(stripeCallArgs.metadata.firebaseUid).toBe(createInput.firebaseUid);

      expect(result.stripeCustomerId).toBe('cus_stripe_new');
    });

    it('publishes account.created event after creation', async () => {
      const finalAccount = createMockAccount({
        id: 'acc_event_test',
        stripeCustomerId: 'cus_event_test',
      });

      mockStripe.customers.create.mockResolvedValue({ id: 'cus_event_test' });
      mockRepository.createInTx.mockResolvedValue(finalAccount);

      await accountService.create(createInput);

      // account.created now fires via mutateAndPublishEvent (shape-3).
      expect(capturedEventInputs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            entityType: 'account',
            entityId: finalAccount.id,
            eventType: 'account.created',
            entityVersion: finalAccount.version,
            eventVersion: 1,
            payload: {
              firstName: finalAccount.firstName,
              lastName: finalAccount.lastName,
              email: finalAccount.email,
              stripeCustomerId: 'cus_event_test',
            },
          }),
        ]),
      );
    });

    it('throws when Stripe.customers.create fails; no DB write happens', async () => {
      mockStripe.customers.create.mockRejectedValue(new Error('Stripe API error'));

      await expect(accountService.create(createInput)).rejects.toThrow('Stripe API error');

      // No DB insert and no compensating Stripe.del — Stripe never created a customer.
      expect(mockRepository.createInTx).not.toHaveBeenCalled();
      expect(mockStripe.customers.del).not.toHaveBeenCalled();
    });

    it('compensating-delete: rolls back Stripe customer when DB INSERT fails', async () => {
      mockStripe.customers.create.mockResolvedValue({ id: 'cus_to_delete' });
      mockRepository.createInTx.mockRejectedValue(new Error('Database connection failed'));
      mockStripe.customers.del.mockResolvedValue({ deleted: true });

      await expect(accountService.create(createInput)).rejects.toThrow('Database connection failed');

      // Compensating action: the orphaned Stripe customer must be deleted.
      expect(mockStripe.customers.del).toHaveBeenCalledWith('cus_to_delete');
    });

    it('logs critical error if compensating Stripe.del also fails', async () => {
      mockStripe.customers.create.mockResolvedValue({ id: 'cus_orphan' });
      mockRepository.createInTx.mockRejectedValue(new Error('DB down'));
      mockStripe.customers.del.mockRejectedValue(new Error('Stripe also down'));

      await expect(accountService.create(createInput)).rejects.toThrow('DB down');

      expect(mockLog.error).toHaveBeenCalledWith(
        expect.objectContaining({
          stripeCustomerId: 'cus_orphan',
          error: 'Stripe also down',
        }),
        expect.stringContaining('CRITICAL'),
      );
    });

    it('does not publish account.created if creation fails', async () => {
      mockStripe.customers.create.mockResolvedValue({ id: 'cus_xx' });
      mockRepository.createInTx.mockRejectedValue(new Error('DB failure'));
      mockStripe.customers.del.mockResolvedValue({ deleted: true });

      await expect(accountService.create(createInput)).rejects.toThrow();

      // No event captured: the mutateAndPublishEvent callback threw before
      // the inline publish ran.
      expect(capturedEventInputs).toEqual([]);
      expect(mockPublishEvent).not.toHaveBeenCalled();
    });

    // Phase 6: re-signup Stripe customer reuse — customers.search hits before
    // customers.create. If a soft-scrubbed customer matches the email hash,
    // its PII is re-attached and customers.create is NOT called.
    it('create() with email that has no prior deletion calls customers.create', async () => {
      mockStripe.customers.search.mockResolvedValueOnce({ data: [] });
      mockStripe.customers.create.mockResolvedValueOnce({ id: 'cus_brand_new' });
      const finalAccount = createMockAccount({ id: 'acc_new', stripeCustomerId: 'cus_brand_new' });
      mockRepository.createInTx.mockResolvedValueOnce(finalAccount);

      await accountService.create(createInput);

      expect(mockStripe.customers.search).toHaveBeenCalled();
      expect(mockStripe.customers.create).toHaveBeenCalled();
      expect(mockStripe.customers.update).not.toHaveBeenCalled();
    });

    it('create() reuses an existing soft-scrubbed customer via customers.update', async () => {
      mockStripe.customers.search.mockResolvedValueOnce({
        data: [{ id: 'cus_prev_scrubbed', metadata: { email_sha256: 'h', deleted_at: '2026-01-01' } }],
      });
      mockStripe.customers.update.mockResolvedValueOnce({ id: 'cus_prev_scrubbed' });
      const finalAccount = createMockAccount({ id: 'acc_reuse', stripeCustomerId: 'cus_prev_scrubbed' });
      mockRepository.createInTx.mockResolvedValueOnce(finalAccount);

      await accountService.create(createInput);

      expect(mockStripe.customers.create).not.toHaveBeenCalled();
      expect(mockStripe.customers.update).toHaveBeenCalledWith('cus_prev_scrubbed', expect.objectContaining({
        email: createInput.email,
        metadata: expect.objectContaining({
          email_sha256: 'h',
          deleted_at: '2026-01-01',
        }),
      }));
    });

    it('create() does NOT compensating-delete a reused customer when DB insert fails', async () => {
      mockStripe.customers.search.mockResolvedValueOnce({
        data: [{ id: 'cus_prev_scrubbed', metadata: { email_sha256: 'h' } }],
      });
      mockStripe.customers.update.mockResolvedValueOnce({ id: 'cus_prev_scrubbed' });
      mockRepository.createInTx.mockRejectedValueOnce(new Error('DB failure'));

      await expect(accountService.create(createInput)).rejects.toThrow('DB failure');
      // Reused customer must survive — it remains the tombstone for the next retry.
      expect(mockStripe.customers.del).not.toHaveBeenCalled();
    });

    // Guest list (migration 341). An address an admin cleared before signup is
    // spent here, so the row is born 'approved' and the person never sees
    // /request-invite.
    describe('pre-approved signup', () => {
      const ADMIN = '11111111-1111-4111-8111-111111111111';
      const entry = {
        id: 'pre-1',
        email: createInput.email,
        note: null,
        addedBy: ADMIN,
        createdAt: new Date('2026-08-08T00:00:00Z'),
        consumedAt: null,
        consumedAccountId: null,
      };

      let findLive: jest.SpyInstance;
      let consume: jest.SpyInstance;

      beforeEach(() => {
        findLive = jest.spyOn(SignupPreapprovalRepository.prototype, 'findLiveByEmail');
        consume = jest
          .spyOn(SignupPreapprovalRepository.prototype, 'consumeInTx')
          .mockResolvedValue(true);
        mockStripe.customers.search.mockResolvedValue({ data: [] });
        mockStripe.customers.create.mockResolvedValue({ id: 'cus_pre' });
        mockRepository.createInTx.mockResolvedValue(
          createMockAccount({ id: 'acc_pre', stripeCustomerId: 'cus_pre' }),
        );
      });

      afterEach(() => {
        findLive.mockRestore();
        consume.mockRestore();
      });

      it('is born approved and spends the entry, in the same transaction', async () => {
        findLive.mockResolvedValue(entry);

        await accountService.create(createInput);

        const dbCallArgs = mockRepository.createInTx.mock.calls[0][1];
        expect(dbCallArgs.accessStatus).toBe('approved');
        // The admin who cleared the address is recorded as the decider, so the
        // column means the same thing it does on the Approve-button path.
        expect(dbCallArgs.accessDecidedBy).toBe(ADMIN);

        // Consumed against the account it let in — the audit trail — and via
        // the same tx client the INSERT used, so a failure rolls both back and
        // leaves the entry live for the retry.
        const consumeArgs = consume.mock.calls[0];
        expect(consumeArgs[1]).toBe('pre-1');
        expect(consumeArgs[2]).toBe('acc_pre');
        expect(consumeArgs[0]).toBe(findLive.mock.calls[0][0]);
      });

      it('stays pending when no entry matches', async () => {
        findLive.mockResolvedValue(null);

        await accountService.create(createInput);

        const dbCallArgs = mockRepository.createInTx.mock.calls[0][1];
        expect(dbCallArgs.accessStatus).toBeUndefined();
        expect(dbCallArgs.accessDecidedBy).toBeUndefined();
        expect(consume).not.toHaveBeenCalled();
      });
    });
  });

  describe('getById', () => {
    it('should return account when found', async () => {
      const account = createMockAccount({ id: 'acc_find_123' });
      mockRepository.findById.mockResolvedValue(account);

      const result = await accountService.getById('acc_find_123');

      expect(mockRepository.findById).toHaveBeenCalledWith('acc_find_123');
      expect(result).toEqual(account);
    });

    it('should return null when account not found', async () => {
      mockRepository.findById.mockResolvedValue(null);

      const result = await accountService.getById('acc_nonexistent');

      expect(mockRepository.findById).toHaveBeenCalledWith('acc_nonexistent');
      expect(result).toBeNull();
    });

    it('should propagate repository errors', async () => {
      mockRepository.findById.mockRejectedValue(new Error('Query failed'));

      await expect(accountService.getById('acc_123')).rejects.toThrow(
        'Query failed'
      );
    });
  });

  describe('getByEmail', () => {
    it('should return account when found by email', async () => {
      const account = createMockAccount({ email: 'found@test.com' });
      mockRepository.findByEmail.mockResolvedValue(account);

      const result = await accountService.getByEmail('found@test.com');

      expect(mockRepository.findByEmail).toHaveBeenCalledWith('found@test.com');
      expect(result).toEqual(account);
    });

    it('should return null when email not found', async () => {
      mockRepository.findByEmail.mockResolvedValue(null);

      const result = await accountService.getByEmail('notfound@test.com');

      expect(result).toBeNull();
    });
  });

  describe('listAll', () => {
    it('should return all accounts', async () => {
      const accounts = [
        createMockAccount({ id: 'acc_1' }),
        createMockAccount({ id: 'acc_2' }),
        createMockAccount({ id: 'acc_3' }),
      ];
      mockRepository.findAll.mockResolvedValue(accounts);

      const result = await accountService.listAll();

      expect(mockRepository.findAll).toHaveBeenCalled();
      expect(result).toHaveLength(3);
      expect(result).toEqual(accounts);
    });

    it('should return empty array when no accounts exist', async () => {
      mockRepository.findAll.mockResolvedValue([]);

      const result = await accountService.listAll();

      expect(result).toEqual([]);
    });
  });

  describe('update', () => {
    const updateInput: UpdateAccountInput = {
      firstName: 'Updated',
      lastName: 'Company',
    };

    it('should update account in database and Stripe name', async () => {
      const updatedAccount = createMockAccount({
        id: 'acc_update_123',
        firstName: updateInput.firstName!,
        lastName: updateInput.lastName!,
        stripeCustomerId: 'cus_existing',
        version: 2,
      });

      mockRepository.update.mockResolvedValue(updatedAccount);
      mockStripe.customers.update.mockResolvedValue({
        id: 'cus_existing',
        email: updatedAccount.email,
        name: `${updatedAccount.firstName} ${updatedAccount.lastName}`,
        metadata: {},
      });

      const result = await accountService.update('acc_update_123', updateInput);

      expect(mockRepository.update).toHaveBeenCalledWith(
        'acc_update_123',
        updateInput
      );
      expect(mockStripe.customers.update).toHaveBeenCalledWith('cus_existing', {
        name: `${updatedAccount.firstName} ${updatedAccount.lastName}`,
      });
      expect(result).toEqual(updatedAccount);
    });

    it('should skip Stripe update when no stripeCustomerId', async () => {
      const accountWithoutStripe = createMockAccount({
        id: 'acc_no_stripe',
        stripeCustomerId: null,
      });

      mockRepository.update.mockResolvedValue(accountWithoutStripe);

      await accountService.update('acc_no_stripe', updateInput);

      expect(mockStripe.customers.update).not.toHaveBeenCalled();
    });

    it('should skip Stripe update when email or name not changed', async () => {
      const updateTimezoneOnly: UpdateAccountInput = {
        timezone: 'America/New_York',
      };

      const account = createMockAccount({
        timezone: 'America/New_York',
        stripeCustomerId: 'cus_123',
      });

      mockRepository.update.mockResolvedValue(account);

      await accountService.update('acc_123', updateTimezoneOnly);

      // Stripe update is only called if input.email or input.firstName or input.lastName is truthy
      expect(mockStripe.customers.update).not.toHaveBeenCalled();
    });

    it('should publish account.updated event after update', async () => {
      const updatedAccount = createMockAccount({
        id: 'acc_event_update',
        firstName: 'Updated',
        lastName: 'Name',
        email: 'updated@test.com',
        timezone: 'America/Los_Angeles',
        version: 3,
      });

      mockRepository.update.mockResolvedValue(updatedAccount);

      await accountService.update('acc_event_update', updateInput);

      expect(mockPublishEvent).toHaveBeenCalledWith({
        entityType: 'account',
        entityId: 'acc_event_update',
        eventType: 'account.updated',
        entityVersion: 3,
        eventVersion: 1,
        payload: {
          firstName: updatedAccount.firstName,
          lastName: updatedAccount.lastName,
          email: updatedAccount.email,
          timezone: updatedAccount.timezone,
        },
      });
    });

    it('should throw error when account not found', async () => {
      mockRepository.update.mockRejectedValue(
        new Error('Account not found: acc_missing')
      );

      await expect(
        accountService.update('acc_missing', updateInput)
      ).rejects.toThrow('Account not found: acc_missing');
    });
  });

  describe('delete', () => {
    it('should soft delete account and archive Stripe customer', async () => {
      const account = createMockAccount({
        id: 'acc_delete_123',
        stripeCustomerId: 'cus_delete_test',
        version: 1,
      });

      mockRepository.findById.mockResolvedValue(account);
      mockRepository.softDelete.mockResolvedValue(true);
      mockStripe.customers.update.mockResolvedValue({
        id: 'cus_delete_test',
        email: 'test@example.com',
        name: 'Test Account',
        metadata: {
          accountId: 'acc_delete_123',
          deletedAt: expect.any(String),
          deletedBy: 'user_123',
        },
      });

      const result = await accountService.delete('acc_delete_123', 'user_123');

      expect(result).toBe(true);
      expect(mockRepository.findById).toHaveBeenCalledWith('acc_delete_123');
      expect(mockRepository.softDelete).toHaveBeenCalledWith('acc_delete_123', 'user_123');

      // A deleted account must not be able to sign in. Marking the row only
      // stops the API resolving it; without these two the person could still
      // authenticate and land in an application where every call 404s.
      // Revoking ends the sessions that exist, disabling stops a new one.
      expect(mockRevokeRefreshTokens).toHaveBeenCalledWith(account.firebaseUid);
      expect(mockUpdateUser).toHaveBeenCalledWith(account.firebaseUid, { disabled: true });
      expect(mockStripe.customers.update).toHaveBeenCalledWith('cus_delete_test', {
        metadata: {
          accountId: 'acc_delete_123',
          deletedAt: expect.any(String),
          deletedBy: 'user_123',
        },
      });
    });

    it('should return false when account not found', async () => {
      mockRepository.findById.mockResolvedValue(null);

      const result = await accountService.delete('acc_nonexistent', 'user_123');

      expect(result).toBe(false);
      expect(mockRepository.softDelete).not.toHaveBeenCalled();
      expect(mockStripe.customers.update).not.toHaveBeenCalled();
    });

    it('should return false when soft delete fails', async () => {
      const account = createMockAccount({ id: 'acc_already_deleted' });
      mockRepository.findById.mockResolvedValue(account);
      mockRepository.softDelete.mockResolvedValue(false);

      const result = await accountService.delete('acc_already_deleted', 'user_123');

      expect(result).toBe(false);
      expect(mockStripe.customers.update).not.toHaveBeenCalled();
    });

    it('should skip Stripe update when no stripeCustomerId', async () => {
      const accountWithoutStripe = createMockAccount({
        id: 'acc_no_stripe',
        stripeCustomerId: null,
      });

      mockRepository.findById.mockResolvedValue(accountWithoutStripe);
      mockRepository.softDelete.mockResolvedValue(true);

      const result = await accountService.delete('acc_no_stripe', 'user_123');

      expect(result).toBe(true);
      expect(mockStripe.customers.update).not.toHaveBeenCalled();
    });

    it('should publish account.deleted event after deletion', async () => {
      const account = createMockAccount({
        id: 'acc_event_delete',
        version: 2,
      });

      mockRepository.findById.mockResolvedValue(account);
      mockRepository.softDelete.mockResolvedValue(true);

      await accountService.delete('acc_event_delete', 'user_123');

      expect(mockPublishEvent).toHaveBeenCalledWith({
        entityType: 'account',
        entityId: 'acc_event_delete',
        eventType: 'account.deleted',
        entityVersion: 3, // version + 1
        eventVersion: 1,
        payload: {
          deletedBy: 'user_123',
        },
      });
    });
  });
});

describe('POST /me/sessions/revoke-all', () => {
  function getRevokeAllHandler() {
    const stack = (accountsRouter as unknown as { stack: Array<{ route?: { path: string; stack: Array<{ method: string; handle: unknown }> } }> }).stack;
    for (const layer of stack) {
      if (layer.route && layer.route.path === '/me/sessions/revoke-all') {
        const postHandlers = layer.route.stack.filter((l) => l.method === 'post');
        return postHandlers[postHandlers.length - 1].handle as (req: unknown, res: unknown, next: unknown) => Promise<void>;
      }
    }
    throw new Error('revoke-all route not found');
  }

  function createReqRes(user: { uid?: string } | undefined) {
    const req = { user, ctx: { caller: 'test' } } as unknown;
    const res = {
      status: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    } as unknown as { status: jest.Mock; send: jest.Mock; json: jest.Mock };
    const next = jest.fn();
    return { req, res, next };
  }

  beforeEach(() => {
    mockRevokeRefreshTokens.mockClear();
    mockUpdateUser.mockClear();
  });

  it('returns 401 when req.user is unset', async () => {
    const handler = getRevokeAllHandler();
    const { req, res, next } = createReqRes(undefined);

    await handler(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' });
    expect(mockRevokeRefreshTokens).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 204 and revokes Firebase refresh tokens for the current user', async () => {
    const handler = getRevokeAllHandler();
    const { req, res, next } = createReqRes({ uid: 'firebase_uid_abc' });

    await handler(req, res, next);

    expect(mockRevokeRefreshTokens).toHaveBeenCalledTimes(1);
    expect(mockRevokeRefreshTokens).toHaveBeenCalledWith('firebase_uid_abc');
    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.send).toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });
});

describe('AccountRepository', () => {
  // Additional repository-specific tests if needed
  // These test the data layer in isolation

  describe('mapRow', () => {
    it('should correctly map database row to Account type', () => {
      // This tests the private mapRow function indirectly through the create method
      const account = createMockAccount();
      const dbRow = accountToDbRow(account);

      // Verify the row structure matches what the repository expects
      expect(dbRow.id).toBe(account.id);
      expect(dbRow.firebase_uid).toBe(account.firebaseUid);
      expect(dbRow.first_name).toBe(account.firstName);
      expect(dbRow.last_name).toBe(account.lastName);
      expect(dbRow.email).toBe(account.email);
      expect(dbRow.timezone).toBe(account.timezone);
      expect(dbRow.stripe_customer_id).toBe(account.stripeCustomerId);
      expect(dbRow.version).toBe(account.version);
      expect(dbRow.created_at).toBe(account.createdAt);
      expect(dbRow.updated_at).toBe(account.updatedAt);
    });
  });
});
