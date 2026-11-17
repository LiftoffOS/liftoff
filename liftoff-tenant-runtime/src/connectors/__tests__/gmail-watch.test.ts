// Tests for armMissingGmailWatches — the bulk-arm backfill complement
// to rearmExpiringGmailWatches. Covers the LEFT-JOIN selection logic
// (only connectors with no subscription row), success/failure counting,
// and idempotency.

jest.mock('../../infrastructure/database', () => ({
  getPool: jest.fn(),
}));
jest.mock('../../infrastructure/safe-trace-context', () => ({
  setTraceContext: jest.fn(),
}));

import { armMissingGmailWatches } from '../gmail-watch';
import { getPool } from '../../infrastructure/database';

const mockGetPool = getPool as jest.MockedFunction<typeof getPool>;

describe('armMissingGmailWatches', () => {
  const ORIG_ENV = { ...process.env };
  let queryMock: jest.Mock;
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CONNECTOR_SERVICE_URL = 'http://cs.local';
    process.env.CONNECTOR_SERVICE_TOKEN = 'svc-token';
    process.env.GCP_PROJECT = 'tenant-x';
    process.env.ENVIRONMENT = 'test';
    queryMock = jest.fn();
    mockGetPool.mockReturnValue({ query: queryMock } as never);
    fetchMock = jest.spyOn(globalThis, 'fetch') as never;
  });

  afterAll(() => {
    process.env = ORIG_ENV;
    jest.restoreAllMocks();
  });

  it('SELECT uses LEFT JOIN with IS NULL filter on gmail_watch_subscriptions', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }); // no missing
    await armMissingGmailWatches();
    expect(queryMock).toHaveBeenCalledTimes(1);
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toContain('LEFT JOIN gmail_watch_subscriptions');
    expect(sql).toContain('s.connector_id IS NULL');
    expect(sql).toContain("m.connector_type = 'google_mail'");
    expect(sql).toContain('m.enabled = true');
  });

  it('returns zero counts when nothing is missing', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const out = await armMissingGmailWatches();
    expect(out).toEqual({ candidates: 0, armed: 0, failed: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('arms each missing connector and counts successes', async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [
          { connector_id: 'c1', tenant_id: 't1' },
          { connector_id: 'c2', tenant_id: 't1' },
        ],
      })
      .mockResolvedValue({ rows: [] }); // armGmailWatchFor's INSERT
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        subscriptionId: 'sub-1',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        historyId: 'h-1',
        expirationMs: Date.now() + 7 * 24 * 60 * 60 * 1000,
      }),
      text: async () => '',
    } as never);

    const out = await armMissingGmailWatches();

    expect(out.candidates).toBe(2);
    expect(out.armed).toBe(2);
    expect(out.failed).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/connectors/c1/webhooks'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('continues past per-connector failures and counts them', async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [
          { connector_id: 'c-good', tenant_id: 't1' },
          { connector_id: 'c-bad', tenant_id: 't1' },
          { connector_id: 'c-good-2', tenant_id: 't1' },
        ],
      })
      .mockResolvedValue({ rows: [] });

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          subscriptionId: 's1',
          expiresAt: null,
          historyId: 'h1',
          expirationMs: Date.now() + 60_000,
        }),
        text: async () => '',
      } as never)
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({}),
        text: async () => 'composio_account_expired',
      } as never)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          subscriptionId: 's3',
          expiresAt: null,
          historyId: 'h3',
          expirationMs: Date.now() + 60_000,
        }),
        text: async () => '',
      } as never);

    const out = await armMissingGmailWatches();

    expect(out.candidates).toBe(3);
    expect(out.armed).toBe(2);
    expect(out.failed).toBe(1);
  });
});
