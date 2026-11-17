// Who can read, rename and delete a plan thread.
//
// Reading went workspace-wide so a shared /share/<id> link works for the people
// it was shared with. Renaming and deleting did not, and the risk is that they
// silently follow: both used to borrow getThread as their permission check, so
// relaxing one relaxed all three with nothing in the diff to notice. These tests
// pin the split.

const mockQuery = jest.fn();
jest.mock('../infrastructure/rls.js', () => ({
  withTenantContext: (_tenantId: string, fn: (c: { query: jest.Mock }) => unknown) =>
    fn({ query: mockQuery }),
}));

import {
  deleteThread,
  getThread,
  updateThreadTitle,
} from '../workforce-plans/chat-repository.js';

const TENANT = '22222222-2222-2222-2222-222222222222';
const AUTHOR = '33333333-3333-3333-3333-333333333333';
const OTHER = '44444444-4444-4444-4444-444444444444';
const THREAD = '55555555-5555-5555-5555-555555555555';

function threadRow(accountId = AUTHOR) {
  return {
    id: THREAD,
    tenant_id: TENANT,
    account_id: accountId,
    title: 'Grant operations plan',
    workforce_plan_id: null,
    created_at: new Date('2026-08-05T00:00:00Z'),
    updated_at: new Date('2026-08-05T00:00:00Z'),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('getThread', () => {
  it('opens somebody else\'s thread for a member — the shared-link case', async () => {
    mockQuery.mockResolvedValue({ rows: [threadRow(OTHER)] });
    const thread = await getThread(THREAD, TENANT);
    expect(thread?.id).toBe(THREAD);
  });

  it('does not leak a thread from another tenant', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ ...threadRow(), tenant_id: '99999999-9999-9999-9999-999999999999' }],
    });
    expect(await getThread(THREAD, TENANT)).toBeNull();
  });

  it('returns null for a deleted or unknown thread', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    expect(await getThread(THREAD, TENANT)).toBeNull();
  });
});

describe('deleteThread', () => {
  it('lets the author delete their own thread', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [threadRow(AUTHOR)] })
      .mockResolvedValueOnce({ rowCount: 1 });
    expect(await deleteThread(THREAD, TENANT, AUTHOR, 'member')).toBe(true);
  });

  it('refuses a member deleting somebody else\'s thread, and writes nothing', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [threadRow(OTHER)] });
    expect(await deleteThread(THREAD, TENANT, AUTHOR, 'member')).toBe(false);
    // One call: the read. The UPDATE must never have been issued.
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('lets an owner delete anybody\'s thread', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [threadRow(OTHER)] })
      .mockResolvedValueOnce({ rowCount: 1 });
    expect(await deleteThread(THREAD, TENANT, AUTHOR, 'owner')).toBe(true);
  });
});

describe('updateThreadTitle', () => {
  it('refuses a member renaming somebody else\'s thread', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [threadRow(OTHER)] });
    expect(await updateThreadTitle(THREAD, TENANT, AUTHOR, 'member', 'New name')).toBeNull();
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('lets the author rename their own thread', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [threadRow(AUTHOR)] })
      .mockResolvedValueOnce({ rows: [{ ...threadRow(AUTHOR), title: 'New name' }] });
    const updated = await updateThreadTitle(THREAD, TENANT, AUTHOR, 'member', 'New name');
    expect(updated?.title).toBe('New name');
  });
});
