// deleteMemberAndRevokeAccess: the membership delete and the credential
// revocations are ONE transaction.
//
// The mocked withTenantScope below behaves like the real one for the property
// under test: it runs the statements on one client and, when the callback
// throws, issues a ROLLBACK and rethrows — so a failing revocation statement
// leaves the membership row in place and the error reaches the caller.
//
// The OAuth grants go through the grant lifecycle's helpers (lockActiveGrants
// in id order, then retireGrantFamily per grant); the static tokens keep their
// own statement. `tokens` is the anchors the helpers retired plus the static
// tokens, so the audit event reads the same number as before.

const mockClientQuery = jest.fn();
const stubClient = { query: mockClientQuery };
const transactionLog: string[] = [];
const mockWithTenantScope = jest.fn(
  async (_tenantId: string, fn: (c: typeof stubClient) => Promise<unknown>) => {
    transactionLog.push('BEGIN');
    try {
      const result = await fn(stubClient);
      transactionLog.push('COMMIT');
      return result;
    } catch (err) {
      transactionLog.push('ROLLBACK');
      throw err;
    }
  },
);
const mockWithAdminScope = jest.fn(
  async (_ctx: unknown, fn: (c: typeof stubClient) => Promise<unknown>) => fn(stubClient),
);
jest.mock('../infrastructure/database', () => ({
  withTenantScope: (tenantId: string, fn: never) => mockWithTenantScope(tenantId, fn),
  withAdminScope: (ctx: unknown, fn: never) => mockWithAdminScope(ctx, fn),
}));

import { TenantMembersRepository } from './repository';

const TENANT_ID = '22222222-2222-2222-2222-222222222222';
const MEMBER_ID = '33333333-3333-3333-3333-333333333333';
const ACCOUNT_ID = '55555555-5555-5555-5555-555555555555';

const statements = () => mockClientQuery.mock.calls.map((c) => String(c[0]).replace(/\s+/g, ' '));

beforeEach(() => {
  jest.clearAllMocks();
  transactionLog.length = 0;
});

describe('deleteMemberAndRevokeAccess', () => {
  it('runs the delete, the id-ordered grant lock, one retirement per grant and the static-token statements on one tenant-scoped transaction; one anchor + one static token → { tokens: 2, grants: 1 }', async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                            // DELETE tenant_members
      .mockResolvedValueOnce({ rows: [{ id: 'grant-1', mcp_token_id: 'anchor-1' }] }) // lockActiveGrants
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                            // grant revoked
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                            // access tokens
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                            // refresh tokens
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                            // anchor (retired here)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                            // anchor's assignment
      .mockResolvedValueOnce({ rows: [{ id: 'static-1' }] })                       // static mcp_tokens RETURNING
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });                           // static assignments

    const repo = new TenantMembersRepository();
    const result = await repo.deleteMemberAndRevokeAccess(TENANT_ID, MEMBER_ID, ACCOUNT_ID);

    expect(result).toEqual({ tokens: 2, grants: 1 });
    expect(mockWithTenantScope).toHaveBeenCalledTimes(1);
    expect(mockWithTenantScope.mock.calls[0][0]).toBe(TENANT_ID);
    expect(mockWithAdminScope).not.toHaveBeenCalled();
    expect(transactionLog).toEqual(['BEGIN', 'COMMIT']);

    const s = statements();
    expect(s[0]).toContain('DELETE FROM tenant_members WHERE id = $1 AND tenant_id = $2');
    expect(mockClientQuery.mock.calls[0][1]).toEqual([MEMBER_ID, TENANT_ID]);
    expect(s[1]).toBe("SELECT id, mcp_token_id FROM oauth_grants WHERE account_id = $1 AND tenant_id = $2 AND status = 'active' ORDER BY id FOR UPDATE");
    expect(mockClientQuery.mock.calls[1][1]).toEqual([ACCOUNT_ID, TENANT_ID]);
    expect(s[2]).toContain("UPDATE oauth_grants SET status = 'revoked'");
    expect(mockClientQuery.mock.calls[2][1]).toEqual(['grant-1']);
    expect(s[3]).toContain('UPDATE oauth_access_tokens SET revoked_at = NOW() WHERE grant_id = $1');
    expect(s[4]).toContain('UPDATE oauth_refresh_tokens SET revoked_at = NOW() WHERE grant_id = $1');
    expect(s[5]).toContain("UPDATE mcp_tokens SET status = 'revoked', deleted_at = NOW() WHERE id = $1 AND status = 'active' AND deleted_at IS NULL");
    expect(mockClientQuery.mock.calls[5][1]).toEqual(['anchor-1']);
    expect(s[6]).toContain('UPDATE person_agent_assignments SET deleted_at = NOW() WHERE agent_id = $1');
    expect(s[7]).toContain("UPDATE mcp_tokens SET status = 'revoked', deleted_at = NOW() WHERE tenant_id = $1 AND account_id = $2 AND status = 'active' AND deleted_at IS NULL RETURNING id");
    expect(mockClientQuery.mock.calls[7][1]).toEqual([TENANT_ID, ACCOUNT_ID]);
    expect(s[8]).toContain('UPDATE person_agent_assignments SET deleted_at = NOW() WHERE tenant_id = $1 AND agent_id = ANY($2::uuid[])');
    expect(mockClientQuery.mock.calls[8][1]).toEqual([TENANT_ID, ['static-1']]);
    expect(s).toHaveLength(9);
  });

  it('a person with no grant and one static token → { tokens: 1, grants: 0 }', async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })            // DELETE tenant_members
      .mockResolvedValueOnce({ rows: [] })                         // no active grants
      .mockResolvedValueOnce({ rows: [{ id: 'static-1' }] })       // static mcp_tokens
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });           // assignments

    const repo = new TenantMembersRepository();
    expect(await repo.deleteMemberAndRevokeAccess(TENANT_ID, MEMBER_ID, ACCOUNT_ID)).toEqual({ tokens: 1, grants: 0 });
    expect(statements().some((q) => q.includes("UPDATE oauth_grants SET status = 'revoked'"))).toBe(false);
  });

  it('a failing revocation statement rolls the membership delete back and propagates', async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                            // DELETE tenant_members
      .mockResolvedValueOnce({ rows: [{ id: 'grant-1', mcp_token_id: 'anchor-1' }] }) // lockActiveGrants
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                            // grant revoked
      .mockRejectedValueOnce(new Error('oauth_access_tokens: connection reset'));  // access tokens fail

    const repo = new TenantMembersRepository();
    await expect(repo.deleteMemberAndRevokeAccess(TENANT_ID, MEMBER_ID, ACCOUNT_ID))
      .rejects.toThrow('oauth_access_tokens: connection reset');

    // The delete ran, and the transaction it ran in was rolled back: the
    // membership row survives, and nothing after the failure was attempted.
    expect(transactionLog).toEqual(['BEGIN', 'ROLLBACK']);
    expect(mockClientQuery).toHaveBeenCalledTimes(4);
  });
});
