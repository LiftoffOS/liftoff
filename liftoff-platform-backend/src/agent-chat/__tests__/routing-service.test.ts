// Rule 3 in the dashboard's multi-agent routing: the suggested answerer over
// the participants, with the ILIKE scorer as the fallback on `null`; mention
// and lead still short-circuit before any request.

jest.mock('../../infrastructure/logging', () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const queryMock = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  getPool: jest.fn(),
  withTenantScope: async (_t: string, fn: (c: { query: typeof queryMock }) => Promise<unknown>) => fn({ query: queryMock }),
}));
const suggestMock = jest.fn();
jest.mock('../route-suggestion', () => ({ suggestAnswerer: (...a: unknown[]) => suggestMock(...a) }));

import { routeMessage } from '../routing-service';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const participants = [{ agentId: A, role: 'participant' as const }, { agentId: B, role: 'participant' as const }];

beforeEach(() => {
  jest.clearAllMocks();
  queryMock.mockImplementation(async (sql: string) => {
    if (sql.includes('SELECT id, role, summary, responsibilities')) {
      return { rows: [
        { id: A, role: 'Code Reviewer', summary: 'Reviews pull requests', responsibilities: 'code review' },
        { id: B, role: 'Sales Ops', summary: null, responsibilities: 'invoices and billing questions' },
      ] };
    }
    // The ILIKE scorer.
    return { rows: [{ id: B, score: 1 }, { id: A, score: 0 }] };
  });
});

describe('routing-service rule 3', () => {
  it('asks over the participants with their role and summary', async () => {
    suggestMock.mockResolvedValue({ agentId: A, probability: 0.9 });
    const d = await routeMessage('thread-1', 't1', 'can you review PR 412', participants, []);
    expect(suggestMock).toHaveBeenCalledWith({
      tenantId: 't1', message: 'can you review PR 412', channel: { kind: 'thread' }, surface: 'dashboard',
      candidates: [
        { id: A, role: 'Code Reviewer', summary: 'Reviews pull requests' },
        { id: B, role: 'Sales Ops', summary: 'invoices and billing questions' },
      ],
    });
    expect(d.respondingAgents).toEqual([{ agentId: A, reason: 'relevant' }]);
    expect(d.observingAgents).toEqual([{ agentId: B }]);
  });

  it('null falls to the ILIKE scorer', async () => {
    suggestMock.mockResolvedValue(null);
    const d = await routeMessage('thread-1', 't1', 'a question about invoices', participants, []);
    expect(d.respondingAgents).toEqual([{ agentId: B, reason: 'relevant' }]);
  });

  it('mention and lead short-circuit before any request', async () => {
    suggestMock.mockResolvedValue({ agentId: B, probability: 0.9 });
    const mentioned = await routeMessage('thread-1', 't1', `hi @[${A}]`, participants, [A]);
    expect(mentioned.respondingAgents).toEqual([{ agentId: A, reason: 'mentioned' }]);
    const led = await routeMessage('thread-1', 't1', 'hi', [{ agentId: A, role: 'lead' }, participants[1]], []);
    expect(led.respondingAgents).toEqual([{ agentId: A, reason: 'lead' }]);
    expect(suggestMock).not.toHaveBeenCalled();
  });

  it('a single participant never asks', async () => {
    await routeMessage('thread-1', 't1', 'hi', [participants[0]], []);
    expect(suggestMock).not.toHaveBeenCalled();
  });
});
