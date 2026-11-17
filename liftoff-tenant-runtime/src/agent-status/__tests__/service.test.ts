import { AgentStatusService } from '../service';
import type { AgentRunState, AgentRunItem } from '../../agent-execution/run-state/types';

const mockPoolQuery = jest.fn();
const mockLoad = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  getPoolForService: jest.fn(() => ({ query: mockPoolQuery })),
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../agent-execution/run-state/service', () => ({
  agentRunStateService: { load: (...args: unknown[]) => mockLoad(...args) },
}));

// The service module keeps an in-process cache keyed by invocationId. Use a unique
// invocation id per test so cached values from a prior test never bleed in.
let invCounter = 0;
function nextInvId() { return `inv-${++invCounter}`; }

function invRow(id: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    tenant_id: 'tenant-1',
    agent_id: 'agent-1',
    thread_id: 'thread-1',
    started_at: new Date(Date.now() - 5000).toISOString(),
    completed_at: null,
    outcome: null,
    error_message: null,
    agent_name: 'Test Agent',
    ...overrides,
  };
}

function makeRunState(id: string, items: AgentRunItem[], overrides: Partial<AgentRunState> = {}): AgentRunState {
  return {
    $schemaVersion: '1.0',
    invocationId: id,
    agentId: 'agent-1',
    tenantId: 'tenant-1',
    currentTurn: 3,
    maxTurns: 10,
    status: 'running',
    items,
    providerState: { type: 'claude-agent-sdk' },
    usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('AgentStatusService', () => {
  let service: AgentStatusService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPoolQuery.mockReset();
    mockLoad.mockReset();
    service = new AgentStatusService();
  });

  it('returns null when invocation does not exist', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const result = await service.getStatus(nextInvId());
    expect(result).toBeNull();
  });

  it('returns null when expectedTenantId does not match (tenant isolation)', async () => {
    const id = nextInvId();
    mockPoolQuery.mockResolvedValueOnce({ rows: [invRow(id, { tenant_id: 'tenant-a' })] });
    const result = await service.getStatus(id, 'tenant-b');
    expect(result).toBeNull();
  });

  it('returns running status with maxTurns and recent events from run state', async () => {
    const id = nextInvId();
    mockPoolQuery.mockResolvedValueOnce({ rows: [invRow(id)] });
    const items: AgentRunItem[] = [
      { type: 'tool_call', toolName: 'search', callId: 'c1', input: {}, turn: 1, timestamp: new Date().toISOString() },
      { type: 'tool_result', callId: 'c1', output: { ok: true }, turn: 1, timestamp: new Date().toISOString() },
      { type: 'message_output', role: 'assistant', content: 'hello', turn: 2, timestamp: new Date().toISOString() },
    ];
    mockLoad.mockResolvedValueOnce(makeRunState(id, items));

    const result = await service.getStatus(id);

    expect(result).not.toBeNull();
    expect(result!.status).toBe('running');
    expect(result!.phase).toBe('executing');
    expect(result!.currentTurn).toBe(3);
    expect(result!.maxTurns).toBe(10);
    expect(result!.isTerminal).toBe(false);
    expect(result!.recentEvents).toHaveLength(3);
    expect(result!.recentEvents[0].type).toBe('tool_call');
    expect(result!.recentEvents[2].contentPreview).toBe('hello');
  });

  it('detects an unmatched tool_call as currentTool', async () => {
    const id = nextInvId();
    mockPoolQuery.mockResolvedValueOnce({ rows: [invRow(id)] });
    const items: AgentRunItem[] = [
      { type: 'tool_call', toolName: 'first', callId: 'c1', input: {}, turn: 1, timestamp: new Date().toISOString() },
      { type: 'tool_result', callId: 'c1', output: {}, turn: 1, timestamp: new Date().toISOString() },
      { type: 'tool_call', toolName: 'in_flight', callId: 'c2', input: {}, turn: 2, timestamp: new Date().toISOString() },
    ];
    mockLoad.mockResolvedValueOnce(makeRunState(id, items));

    const result = await service.getStatus(id);
    expect(result!.currentTool).toBe('in_flight');
  });

  it('reports awaiting_approval phase when interruption has pending approval', async () => {
    const id = nextInvId();
    mockPoolQuery.mockResolvedValueOnce({ rows: [invRow(id)] });
    mockLoad.mockResolvedValueOnce(makeRunState(id, [], {
      status: 'interrupted',
      interruption: {
        reason: 'hitl_approval',
        pendingApprovals: [{ callId: 'c1', toolName: 'risky', input: {}, idempotencyKey: 'k1' }],
        interruptedAtTurn: 3,
        approvalRequestId: 'appr-123',
      },
    }));

    const result = await service.getStatus(id);
    expect(result!.phase).toBe('awaiting_approval');
    expect(result!.pendingApprovalId).toBe('appr-123');
    expect(result!.status).toBe('interrupted');
  });

  it('marks completed invocations as terminal with elapsedMs from completed_at', async () => {
    const id = nextInvId();
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    const completedAt = new Date(Date.now() - 30_000).toISOString();
    mockPoolQuery.mockResolvedValueOnce({ rows: [invRow(id, {
      started_at: startedAt,
      completed_at: completedAt,
      outcome: 'success',
    })] });
    mockLoad.mockResolvedValueOnce(makeRunState(id, [], { status: 'complete' }));

    const result = await service.getStatus(id);
    expect(result!.status).toBe('complete');
    expect(result!.phase).toBe('completed');
    expect(result!.isTerminal).toBe(true);
    expect(result!.elapsedMs).toBe(new Date(completedAt).getTime() - new Date(startedAt).getTime());
  });

  it('falls back to invocation outcome when run state is missing', async () => {
    const id = nextInvId();
    mockPoolQuery.mockResolvedValueOnce({ rows: [invRow(id, { outcome: 'error', error_message: 'boom' })] });
    mockLoad.mockResolvedValueOnce(null);

    const result = await service.getStatus(id);
    expect(result!.status).toBe('failed');
    expect(result!.lastError).toBe('boom');
    expect(result!.isTerminal).toBe(true);
    expect(result!.currentTurn).toBe(0);
    expect(result!.maxTurns).toBeNull();
  });

  it('sanitizes secrets in message content previews', async () => {
    const id = nextInvId();
    mockPoolQuery.mockResolvedValueOnce({ rows: [invRow(id)] });
    const items: AgentRunItem[] = [
      { type: 'message_output', role: 'assistant',
        content: 'here is my password: hunter2supersecret you can use',
        turn: 1, timestamp: new Date().toISOString() },
    ];
    mockLoad.mockResolvedValueOnce(makeRunState(id, items));

    const result = await service.getStatus(id);
    expect(result!.recentEvents[0].contentPreview).not.toContain('hunter2supersecret');
    expect(result!.recentEvents[0].contentPreview).toContain('[REDACTED]');
  });

  it('serves cached value on repeat call within TTL (no second DB query)', async () => {
    const id = nextInvId();
    mockPoolQuery.mockResolvedValueOnce({ rows: [invRow(id)] });
    mockLoad.mockResolvedValueOnce(makeRunState(id, []));

    const first = await service.getStatus(id);
    const second = await service.getStatus(id);

    expect(first).toEqual(second);
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    expect(mockLoad).toHaveBeenCalledTimes(1);
  });
});
