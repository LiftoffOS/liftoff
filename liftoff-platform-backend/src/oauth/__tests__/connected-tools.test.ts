// OAuth-connected tools are read off the anchors under tenant scope, joined
// to the live client registration, and branded once here so the workforce
// payload and the consent page agree on a client's identity.

const mockQuery = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  withTenantScope: jest.fn(async (_tenantId: string, fn: (client: { query: typeof mockQuery }) => unknown) => fn({ query: mockQuery })),
}));

import { withTenantScope } from '../../infrastructure/database';
import { listOauthConnectedTools } from '../connected-tools';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

beforeEach(() => jest.clearAllMocks());

describe('listOauthConnectedTools', () => {
  it('reads active OAuth anchors with an active grant under tenant scope', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listOauthConnectedTools(TENANT_ID);
    expect(withTenantScope).toHaveBeenCalledWith(TENANT_ID, expect.any(Function));
    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toContain("t.auth_kind = 'oauth'");
    expect(sql).toContain("g.status = 'active'");
    expect(sql).toContain('JOIN oauth_clients c ON c.client_id = g.client_id');
    expect(mockQuery.mock.calls[0][1]).toEqual([TENANT_ID]);
  });

  it('brands each row from the registered client name', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 'a1', tenant_id: TENANT_ID, account_id: 'acc-1', client_name: 'Codex', last_used_at: null, created_at: '2026-09-01T00:00:00Z' },
        { id: 'a2', tenant_id: TENANT_ID, account_id: 'acc-2', client_name: 'Muse personal agent', last_used_at: '2026-09-02T00:00:00Z', created_at: '2026-09-01T00:00:00Z' },
      ],
    });
    const tools = await listOauthConnectedTools(TENANT_ID);
    expect(tools).toEqual([
      { id: 'a1', tenantId: TENANT_ID, accountId: 'acc-1', clientName: 'Codex', clientSlug: 'codex', clientLabel: 'Codex', lastUsedAt: null, createdAt: '2026-09-01T00:00:00Z' },
      { id: 'a2', tenantId: TENANT_ID, accountId: 'acc-2', clientName: 'Muse personal agent', clientSlug: null, clientLabel: 'Muse personal agent', lastUsedAt: '2026-09-02T00:00:00Z', createdAt: '2026-09-01T00:00:00Z' },
    ]);
  });
});
