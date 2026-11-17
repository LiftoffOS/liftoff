// Unit tests for the pre-signup guest list repository (migration 341).
//
// The SQL is thin; what is worth pinning is the behaviour the rest of the
// feature leans on: exact-match normalization, the conflict path that makes a
// second add idempotent rather than a 500, and the refusal to un-spend or
// re-spend a consumed entry.

const mockQuery = jest.fn();

jest.mock('../infrastructure/database', () => ({
  getPool: jest.fn(() => ({ query: (...a: unknown[]) => mockQuery(...a) })),
}));

import { SignupPreapprovalRepository, normalizeSignupEmail } from './signup-preapprovals';

const ROW = {
  id: 'pre-1',
  email: 'person@example.com',
  note: 'prospect',
  added_by: 'admin-1',
  created_at: new Date('2026-08-08T00:00:00Z'),
  consumed_at: null,
  consumed_account_id: null,
};

let repo: SignupPreapprovalRepository;

beforeEach(() => {
  jest.clearAllMocks();
  repo = new SignupPreapprovalRepository();
});

describe('normalizeSignupEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeSignupEmail('  person@example.com ')).toBe('person@example.com');
  });

  it('does NOT unwrap plus-addressing or gmail dots', () => {
    // Deliberate. A whitelist that grants more than it literally says is the
    // worse failure: the miss is visible, the over-grant is not.
    expect(normalizeSignupEmail('person@example.com')).toBe('person@example.com');
    expect(normalizeSignupEmail('person@example.com')).toBe('person@example.com');
  });
});

describe('findLiveByEmail', () => {
  it('normalizes the address before matching', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [ROW] }) };
    const found = await repo.findLiveByEmail(client as never, '  person@example.com ');

    expect(client.query.mock.calls[0][1]).toEqual(['person@example.com']);
    expect(found?.id).toBe('pre-1');
    expect(found?.addedBy).toBe('admin-1');
    expect(found?.consumedAt).toBeNull();
  });

  it('returns null when nothing is live for the address', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    expect(await repo.findLiveByEmail(client as never, 'nobody@example.com')).toBeNull();
  });
});

describe('consumeInTx', () => {
  it('reports false when the entry was already spent', async () => {
    // The UPDATE guards on consumed_at IS NULL, so a retry matches no row.
    // Reporting false keeps a retry from re-dating someone else's grant.
    const client = { query: jest.fn().mockResolvedValue({ rowCount: 0 }) };
    expect(await repo.consumeInTx(client as never, 'pre-1', 'acc-1')).toBe(false);
  });

  it('reports true on the spend that lands', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rowCount: 1 }) };
    expect(await repo.consumeInTx(client as never, 'pre-1', 'acc-1')).toBe(true);
    expect(client.query.mock.calls[0][1]).toEqual(['pre-1', 'acc-1']);
  });
});

describe('add', () => {
  it('stores the normalized address', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [ROW] });
    const { entry, created } = await repo.add('  person@example.com ', 'admin-1', 'prospect');

    expect(created).toBe(true);
    expect(entry.email).toBe('person@example.com');
    expect(mockQuery.mock.calls[0][1]).toEqual(['person@example.com', 'admin-1', 'prospect']);
  });

  it('is idempotent when a live entry already exists', async () => {
    // Partial unique index fires; the existing entry is returned rather than
    // a 500, and created:false stops a second audit row re-attributing the
    // original decision.
    mockQuery.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));
    mockQuery.mockResolvedValueOnce({ rows: [ROW] });

    const { entry, created } = await repo.add('person@example.com', 'admin-2', null);

    expect(created).toBe(false);
    expect(entry.id).toBe('pre-1');
    expect(entry.addedBy).toBe('admin-1');
  });

  it('re-raises when the conflicting row vanished in the window', async () => {
    mockQuery.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await expect(repo.add('person@example.com', 'admin-2', null)).rejects.toThrow('dup');
  });

  it('re-raises a non-conflict error untouched', async () => {
    mockQuery.mockRejectedValueOnce(Object.assign(new Error('down'), { code: '08006' }));
    await expect(repo.add('person@example.com', 'admin-1', null)).rejects.toThrow('down');
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});

describe('revoke', () => {
  it('returns the removed entry', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [ROW] });
    const removed = await repo.revoke('pre-1');
    expect(removed?.email).toBe('person@example.com');
  });

  it('returns null for a missing or already-spent entry', async () => {
    // A consumed entry is history: the DELETE guards on consumed_at IS NULL so
    // the audit trail cannot be erased by a revoke that arrives too late.
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await repo.revoke('pre-1')).toBeNull();
  });
});
