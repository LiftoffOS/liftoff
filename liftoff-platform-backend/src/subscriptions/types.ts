// Subscription Types

export interface Subscription {
  id: string;
  accountId: string;
  planId: string;
  stripeSubscriptionId: string;
  status: string;
  version: number;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateSubscriptionInput {
  accountId: string;
  planId: string;
  stripeCustomerId: string;
  stripePriceId: string;
}
