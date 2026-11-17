// Subscriptions Router
// Per Section 13: Stripe subscriptions for commercial plan

import { Router } from 'express';
import { SubscriptionService } from './service';
import { logAudit } from '../infrastructure/logging';

export const subscriptionsRouter = Router();
const service = new SubscriptionService();

// Create a new subscription
subscriptionsRouter.post('/', async (req, res, next) => {
  try {
    const subscription = await service.create(req.body);

    logAudit('subscription.created', req.ctx, {
      subscriptionId: subscription.id,
      accountId: subscription.accountId,
      planId: subscription.planId,
    });

    res.status(201).json(subscription);
  } catch (error) {
    next(error);
  }
});

// Get subscription by ID
subscriptionsRouter.get('/:id', async (req, res, next) => {
  try {
    const subscription = await service.getById(req.params.id);
    if (!subscription) {
      res.status(404).json({ error: 'Subscription not found' });
      return;
    }
    res.json(subscription);
  } catch (error) {
    next(error);
  }
});

// Get subscriptions for an account
subscriptionsRouter.get('/account/:accountId', async (req, res, next) => {
  try {
    const subscriptions = await service.getByAccountId(req.params.accountId);
    res.json(subscriptions);
  } catch (error) {
    next(error);
  }
});

// Get active subscription for an account
subscriptionsRouter.get('/account/:accountId/active', async (req, res, next) => {
  try {
    const subscription = await service.getActiveByAccountId(req.params.accountId);
    if (!subscription) {
      res.status(404).json({ error: 'No active subscription found' });
      return;
    }
    res.json(subscription);
  } catch (error) {
    next(error);
  }
});

// Cancel a subscription
subscriptionsRouter.post('/:id/cancel', async (req, res, next) => {
  try {
    const subscription = await service.cancel(req.params.id);

    logAudit('subscription.canceled', req.ctx, {
      subscriptionId: subscription.id,
      accountId: subscription.accountId,
    });

    res.json(subscription);
  } catch (error) {
    next(error);
  }
});

// Pause a subscription
subscriptionsRouter.post('/:id/pause', async (req, res, next) => {
  try {
    const subscription = await service.pause(req.params.id);

    logAudit('subscription.paused', req.ctx, {
      subscriptionId: subscription.id,
      accountId: subscription.accountId,
    });

    res.json(subscription);
  } catch (error) {
    next(error);
  }
});

// Resume a subscription
subscriptionsRouter.post('/:id/resume', async (req, res, next) => {
  try {
    const subscription = await service.resume(req.params.id);

    logAudit('subscription.resumed', req.ctx, {
      subscriptionId: subscription.id,
      accountId: subscription.accountId,
    });

    res.json(subscription);
  } catch (error) {
    next(error);
  }
});

// Webhook endpoint removed — liftoff-billing is the sole Stripe webhook
// receiver as of Phase 0. All Stripe events are processed there and state
// mutations are applied to billing_controls via the internal billing API.
// See: src/billing/billing-controls-internal-router.ts
