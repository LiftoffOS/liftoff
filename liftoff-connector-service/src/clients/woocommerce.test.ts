// WooCommerceClient.list('Order') (native Basic-auth polling) + normalizer tests.

import { WooCommerceClient } from './woocommerce.js';
import { WooCommerceNormalizer } from '../normalizers/woocommerce.normalizer.js';
import type { CredentialProvider } from './types.js';

const credentialProvider: CredentialProvider = async () => ({
  accessToken: 'ck_test',       // consumer key
  refreshToken: 'cs_test',      // consumer secret
  instanceUrl: 'https://store.example.com',
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

describe('WooCommerceClient.list', () => {
  afterEach(() => jest.restoreAllMocks());

  it('maps orders to records and sends modified_after for incremental sync', async () => {
    const spy = mockFetchOnce([
      { id: 101, number: '101', status: 'processing', total: '49.00', currency: 'USD', billing: { country: 'US', email: 'a@b.com' } },
    ]);
    const client = new WooCommerceClient(credentialProvider);
    const res = await client.list('Order', { since: new Date('2026-06-26T00:00:00Z'), limit: 100 });

    expect(res.records).toHaveLength(1);
    expect(res.records[0].id).toBe('101');
    expect(res.hasMore).toBe(false); // 1 < per_page 100

    const url = (spy.mock.calls[0][0] as string);
    expect(url).toContain('/wp-json/wc/v3/orders');
    expect(url).toContain('modified_after=2026-06-26T00%3A00%3A00.000Z');
    expect(url).toContain('orderby=modified');
  });

  it('signals hasMore + next page when a full page is returned', async () => {
    const full = Array.from({ length: 2 }, (_, i) => ({ id: i + 1 }));
    mockFetchOnce(full);
    const client = new WooCommerceClient(credentialProvider);
    const res = await client.list('Order', { limit: 2 });
    expect(res.hasMore).toBe(true);
    expect(res.nextPageToken).toBe('2');
  });

  it('returns empty for a non-Order entity without calling the API', async () => {
    const spy = jest.spyOn(global, 'fetch');
    const client = new WooCommerceClient(credentialProvider);
    expect((await client.list('Product')).records).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('WooCommerceNormalizer', () => {
  it('normalizes an order from { results: [...] }', () => {
    const n = new WooCommerceNormalizer();
    const recs = n.normalize({
      results: [{
        id: 101, number: '101', status: 'completed', total: '49.00', currency: 'USD',
        date_modified_gmt: '2026-06-26T10:00:00', customer_id: 7,
        billing: { country: 'US', email: 'a@b.com' }, line_items: [{ id: 1 }, { id: 2 }],
      }],
    });
    expect(recs).toHaveLength(1);
    expect(recs[0].entityType).toBe('Order');
    expect(recs[0].externalId).toBe('101');
    expect(recs[0].data.status).toBe('completed');
    expect(recs[0].data.billingCountry).toBe('US');
    expect(recs[0].data.itemCount).toBe(2);
    expect(recs[0].data.customerId).toBe('7');
    expect(recs[0].metadata.source).toBe('woocommerce');
    expect(recs[0].metadata.version).toBe('2026-06-26T10:00:00');
  });

  it('skips records without an id and declares the Order schema with the dateModified anchor', () => {
    const n = new WooCommerceNormalizer();
    expect(n.normalize({ results: [{ status: 'x' }] })).toHaveLength(0);
    expect(JSON.stringify(n.entitySchemas.Order)).toMatch(/dateModified/);
  });
});
