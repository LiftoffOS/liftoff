// Every tool call must reach the governance ledger.
//
// `governance_wal` could end up holding zero rows.
// Two independent causes: the batched fast path never recorded at all, and
// execute()'s specialised branches (agent-Slack, agent-Teams, custom MCP,
// external agent, sandbox, idempotent replay) all return before the record
// that used to sit at the bottom of the execution body.
//
// These tests assert the property that was missing — a call of ANY shape
// produces exactly one WAL write — rather than testing the two fixes
// individually. A new early return added later fails these.

const mockExecuteBatch = jest.fn();
const mockExecute = jest.fn();
const mockWriteWalEntry = jest.fn().mockResolvedValue(undefined);

jest.mock('../../governance/wal', () => ({
  writeWalEntry: (...args: unknown[]) => mockWriteWalEntry(...args),
}));

// 'on' so recordToGovernance does not take its only legitimate early return.
jest.mock('../../governance/governance-service-flag', () => ({
  getGovernanceServiceMode: () => 'on',
  isGovernanceServiceEnabled: () => true,
  isGovernanceShadowMode: () => false,
}));

// The RPC half is not under test here; the WAL write is the durable record.
jest.mock('../../governance/shadow-mode', () => ({
  withGovernanceShadowAndFallback: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../governance/governance-service-client', () => {
  const actual = jest.requireActual('../../governance/governance-service-client');
  return { ...actual, getGovernanceServiceClient: () => ({ record: jest.fn(), authorize: jest.fn() }) };
});

jest.mock('../../connectors/connector-service-client', () => ({
  getConnectorServiceClient: () => ({ execute: mockExecute, executeBatch: mockExecuteBatch }),
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../infrastructure/database', () => ({
  getPool: () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }),
  getPoolForService: () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }),
}));

jest.mock('../../admission/service', () => ({
  AdmissionService: jest.fn().mockImplementation(() => ({
    checkAdmission: jest.fn().mockResolvedValue({ allowed: true }),
  })),
}));

jest.mock('../../action-ledger/service', () => ({
  ActionLedgerService: jest.fn().mockImplementation(() => ({
    getByIdempotencyKey: jest.fn().mockResolvedValue(null),
    recordIntent: jest.fn().mockResolvedValue('action-123'),
    recordOutcome: jest.fn().mockResolvedValue(undefined),
    recordFailure: jest.fn().mockResolvedValue(undefined),
    recordPostActionSnapshot: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('../state-fetcher', () => ({
  stateFetcherRegistry: { fetchState: jest.fn().mockResolvedValue({ data: {}, fetchedAt: new Date(), versionToken: 'v1' }) },
  ExternalStateFetcherRegistry: jest.fn(),
}));

jest.mock('../permission-validator', () => ({
  permissionValidator: { validate: jest.fn().mockResolvedValue({ allowed: true, appliedEntry: null }) },
}));

jest.mock('../conflict-policy-registry', () => ({
  ConflictPolicyRegistry: jest.fn().mockImplementation(() => ({
    get: jest.fn().mockResolvedValue({
      connector: 'slack', entityType: 'message', actionType: 'send',
      freshnessTTL: null, freshReadBeforeWriteRequired: false, versionTokenField: null,
      fieldComparisonSet: [], conflictResolutionMode: 'last-write-wins',
      escalateOnConflict: false, undoSupportMode: 'none',
    }),
  })),
}));

// The specialised handlers each return without touching the main body.
jest.mock('../agent-slack-handler', () => ({
  agentSlackHandler: { execute: jest.fn().mockResolvedValue({ success: true, data: { ok: true }, traceId: 't' }) },
}), { virtual: true });

import { ToolGatewayService } from '../service';
import type { ExecuteInput } from '../types';

const baseInput = (o: Partial<ExecuteInput>): ExecuteInput => ({
  tenantId: 'tenant-1',
  agentId: 'agent-1',
  instructionVersion: 1,
  traceId: 'trace-abc',
  idempotencyKey: 'idk',
  connector: 'slack',
  entityType: 'message',
  actionType: 'send_message',
  payload: { channel: '#c', text: 'hi' },
  ...o,
});

describe('governance audit coverage', () => {
  let svc: ToolGatewayService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockWriteWalEntry.mockResolvedValue(undefined);
    svc = new ToolGatewayService();
  });

  // The batched fast path. Every Google Sheets call an agent makes goes this
  // way, and it produced ledger rows but no audit rows.
  it('records a batched fast-path call', async () => {
    mockExecuteBatch.mockResolvedValueOnce({
      results: [{ success: true, result: { ok: 1 }, error: '' }],
    });

    await svc.executeBatch([baseInput({ idempotencyKey: 'batch-1' })]);

    expect(mockWriteWalEntry).toHaveBeenCalledTimes(1);
    expect(mockWriteWalEntry.mock.calls[0][0]).toMatchObject({
      tenantId: 'tenant-1',
      idempotencyKey: 'batch-1',
    });
  });

  it('records every slot of a multi-item batch, not just the first', async () => {
    mockExecuteBatch.mockResolvedValueOnce({
      results: [
        { success: true, result: { ok: 1 }, error: '' },
        { success: false, result: null, error: 'vendor exploded' },
      ],
    });

    await svc.executeBatch([
      baseInput({ idempotencyKey: 'b1' }),
      baseInput({ idempotencyKey: 'b2' }),
    ]);

    expect(mockWriteWalEntry).toHaveBeenCalledTimes(2);
    const keys = mockWriteWalEntry.mock.calls.map((c) => c[0].idempotencyKey).sort();
    expect(keys).toEqual(['b1', 'b2']);
  });

  // A failed tool call is as security-relevant as a successful one.
  it('records a failed batch slot', async () => {
    mockExecuteBatch.mockResolvedValueOnce({
      results: [{ success: false, result: null, error: 'permission denied upstream' }],
    });

    await svc.executeBatch([baseInput({ idempotencyKey: 'fail-1' })]);

    expect(mockWriteWalEntry).toHaveBeenCalledTimes(1);
  });

  // Exactly one. The record used to live inside the execution body; it is now
  // in the wrapper, and a leftover inner call would double every audit row.
  it('records a single connector call exactly once', async () => {
    mockExecute.mockResolvedValueOnce({ success: true, result: { ok: true }, error: '' });

    await svc.execute(baseInput({ idempotencyKey: 'single-1', actionType: 'send_message' }));

    expect(mockWriteWalEntry).toHaveBeenCalledTimes(1);
  });

  // A connector failure does NOT throw — the tool-error contract converts it
  // to a structured failure result. It is still an audited event.
  it('records a connector failure that returns rather than throws', async () => {
    mockExecute.mockRejectedValueOnce(new Error('connector blew up'));

    const r = await svc.execute(baseInput({ idempotencyKey: 'connfail-1' }));

    expect(r.success).toBe(false);
    expect(mockWriteWalEntry).toHaveBeenCalledTimes(1);
    expect(mockWriteWalEntry.mock.calls[0][0]).toMatchObject({ idempotencyKey: 'connfail-1' });
  });

  // A genuine throw is a refusal, and refusals belong in the ledger. Before
  // the wrapper, a throw from any pre-ledger branch recorded nothing — and
  // validateIdentity is the very first statement in the execution body, so
  // this is the earliest possible exit.
  it('records and rethrows when the call is refused outright', async () => {
    await expect(
      svc.execute(baseInput({ idempotencyKey: 'refused-1', agentId: '' })),
    ).rejects.toThrow('Agent ID required');

    expect(mockWriteWalEntry).toHaveBeenCalledTimes(1);
    expect(mockWriteWalEntry.mock.calls[0][0]).toMatchObject({ idempotencyKey: 'refused-1' });
  });

  // The audit must not become a new way for tool calls to fail: writeWalEntry
  // failures are swallowed inside recordToGovernance by design.
  it('does not fail the tool call when the audit write fails', async () => {
    mockExecute.mockResolvedValueOnce({ success: true, result: { ok: true }, error: '' });
    mockWriteWalEntry.mockRejectedValueOnce(new Error('wal table gone'));

    const r = await svc.execute(baseInput({ idempotencyKey: 'resilient-1' }));
    expect(r.success).toBe(true);
  });
});
