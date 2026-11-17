// A.1 — unit tests for the standard-tool audit emitter.
//
// Both mcp-server.ts and agent-execution/service.ts call emitStandardToolAudit
// directly, so this exercises the SAME code path that production uses. If a
// future change to mcp-server.ts removes the void emitStandardToolAudit({...})
// call, the per-site integration tests catch it; if the helper's internal
// field mapping drifts, these tests catch it.

const mockInsertAuditLog = jest.fn().mockResolvedValue(undefined);
jest.mock('../service', () => ({
  insertAuditLog: mockInsertAuditLog,
  // sanitizeArgs, listAuditLogs, getAuditLog are unused by the helper.
}));

import {
  emitStandardToolAudit,
  isStandardToolAuditDisabled,
} from '../standard-tool-emitter';

beforeEach(() => {
  mockInsertAuditLog.mockClear();
  delete process.env.AUDIT_LOG_STANDARD_TOOLS_DISABLED;
});

afterEach(() => {
  delete process.env.AUDIT_LOG_STANDARD_TOOLS_DISABLED;
});

const base = {
  tenantId: 'tenant-1',
  agentId: 'agent-1',
  threadId: 'thread-1',
  invocationId: 'inv-1',
  action: 'memory_save',
  inputArgs: { content: 'hello' },
  success: true,
  durationMs: 42,
};

describe('emitStandardToolAudit — success row', () => {
  it('inserts with the expected tenant + agent + invocation context', async () => {
    await emitStandardToolAudit(base);
    expect(mockInsertAuditLog).toHaveBeenCalledTimes(1);
    expect(mockInsertAuditLog).toHaveBeenCalledWith(null, 'tenant-1', expect.objectContaining({
      internalAgentId: 'agent-1',
      threadId: 'thread-1',
      invocationId: 'inv-1',
      action: 'memory_save',
      outcome: 'success',
      triggeredBy: 'agent:agent-1',
      durationMs: 42,
    }));
  });

  it('uses the bare action name verbatim (no connector prefix for standard tools)', async () => {
    await emitStandardToolAudit({ ...base, action: 'notifications_send' });
    expect(mockInsertAuditLog.mock.calls[0][2].action).toBe('notifications_send');
  });

  it('does NOT populate outputSummary or errorCode on success', async () => {
    await emitStandardToolAudit(base);
    const row = mockInsertAuditLog.mock.calls[0][2];
    expect(row.outputSummary).toBeUndefined();
    expect(row.errorCode).toBeUndefined();
  });
});

describe('emitStandardToolAudit — error row', () => {
  it('populates outcome=error and outputSummary from the error string', async () => {
    await emitStandardToolAudit({
      ...base,
      success: false,
      error: 'memory_save failed: tenant quota exceeded',
    });
    const row = mockInsertAuditLog.mock.calls[0][2];
    expect(row.outcome).toBe('error');
    expect(row.outputSummary).toBe('memory_save failed: tenant quota exceeded');
    expect(row.errorCode).toBe('standard_tool_error');
  });

  it('truncates outputSummary to 500 chars', async () => {
    await emitStandardToolAudit({
      ...base,
      success: false,
      error: 'x'.repeat(2000),
    });
    expect(mockInsertAuditLog.mock.calls[0][2].outputSummary).toHaveLength(500);
  });

  it('respects a caller-provided errorCode override', async () => {
    await emitStandardToolAudit({
      ...base,
      success: false,
      error: 'unknown tool',
      errorCode: 'no_handler_registered',
    });
    expect(mockInsertAuditLog.mock.calls[0][2].errorCode).toBe('no_handler_registered');
  });
});

describe('emitStandardToolAudit — kill switch', () => {
  it('does not call insertAuditLog when AUDIT_LOG_STANDARD_TOOLS_DISABLED=1', async () => {
    process.env.AUDIT_LOG_STANDARD_TOOLS_DISABLED = '1';
    await emitStandardToolAudit(base);
    expect(mockInsertAuditLog).not.toHaveBeenCalled();
  });

  it('still calls when the env var is any other value', async () => {
    process.env.AUDIT_LOG_STANDARD_TOOLS_DISABLED = '0';
    await emitStandardToolAudit(base);
    expect(mockInsertAuditLog).toHaveBeenCalledTimes(1);
  });

  it('still calls when the env var is "true" (only "1" disables)', async () => {
    process.env.AUDIT_LOG_STANDARD_TOOLS_DISABLED = 'true';
    await emitStandardToolAudit(base);
    expect(mockInsertAuditLog).toHaveBeenCalledTimes(1);
  });

  it('isStandardToolAuditDisabled mirrors the gate', () => {
    expect(isStandardToolAuditDisabled()).toBe(false);
    process.env.AUDIT_LOG_STANDARD_TOOLS_DISABLED = '1';
    expect(isStandardToolAuditDisabled()).toBe(true);
  });
});

describe('emitStandardToolAudit — search sub-dispatch convention', () => {
  it('preserves <connectorAlias>__search action shape', async () => {
    await emitStandardToolAudit({ ...base, action: 'slack__search' });
    await emitStandardToolAudit({ ...base, action: 'github__search' });
    expect(mockInsertAuditLog.mock.calls[0][2].action).toBe('slack__search');
    expect(mockInsertAuditLog.mock.calls[1][2].action).toBe('github__search');
  });
});

describe('emitStandardToolAudit — fire-and-forget guarantee', () => {
  it('resolves (does not throw) when insertAuditLog rejects', async () => {
    mockInsertAuditLog.mockRejectedValueOnce(new Error('DB down'));
    await expect(emitStandardToolAudit(base)).resolves.toBeUndefined();
  });
});
