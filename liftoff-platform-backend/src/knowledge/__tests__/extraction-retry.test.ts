// Tests for the backstop's retry behaviour.
//
// `runExtractionBatch` logs itself as a "backstop cron tick" and
// subscriber.ts:162 tells the reader that a failed extraction stays in the row
// "for the hourly backstop cron to retry". Neither was true: the query
// selected `extraction_status = 'pending'` and nothing else, so an item that
// errored once was never looked at again. It kept its place in the library,
// showed no error to the operator, and held no text.

const mockClient = { query: jest.fn() };
jest.mock('../../infrastructure/database', () => ({
  withTenantScope: jest.fn(async (_tenantId: string, fn: (c: unknown) => Promise<unknown>) =>
    fn(mockClient),
  ),
  withAdminScope: jest.fn(async (_meta: unknown, fn: (c: unknown) => Promise<unknown>) =>
    fn(mockClient),
  ),
}));

import {
  findPendingExtraction,
  markExtractionError,
  saveExtractedText,
  MAX_EXTRACTION_ATTEMPTS,
} from '../repository';

beforeEach(() => {
  jest.clearAllMocks();
  mockClient.query.mockResolvedValue({ rows: [] });
});

describe('findPendingExtraction — what the backstop considers due', () => {
  it('picks up errored items, not only pending ones', async () => {
    await findPendingExtraction();
    const sql = String(mockClient.query.mock.calls[0][0]);

    expect(sql).toContain("extraction_status = 'pending'");
    expect(sql).toContain("extraction_status = 'error'");
  });

  it('bounds the retries so an unreadable file does not run forever', async () => {
    await findPendingExtraction();
    const sql = String(mockClient.query.mock.calls[0][0]);

    expect(sql).toContain(`extraction_attempts < ${MAX_EXTRACTION_ATTEMPTS}`);
    // Backoff widens with each attempt rather than retrying every tick.
    expect(sql).toMatch(/POWER\(2, extraction_attempts\)/);
  });

  it('applies the same rule to the tenant-scoped path', async () => {
    await findPendingExtraction('tenant-1');
    const sql = String(mockClient.query.mock.calls[0][0]);

    expect(sql).toContain("extraction_status = 'error'");
    expect(sql).toContain('tenant_id = $1');
  });
});

describe('attempt accounting', () => {
  it('counts a failure, which is what the backoff and the cap are read from', async () => {
    await markExtractionError('tenant-1', 'item-1', 'connector-service file fetch failed: 415');
    const sql = String(mockClient.query.mock.calls[0][0]);

    expect(sql).toContain('extraction_attempts = extraction_attempts + 1');
    expect(sql).toContain("extraction_status = 'error'");
  });

  it('clears the count on success, so a later resync starts with a full budget', async () => {
    await saveExtractedText('tenant-1', 'item-1', 'extracted body');
    const sql = String(mockClient.query.mock.calls[0][0]);

    expect(sql).toContain('extraction_attempts = 0');
    expect(sql).toContain("extraction_status = 'done'");
  });
});
