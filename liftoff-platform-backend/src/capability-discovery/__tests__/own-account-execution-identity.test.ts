// An own-account capability runs on the tenant's OWN connected connector, which
// the executor finds THROUGH the account that originated the run. With no
// account there is nothing to look the connection up by, and a connector with
// no platform key has nowhere else to run: the executor refuses in-process —
// no Execute RPC — and that refusal must be written down, because the
// model-facing text deliberately names no cause.

const mockLogInfo = jest.fn();
jest.mock('../../infrastructure/logging', () => ({
  log: { info: (...a: unknown[]) => mockLogInfo(...a), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../connectors/connector-service-client', () => ({
  getCatalog: jest.fn(),
  getConnectorServiceClient: jest.fn(),
  listConnectorsForTenant: jest.fn(),
}));
jest.mock('../../connectors/connector-type-registry', () => ({ fetchRegistry: jest.fn() }));
jest.mock('../../mcp/tool-classifier', () => ({ toolClassifier: { getCachedClassification: jest.fn() } }));
jest.mock('../evidence', () => ({ recordUsageEvidence: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../cost-attribution/repository', () => ({
  ingestEventWithBuckets: jest.fn().mockResolvedValue(1),
  resolveAccountIdForTenant: jest.fn().mockResolvedValue('acct-1'),
}));

import { toolClassifier } from '../../mcp/tool-classifier';
import { getCatalog, getConnectorServiceClient, listConnectorsForTenant } from '../../connectors/connector-service-client';
import { fetchRegistry } from '../../connectors/connector-type-registry';
import { executeVendorTool } from '../vendor-execution';

const executeMock = jest.fn();

function wireGmail() {
  (getCatalog as jest.Mock).mockResolvedValue({ connectors: [{ type: 'google_mail', status: 'available' }] });
  (fetchRegistry as jest.Mock).mockResolvedValue(
    new Map([['google_mail', { connectorType: 'google_mail', functionNames: ['send_email', 'create_draft'] }]]),
  );
  (toolClassifier.getCachedClassification as jest.Mock).mockResolvedValue({
    categories: ['outbound', 'customerCommunication'],
    isManualOverride: false,
    toolDescriptionHash: 'h',
  });
  (getConnectorServiceClient as jest.Mock).mockReturnValue({ execute: executeMock });
  (listConnectorsForTenant as jest.Mock).mockResolvedValue([
    { id: 'conn-gmail-1', type: 'google_mail', status: 'active' },
  ]);
}

function refusalLog(): Record<string, unknown> | undefined {
  const call = mockLogInfo.mock.calls.find((c) => (c[0] as { event?: string })?.event === 'capability_run_refused');
  return call?.[0] as Record<string, unknown> | undefined;
}

beforeEach(() => {
  jest.clearAllMocks();
  executeMock.mockReset();
  wireGmail();
});

describe('an own-account send with no originating account', () => {
  it('is refused in-process — no lookup, no Execute RPC — and the refusal is logged with its cause', async () => {
    const out = await executeVendorTool({
      tenantId: 't1', accountId: '', connectorType: 'google_mail', toolName: 'send_email',
      args: { to: 'x@y.com' }, caller: 'agent', approved: true,
    });

    expect(out).toEqual({ success: false, reason: 'google_mail has no platform execution path yet' });
    expect(listConnectorsForTenant).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
    expect(refusalLog()).toMatchObject({
      connectorType: 'google_mail', toolName: 'send_email', caller: 'agent', approved: true, hasAccount: false,
      reason: 'google_mail has no platform execution path yet',
    });
  });
});

describe('an own-account send with the originating account', () => {
  it('executes on the tenant’s connected connector, approved, with the real arguments', async () => {
    executeMock.mockResolvedValue({ success: true, output: { id: 'msg-1' }, costUsd: 0 });

    const out = await executeVendorTool({
      tenantId: 't1', accountId: 'acct-7', connectorType: 'google_mail', toolName: 'send_email',
      args: { to: 'x@y.com', subject: 's', body: 'b' }, caller: 'agent', approved: true,
    });

    expect(listConnectorsForTenant).toHaveBeenCalledWith('t1', 'acct-7');
    expect(executeMock).toHaveBeenCalledTimes(1);
    const req = executeMock.mock.calls[0][0] as { connectorId: string; functionName: string; input: unknown };
    expect(req.connectorId).toBe('conn-gmail-1');
    expect(req.functionName).toBe('send_email');
    expect(req.input).toEqual({ to: 'x@y.com', subject: 's', body: 'b' });
    expect(out.success).toBe(true);
    expect(refusalLog()).toBeUndefined();
  });

  it('carries the caller\'s idempotency key to the connector boundary verbatim', async () => {
    executeMock.mockResolvedValue({ success: true, output: { id: 'msg-1' }, costUsd: 0 });

    await executeVendorTool({
      tenantId: 't1', accountId: 'acct-7', connectorType: 'google_mail', toolName: 'send_email',
      args: { to: 'x@y.com', subject: 's', body: 'b' }, caller: 'agent', approved: true,
      idempotencyKey: 'cap:6ebe2b95:0123456789ab:deadbeefdeadbeef',
    });

    const req = executeMock.mock.calls[0][0] as { idempotencyKey: string };
    expect(req.idempotencyKey).toBe('cap:6ebe2b95:0123456789ab:deadbeefdeadbeef');
    // The boundary's idempotency is scoped by the tenant header and engages
    // only when it is present; a ledger-keyed act sends it.
    expect(executeMock.mock.calls[0][1]).toEqual({ headers: { 'x-tenant-id': 't1' } });
  });

  it('mints its own key when the caller keeps no ledger', async () => {
    executeMock.mockResolvedValue({ success: true, output: { id: 'msg-1' }, costUsd: 0 });
    await executeVendorTool({
      tenantId: 't1', accountId: 'acct-7', connectorType: 'google_mail', toolName: 'send_email',
      args: { to: 'x@y.com', subject: 's', body: 'b' }, caller: 'agent', approved: true,
    });
    const req = executeMock.mock.calls[0][0] as { idempotencyKey: string };
    expect(req.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    // A per-call id has nothing to replay, so the boundary is not engaged.
    expect(executeMock.mock.calls[0][1]).toBeUndefined();
  });

  it('still refuses, and logs, an unapproved write from the agent', async () => {
    const out = await executeVendorTool({
      tenantId: 't1', accountId: 'acct-7', connectorType: 'google_mail', toolName: 'send_email',
      args: { to: 'x@y.com' }, caller: 'agent', approved: false,
    });
    expect(out.success).toBe(false);
    expect('requiresApproval' in out && out.requiresApproval).toBe(true);
    expect(executeMock).not.toHaveBeenCalled();
    expect(refusalLog()).toMatchObject({ requiresApproval: true, approved: false, hasAccount: true });
  });
});
