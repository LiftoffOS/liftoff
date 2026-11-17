// Subscription + plan domain shapes. Monetary values are int64-safe
// cents expressed as `bigint` in TypeScript. Never `number` (which
// loses precision above 2^53).

export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'unpaid'
  | 'incomplete';

export interface Subscription {
  id: string;
  tenantId: string;
  stripeSubscriptionId: string;
  status: SubscriptionStatus;
  planId: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SubscriptionItem {
  id: string;
  subscriptionId: string;
  stripeItemId: string;
  planFeatureId: string;
  quantity: bigint;
}

export interface Plan {
  id: string;
  name: string;
  description: string;
  /** Monthly base cost, cents. */
  baseAmountCents: bigint;
  /** ISO-4217, e.g. "USD". */
  currency: string;
  stripeProductId: string;
  stripePriceId: string;
  active: boolean;
}

export interface PlanFeature {
  id: string;
  planId: string;
  featureKey: string;
  includedQuantity: bigint | null;
  /** When null, feature is binary (present/absent). */
  overageUnitCostCents: bigint | null;
}

export interface CreditBalance {
  tenantId: string;
  availableCents: bigint;
  reservedCents: bigint;
  asOf: Date;
}
