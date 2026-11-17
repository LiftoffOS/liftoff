// Stripe webhook envelope + idempotency record. Stripe webhooks require
// raw request body for signature verification, so the HTTP handler lives
// directly on liftoff-billing (Phase 1c) — not as a Connect-RPC.

export interface StripeWebhookEvent {
  id: string;
  stripeEventId: string;
  stripeEventType: string;
  livemode: boolean;
  apiVersion: string | null;
  /** SHA256 of the raw payload — for tamper detection only. */
  payloadSha256: string;
  /** Raw Stripe JSON payload. Retained for replay + forensics. */
  payload: unknown;
  signature: string;
  /** Milliseconds since epoch, extracted from the signature header's `t=` value. */
  signatureTimestampMs: bigint;
  receivedAt: Date;
  /** Null until the outbox worker drains this event. */
  processedAt: Date | null;
  processingErrors: string[];
}

export interface StripeWebhookAckResult {
  /** Always true — handler always 200s after outbox write. */
  acknowledged: true;
  /** False on idempotent replay (stripeEventId already stored). */
  wasNew: boolean;
  outboxEventId: string | null;
}
