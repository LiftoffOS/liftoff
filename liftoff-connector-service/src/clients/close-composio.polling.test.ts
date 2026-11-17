// CloseComposioClient — reactive Lead/Contact polling via the Composio proxy.

const mockProxy = jest.fn();
jest.mock('../oauth/composio-client.js', () => ({
  composioProxyRequest: (...a: unknown[]) => mockProxy(...a),
}));
jest.mock('../infra/logging.js', () => ({ logger: { warn: jest.fn(), info: jest.fn(), debug: jest.fn() } }));

import { CloseComposioClient } from './close-composio.js';

const client = new CloseComposioClient({ tenantId: 'tenant-1', connectedAccountId: 'ca_close' });

beforeEach(() => jest.clearAllMocks());

const LEADS = {
  has_more: false,
  data: [
    { id: 'lead_1', display_name: 'Acme', status_label: 'Potential', date_updated: '2026-02-01T00:00:00Z',
      contacts: [
        { id: 'cont_1', name: 'Jane', title: 'CTO', emails: [{ email: 'jane@acme.com', type: 'office' }], date_updated: '2026-02-01T00:00:00Z' },
      ] },
    { id: 'lead_2', display_name: 'Old Co', status_label: 'Bad Fit', date_updated: '2026-01-01T00:00:00Z',
      contacts: [{ id: 'cont_2', name: 'Bob', emails: [] }] },
  ],
};

describe('CloseComposioClient.list', () => {
  it("list('Lead') proxies GET /api/v1/lead/ with _limit/_skip (no _order_by) and stamps __entity=lead", async () => {
    mockProxy.mockResolvedValue(LEADS);
    const res = await client.list('Lead', { since: new Date('2026-01-15T00:00:00Z') });

    expect(mockProxy).toHaveBeenCalledWith(expect.objectContaining({
      connectedAccountId: 'ca_close',
      method: 'GET',
      endpoint: '/api/v1/lead/',
      queryParams: { _limit: 100, _skip: 0 },
    }));
    // lead_2 is before the since watermark → filtered out.
    expect(res.records.map(r => r.id)).toEqual(['lead_1']);
    expect(res.records[0].data.__entity).toBe('lead');
    expect(res.hasMore).toBe(false); // has_more:false → no further pages
  });

  it('paginates via _skip when Close reports has_more, honoring pageToken', async () => {
    mockProxy.mockResolvedValue({ has_more: true, data: [{ id: 'lead_x', date_updated: '2026-03-01T00:00:00Z' }] });
    const res = await client.list('Lead', { since: new Date('2026-01-01T00:00:00Z'), pageToken: '100' });
    expect(mockProxy).toHaveBeenCalledWith(expect.objectContaining({ queryParams: { _limit: 100, _skip: 100 } }));
    expect(res.hasMore).toBe(true);
    expect(res.nextPageToken).toBe('200');
  });

  it("list('Contact') flattens embedded contacts and injects leadId, stamped __entity=contact", async () => {
    mockProxy.mockResolvedValue(LEADS);
    const res = await client.list('Contact', { since: new Date('2026-01-15T00:00:00Z') });
    // cont_1 (lead_1) is after since; cont_2 (lead_2) is before → filtered out.
    expect(res.records.map(r => r.id)).toEqual(['cont_1']);
    expect(res.records[0].data).toMatchObject({ __entity: 'contact', leadId: 'lead_1', leadName: 'Acme' });
  });

  it('returns empty for an unsupported entityType without proxying', async () => {
    const res = await client.list('Opportunity', {});
    expect(res).toEqual({ records: [], hasMore: false, unsupported: true });
    expect(mockProxy).not.toHaveBeenCalled();
  });

  it('throws when the proxy fails', async () => {
    mockProxy.mockRejectedValue(new Error('Composio proxy GET /api/v1/lead/: HTTP 502'));
    await expect(client.list('Lead', { since: new Date(0) })).rejects.toThrow('HTTP 502');
  });
});
