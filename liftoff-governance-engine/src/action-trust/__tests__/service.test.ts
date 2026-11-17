// getAgentActionTrust — tenant-scoped read. We mock withTenantScope with a
// controllable client so we can assert the query shape and the null/hit paths
// without a real DB. (Local jest.mock wins over the global setup mock.)

const mockClientQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  withTenantScope: jest.fn(
    async (_tenantId: string, fn: (client: unknown) => Promise<unknown>) =>
      fn({ query: mockClientQuery }),
  ),
}));

import { getAgentActionTrust } from '../service';
import { withTenantScope } from '../../infrastructure/database';

const TENANT = 't-1';
const AGENT = 'a-1';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('getAgentActionTrust', () => {
  it('returns null (without touching the DB) for an empty action class', async () => {
    const result = await getAgentActionTrust(TENANT, AGENT, '   ');
    expect(result).toBeNull();
    expect(withTenantScope).not.toHaveBeenCalled();
  });

  it('returns null when no row exists', async () => {
    mockClientQuery.mockResolvedValueOnce({ rows: [] });
    const result = await getAgentActionTrust(TENANT, AGENT, 'update');
    expect(result).toBeNull();
    expect(withTenantScope).toHaveBeenCalledWith(TENANT, expect.any(Function));
  });

  it('scopes to the tenant and returns tier + runs + derived passRate', async () => {
    mockClientQuery.mockResolvedValueOnce({
      rows: [{ runs: 40, passes: 38, rejects: 2, tier: 'auto' }],
    });
    const result = await getAgentActionTrust(TENANT, AGENT, 'update');
    expect(result).toEqual({ tier: 'auto', runs: 40, passRate: 38 / 40 });

    const [sql, params] = mockClientQuery.mock.calls[0];
    expect(String(sql)).toContain('FROM agent_action_trust');
    expect(String(sql)).toContain('tenant_id = $1');
    expect(params).toEqual([TENANT, AGENT, 'update']);
  });

  it('normalizes a dispatch-prefixed tool name before querying', async () => {
    mockClientQuery.mockResolvedValueOnce({ rows: [] });
    await getAgentActionTrust(TENANT, AGENT, 'mcp__server__update');
    const [, params] = mockClientQuery.mock.calls[0];
    expect(params).toEqual([TENANT, AGENT, 'update']);
  });
});
