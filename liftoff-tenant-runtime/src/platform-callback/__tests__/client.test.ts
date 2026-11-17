// settleMcpChatRunViaCallback — the TR->PB transport for durable MCP HITL
// (Option 1). Verifies it targets the settle-by-approval endpoint, carries the
// outcome ('completed' with replyText, or 'failed' with errorCode), and surfaces
// a non-ok response so the resume/expiry caller can log-and-swallow (best-effort).

const fetchMock = jest.fn();
jest.mock('@liftoffos/service-client', () => ({
  ServiceClient: jest.fn().mockImplementation(() => ({ fetch: fetchMock })),
}));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { settleMcpChatRunViaCallback } from '../client';

beforeEach(() => {
  jest.clearAllMocks();
  process.env.PLATFORM_BACKEND_URL = 'https://pb.internal';
  process.env.PLATFORM_CALLBACK_TOKEN = 'callback-secret';
});

describe('settleMcpChatRunViaCallback', () => {
  it("POSTs a 'completed' settle with the continuation to the settle-by-approval endpoint", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    await settleMcpChatRunViaCallback({ tenantId: 't1', approvalId: 'a1', outcome: 'completed', threadId: 'th1', replyText: 'done' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [target, path, opts] = fetchMock.mock.calls[0] as [string, string, { method: string; body: string; breakerKey: string }];
    expect(target).toBe('platform');
    expect(path).toBe('/api/internal/mcp-chat-runs/settle-by-approval');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ tenantId: 't1', approvalId: 'a1', outcome: 'completed', threadId: 'th1', replyText: 'done' });
    expect(opts.breakerKey).toBe('platform:mcp-chat-run-settle');
  });

  it("POSTs a 'failed' settle with the errorCode (24h expiry backstop)", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    await settleMcpChatRunViaCallback({ tenantId: 't1', approvalId: 'a1', outcome: 'failed', errorCode: 'approval_expired' });
    const [, , opts] = fetchMock.mock.calls[0] as [string, string, { body: string }];
    expect(JSON.parse(opts.body)).toEqual({ tenantId: 't1', approvalId: 'a1', outcome: 'failed', errorCode: 'approval_expired' });
  });

  it('throws on a non-ok response so the caller can log + swallow', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    await expect(
      settleMcpChatRunViaCallback({ tenantId: 't1', approvalId: 'a1', outcome: 'completed', replyText: '' }),
    ).rejects.toThrow('HTTP 500');
  });
});

// ── postSkillFeedback — id-space chokepoint (INV-TR-010) ──────────────

const resolveInternalAgentIdMock = jest.fn();
jest.mock('../../agent-lifecycle/resolve-runtime-agent-id', () => ({
  resolveInternalAgentId: (...args: unknown[]) => resolveInternalAgentIdMock(...args),
}));

import { postSkillFeedback } from '../client';

describe('postSkillFeedback', () => {
  const PAYLOAD = {
    tenantId: 't1',
    agentId: 'rt-agent-1',
    taskId: 'task-1',
    feedback: [{ skillId: 's1', skillName: 'x', outcome: 'success' as const }],
  };

  it('resolves and attaches internalAgentId alongside the unchanged runtime agentId', async () => {
    resolveInternalAgentIdMock.mockResolvedValueOnce('int-agent-1');
    fetchMock.mockResolvedValue({ ok: true, status: 204 });

    await postSkillFeedback(PAYLOAD);

    expect(resolveInternalAgentIdMock).toHaveBeenCalledWith('t1', 'rt-agent-1', 'skill-feedback');
    const [target, path, opts] = fetchMock.mock.calls[0] as [string, string, { body: string }];
    expect(target).toBe('platform');
    expect(path).toBe('/api/internal/platform-tools/skill-feedback');
    expect(JSON.parse(opts.body)).toEqual({ ...PAYLOAD, internalAgentId: 'int-agent-1' });
  });

  it('sends without internalAgentId on a mapping miss (null), never a wrong-space id', async () => {
    resolveInternalAgentIdMock.mockResolvedValueOnce(null);
    fetchMock.mockResolvedValue({ ok: true, status: 204 });

    await postSkillFeedback(PAYLOAD);

    expect(JSON.parse((fetchMock.mock.calls[0] as [string, string, { body: string }])[2].body)).toEqual(PAYLOAD);
  });

  it('sends without internalAgentId when resolution throws (callback must not abort)', async () => {
    resolveInternalAgentIdMock.mockRejectedValueOnce(new Error('db down'));
    fetchMock.mockResolvedValue({ ok: true, status: 204 });

    await postSkillFeedback(PAYLOAD);

    expect(JSON.parse((fetchMock.mock.calls[0] as [string, string, { body: string }])[2].body)).toEqual(PAYLOAD);
  });

  it('still throws on a non-ok response so callers log-and-swallow', async () => {
    resolveInternalAgentIdMock.mockResolvedValueOnce('int-agent-1');
    fetchMock.mockResolvedValue({ ok: false, status: 409 });

    await expect(postSkillFeedback(PAYLOAD)).rejects.toThrow('HTTP 409');
  });
});
