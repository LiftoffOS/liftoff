// Subscription Service Implementation
// Per Section 13: Use Stripe subscriptions for the commercial plan

import Stripe from 'stripe';
import { Subscription, CreateSubscriptionInput } from './types';
import { SubscriptionRepository } from './repository';
import { getStripeSecretKey } from '../infrastructure/secrets';
import { publishEvent } from '../events/publisher';

let stripe: Stripe | null = null;

async function getStripe(): Promise<Stripe> {
  if (!stripe) {
    const secretKey = await getStripeSecretKey();
    stripe = new Stripe(secretKey);
  }
  return stripe;
}

export class SubscriptionService {
  private repository = new SubscriptionRepository();

  async create(input: CreateSubscriptionInput): Promise<Subscription> {
    const stripeClient = await getStripe();

    // Create Stripe subscription
    const stripeSubscription = await stripeClient.subscriptions.create({
      customer: input.stripeCustomerId,
      items: [{ price: input.stripePriceId }],
    });

    const subscription = await this.repository.create({
      accountId: input.accountId,
      planId: input.planId,
      stripeSubscriptionId: stripeSubscription.id,
      status: stripeSubscription.status,
    });

    await publishEvent({
      entityType: 'subscription',
      entityId: subscription.id,
      eventType: 'subscription.created',
      entityVersion: subscription.version,
      eventVersion: 1,
      payload: {
        accountId: subscription.accountId,
        planId: subscription.planId,
        stripeSubscriptionId: subscription.stripeSubscriptionId,
        status: subscription.status,
      },
    });

    return subscription;
  }

  async getById(id: string): Promise<Subscription | null> {
    return this.repository.findById(id);
  }

  async getByAccountId(accountId: string): Promise<Subscription[]> {
    return this.repository.findByAccountId(accountId);
  }

  async getActiveByAccountId(accountId: string): Promise<Subscription | null> {
    return this.repository.findActiveByAccountId(accountId);
  }

  async cancel(id: string): Promise<Subscription> {
    const stripeClient = await getStripe();

    const subscription = await this.repository.findById(id);
    if (!subscription) {
      throw new Error(`Subscription not found: ${id}`);
    }

    if (subscription.stripeSubscriptionId) {
      await stripeClient.subscriptions.cancel(subscription.stripeSubscriptionId);
    }

    const updated = await this.repository.updateStatus(id, 'canceled');

    await publishEvent({
      entityType: 'subscription',
      entityId: subscription.id,
      eventType: 'subscription.canceled',
      entityVersion: updated.version,
      eventVersion: 1,
      payload: {
        accountId: subscription.accountId,
      },
    });

    return updated;
  }

  async pause(id: string): Promise<Subscription> {
    const stripeClient = await getStripe();

    const subscription = await this.repository.findById(id);
    if (!subscription) {
      throw new Error(`Subscription not found: ${id}`);
    }

    if (subscription.stripeSubscriptionId) {
      await stripeClient.subscriptions.update(subscription.stripeSubscriptionId, {
        pause_collection: { behavior: 'void' },
      });
    }

    const updated = await this.repository.updateStatus(id, 'paused');

    await publishEvent({
      entityType: 'subscription',
      entityId: subscription.id,
      eventType: 'subscription.paused',
      entityVersion: updated.version,
      eventVersion: 1,
      payload: {
        accountId: subscription.accountId,
      },
    });

    return updated;
  }

  async resume(id: string): Promise<Subscription> {
    const stripeClient = await getStripe();

    const subscription = await this.repository.findById(id);
    if (!subscription) {
      throw new Error(`Subscription not found: ${id}`);
    }

    if (subscription.stripeSubscriptionId) {
      await stripeClient.subscriptions.update(subscription.stripeSubscriptionId, {
        pause_collection: null,
      });
    }

    const updated = await this.repository.updateStatus(id, 'active');

    await publishEvent({
      entityType: 'subscription',
      entityId: subscription.id,
      eventType: 'subscription.resumed',
      entityVersion: updated.version,
      eventVersion: 1,
      payload: {
        accountId: subscription.accountId,
      },
    });

    return updated;
  }

  // Get account by Stripe customer ID (used for webhook processing)
  async getAccountByStripeCustomerId(customerId: string): Promise<{ id: string; tenantId: string } | null> {
    const subscription = await this.repository.findByStripeCustomerId(customerId);
    if (!subscription) {
      return null;
    }
    return {
      id: subscription.accountId,
      tenantId: subscription.accountId, // Assuming tenantId equals accountId
    };
  }

  // Sync subscription from Stripe (used for webhook processing)
  async syncFromStripe(stripeSubscriptionId: string): Promise<void> {
    const stripeClient = await getStripe();
    const stripeSubscription = await stripeClient.subscriptions.retrieve(stripeSubscriptionId);

    const subscription = await this.repository.findByStripeId(stripeSubscriptionId);
    if (subscription) {
      await this.repository.updateStatus(subscription.id, stripeSubscription.status);
    }
  }
}
