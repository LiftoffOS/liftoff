// Pub/Sub event envelopes published by liftoff-billing. All events carry
// `ordering_key = tenantId` and consumers use the outbox-backed
// effectively-once pattern from @liftoffos/outbox.

export type BillingEventType =
  | 'billing.invoice.created'
  | 'billing.invoice.finalized'
  | 'billing.subscription.updated'
  | 'billing.subscription.canceled'
  | 'billing.payment.succeeded'
  | 'billing.payment.failed'
  | 'billing.meter.usage_recorded'
  | 'billing.credit_balance.changed';

export interface BillingEventEnvelope<TPayload = unknown> {
  eventId: string;
  eventType: BillingEventType;
  schemaVersion: number;
  tenantId: string;
  occurredAt: Date;
  sourceService: 'liftoff-billing';
  traceId: string;
  payload: TPayload;
}

export interface InvoiceCreatedPayload {
  invoiceId: string;
  stripeInvoiceId: string;
  amountDueCents: bigint;
  currency: string;
  periodStart: Date;
  periodEnd: Date;
}

export interface InvoiceFinalizedPayload extends InvoiceCreatedPayload {
  amountPaidCents: bigint;
  paidAt: Date;
}

export interface SubscriptionUpdatedPayload {
  subscriptionId: string;
  planId: string;
  /** Subscription status as of the event. */
  status: string;
  currentPeriodEnd: Date;
}

export interface MeterUsageRecordedPayload {
  meterEventId: string;
  vendor: string;
  requestId: string;
  quantity: bigint;
  costMicros: bigint | null;
}

export interface CreditBalanceChangedPayload {
  availableCents: bigint;
  reservedCents: bigint;
  /** Positive = credit added; negative = consumed. */
  deltaCents: bigint;
  reason: string;
}

export interface PaymentSucceededPayload {
  invoiceId: string;
  amountCents: bigint;
  paymentMethodId: string;
}

export interface PaymentFailedPayload {
  invoiceId: string;
  amountCents: bigint;
  paymentMethodId: string | null;
  failureCode: string;
  failureMessage: string;
}
