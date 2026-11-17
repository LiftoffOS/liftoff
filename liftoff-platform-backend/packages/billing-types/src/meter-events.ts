// Meter events — atomic units of usage reported to billing by developer-proxy,
// tenant-runtime, and platform-backend. ReportUsage is idempotent on
// (tenantId, userId, vendor, requestId); duplicate inserts return the
// original row.

export type BillingVendor = 'anthropic' | 'openai' | 'internal';

export interface MeterEvent {
  id: string;
  tenantId: string;
  userId: string | null;
  vendor: BillingVendor;
  requestId: string;
  /** Meaning depends on eventType (tokens, seconds, calls). */
  quantity: bigint;
  eventType: string;
  occurredAt: Date;
  /** Null until reconciled with Stripe. */
  reportedAt: Date | null;
}

/**
 * Report usage input. Uniqueness constraint spans
 * (tenantId, userId, vendor, requestId); the server treats duplicate
 * inserts as idempotent no-ops.
 */
export interface ReportUsageInput {
  tenantId: string;
  userId: string | null;
  vendor: BillingVendor;
  requestId: string;
  eventType: string;
  quantity: bigint;
  occurredAt: Date;
  /**
   * Optional — the caller's cost computation in micros. Stored verbatim;
   * reconciliation catches drift against Stripe.
   */
  costMicros: bigint | null;
}

export interface ReportUsageResult {
  meterEvent: MeterEvent;
  /** True when this call created a new row; false on idempotent replay. */
  created: boolean;
}

export interface MeterReconciliationLog {
  id: string;
  windowStart: Date;
  windowEnd: Date;
  tenantId: string | null;
  eventsScanned: bigint;
  eventsReported: bigint;
  driftCount: bigint;
  /** Signed. Positive = billing under-reported to Stripe. */
  netDriftMicros: bigint;
  completedAt: Date;
}
