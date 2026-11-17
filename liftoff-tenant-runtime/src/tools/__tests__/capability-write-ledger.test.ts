// A write-class capability is an outward act and is treated as one: claimed
// in the action ledger before it runs, answered from the ledger when this run
// already did it, recorded when it is done — and never reported as a failure
// because the ledger could not record a send that happened.

jest.mock('../../clients/platform-backend-client', () => {
  const actual = jest.requireActual('../../clients/platform-backend-client');
  return { ...actual, capabilitySearchViaBackend: jest.fn(), runCapabilityViaBackend: jest.fn() };
});
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockFindCompleted = jest.fn();
jest.mock('../../tool-gateway/duplicate-outward-action', () => {
  const actual = jest.requireActual('../../tool-gateway/duplicate-outward-action');
  return { ...actual, findCompletedDuplicate: (...a: unknown[]) => mockFindCompleted(...a) };
});
const mockClaim = jest.fn();
const mockRecordOutcome = jest.fn();
const mockRecordFailure = jest.fn();
jest.mock('../../action-ledger/service', () => ({
  ActionLedgerService: jest.fn().mockImplementation(() => ({
    claimCapabilityWrite: (...a: unknown[]) => mockClaim(...a),
    recordOutcome: (...a: unknown[]) => mockRecordOutcome(...a),
    recordFailure: (...a: unknown[]) => mockRecordFailure(...a),
  })),
}));

import { executeStandardTool, type StandardToolContext } from '../standard-tool-handler';
import { runCapabilityViaBackend } from '../../clients/platform-backend-client';
import { recordCapabilityApproval, capabilityApprovalKey } from '../../tool-gateway/capability-approval-signal';
import { logger } from '../../infrastructure/logging';

const mockRun = runCapabilityViaBackend as jest.MockedFunction<typeof runCapabilityViaBackend>;

const INV = '6ebe2b95-0000-4000-8000-000000000001';
const OP = '0123456789ab';
const WRITE_HANDLE = `cap_w.${OP}.mail_send.aGVsbG8`;
const send = { to: 'person@example.com', subject: 'Lead enrichment result', body: 'hello' };

const ctx: StandardToolContext = {
  tenantId: 'tenant-1', agentId: 'agent-1', memoryScope: {}, integrations: [],
  invocationId: INV, traceId: 'resume-hitl-' + INV, messageSenderAccountId: 'acct-9',
};

function approve(payload: Record<string, unknown>) {
  recordCapabilityApproval(capabilityApprovalKey(INV, payload));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFindCompleted.mockResolvedValue(null);
  mockClaim.mockResolvedValue({ kind: 'owned', actionId: 'action-1' });
  mockRecordOutcome.mockResolvedValue(undefined);
  mockRecordFailure.mockResolvedValue(undefined);
});

describe('a write-class capability, first time in the run', () => {
  it('is claimed, dispatched with the act\'s key, and recorded completed with what came back', async () => {
    mockRun.mockResolvedValue({ ok: true, text: '{"id":"1a0a2ecbe2dd5c77"}' });
    const payload = { capabilityId: WRITE_HANDLE, args: send };
    approve(payload);

    const res = await executeStandardTool('run_capability', payload, ctx);

    expect(res).toEqual({ success: true, result: '{"id":"1a0a2ecbe2dd5c77"}' });
    const [intent, handle] = mockClaim.mock.calls[0] as [Record<string, unknown>, string];
    expect(handle).toBe(WRITE_HANDLE);
    expect(intent).toMatchObject({
      connector: 'capability', actionType: 'run_capability', invocationId: INV,
      targetRef: expect.stringMatching(/^capability:to\/person@example.com@[0-9a-f]{12}$/),
      actKey: expect.stringMatching(new RegExp(`^cap:mail_send:${OP}\\|to/person@example\\.com@[0-9a-f]{12}$`)),
      idempotencyKey: expect.stringMatching(new RegExp(`^cap:${INV}:${OP}:[0-9a-f]{16}$`)),
    });
    // The same key reaches the control plane, and so the connector boundary.
    expect(mockRun).toHaveBeenCalledWith('tenant-1', 'acct-9', WRITE_HANDLE, send, true, intent.idempotencyKey, { scopeId: '6ebe2b95-0000-4000-8000-000000000001' }, undefined);
    expect(mockRecordOutcome).toHaveBeenCalledWith('action-1', { success: true, data: '{"id":"1a0a2ecbe2dd5c77"}' });
    expect(mockRecordFailure).not.toHaveBeenCalled();
  });

  it('two calls that would do the same thing carry the same key; different arguments do not', async () => {
    mockRun.mockResolvedValue({ ok: true, text: 'ok' });
    await executeStandardTool('run_capability', { capabilityId: WRITE_HANDLE, args: { ...send, body: 'v1' } }, ctx);
    await executeStandardTool('run_capability', { capabilityId: `cap_w.${OP}.mail_send.ZnJlc2g`, args: { ...send, body: 'v1' } }, ctx);
    await executeStandardTool('run_capability', { capabilityId: WRITE_HANDLE, args: { ...send, subject: 'Other' } }, ctx);
    const keys = mockClaim.mock.calls.map((c) => (c[0] as { idempotencyKey: string }).idempotencyKey);
    // A fresh search mints a new handle for the same operation: same key.
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('a refusal from the control plane is recorded as a failure, never as an act', async () => {
    mockRun.mockResolvedValue({ ok: false, kind: 'requires_approval', text: 'This capability was not run.' });
    const res = await executeStandardTool('run_capability', { capabilityId: WRITE_HANDLE, args: send }, ctx);
    expect(res).toEqual({ success: false, error: 'This capability was not run.' });
    expect(mockRecordFailure).toHaveBeenCalledWith('action-1', expect.any(Error));
    expect(mockRecordOutcome).not.toHaveBeenCalled();
  });
});

describe('a write-class capability this run already did', () => {
  it('is replayed from the claim: no dispatch, the first response, and a notice that says so', async () => {
    mockClaim.mockResolvedValue({ kind: 'replay', actionId: 'action-1', createdAt: '2026-09-15T02:37:00.000Z', externalResponse: '{"id":"1a0a2ecbe2dd5c77"}' });
    const res = await executeStandardTool('run_capability', { capabilityId: WRITE_HANDLE, args: send }, ctx);
    expect(mockRun).not.toHaveBeenCalled();
    expect(res?.success).toBe(true);
    expect(res?.result).toMatch(/^Already done in this run:/);
    expect(res?.result).toContain('nothing was sent a second time');
    expect(res?.result).toContain('{"id":"1a0a2ecbe2dd5c77"}');
    expect(mockRecordOutcome).not.toHaveBeenCalled();
  });

  it('is refused while a sibling still holds the claim: no dispatch, not retryable', async () => {
    mockClaim.mockResolvedValue({ kind: 'in_flight', actionId: 'action-1', claimedAt: new Date().toISOString() });
    const res = await executeStandardTool('run_capability', { capabilityId: WRITE_HANDLE, args: send }, ctx);
    expect(mockRun).not.toHaveBeenCalled();
    expect(res?.success).toBe(false);
    expect(res?.error).toMatch(/Already being done in this run/);
    expect(res?.retryable).toBe(false);
  });

  it('is answered when the same email already went through the bound connector — before any claim', async () => {
    mockFindCompleted.mockResolvedValue({ actionId: 'action-direct', createdAt: '2026-09-15T02:37:00.000Z', externalResponse: { id: 'direct-1' } });
    const res = await executeStandardTool('run_capability', { capabilityId: WRITE_HANDLE, args: send }, ctx);
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockRun).not.toHaveBeenCalled();
    expect(res?.success).toBe(true);
    expect(res?.result).toMatch(/^Already done in this run:/);
    // Asked with the act key, which is what a direct send shares with this call.
    const actKey = mockFindCompleted.mock.calls[0][2] as string;
    expect(actKey).toMatch(new RegExp(`^cap:mail_send:${OP}\\|to/`));
  });
});

describe('when the ledger is not there', () => {
  it('a confirmed send is still a success when the outcome cannot be recorded — the act happened', async () => {
    mockRun.mockResolvedValue({ ok: true, text: 'sent' });
    mockRecordOutcome.mockRejectedValue(new Error('database is down'));
    const res = await executeStandardTool('run_capability', { capabilityId: WRITE_HANDLE, args: send }, ctx);
    expect(res).toEqual({ success: true, result: 'sent' });
    expect(logger.error).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('ledger outcome not recorded'));
  });

  it('a claim that cannot be made does not block the work; the key still goes to the connector boundary', async () => {
    mockClaim.mockRejectedValue(new Error('database is down'));
    mockRun.mockResolvedValue({ ok: true, text: 'sent' });
    const res = await executeStandardTool('run_capability', { capabilityId: WRITE_HANDLE, args: send }, ctx);
    expect(res).toEqual({ success: true, result: 'sent' });
    expect(mockRun.mock.calls[0][5]).toMatch(new RegExp(`^cap:${INV}:${OP}:`));
    expect(mockRecordOutcome).not.toHaveBeenCalled();
  });
});

describe('calls the ledger has no business with', () => {
  it('a read-class capability is dispatched without a claim or a key', async () => {
    mockRun.mockResolvedValue({ ok: true, text: 'data' });
    await executeStandardTool('run_capability', { capabilityId: `cap_r.${OP}.aGVsbG8`, args: { q: 'x' } }, ctx);
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockRun).toHaveBeenCalledWith('tenant-1', 'acct-9', `cap_r.${OP}.aGVsbG8`, { q: 'x' }, false, undefined, { scopeId: '6ebe2b95-0000-4000-8000-000000000001' }, undefined);
  });

  it('a write with no run to key it on is dispatched, and the gap is logged', async () => {
    mockRun.mockResolvedValue({ ok: true, text: 'sent' });
    await executeStandardTool('run_capability', { capabilityId: WRITE_HANDLE, args: send }, { ...ctx, invocationId: 'not-a-uuid' });
    expect(mockClaim).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('without a ledger claim'));
  });

  it('a handle minted before it carried an operation is keyed on the handle itself, with no act key', async () => {
    mockRun.mockResolvedValue({ ok: true, text: 'sent' });
    await executeStandardTool('run_capability', { capabilityId: 'cap_w.legacybody', args: send }, ctx);
    const intent = mockClaim.mock.calls[0][0] as { actKey: string | null; idempotencyKey: string };
    expect(intent.actKey).toBeNull();
    expect(intent.idempotencyKey).toMatch(new RegExp(`^cap:${INV}:[0-9a-f]{12}:[0-9a-f]{16}$`));
    // No act key means no cross-route lookup either.
    expect(mockFindCompleted).not.toHaveBeenCalled();
  });
});
