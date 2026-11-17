// Staged bytes go; published ones stay.
//
// The race this sweep uniquely has: a file presented between the select and
// the delete has had its lifetime cleared, and a person is now holding a card
// for it. Deleting its object first would leave that card pointing at nothing.
// So the row goes first, under the same predicate, and the bytes are only
// removed if that actually took the row.

const mockWithAdminScope = jest.fn();
const mockClientQuery = jest.fn();
const mockObjectDelete = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  withAdminScope: (
    opts: unknown,
    fn: (client: { query: typeof mockClientQuery }) => Promise<unknown>,
  ) => mockWithAdminScope(opts, fn),
  withTenantScope: jest.fn(),
  getPool: jest.fn(),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../gcs-client', () => ({
  generatedFilesBucket: () => ({ file: () => ({ delete: mockObjectDelete }) }),
}));

import { sweepStagedFiles } from '../sweep-staged';

const ROW = { id: 'f1', tenant_id: 't1', gcs_path: 'tenants/t/agents/a/1/staged.pdf' };

beforeEach(() => {
  jest.clearAllMocks();
  mockWithAdminScope.mockImplementation((_o: unknown, fn: (c: unknown) => Promise<unknown>) =>
    fn({ query: mockClientQuery }));
  mockObjectDelete.mockResolvedValue(undefined);
});

it('removes the row and then the bytes of a file nobody published', async () => {
  mockClientQuery
    .mockResolvedValueOnce({ rows: [ROW], rowCount: 1 })   // the select
    .mockResolvedValueOnce({ rows: [], rowCount: 1 });      // the delete took it

  const result = await sweepStagedFiles();

  expect(result).toEqual({ deleted: 1, failed: 0 });
  expect(mockObjectDelete).toHaveBeenCalledWith({ ignoreNotFound: true });
  const deleteStatement = String(mockClientQuery.mock.calls[1][0]);
  expect(deleteStatement).toMatch(/DELETE FROM generated_files/i);
  // The predicate is repeated rather than trusting the id alone.
  expect(deleteStatement).toMatch(/discard_after IS NOT NULL/i);
});

it('keeps the bytes of a file presented since the select', async () => {
  mockClientQuery
    .mockResolvedValueOnce({ rows: [ROW], rowCount: 1 })
    .mockResolvedValueOnce({ rows: [], rowCount: 0 });      // lifetime was cleared

  const result = await sweepStagedFiles();

  expect(result).toEqual({ deleted: 0, failed: 0 });
  expect(mockObjectDelete).not.toHaveBeenCalled();
});

it('asks only for files whose lifetime has run out', async () => {
  mockClientQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
  await sweepStagedFiles();
  const select = String(mockClientQuery.mock.calls[0][0]);
  expect(select).toMatch(/discard_after IS NOT NULL/i);
  expect(select).toMatch(/discard_after < NOW\(\)/i);
  // Never a person's upload: that is the other sweep's row, on its own predicate.
  expect(select).not.toMatch(/uploaded_by_account_id/i);
});

it('carries on through one unreachable object', async () => {
  mockClientQuery
    .mockResolvedValueOnce({ rows: [ROW, { ...ROW, id: 'f2' }], rowCount: 2 })
    .mockResolvedValueOnce({ rows: [], rowCount: 1 })
    .mockResolvedValueOnce({ rows: [], rowCount: 1 });
  mockObjectDelete.mockRejectedValueOnce(new Error('bucket unavailable'));

  const result = await sweepStagedFiles();

  expect(result).toEqual({ deleted: 1, failed: 1 });
});
