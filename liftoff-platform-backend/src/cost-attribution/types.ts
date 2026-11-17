// Cost Attribution Module — shared types.
//
// CostAttributionEvent is the canonical cost record. One row per billable
// unit (LLM invocation, connector call, infrastructure compute, etc.).
// Ingested from multiple sources into cost_attribution_events (partitioned).

export type EventType =
  | 'llm_invocation'
  | 'embedding'
  | 'connector_call'
  | 'infra_compute'
  | 'developer_proxy_llm'
  | 'credit'
  | 'web_tool'
  | 'sandbox'
  | 'cloud_scheduler'
  | 'kms_operation'
  | 'cloud_tasks'
  | 'cloud_storage_op'
  | 'cloud_build'
  // Voice. Both land in migration 331's CHECK constraint together — see
  // migration 253 for what happens when a TypeScript EventType ships without
  // its constraint value. Both are written today: dictation and conversation
  // listening produce voice_stt, spoken replies produce voice_tts.
  | 'voice_stt'
  | 'voice_tts';

export type EventSource =
  | 'tenant_runtime'
  | 'governance'
  | 'developer_proxy'
  | 'gcp_billing'
  | 'gcp_billing_platform'
  | 'platform_llm'
  | 'composio_mcp'
  // An operator handing Operating Units back for work that failed. Travels as a
  // negative-cost event so it reuses applyOuRefund rather than a parallel path;
  // its CHECK value lands in migration 448 alongside this line, because
  // migration 253 is what happens when the two are separated.
  | 'operator_credit';
// Note: the usage-ledger-ingester stores per-tenant cursors under
// `usage_ledger_{tenantId}` (a dynamic string) and writes events with
// `source = 'tenant_runtime'` so /insights queries discriminate by event_type.

export type CorrelationConfidence = 'direct' | 'exact' | 'fuzzy' | 'unmatched';

export interface CostAttributionEvent {
  id?: string;
  tenantId: string;
  agentId?: string | null;
  workflowId?: string | null;
  actionId?: string | null;
  threadId?: string | null;
  invocationId?: string | null;
  parentInvocationId?: string | null;
  itemId?: string | null;
  connector?: string | null;
  entityType?: string | null;
  actionType?: string | null;
  purpose?: string | null;
  eventType: EventType;
  source: EventSource;
  sourceId?: string | null;
  provider?: string | null;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedTokens?: number | null;
  costUsd: number;
  /**
   * Vendor-native usage for this row, in `usageUnit`. Voice rows and x402
   * connector calls today (migrations 326, 440).
   *
   * Not derivable from costUsd: vendor invoices are denominated in characters
   * and hours, and USD is not invertible once a vendor changes price. Kept so a
   * voice equivalent of src/web-tools/vendor-reconciliation.ts can reconcile
   * against a real bill. Token-billed vendors ALSO populate outputTokens, where
   * the value genuinely is tokens. x402 vendors charge per CALL, so their rows
   * carry usage_quantity=1, usage_unit='call' and reconciliation against the
   * wallet's on-chain settled USDC counts calls and sums cost_usd.
   */
  usageQuantity?: number | null;
  usageUnit?: 'characters' | 'audio_tokens' | 'audio_seconds' | 'call' | null;
  /**
   * True when the CUSTOMER'S OWN provider key served this call.
   *
   * A routing input, not a column: `ingestEventWithBuckets` reads it to pick
   * the bucket and nothing writes it to the row, because `cost_bucket =
   * 'byok_customer_funded'` already carries the fact. Reported by the BYOK
   * gateway, the only component that knows which key actually went out on the
   * wire.
   */
  byokFunded?: boolean;
  /**
   * Whose key paid the VENDOR for a web-tool call.
   *
   * A routing input, not a column, exactly like `byokFunded` above — and
   * deliberately separate from it, because the two route to different places.
   * `byokFunded` is the customer's own LLM provider key and books
   * `cost_bucket='byok_customer_funded'`; this is a web-tool vendor and books
   * `'unknown'`, which is the bucket every strict BYOK web-tool row has always
   * used and the one downstream customer-billed totals already exclude.
   *
   * Only vendors that have BOTH a platform key and a BYOK connector populate
   * it — steel, browser_use, tavily and exa today — because only there does the
   * answer vary per tenant. Absent means the vendor's usual funding, which for every strict
   * BYOK web-tool vendor is the tenant's own key.
   */
  webToolFunding?: 'tenant_key' | 'platform';
  /**
   * True when the platform's x402 wallet paid the VENDOR for this call (a USDC
   * micropayment settled per call — gloria premium and the other x402 vendors).
   *
   * A routing input, not a column, like the two flags above — but it routes to
   * a third place: the row is booked `cost_bucket='x402_wallet_funded'` AND the
   * customer IS charged real OUs for it (applyOuConsumption runs exactly as it
   * does for the plain customer path). The wallet paying the vendor is a fact
   * about the vendor side of the call, not a reason to waive the charge —
   * unlike BYOK, where the customer already paid the vendor themselves.
   * Reported by the tenant runtime off the connector-service executor's
   * receipt-derived costUsd.
   */
  x402Funded?: boolean;
  ouConsumed:      number;
  customerCostUsd: number;
  costBucket:      'included' | 'precommit' | 'reload' | 'platform_overhead' | 'byok_customer_funded' | 'x402_wallet_funded' | 'unknown';
  hostingMode?: string | null;
  correlationConfidence?: CorrelationConfidence | null;
  occurredAt: Date;
  createdAt?: Date;
}

export interface CostAttributionSnapshot {
  tenantId: string;
  agentId?: string | null;
  workflowId?: string | null;
  periodStart: Date;
  periodEnd: Date;
  granularity: 'hour' | 'day' | 'month';
  totalCostUsd: number;
  llmCostUsd: number;
  connectorCostUsd: number;
  infraCostUsd: number;
  totalInvocations: number;
  totalActions: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

export interface AttributionQuery {
  tenantId: string;
  agentId?: string;
  workflowId?: string;
  since?: Date;
  until?: Date;
  eventType?: EventType;
  limit?: number;
  cursor?: string;
}

export interface CostBreakdown {
  totalCostUsd: number;
  llmCostUsd: number;
  connectorCostUsd: number;
  infraCostUsd: number;
  developerProxyCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalInvocations: number;
}

export interface CostByAgent {
  agentId: string;
  totalCostUsd: number;
  llmCostUsd: number;
  connectorCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  invocationCount: number;
}
