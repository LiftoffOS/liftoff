/**
 * resolveCaller — shared Firebase UID → account → tenant role helper used by
 * the insights, browser-sessions, and stream routers. Each failure mode maps
 * to a specific HTTP status that the routes propagate directly.
 */
const getByFirebaseUidMock = jest.fn();
const getCallerRoleMock = jest.fn();

jest.mock('../../accounts/service', () => ({
  AccountService: jest.fn().mockImplementation(() => ({
    getByFirebaseUid: (...args: unknown[]) => getByFirebaseUidMock(...args),
  })),
}));

jest.mock('../../insights/chat-repository', () => ({
  getCallerRole: (...args: unknown[]) => getCallerRoleMock(...args),
}));

import { resolveCaller } from '../resolve-caller';

beforeEach(() => jest.clearAllMocks());

describe('resolveCaller', () => {
  it('returns 401 when firebaseUid is undefined (anonymous request)', async () => {
    const r = await resolveCaller(undefined, 'tenant-1');
    expect(r).toEqual({ ok: false, status: 401, error: 'Authentication required' });
    expect(getByFirebaseUidMock).not.toHaveBeenCalled();
  });

  it('returns 401 when no account matches the Firebase UID', async () => {
    getByFirebaseUidMock.mockResolvedValueOnce(null);
    const r = await resolveCaller('fb-1', 'tenant-1');
    expect(r).toEqual({ ok: false, status: 401, error: 'Account not found' });
  });

  it('returns 404 when caller has no role in the tenant (no existence leak)', async () => {
    getByFirebaseUidMock.mockResolvedValueOnce({ id: 'acc-1' });
    getCallerRoleMock.mockResolvedValueOnce(null);
    const r = await resolveCaller('fb-1', 'tenant-1');
    expect(r).toEqual({ ok: false, status: 404, error: 'Tenant not found' });
  });

  it('returns the caller context on success', async () => {
    getByFirebaseUidMock.mockResolvedValueOnce({ id: 'acc-1' });
    getCallerRoleMock.mockResolvedValueOnce('admin');
    const r = await resolveCaller('fb-1', 'tenant-1');
    expect(r).toEqual({
      ok: true,
      caller: { accountId: 'acc-1', tenantId: 'tenant-1', role: 'admin' },
    });
  });
});
