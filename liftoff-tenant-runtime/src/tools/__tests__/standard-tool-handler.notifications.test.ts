// B.2 — notifications_send schema-rejection unit tests.
//
// Schema fences are the cheap-to-test invariant. Happy-path delivery is
// covered by the existing notifications-send integration tests (delivery,
// dedup, recipient resolution) — duplicating that here would just inflate
// the mock surface without adding signal.

jest.mock('../../platform-callback/client', () => ({
  // The BYOK session opener asks the control plane whose key funds a run.
  // Null here means "no callback configured", which is the managed path and
  // exactly the behaviour these tests were written against.
  getPlatformCallbackClient: jest.fn(() => null),
  enqueueNotificationViaCallback: jest.fn(),
  resolveAccountsByRole: jest.fn().mockResolvedValue([]),
  resolveAgentOwnerAccount: jest.fn().mockResolvedValue(null),
  resolveDefaultEscalationRecipients: jest.fn().mockResolvedValue([]),
}));

jest.mock('../../infrastructure/database', () => ({
  getPool: jest.fn().mockReturnValue({
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  }),
  getPoolForService: jest.fn().mockReturnValue({
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  }),
}));

import { executeStandardTool, StandardToolContext } from '../standard-tool-handler';

const ctx: StandardToolContext = {
  tenantId: 'tenant-1',
  agentId: 'agent-1',
  memoryScope: { writableLayers: [], readableLayers: [] },
  traceId: 'trace-1',
};

describe('notifications_send — schema rejection', () => {
  it('rejects missing body', async () => {
    const r = await executeStandardTool('notifications_send', { recipients: ['user:1'] }, ctx);
    expect(r?.success).toBe(false);
    expect(r?.error).toMatch(/body/);
  });

  it('rejects empty-string body', async () => {
    const r = await executeStandardTool('notifications_send', { body: '' }, ctx);
    expect(r?.success).toBe(false);
  });

  it('rejects non-string body', async () => {
    const r = await executeStandardTool('notifications_send', { body: 42 }, ctx);
    expect(r?.success).toBe(false);
  });

  it('rejects invalid priority enum value', async () => {
    const r = await executeStandardTool('notifications_send', { body: 'ok', priority: 'critical' }, ctx);
    expect(r?.success).toBe(false);
    expect(r?.error).toMatch(/priority/);
  });

  it('accepts "normal" priority', async () => {
    const r = await executeStandardTool('notifications_send', { body: 'ok', priority: 'normal' }, ctx);
    // Will return a missing-default-recipients error (no recipients + no fallback in mock),
    // which is the EXPECTED schema-validation-passed outcome — the priority gate didn't
    // reject the call.
    expect(r?.error).not.toMatch(/priority/);
  });

  it('accepts "urgent" priority', async () => {
    const r = await executeStandardTool('notifications_send', { body: 'ok', priority: 'urgent' }, ctx);
    expect(r?.error).not.toMatch(/priority/);
  });
});

describe('notifications_send — recipient resolution failure', () => {
  it('reports no-default-configured when no recipient and no fallback', async () => {
    const r = await executeStandardTool('notifications_send', { body: 'ping' }, ctx);
    expect(r?.success).toBe(false);
    expect(r?.error).toMatch(/no recipients.*default escalation/);
  });
});
