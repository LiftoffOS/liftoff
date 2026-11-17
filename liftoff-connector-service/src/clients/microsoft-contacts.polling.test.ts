// MicrosoftContactsClient.list('Contact') (Graph polling) + normalizer .results path.

import { MicrosoftContactsClient } from './microsoft-contacts.js';
import { MicrosoftContactsNormalizer } from '../normalizers/microsoft-contacts.normalizer.js';
import type { CredentialProvider } from './types.js';

const credentialProvider: CredentialProvider = async () => ({
  accessToken: 'graph_token',
  instanceUrl: undefined,
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

describe('MicrosoftContactsClient.list', () => {
  afterEach(() => jest.restoreAllMocks());

  it('pages /me/contacts with incremental $filter + $orderby on lastModifiedDateTime', async () => {
    const spy = mockFetchOnce({
      value: [{ id: 'AAMk1', displayName: 'Ada Lovelace', lastModifiedDateTime: '2026-06-26T10:00:00Z' }],
    });
    const client = new MicrosoftContactsClient(credentialProvider);
    const res = await client.list('Contact', { since: new Date('2026-06-26T00:00:00Z'), limit: 100 });

    expect(res.records).toHaveLength(1);
    expect(res.records[0].id).toBe('AAMk1');
    expect(res.hasMore).toBe(false);

    const url = spy.mock.calls[0][0] as string;
    expect(url).toContain('/me/contacts');
    expect(url).toContain('%24orderby=lastModifiedDateTime');
    // URLSearchParams encodes the $filter spaces as '+'.
    expect(url).toContain('%24filter=lastModifiedDateTime+ge+2026-06-26T00%3A00%3A00.000Z');
  });

  it('surfaces @odata.nextLink $skiptoken as the page token', async () => {
    mockFetchOnce({
      value: [{ id: 'AAMk2' }],
      '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/contacts?%24skiptoken=ABC123',
    });
    const client = new MicrosoftContactsClient(credentialProvider);
    const res = await client.list('Contact', {});
    expect(res.hasMore).toBe(true);
    expect(res.nextPageToken).toBe('ABC123');
  });

  it('returns empty for a non-Contact entity without calling Graph', async () => {
    const spy = jest.spyOn(global, 'fetch');
    const client = new MicrosoftContactsClient(credentialProvider);
    expect((await client.list('ContactFolder')).records).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('MicrosoftContactsNormalizer .results polling path', () => {
  it('normalizes scheduler-wrapped { results: [contact] } rows to Contact records', () => {
    const n = new MicrosoftContactsNormalizer();
    const recs = n.normalize({
      results: [{
        id: 'AAMk1',
        displayName: 'Ada Lovelace',
        emailAddresses: [{ name: 'Ada', address: 'ada@example.com' }],
        lastModifiedDateTime: '2026-06-26T10:00:00Z',
        changeKey: 'CK1',
      }],
    });
    expect(recs).toHaveLength(1);
    expect(recs[0].entityType).toBe('Contact');
    expect(recs[0].externalId).toBe('AAMk1');
    expect(recs[0].data.displayName).toBe('Ada Lovelace');
    expect(recs[0].metadata.source).toBe('microsoft_contacts');
    expect(recs[0].metadata.version).toBe('CK1');
  });
});
