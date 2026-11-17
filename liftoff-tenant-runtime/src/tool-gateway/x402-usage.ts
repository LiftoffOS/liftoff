// x402-funded connector calls → the usage ledger.
//
// Connector-service pays some vendors PER CALL from the platform's x402
// wallet (a USDC micropayment on a 402 challenge — gloria's premium tools
// first) and reports the settled amount as ExecuteResponse.costUsd. That
// wire field used to be dropped here, which for x402 would mean real money
// leaving the wallet with no usage record anywhere — the exact class of
// defect INV-PB-013 exists to prevent. So the tool gateway ledgers it: one
// usage_events row per paid call, which the control plane's usage-ledger
// ingester books into cost_attribution_events as cost_bucket=
// 'x402_wallet_funded' with real OU consumption (the customer is charged
// the correct number of Operating Units for the call).
//
// The wire is the authority on funding: connector-service ≥0.20.0 reports
// ExecuteResponse.funding_source per call, and only 'x402_wallet' books
// here. Other funding ('tenant_key', 'platform_key') is not a wallet charge,
// and whether it becomes a customer charge is a pricing decision nobody has
// made. An empty report is an older connector-service build; the enumerated
// vendor set below stands in for exactly that case.

import { randomUUID } from 'crypto';
import { usageLedgerService } from '../usage-ledger/service';
import { logger } from '../infrastructure/logging';
import type { ExecuteInput } from './types';

/** LEGACY FALLBACK: connectors whose per-call charges are paid by the
 *  platform x402 wallet, consulted only when the wire carries no
 *  funding_source (an older connector-service build). A connector belongs
 *  here only if its executor pays EXCLUSIVELY through the x402 transport —
 *  which is why strale is absent: its lanes differ per call, and only the
 *  wire report can say which one ran. Do not grow this set for a new vendor;
 *  its executor's funding_source stamp is the mechanism now. */
export const X402_FUNDED_CONNECTORS = new Set<string>([
  'gloria',
  'google_trends',
  'browserbase_x402',
  'kadec0',
]);

/**
 * Ledger one x402-paid connector call. Fire-and-forget, like the web tools'
 * usage tracking: a ledger hiccup must not fail a vendor call that already
 * succeeded (and was already paid for).
 *
 * `ledgerActionId` is the action ledger's own id for this dispatch, threaded
 * from the gateway's recordIntent. It becomes the cost row's action_id, so
 * every wallet payment joins back to the actions row that caused it — the
 * action ledger stays the unifying record. The sandbox dispatch paths bypass
 * recordIntent (they audit-log instead), so a call with no ledger id falls
 * back to a fresh UUID, the web tools' convention.
 */
export function recordX402ConnectorUsage(
  input: ExecuteInput,
  costUsd: number,
  ledgerActionId?: string,
  fundingSource?: string,
): void {
  // Wire-first: a non-empty funding_source is connector-service's own report
  // of whose money paid, and overrides the vendor set in both directions — a
  // dual-lane vendor served by the tenant's own key books nothing, and a
  // wallet-funded call books even for a vendor the set has never heard of.
  if (fundingSource) {
    if (fundingSource !== 'x402_wallet') return;
  } else if (!X402_FUNDED_CONNECTORS.has(input.connector)) {
    return;
  }
  if (!(costUsd > 0)) return;

  usageLedgerService.recordUsage({
    tenantId: input.tenantId,
    agentId: input.agentId,
    workflowId: (input.payload as { workflowId?: string } | undefined)?.workflowId ?? null,
    actionId: ledgerActionId ?? randomUUID(),
    eventType: 'connector_call',
    credits: 1,
    metadata: {
      tool_name: input.actionType,
      vendor: input.connector,
      // The owning thread and invocation, so the cost row lands with the same
      // drill-down keys the audit trail is keyed by.
      thread_id: input.threadId,
      invocation_id: input.invocationId,
      cost_micros: Math.round(costUsd * 1_000_000),
      // The routing marker the ingester keys the x402 branch on. Every paid
      // x402 call is wallet-funded by definition — the wallet is the only
      // payer the x402 transport has.
      funding: 'x402_wallet',
      trace_id: input.traceId,
    },
  }).catch((err: Error) => {
    logger.warn(
      { err: err.message, connector: input.connector, actionType: input.actionType, costUsd },
      'Non-fatal: x402 connector-call usage tracking failed',
    );
  });
}
