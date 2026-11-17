// OAuth access-token verifier — unit tests.
// The verifier is the /mcp trust boundary for liftoff_oat_* tokens: every
// rejection branch (expired/revoked token, inactive grant, dead/expired
// anchor, wrong audience) must return null, and success must map to the
// anchor-keyed McpAuthContext.

const mockAdminQuery = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  withAdminScope: jest.fn(async (_ctx: unknown, fn: (client: { query: typeof mockAdminQuery }) => unknown) => {
    return fn({ query: mockAdminQuery });
  }),
}));

jest.mock('../../infrastructure/control-plane-url', () => ({
  getBackendUrl: () => 'https://api-test.example.com',
}));

import { verifyOAuthAccessToken } from '../verifier';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const ACCOUNT_ID = '44444444-4444-4444-4444-444444444444';
const ANCHOR_ID = '33333333-3333-3333-3333-333333333333';

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    resource: 'https://api-test.example.com/mcp',
    grant_status: 'active',
    tenant_id: TENANT_ID,
    account_id: ACCOUNT_ID,
    mcp_token_id: ANCHOR_ID,
    anchor_status: 'active',
    anchor_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    anchor_deleted_at: null,
    ...overrides,
  };
}

beforeEach(() => jest.clearAllMocks());

describe('verifyOAuthAccessToken', () => {
  it('returns the anchor-keyed context for a fully valid token', async () => {
    mockAdminQuery.mockResolvedValueOnce({ rows: [row()] });
    const ctx = await verifyOAuthAccessToken('liftoff_oat_valid');
    expect(ctx).toEqual({ tenantId: TENANT_ID, accountId: ACCOUNT_ID, keyId: ANCHOR_ID, keyType: 'collab' });
  });

  // The teams page reads a connection's activity from the anchor, so a call
  // through an OAuth token stamps it the way the static branch does; a
  // rejected token stamps nothing.
  it('stamps last_used_at on the anchor for a valid token only', async () => {
    mockAdminQuery.mockResolvedValueOnce({ rows: [row()] });
    await verifyOAuthAccessToken('liftoff_oat_valid');
    const stamp = mockAdminQuery.mock.calls.find((c) => String(c[0]).includes('last_used_at'));
    expect(stamp).toBeDefined();
    expect(stamp![0]).toContain('UPDATE mcp_tokens SET last_used_at = NOW()');
    expect(stamp![1]).toEqual([ANCHOR_ID]);

    mockAdminQuery.mockClear();
    mockAdminQuery.mockResolvedValueOnce({ rows: [row({ grant_status: 'revoked' })] });
    await verifyOAuthAccessToken('liftoff_oat_revoked');
    expect(mockAdminQuery.mock.calls.some((c) => String(c[0]).includes('last_used_at'))).toBe(false);
  });

  it('returns null when the token row is absent (expired/revoked filtered in SQL)', async () => {
    mockAdminQuery.mockResolvedValueOnce({ rows: [] });
    expect(await verifyOAuthAccessToken('liftoff_oat_gone')).toBeNull();
  });

  it('returns null for a revoked grant', async () => {
    mockAdminQuery.mockResolvedValueOnce({ rows: [row({ grant_status: 'revoked' })] });
    expect(await verifyOAuthAccessToken('liftoff_oat_x')).toBeNull();
  });

  it('returns null for a revoked or deleted anchor', async () => {
    mockAdminQuery.mockResolvedValueOnce({ rows: [row({ anchor_status: 'revoked' })] });
    expect(await verifyOAuthAccessToken('liftoff_oat_x')).toBeNull();
    mockAdminQuery.mockResolvedValueOnce({ rows: [row({ anchor_deleted_at: new Date().toISOString() })] });
    expect(await verifyOAuthAccessToken('liftoff_oat_x')).toBeNull();
  });

  it('returns null past the anchor 365-day expiry (re-consent required)', async () => {
    mockAdminQuery.mockResolvedValueOnce({ rows: [row({ anchor_expires_at: new Date(Date.now() - 1000).toISOString() })] });
    expect(await verifyOAuthAccessToken('liftoff_oat_x')).toBeNull();
  });

  it('returns null when the token audience is not the canonical resource', async () => {
    mockAdminQuery.mockResolvedValueOnce({ rows: [row({ resource: 'https://other.example/mcp' })] });
    expect(await verifyOAuthAccessToken('liftoff_oat_x')).toBeNull();
  });
});
