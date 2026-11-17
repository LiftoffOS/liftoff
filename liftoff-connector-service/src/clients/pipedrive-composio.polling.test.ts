// PipedriveComposioClient — reactive Deal/Contact polling via PIPEDRIVE_GET_RECENTS.

const mockExecute = jest.fn();
jest.mock('../oauth/composio-client.js', () => ({
  getComposio: () => ({ tools: { execute: mockExecute } }),
}));
jest.mock('../infra/logging.js', () => ({ logger: { warn: jest.fn(), info: jest.fn(), debug: jest.fn() } }));

import { PipedriveComposioClient } from './pipedrive-composio.js';

const client = new PipedriveComposioClient({ tenantId: 'tenant-1', connectedAccountId: 'ca_pd' });

beforeEach(() => jest.clearAllMocks());

const RECENTS = {
  successful: true,
  data: {
    success: true,
    data: [
      { item: 'deal', id: 11, data: { id: 11, title: 'Big deal', value: 5000, currency: 'USD', status: 'open', update_time: '2026-01-02 10:00:00' } },
      { item: 'person', id: 22, data: { id: 22, name: 'Jane Doe', first_name: 'Jane', last_name: 'Doe', email: [{ value: 'jane@x.com', primary: true }], update_time: '2026-01-02 11:00:00' } },
    ],
  },
};

describe('PipedriveComposioClient.list', () => {
  it("list('Deal') calls GET_RECENTS scoped to items=deal and returns only deal rows", async () => {
    mockExecute.mockResolvedValue(RECENTS);
    const res = await client.list('Deal', { since: new Date('2026-01-01T00:00:00Z') });

    expect(mockExecute).toHaveBeenCalledWith('PIPEDRIVE_GET_RECENTS', expect.objectContaining({
      userId: 'tenant-1',
      connectedAccountId: 'ca_pd',
      arguments: expect.objectContaining({ since_timestamp: '2026-01-01 00:00:00', items: 'deal', limit: 100, start: 0 }),
    }));
    expect(res.hasMore).toBe(false);
    expect(res.records.map(r => r.id)).toEqual(['11']);
    expect(res.records[0].data.__entity).toBe('deal');
    expect(res.records[0].data.title).toBe('Big deal');
  });

  it("list('Contact') scopes items=person and returns only person rows, stamped __entity=person", async () => {
    mockExecute.mockResolvedValue(RECENTS);
    const res = await client.list('Contact', { since: new Date('2026-01-01T00:00:00Z') });
    expect(mockExecute).toHaveBeenCalledWith('PIPEDRIVE_GET_RECENTS', expect.objectContaining({
      arguments: expect.objectContaining({ items: 'person' }),
    }));
    expect(res.records.map(r => r.id)).toEqual(['22']);
    expect(res.records[0].data.__entity).toBe('person');
  });

  it('tolerates entry.data returned as a grouped array (one record per element)', async () => {
    mockExecute.mockResolvedValue({
      successful: true,
      data: { data: [
        { item: 'deal', id: 0, data: [
          { id: 101, title: 'A', update_time: '2026-01-02 10:00:00' },
          { id: 102, title: 'B', update_time: '2026-01-02 11:00:00' },
        ] },
      ] },
    });
    const res = await client.list('Deal', { since: new Date('2026-01-01T00:00:00Z') });
    expect(res.records.map(r => r.id)).toEqual(['101', '102']);
    expect(res.records.every(r => r.data.__entity === 'deal')).toBe(true);
  });

  it('returns empty for an unmapped entityType', async () => {
    const res = await client.list('Organization', {});
    expect(res).toEqual({ records: [], hasMore: false, unsupported: true });
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('throws when GET_RECENTS returns successful=false', async () => {
    mockExecute.mockResolvedValue({ successful: false, error: 'bad token' });
    await expect(client.list('Deal', { since: new Date(0) })).rejects.toThrow('bad token');
  });
});
