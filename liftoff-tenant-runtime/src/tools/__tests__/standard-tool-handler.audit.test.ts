// B.2 — audit_log standard tool handler unit tests.
//
// The audit_log tool is what agents use to durably emit "this happened"
// rows that downstream consumers (compliance review, /activity, the
// reflection-engine evidence loop) trust. If the handler ever stops
// writing rows, those consumers fail silently — testing the contract
// here is the cheapest place to catch that.

const mockInsertAuditLog = jest.fn().mockResolvedValue(undefined);
jest.mock('../../audit', () => ({
  insertAuditLog: mockInsertAuditLog,
}));

import { executeStandardTool, StandardToolContext } from '../standard-tool-handler';

const ctx: StandardToolContext = {
  tenantId: 'tenant-1',
  agentId: 'agent-1',
  memoryScope: { writableLayers: [], readableLayers: [] },
  traceId: 'trace-1',
};

beforeEach(() => mockInsertAuditLog.mockClear());

describe('audit_log handler — happy path', () => {
  it('inserts a row with the agent-supplied action verbatim', async () => {
    const r = await executeStandardTool('audit_log', { action: 'manual_review_completed' }, ctx);
    expect(r?.success).toBe(true);
    expect(mockInsertAuditLog).toHaveBeenCalledWith(
      null,
      'tenant-1',
      expect.objectContaining({
        action: 'manual_review_completed',
        internalAgentId: 'agent-1',
        triggeredBy: 'agent:agent-1',
      }),
    );
  });

  it('passes through resource_type, resource_id, metadata into input_args', async () => {
    await executeStandardTool('audit_log', {
      action: 'incident_closed',
      resource_type: 'ticket',
      resource_id: 'JIRA-1234',
      metadata: { rootCause: 'expired secret' },
    }, ctx);
    expect(mockInsertAuditLog.mock.calls[0][2].inputArgs).toEqual({
      resource_type: 'ticket',
      resource_id: 'JIRA-1234',
      rootCause: 'expired secret',
    });
  });

  it('defaults outcome to success when not supplied', async () => {
    await executeStandardTool('audit_log', { action: 'x' }, ctx);
    expect(mockInsertAuditLog.mock.calls[0][2].outcome).toBe('success');
  });

  it('maps the tool alias "failure" onto the column constraint "error"', async () => {
    await executeStandardTool('audit_log', { action: 'x', outcome: 'failure' }, ctx);
    expect(mockInsertAuditLog.mock.calls[0][2].outcome).toBe('error');
  });
});

describe('audit_log handler — schema rejection', () => {
  it('rejects missing action', async () => {
    const r = await executeStandardTool('audit_log', {}, ctx);
    expect(r?.success).toBe(false);
    expect(r?.error).toMatch(/non-empty.*action/);
    expect(mockInsertAuditLog).not.toHaveBeenCalled();
  });

  it('rejects empty-string action', async () => {
    const r = await executeStandardTool('audit_log', { action: '' }, ctx);
    expect(r?.success).toBe(false);
    expect(mockInsertAuditLog).not.toHaveBeenCalled();
  });

  it('rejects non-string action', async () => {
    const r = await executeStandardTool('audit_log', { action: 42 }, ctx);
    expect(r?.success).toBe(false);
    expect(mockInsertAuditLog).not.toHaveBeenCalled();
  });
});

describe('audit_log handler — DB failure', () => {
  it('returns {success:false} with the underlying error when the insert throws', async () => {
    mockInsertAuditLog.mockRejectedValueOnce(new Error('RLS denied'));
    const r = await executeStandardTool('audit_log', { action: 'x' }, ctx);
    expect(r?.success).toBe(false);
    expect(r?.error).toMatch(/RLS denied/);
  });
});
