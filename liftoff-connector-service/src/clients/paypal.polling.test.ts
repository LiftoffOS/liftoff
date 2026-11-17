// PayPalClient.list('Payment') (Transaction Search reporting polling) + normalizer tests.

import { PayPalClient } from './paypal.js';
import { PayPalNormalizer } from '../normalizers/paypal.normalizer.js';
import type { CredentialProvider } from './types.js';

const credentialProvider: CredentialProvider = async () => ({
  accessToken: 'A21AA_test',
  tenantId: 't1',
  connectorId: 'c1',
});

function mockFetchOnce(body: unknown, status = 200) {
  return jest.spyOn(global, 'fetch').mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response);
}

function txn(id: string, status = 'S') {
  return {
    transaction_info: {
      transaction_id: id,
      transaction_status: status,
      transaction_amount: { currency_code: 'USD', value: '49.00' },
      transaction_initiation_date: '2026-06-26T10:00:00+0000',
      transaction_updated_date: '2026-06-26T10:05:00+0000',
      paypal_reference_id: 'REF123',
    },
    payer_info: { email_address: 'payer@example.com' },
  };
}

describe('PayPalClient.list', () => {
  afterEach(() => jest.restoreAllMocks());

  it('hits /v1/reporting/transactions with start_date and maps payments to records', async () => {
    const spy = mockFetchOnce({
      transaction_details: [txn('TXN-1')],
      total_pages: 1,
      page: 1,
    });
    const client = new PayPalClient(credentialProvider);
    // A `since` comfortably inside the 31-day window is passed through verbatim as
    // start_date. Derive it from now (not a fixed calendar date) so the fixture can
    // never age out of the window and get clamped forward as wall-clock time advances.
    const since = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    const res = await client.list('Payment', { since, limit: 100 });

    expect(res.records).toHaveLength(1);
    expect(res.records[0].id).toBe('TXN-1');
    expect(res.hasMore).toBe(false); // page 1 of 1

    const url = spy.mock.calls[0][0] as string;
    expect(url).toContain('/v1/reporting/transactions');
    // Encoding-agnostic: read the parsed query param rather than matching an encoded literal.
    expect(new URL(url).searchParams.get('start_date')).toBe(since.toISOString());
    expect(url).toContain('end_date=');
    expect(url).toContain('fields=all');
  });

  it('clamps start_date forward to a 31-day window when since is older', async () => {
    const spy = mockFetchOnce({ transaction_details: [], total_pages: 1, page: 1 });
    const client = new PayPalClient(credentialProvider);
    const oldSince = new Date('2020-01-01T00:00:00Z'); // way more than 31 days ago
    await client.list('Payment', { since: oldSince });

    const url = spy.mock.calls[0][0] as string;
    expect(url).not.toContain('start_date=2020-01-01');
    // start_date must be within ~31 days of now, not the ancient `since`.
    const startParam = decodeURIComponent(
      new URL(url).searchParams.get('start_date') as string,
    );
    const startMs = new Date(startParam).getTime();
    const thirtyTwoDaysAgo = Date.now() - 32 * 24 * 60 * 60 * 1000;
    expect(startMs).toBeGreaterThan(thirtyTwoDaysAgo);
  });

  it('signals hasMore + next page when more pages exist', async () => {
    mockFetchOnce({
      transaction_details: [txn('TXN-1'), txn('TXN-2')],
      total_pages: 3,
      page: 1,
    });
    const client = new PayPalClient(credentialProvider);
    const res = await client.list('Payment', { limit: 2 });
    expect(res.hasMore).toBe(true);
    expect(res.nextPageToken).toBe('2');
  });

  it('returns empty for a non-Payment entity without calling the API', async () => {
    const spy = jest.spyOn(global, 'fetch');
    const client = new PayPalClient(credentialProvider);
    expect((await client.list('Invoice')).records).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('PayPalNormalizer', () => {
  it('normalizes a Payment from { results: [...] }', () => {
    const n = new PayPalNormalizer();
    const recs = n.normalize({ results: [txn('TXN-9', 'S')] });

    expect(recs).toHaveLength(1);
    expect(recs[0].entityType).toBe('Payment');
    expect(recs[0].externalId).toBe('TXN-9');
    expect(recs[0].data.status).toBe('S');
    expect(recs[0].data.amountValue).toBe('49.00');
    expect(recs[0].data.amountCurrency).toBe('USD');
    expect(recs[0].data.referenceId).toBe('REF123');
    expect(recs[0].data.payerEmail).toBe('payer@example.com');
    expect(recs[0].metadata.source).toBe('paypal');
    expect(recs[0].metadata.version).toBe('2026-06-26T10:05:00+0000');
  });

  it('skips records without a transaction_id and declares the Payment schema', () => {
    const n = new PayPalNormalizer();
    expect(n.normalize({ results: [{ transaction_info: { transaction_status: 'S' } }] })).toHaveLength(0);
    expect(JSON.stringify(n.entitySchemas.Payment)).toMatch(/payerEmail/);
  });
});
