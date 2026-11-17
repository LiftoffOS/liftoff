// The durable answer to "who did this run hand work to": the delegation_active
// rows of the parent invocation, which exist only for children that actually
// started. Read in first-brought-in order, deduplicated, and never able to
// fail the turn it describes.

const mockQuery = jest.fn<Promise<{ rows: Array<{ agent_id: string }> }>, [string, unknown[]]>();
jest.mock('../../infrastructure/database', () => ({
  getPoolForService: () => ({ query: mockQuery }),
}));

const warn = jest.fn();
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: (...a: unknown[]) => warn(...a), error: jest.fn(), debug: jest.fn() },
}));

import { listDelegatedAgentIds } from '../delegated-agents';

const TENANT = '00000000-0000-0000-0000-000000000001';
const PARENT = '00000000-0000-0000-0000-000000000002';

beforeEach(() => {
  mockQuery.mockReset();
  warn.mockReset();
});

describe('listDelegatedAgentIds', () => {
  it('reads the parent invocation\'s delegation_active rows in the order they started', async () => {
    mockQuery.mockResolvedValue({ rows: [{ agent_id: 'rt-8' }, { agent_id: 'rt-7' }] });

    await expect(listDelegatedAgentIds(TENANT, PARENT)).resolves.toEqual(['rt-8', 'rt-7']);

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/FROM delegation_active/);
    expect(sql).toMatch(/parent_invocation_id = \$1 AND tenant_id = \$2/);
    expect(sql).toMatch(/ORDER BY started_at ASC, task_index ASC/);
    expect(params).toEqual([PARENT, TENANT]);
  });

  it('names a teammate once however many times the run handed it work', async () => {
    mockQuery.mockResolvedValue({ rows: [{ agent_id: 'rt-7' }, { agent_id: 'rt-8' }, { agent_id: 'rt-7' }] });

    await expect(listDelegatedAgentIds(TENANT, PARENT)).resolves.toEqual(['rt-7', 'rt-8']);
  });

  it('reads as nobody, and says so in the log, when the record cannot be read', async () => {
    mockQuery.mockRejectedValue(new Error('connection reset'));

    await expect(listDelegatedAgentIds(TENANT, PARENT)).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, parentInvocationId: PARENT }),
      expect.stringContaining('delegation_active'),
    );
  });

  it('reads as nobody for a run that delegated to no one', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await expect(listDelegatedAgentIds(TENANT, PARENT)).resolves.toEqual([]);
  });
});
