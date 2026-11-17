// Cross-service Pub/Sub event envelope. Mirrors the
// liftoff.event.v1.EventEnvelope proto field-for-field so the same
// shape is wire-compatible across publishers and consumers.

export interface EventEnvelope<TPayload = unknown> {
  /** UUID — also used as the idempotency key on the consumer side. */
  eventId: string;
  /** Domain-specific type, e.g. `billing.invoice.created`. */
  eventType: string;
  /** Bumped when the payload shape changes in a backwards-incompatible way. */
  schemaVersion: number;
  tenantId: string;
  occurredAt: Date;
  sourceService: string;
  /** W3C traceparent. */
  traceId: string | null;
  payload: TPayload;
}

export function serializeEnvelope<T>(env: EventEnvelope<T>): string {
  return JSON.stringify({
    eventId: env.eventId,
    eventType: env.eventType,
    schemaVersion: env.schemaVersion,
    tenantId: env.tenantId,
    occurredAt: env.occurredAt.toISOString(),
    sourceService: env.sourceService,
    traceId: env.traceId,
    payload: env.payload,
  });
}

export function deserializeEnvelope<T = unknown>(raw: string | Buffer): EventEnvelope<T> {
  const text = typeof raw === 'string' ? raw : raw.toString('utf-8');
  const parsed = JSON.parse(text) as {
    eventId: string;
    eventType: string;
    schemaVersion: number;
    tenantId: string;
    occurredAt: string;
    sourceService: string;
    traceId: string | null;
    payload: T;
  };
  return {
    eventId: parsed.eventId,
    eventType: parsed.eventType,
    schemaVersion: parsed.schemaVersion,
    tenantId: parsed.tenantId,
    occurredAt: new Date(parsed.occurredAt),
    sourceService: parsed.sourceService,
    traceId: parsed.traceId,
    payload: parsed.payload,
  };
}
