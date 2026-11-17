// INV-PB-013 for the x402 connector path: every vendor the platform x402
// wallet pays per call MUST ledger a usage record — money leaving the wallet
// with no row anywhere is invisible spend. Enumerates X402_FUNDED_CONNECTORS
// so a vendor added to the set cannot ship without the record shape the
// control plane's ingester books (cost_micros + the funding marker), and so
// the scoping stays tight: absent a wire funding report, a connector outside
// the set must record NOTHING, because whether its costUsd becomes a
// customer charge is a pricing decision, not a side effect. When the wire
// DOES report (ExecuteResponse.funding_source), its word is the authority.

const mockRecordUsage = jest.fn().mockResolvedValue(undefined);
jest.mock('../../usage-ledger/service', () => ({
  usageLedgerService: { recordUsage: (...a: unknown[]) => mockRecordUsage(...a) },
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { recordX402ConnectorUsage, X402_FUNDED_CONNECTORS } from '../x402-usage';
import type { ExecuteInput } from '../types';

function input(over: Partial<ExecuteInput> = {}): ExecuteInput {
  return {
    tenantId: 't-1',
    agentId: 'a-1',
    instructionVersion: 1,
    traceId: 'trace-1',
    idempotencyKey: 'idem-1',
    connector: 'gloria',
    entityType: 'news',
    actionType: 'get_ticker_summary',
    payload: { ticker: 'BTC' },
    threadId: 'thread-9',
    invocationId: 'inv-7',
    ...over,
  } as ExecuteInput;
}

beforeEach(() => mockRecordUsage.mockClear());

describe('x402 connector usage (INV-PB-013)', () => {
  it('enumerates at least one funded connector, so nothing here passes vacuously', () => {
    expect(X402_FUNDED_CONNECTORS.size).toBeGreaterThan(0);
  });

  it.each([...X402_FUNDED_CONNECTORS])(
    '%s ledgers every paid call with the shape the ingester books',
    (connector) => {
      recordX402ConnectorUsage(input({ connector }), 0.011);
      expect(mockRecordUsage).toHaveBeenCalledTimes(1);
      const event = mockRecordUsage.mock.calls[0][0] as {
        tenantId: string; agentId: string; eventType: string;
        metadata: Record<string, unknown>;
      };
      expect(event.tenantId).toBe('t-1');
      expect(event.agentId).toBe('a-1');
      expect(event.eventType).toBe('connector_call');
      // The two fields the control plane's booking depends on: the settled
      // amount (metadata-priced, never off credits) and the routing marker.
      expect(event.metadata.cost_micros).toBe(11_000);
      expect(event.metadata.funding).toBe('x402_wallet');
      expect(event.metadata.vendor).toBe(connector);
      expect(event.metadata.tool_name).toBe('get_ticker_summary');
      // Drill-down keys: the thread and invocation the audit trail is keyed by.
      expect(event.metadata.thread_id).toBe('thread-9');
      expect(event.metadata.invocation_id).toBe('inv-7');
    },
  );

  it("carries the action ledger's id so the cost row joins the actions row", () => {
    recordX402ConnectorUsage(input(), 0.011, 'action-ledger-id-1');
    const event = mockRecordUsage.mock.calls[0][0] as { actionId: string };
    expect(event.actionId).toBe('action-ledger-id-1');
  });

  it('falls back to a fresh id on paths with no ledger action (sandbox dispatch)', () => {
    recordX402ConnectorUsage(input(), 0.011);
    const event = mockRecordUsage.mock.calls[0][0] as { actionId: string };
    expect(event.actionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('records nothing for a paid call on a connector OUTSIDE the set', () => {
    recordX402ConnectorUsage(input({ connector: 'strale' }), 0.05);
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  // The wire is the authority (ExecuteResponse.funding_source, CS ≥0.20.0):
  // a non-empty report overrides the vendor set in both directions.
  it("wire 'x402_wallet' books a connector the set has never heard of", () => {
    recordX402ConnectorUsage(input({ connector: 'strale' }), 0.05, undefined, 'x402_wallet');
    expect(mockRecordUsage).toHaveBeenCalledTimes(1);
    const event = mockRecordUsage.mock.calls[0][0] as { metadata: Record<string, unknown> };
    expect(event.metadata.funding).toBe('x402_wallet');
    expect(event.metadata.cost_micros).toBe(50_000);
  });

  it("wire 'tenant_key' books NOTHING even for a vendor in the set — the dual-lane case", () => {
    recordX402ConnectorUsage(input({ connector: 'gloria' }), 0.031, undefined, 'tenant_key');
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it("wire 'platform_key' books nothing here either", () => {
    recordX402ConnectorUsage(input({ connector: 'gloria' }), 0.02, undefined, 'platform_key');
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it('an EMPTY wire report falls back to the vendor set (older connector-service)', () => {
    recordX402ConnectorUsage(input({ connector: 'gloria' }), 0.011, undefined, '');
    expect(mockRecordUsage).toHaveBeenCalledTimes(1);
  });

  it('records nothing for a free ($0) call on a funded connector', () => {
    recordX402ConnectorUsage(input({ connector: 'gloria' }), 0);
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it('survives a ledger failure without throwing — the vendor call already succeeded', async () => {
    mockRecordUsage.mockRejectedValueOnce(new Error('ledger down'));
    expect(() => recordX402ConnectorUsage(input(), 0.01)).not.toThrow();
    // Let the rejected promise's catch run.
    await new Promise((resolve) => setImmediate(resolve));
  });
});
