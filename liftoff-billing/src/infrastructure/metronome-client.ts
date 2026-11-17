// Stripe-native usage billing — replaces the defunct api.metronome.com integration.
// Stripe acquired Metronome; OU events now flow through stripe.billing.meterEvents.
import Stripe from 'stripe';

export const OU_METER_EVENT_NAME = 'operating_unit_consumed';

export interface StripeUsageClient {
  attachOuPriceToSubscription(subscriptionId: string): Promise<void>;
  ingestOuEvent(event: { stripeCustomerId: string; quantity: bigint; requestId: string; occurredAt: Date }): Promise<void>;
}

export function buildStripeUsageClient(stripe: Stripe, ouPriceId: string): StripeUsageClient {
  return {
    async attachOuPriceToSubscription(subscriptionId) {
      if (!ouPriceId) return;
      const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ['items'] });
      const alreadyAttached = sub.items.data.some((item) => item.price.id === ouPriceId);
      if (alreadyAttached) return;
      await stripe.subscriptionItems.create({ subscription: subscriptionId, price: ouPriceId });
    },

    async ingestOuEvent({ stripeCustomerId, quantity, requestId, occurredAt }) {
      await stripe.billing.meterEvents.create({
        event_name: OU_METER_EVENT_NAME,
        payload: {
          value: String(quantity),
          stripe_customer_id: stripeCustomerId,
        },
        identifier: requestId,
        timestamp: Math.floor(occurredAt.getTime() / 1000),
      });
    },
  };
}
