// resolveMcpActor: membership re-read on every call and the only closed door;
// one tenant-scoped query on the tool path; the worker's two-step path.

const mockQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  withTenantScope: jest.fn(async (_t: string, fn: (c: { query: typeof mockQuery }) => Promise<unknown>) => fn({ query: mockQuery })),
}));
const mockGetMembership = jest.fn();
jest.mock('../../tenant-members', () => ({
  tenantMembersService: { getMembership: (...a: unknown[]) => mockGetMembership(...a) },
}));

import { readAnchorIdentity, resolveMcpActor } from '../actor';

const TENANT = '11111111-1111-1111-1111-111111111111';
const ACCOUNT = '22222222-2222-2222-2222-222222222222';
const KEY = '33333333-3333-3333-3333-333333333333';
const ctx = { tenantId: TENANT, accountId: ACCOUNT, keyId: KEY, keyType: 'collab' as const };

beforeEach(() => jest.clearAllMocks());

describe('resolveMcpActor (tool path)', () => {
  it('reads membership, account and anchor in one tenant-scoped query', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ role: 'member', first_name: 'Ada', last_name: 'Lovelace', email: 'ada@x.y', client: 'Claude Code' }] });
    const actor = await resolveMcpActor(ctx);
    expect(actor).toEqual({ ...ctx, role: 'member', displayName: 'Ada Lovelace', client: 'Claude Code' });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][1]).toEqual([TENANT, ACCOUNT, KEY]);
    expect(String(mockQuery.mock.calls[0][0])).toContain('FROM tenant_members m');
    expect(mockGetMembership).not.toHaveBeenCalled();
  });

  it('answers null when the account is not a member (fail closed)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await resolveMcpActor(ctx)).toBeNull();
  });

  it('a missing anchor row is not a refusal: the name comes from the account, the client is empty', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ role: 'owner', first_name: null, last_name: null, email: 'o@x.y', client: null }] });
    const actor = await resolveMcpActor(ctx);
    expect(actor).toMatchObject({ role: 'owner', displayName: 'o@x.y', client: '' });
  });
});

describe('the worker path', () => {
  it('reads the anchor, then only the membership', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ account_id: ACCOUNT, name: 'Codex', first_name: 'A', last_name: 'B', email: 'a@b.c' }] });
    const anchor = await readAnchorIdentity(TENANT, KEY);
    expect(anchor).toEqual({ accountId: ACCOUNT, displayName: 'A B', client: 'Codex', keyType: 'collab' });
    mockGetMembership.mockResolvedValueOnce({ role: 'admin' });
    const actor = await resolveMcpActor({ ...ctx, keyType: anchor!.keyType }, anchor!);
    expect(actor).toMatchObject({ role: 'admin', displayName: 'A B', client: 'Codex', keyType: 'collab' });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockGetMembership).toHaveBeenCalledWith(TENANT, ACCOUNT);
  });

  it('no anchor row → null; membership gone → null', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await readAnchorIdentity(TENANT, KEY)).toBeNull();
    mockGetMembership.mockResolvedValueOnce(null);
    expect(await resolveMcpActor(ctx, { accountId: ACCOUNT, displayName: 'x', client: '', keyType: 'collab' })).toBeNull();
  });
});
