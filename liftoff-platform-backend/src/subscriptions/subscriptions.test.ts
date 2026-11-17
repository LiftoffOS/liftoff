// Subscription Service Tests
// Tests Stripe subscription lifecycle: create, pause, resume, cancel

import { SubscriptionService } from './service';
import { SubscriptionRepository } from './repository';
import { CreateSubscriptionInput } from './types';
import { createMockSubscription } from '../test-utils/mocks';

// Mock external dependencies
jest.mock('../infrastructure/database');

// Mock Stripe - create mock inside factory to avoid hoisting issues
jest.mock('stripe', () => {
  const mockSubscriptionsCreate = jest.fn();
  const mockSubscriptionsUpdate = jest.fn();
  const mockSubscriptionsCancel = jest.fn();
  const mockCustomersCreate = jest.fn();
  const mockCustomersUpdate = jest.fn();

  const mockStripeInstance = {
    subscriptions: {
      create: mockSubscriptionsCreate,
      update: mockSubscriptionsUpdate,
      cancel: mockSubscriptionsCancel,
    },
    customers: {
      create: mockCustomersCreate,
      update: mockCustomersUpdate,
    },
  };

  const MockStripe = jest.fn(() => mockStripeInstance);

  return {
    __esModule: true,
    default: MockStripe,
    __getMockStripe: () => mockStripeInstance,
  };
});

// Mock the repository
jest.mock('./repository');

// Mock publishEvent - define inline since jest.mock is hoisted
jest.mock('../events/publisher', () => ({
  publishEvent: jest.fn().mockResolvedValue(undefined),
}));

// Mock getStripeSecretKey
jest.mock('../infrastructure/secrets', () => ({
  getStripeSecretKey: jest.fn().mockResolvedValue('sk_test_mock'),
}));

import { publishEvent } from '../events/publisher';
const mockPublishEvent = publishEvent as jest.MockedFunction<typeof publishEvent>;

// Get the mock Stripe instance from the mocked module
const StripeMock = jest.requireMock('stripe');
const mockStripe = StripeMock.__getMockStripe();

describe('SubscriptionService', () => {
  let subscriptionService: SubscriptionService;
  let mockRepository: jest.Mocked<SubscriptionRepository>;

  beforeEach(() => {
    jest.clearAllMocks();

    // Reset Stripe singleton in the service module by clearing the module cache
    jest.resetModules();

    // Create mock repository
    mockRepository = {
      create: jest.fn(),
      findById: jest.fn(),
      findByStripeId: jest.fn(),
      findByAccountId: jest.fn(),
      findActiveByAccountId: jest.fn(),
      updateStatus: jest.fn(),
      updateByStripeId: jest.fn(),
    } as unknown as jest.Mocked<SubscriptionRepository>;

    // Replace SubscriptionRepository prototype methods
    (SubscriptionRepository as jest.Mock).mockImplementation(() => mockRepository);

    subscriptionService = new SubscriptionService();
  });

  describe('create', () => {
    const createInput: CreateSubscriptionInput = {
      accountId: 'acc_test_123',
      planId: 'plan_pro_monthly',
      stripeCustomerId: 'cus_test_123',
      stripePriceId: 'price_pro_monthly',
    };

    it('should create subscription in Stripe and database', async () => {
      const stripeSubscription = {
        id: 'sub_stripe_new',
        customer: createInput.stripeCustomerId,
        status: 'active',
        items: { data: [{ price: { id: createInput.stripePriceId } }] },
      };

      const dbSubscription = createMockSubscription({
        id: 'sub_db_123',
        accountId: createInput.accountId,
        planId: createInput.planId,
        stripeSubscriptionId: 'sub_stripe_new',
        status: 'active',
      });

      mockStripe.subscriptions.create.mockResolvedValue(stripeSubscription);
      mockRepository.create.mockResolvedValue(dbSubscription);

      const result = await subscriptionService.create(createInput);

      expect(mockStripe.subscriptions.create).toHaveBeenCalledWith({
        customer: createInput.stripeCustomerId,
        items: [{ price: createInput.stripePriceId }],
      });
      expect(mockRepository.create).toHaveBeenCalledWith({
        accountId: createInput.accountId,
        planId: createInput.planId,
        stripeSubscriptionId: 'sub_stripe_new',
        status: 'active',
      });
      expect(result.stripeSubscriptionId).toBe('sub_stripe_new');
    });

    it('should publish subscription.created event after creation', async () => {
      const stripeSubscription = {
        id: 'sub_event_test',
        customer: createInput.stripeCustomerId,
        status: 'active',
        items: { data: [] },
      };

      const dbSubscription = createMockSubscription({
        id: 'sub_event_123',
        stripeSubscriptionId: 'sub_event_test',
        version: 1,
      });

      mockStripe.subscriptions.create.mockResolvedValue(stripeSubscription);
      mockRepository.create.mockResolvedValue(dbSubscription);

      await subscriptionService.create(createInput);

      expect(mockPublishEvent).toHaveBeenCalledWith({
        entityType: 'subscription',
        entityId: dbSubscription.id,
        eventType: 'subscription.created',
        entityVersion: 1,
        eventVersion: 1,
        payload: {
          accountId: dbSubscription.accountId,
          planId: dbSubscription.planId,
          stripeSubscriptionId: dbSubscription.stripeSubscriptionId,
          status: dbSubscription.status,
        },
      });
    });

    it('should throw error when Stripe subscription creation fails', async () => {
      const stripeError = new Error('Card declined');
      mockStripe.subscriptions.create.mockRejectedValue(stripeError);

      await expect(subscriptionService.create(createInput)).rejects.toThrow(
        'Card declined'
      );
      expect(mockRepository.create).not.toHaveBeenCalled();
    });

    it('should throw error when database creation fails', async () => {
      const stripeSubscription = {
        id: 'sub_stripe_123',
        customer: createInput.stripeCustomerId,
        status: 'active',
        items: { data: [] },
      };

      mockStripe.subscriptions.create.mockResolvedValue(stripeSubscription);
      mockRepository.create.mockRejectedValue(new Error('Database error'));

      await expect(subscriptionService.create(createInput)).rejects.toThrow(
        'Database error'
      );
    });
  });

  describe('getById', () => {
    it('should return subscription when found', async () => {
      const subscription = createMockSubscription({ id: 'sub_find_123' });
      mockRepository.findById.mockResolvedValue(subscription);

      const result = await subscriptionService.getById('sub_find_123');

      expect(mockRepository.findById).toHaveBeenCalledWith('sub_find_123');
      expect(result).toEqual(subscription);
    });

    it('should return null when subscription not found', async () => {
      mockRepository.findById.mockResolvedValue(null);

      const result = await subscriptionService.getById('sub_nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('getByAccountId', () => {
    it('should return all subscriptions for an account', async () => {
      const subscriptions = [
        createMockSubscription({ id: 'sub_1', accountId: 'acc_123' }),
        createMockSubscription({ id: 'sub_2', accountId: 'acc_123', status: 'canceled' }),
      ];
      mockRepository.findByAccountId.mockResolvedValue(subscriptions);

      const result = await subscriptionService.getByAccountId('acc_123');

      expect(mockRepository.findByAccountId).toHaveBeenCalledWith('acc_123');
      expect(result).toHaveLength(2);
    });

    it('should return empty array when no subscriptions exist', async () => {
      mockRepository.findByAccountId.mockResolvedValue([]);

      const result = await subscriptionService.getByAccountId('acc_no_subs');

      expect(result).toEqual([]);
    });
  });

  describe('getActiveByAccountId', () => {
    it('should return active subscription for an account', async () => {
      const activeSubscription = createMockSubscription({
        id: 'sub_active',
        status: 'active',
      });
      mockRepository.findActiveByAccountId.mockResolvedValue(activeSubscription);

      const result = await subscriptionService.getActiveByAccountId('acc_123');

      expect(mockRepository.findActiveByAccountId).toHaveBeenCalledWith('acc_123');
      expect(result?.status).toBe('active');
    });

    it('should return null when no active subscription exists', async () => {
      mockRepository.findActiveByAccountId.mockResolvedValue(null);

      const result = await subscriptionService.getActiveByAccountId('acc_no_active');

      expect(result).toBeNull();
    });
  });

  describe('cancel', () => {
    it('should cancel subscription in Stripe and update database', async () => {
      const subscription = createMockSubscription({
        id: 'sub_cancel_123',
        stripeSubscriptionId: 'sub_stripe_cancel',
        status: 'active',
      });

      const canceledSubscription = createMockSubscription({
        ...subscription,
        status: 'canceled',
        version: 2,
      });

      mockRepository.findById.mockResolvedValue(subscription);
      mockStripe.subscriptions.cancel.mockResolvedValue({
        id: subscription.stripeSubscriptionId,
        customer: 'cus_123',
        status: 'canceled',
        items: { data: [] },
      });
      mockRepository.updateStatus.mockResolvedValue(canceledSubscription);

      const result = await subscriptionService.cancel('sub_cancel_123');

      expect(mockStripe.subscriptions.cancel).toHaveBeenCalledWith(
        subscription.stripeSubscriptionId
      );
      expect(mockRepository.updateStatus).toHaveBeenCalledWith(
        'sub_cancel_123',
        'canceled'
      );
      expect(result.status).toBe('canceled');
    });

    it('should publish subscription.canceled event', async () => {
      const subscription = createMockSubscription({
        id: 'sub_cancel_event',
        accountId: 'acc_cancel',
        stripeSubscriptionId: 'sub_stripe_event',
      });

      const canceledSubscription = createMockSubscription({
        ...subscription,
        status: 'canceled',
        version: 2,
      });

      mockRepository.findById.mockResolvedValue(subscription);
      mockStripe.subscriptions.cancel.mockResolvedValue({
        id: subscription.stripeSubscriptionId,
        customer: 'cus_123',
        status: 'canceled',
        items: { data: [] },
      });
      mockRepository.updateStatus.mockResolvedValue(canceledSubscription);

      await subscriptionService.cancel('sub_cancel_event');

      expect(mockPublishEvent).toHaveBeenCalledWith({
        entityType: 'subscription',
        entityId: subscription.id,
        eventType: 'subscription.canceled',
        entityVersion: 2,
        eventVersion: 1,
        payload: {
          accountId: subscription.accountId,
        },
      });
    });

    it('should throw error when subscription not found', async () => {
      mockRepository.findById.mockResolvedValue(null);

      await expect(subscriptionService.cancel('sub_missing')).rejects.toThrow(
        'Subscription not found: sub_missing'
      );
      expect(mockStripe.subscriptions.cancel).not.toHaveBeenCalled();
    });

    it('should skip Stripe API call when no stripeSubscriptionId', async () => {
      const subscriptionWithoutStripe = createMockSubscription({
        id: 'sub_no_stripe',
        stripeSubscriptionId: '',
      });

      const canceledSubscription = createMockSubscription({
        ...subscriptionWithoutStripe,
        status: 'canceled',
      });

      mockRepository.findById.mockResolvedValue(subscriptionWithoutStripe);
      mockRepository.updateStatus.mockResolvedValue(canceledSubscription);

      await subscriptionService.cancel('sub_no_stripe');

      expect(mockStripe.subscriptions.cancel).not.toHaveBeenCalled();
      expect(mockRepository.updateStatus).toHaveBeenCalled();
    });
  });

  describe('pause', () => {
    it('should pause subscription in Stripe with void behavior', async () => {
      const subscription = createMockSubscription({
        id: 'sub_pause_123',
        stripeSubscriptionId: 'sub_stripe_pause',
        status: 'active',
      });

      const pausedSubscription = createMockSubscription({
        ...subscription,
        status: 'paused',
        version: 2,
      });

      mockRepository.findById.mockResolvedValue(subscription);
      mockStripe.subscriptions.update.mockResolvedValue({
        id: subscription.stripeSubscriptionId,
        customer: 'cus_123',
        status: 'active',
        items: { data: [] },
        pause_collection: { behavior: 'void' },
      });
      mockRepository.updateStatus.mockResolvedValue(pausedSubscription);

      const result = await subscriptionService.pause('sub_pause_123');

      expect(mockStripe.subscriptions.update).toHaveBeenCalledWith(
        subscription.stripeSubscriptionId,
        { pause_collection: { behavior: 'void' } }
      );
      expect(mockRepository.updateStatus).toHaveBeenCalledWith(
        'sub_pause_123',
        'paused'
      );
      expect(result.status).toBe('paused');
    });

    it('should publish subscription.paused event', async () => {
      const subscription = createMockSubscription({
        id: 'sub_pause_event',
        accountId: 'acc_pause',
        stripeSubscriptionId: 'sub_stripe_pause',
      });

      const pausedSubscription = createMockSubscription({
        ...subscription,
        status: 'paused',
        version: 2,
      });

      mockRepository.findById.mockResolvedValue(subscription);
      mockStripe.subscriptions.update.mockResolvedValue({
        id: subscription.stripeSubscriptionId,
        customer: 'cus_123',
        status: 'active',
        items: { data: [] },
        pause_collection: { behavior: 'void' },
      });
      mockRepository.updateStatus.mockResolvedValue(pausedSubscription);

      await subscriptionService.pause('sub_pause_event');

      expect(mockPublishEvent).toHaveBeenCalledWith({
        entityType: 'subscription',
        entityId: subscription.id,
        eventType: 'subscription.paused',
        entityVersion: 2,
        eventVersion: 1,
        payload: {
          accountId: subscription.accountId,
        },
      });
    });

    it('should throw error when subscription not found', async () => {
      mockRepository.findById.mockResolvedValue(null);

      await expect(subscriptionService.pause('sub_missing')).rejects.toThrow(
        'Subscription not found: sub_missing'
      );
    });
  });

  describe('resume', () => {
    it('should resume subscription by clearing pause_collection', async () => {
      const pausedSubscription = createMockSubscription({
        id: 'sub_resume_123',
        stripeSubscriptionId: 'sub_stripe_resume',
        status: 'paused',
      });

      const activeSubscription = createMockSubscription({
        ...pausedSubscription,
        status: 'active',
        version: 3,
      });

      mockRepository.findById.mockResolvedValue(pausedSubscription);
      mockStripe.subscriptions.update.mockResolvedValue({
        id: pausedSubscription.stripeSubscriptionId,
        customer: 'cus_123',
        status: 'active',
        items: { data: [] },
        pause_collection: null,
      });
      mockRepository.updateStatus.mockResolvedValue(activeSubscription);

      const result = await subscriptionService.resume('sub_resume_123');

      expect(mockStripe.subscriptions.update).toHaveBeenCalledWith(
        pausedSubscription.stripeSubscriptionId,
        { pause_collection: null }
      );
      expect(mockRepository.updateStatus).toHaveBeenCalledWith(
        'sub_resume_123',
        'active'
      );
      expect(result.status).toBe('active');
    });

    it('should publish subscription.resumed event', async () => {
      const pausedSubscription = createMockSubscription({
        id: 'sub_resume_event',
        accountId: 'acc_resume',
        stripeSubscriptionId: 'sub_stripe_resume',
        status: 'paused',
      });

      const activeSubscription = createMockSubscription({
        ...pausedSubscription,
        status: 'active',
        version: 3,
      });

      mockRepository.findById.mockResolvedValue(pausedSubscription);
      mockStripe.subscriptions.update.mockResolvedValue({
        id: pausedSubscription.stripeSubscriptionId,
        customer: 'cus_123',
        status: 'active',
        items: { data: [] },
        pause_collection: null,
      });
      mockRepository.updateStatus.mockResolvedValue(activeSubscription);

      await subscriptionService.resume('sub_resume_event');

      expect(mockPublishEvent).toHaveBeenCalledWith({
        entityType: 'subscription',
        entityId: pausedSubscription.id,
        eventType: 'subscription.resumed',
        entityVersion: 3,
        eventVersion: 1,
        payload: {
          accountId: pausedSubscription.accountId,
        },
      });
    });

    it('should throw error when subscription not found', async () => {
      mockRepository.findById.mockResolvedValue(null);

      await expect(subscriptionService.resume('sub_missing')).rejects.toThrow(
        'Subscription not found: sub_missing'
      );
    });

    it('should skip Stripe API call when no stripeSubscriptionId', async () => {
      const subscriptionWithoutStripe = createMockSubscription({
        id: 'sub_no_stripe',
        stripeSubscriptionId: '',
        status: 'paused',
      });

      const activeSubscription = createMockSubscription({
        ...subscriptionWithoutStripe,
        status: 'active',
      });

      mockRepository.findById.mockResolvedValue(subscriptionWithoutStripe);
      mockRepository.updateStatus.mockResolvedValue(activeSubscription);

      await subscriptionService.resume('sub_no_stripe');

      expect(mockStripe.subscriptions.update).not.toHaveBeenCalled();
      expect(mockRepository.updateStatus).toHaveBeenCalled();
    });
  });
});
