// Shared chat admission — unit tests.
// The helper is the single gate both HTTP and MCP chat run through; each
// rejection must carry the exact HTTP semantics the stream-router used to
// produce inline (404 agent, 429 + retryAfter, 402 + reason).

const mockPoolQuery = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  withTenantScope: jest.fn(async (_tenantId: string, fn: (client: { query: typeof mockPoolQuery }) => unknown) => {
    return fn({ query: mockPoolQuery });
  }),
}));

const mockRateLimit = jest.fn();
jest.mock('../../common/chat-rate-limiter', () => ({
  checkAndIncrementChatRateLimit: (...args: unknown[]) => mockRateLimit(...args),
}));

const mockGuard = jest.fn();
jest.mock('../../billing/execution-guard', () => ({
  checkExecutionAllowed: (...args: unknown[]) => mockGuard(...args),
}));

import { checkChatAdmission, CHAT_RATE_LIMITS } from '../admission';

const INPUT = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  accountId: '44444444-4444-4444-4444-444444444444',
  agentId: '55555555-5555-5555-5555-555555555555',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockPoolQuery.mockResolvedValue({ rows: [{ id: INPUT.agentId }] });
  mockRateLimit.mockResolvedValue({ allowed: true });
  mockGuard.mockResolvedValue({ allowed: true });
});

describe('checkChatAdmission', () => {
  it('allows when agent exists, rate limit clears, and the guard passes', async () => {
    const result = await checkChatAdmission(INPUT);
    expect(result).toEqual({ allowed: true });
    // Web parity: the agent check is non-deleted only (no status filter) —
    // paused agents remain chattable.
    expect(String(mockPoolQuery.mock.calls[0][0])).not.toContain("status = 'active'");
  });

  it('404s a missing agent', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const result = await checkChatAdmission(INPUT);
    expect(result).toEqual({ allowed: false, httpStatus: 404, error: 'agent not found' });
  });

  it('429s with retryAfter and uses the SAME durable table + limits as the web surface', async () => {
    mockRateLimit.mockResolvedValueOnce({ allowed: false, retryAfter: 42 });
    const result = await checkChatAdmission(INPUT);
    expect(result).toMatchObject({ allowed: false, httpStatus: 429, retryAfter: 42 });
    expect(mockRateLimit).toHaveBeenCalledWith(expect.objectContaining({
      tableName: 'agent_chat_rate_limit_events',
      limits: CHAT_RATE_LIMITS,
    }));
  });

  it('402s with the guard reason (suspended / no subscription)', async () => {
    mockGuard.mockResolvedValueOnce({ allowed: false, reason: 'suspended' });
    const result = await checkChatAdmission(INPUT);
    expect(result).toMatchObject({ allowed: false, httpStatus: 402, error: 'payment_required', reason: 'suspended' });
  });
});
