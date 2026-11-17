// GongClient (polling via Composio proxy) + GongNormalizer unit tests.

jest.mock('./composio-transport.js', () => ({
  tryComposioProxy: jest.fn(),
}));

import { tryComposioProxy } from './composio-transport.js';
import { GongClient } from './gong.js';
import { GongNormalizer } from '../normalizers/gong.normalizer.js';
import type { CredentialProvider } from './types.js';

const credentialProvider: CredentialProvider = async () => ({
  accessToken: '',
  connectorConfig: { composioConnectedAccountId: 'ca_test' },
  tenantId: 't1',
  connectorId: 'c1',
});

const mockProxy = tryComposioProxy as jest.MockedFunction<typeof tryComposioProxy>;

describe('GongClient.list', () => {
  beforeEach(() => mockProxy.mockReset());

  it('maps the /v2/calls response to records + cursor and sends fromDateTime', async () => {
    mockProxy.mockResolvedValue({
      handled: true,
      data: {
        records: { cursor: 'next-cursor' },
        calls: [
          { id: 'call_1', started: '2026-06-26T10:00:00Z', title: 'Demo', duration: 1800, direction: 'Outbound' },
        ],
      },
    } as never);

    const client = new GongClient(credentialProvider);
    const res = await client.list('Call', { since: new Date('2026-06-26T00:00:00Z') });

    expect(res.records).toHaveLength(1);
    expect(res.records[0].id).toBe('call_1');
    expect(res.nextPageToken).toBe('next-cursor');
    expect(res.hasMore).toBe(true);
    expect(mockProxy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        method: 'GET',
        path: '/v2/calls',
        query: expect.objectContaining({ fromDateTime: '2026-06-26T00:00:00.000Z' }),
      }),
    );
  });

  it('forwards the page cursor when paginating', async () => {
    mockProxy.mockResolvedValue({ handled: true, data: { records: {}, calls: [] } } as never);
    const client = new GongClient(credentialProvider);
    await client.list('Call', { pageToken: 'cur_2' });
    expect(mockProxy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ query: expect.objectContaining({ cursor: 'cur_2' }) }),
    );
  });

  it('returns empty for a non-Call entity without calling the proxy', async () => {
    const client = new GongClient(credentialProvider);
    const res = await client.list('Foo');
    expect(res.records).toEqual([]);
    expect(mockProxy).not.toHaveBeenCalled();
  });

  it('throws a clear error when the proxy did not engage (no composioConnectedAccountId)', async () => {
    mockProxy.mockResolvedValue({ handled: false } as never);
    const client = new GongClient(credentialProvider);
    await expect(client.list('Call')).rejects.toThrow(/Composio proxy/i);
  });
});

describe('GongNormalizer', () => {
  it('normalizes a Call payload from { results: [...] }', () => {
    const n = new GongNormalizer();
    const recs = n.normalize({
      results: [{ id: 'call_1', started: '2026-06-26T10:00:00Z', title: 'Demo', duration: 1800, direction: 'Outbound', primaryUserId: 'u9' }],
    });
    expect(recs).toHaveLength(1);
    expect(recs[0].entityType).toBe('Call');
    expect(recs[0].externalId).toBe('call_1');
    expect(recs[0].data.direction).toBe('Outbound');
    expect(recs[0].data.primaryUserId).toBe('u9');
    expect(recs[0].metadata.source).toBe('gong');
    expect(recs[0].metadata.version).toBe('2026-06-26T10:00:00Z');
  });

  it('skips records without an id', () => {
    const n = new GongNormalizer();
    expect(n.normalize({ results: [{ title: 'no id' }] })).toHaveLength(0);
  });

  it('publishes a Call entity schema declaring the started anchor field', () => {
    const n = new GongNormalizer();
    expect(n.entitySchemas.Call).toBeDefined();
    expect(JSON.stringify(n.entitySchemas.Call)).toMatch(/started/);
  });
});
