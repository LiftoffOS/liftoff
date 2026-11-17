// MicrosoftOneNoteClient reactive polling (Page) + normalizer .results branch.
// Verifies the flat Graph pages endpoint wiring the scheduler depends on:
//   client.list('Page') → GET /me/onenote/pages?$orderby=lastModifiedDateTime desc
//   normalizer.normalize({ results: [...] }) → Page records.

import { MicrosoftOneNoteClient } from './microsoft-onenote.js';
import { MicrosoftOneNoteNormalizer } from '../normalizers/microsoft-onenote.normalizer.js';
import type { CredentialProvider } from './types.js';

const credentialProvider: CredentialProvider = async () => ({
  accessToken: 'tok',
  tenantId: 't1',
  connectorId: 'c1',
});

describe('MicrosoftOneNoteClient.list("Page")', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function mockFetch(body: unknown) {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => body,
    } as Response);
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  it('hits /me/onenote/pages with $orderby and maps value rows to records', async () => {
    const fetchMock = mockFetch({
      value: [
        {
          id: 'P1',
          title: 'Notes',
          lastModifiedDateTime: '2026-06-26T10:00:00Z',
          links: { oneNoteWebUrl: { href: 'https://onenote.com/p1' } },
        },
      ],
    });

    const client = new MicrosoftOneNoteClient(credentialProvider);
    const res = await client.list('Page', { since: new Date('2026-06-25T00:00:00Z'), limit: 50 });

    expect(res.records).toHaveLength(1);
    expect(res.records[0].id).toBe('P1');
    expect(res.records[0].data.title).toBe('Notes');
    expect(res.hasMore).toBe(false);

    // URLSearchParams encodes spaces as '+'; normalize before asserting.
    const calledUrl = (fetchMock.mock.calls[0][0] as string).replace(/\+/g, ' ');
    expect(calledUrl).toContain('/me/onenote/pages');
    expect(decodeURIComponent(calledUrl)).toContain('$orderby=lastModifiedDateTime desc');
    // since → $filter on lastModifiedDateTime
    expect(decodeURIComponent(calledUrl)).toContain('$filter=lastModifiedDateTime ge 2026-06-25T00:00:00.000Z');
    expect(decodeURIComponent(calledUrl)).toContain('$top=50');
  });

  it('returns a nextPageToken parsed from @odata.nextLink $skiptoken', async () => {
    mockFetch({
      value: [{ id: 'P2', title: 'More', lastModifiedDateTime: '2026-06-26T11:00:00Z' }],
      '@odata.nextLink':
        'https://graph.microsoft.com/v1.0/me/onenote/pages?$skiptoken=ABC123&$top=100',
    });

    const client = new MicrosoftOneNoteClient(credentialProvider);
    const res = await client.list('Page', {});

    expect(res.hasMore).toBe(true);
    expect(res.nextPageToken).toBe('ABC123');
  });

  it('forwards a pageToken as $skiptoken when paginating', async () => {
    const fetchMock = mockFetch({ value: [] });

    const client = new MicrosoftOneNoteClient(credentialProvider);
    await client.list('Page', { pageToken: 'CUR2' });

    const calledUrl = decodeURIComponent(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl).toContain('$skiptoken=CUR2');
  });
});

describe('MicrosoftOneNoteNormalizer .results branch', () => {
  it('normalizes { results: [...] } into Page records', () => {
    const n = new MicrosoftOneNoteNormalizer();
    const recs = n.normalize({
      results: [
        {
          id: 'P1',
          title: 'Notes',
          lastModifiedDateTime: '2026-06-26T10:00:00Z',
          links: { oneNoteWebUrl: { href: 'https://onenote.com/p1' } },
        },
      ],
    });

    expect(recs).toHaveLength(1);
    expect(recs[0].entityType).toBe('Page');
    expect(recs[0].externalId).toBe('P1');
    expect(recs[0].data.title).toBe('Notes');
    expect(recs[0].data.oneNoteWebUrl).toBe('https://onenote.com/p1');
    expect(recs[0].metadata.source).toBe('microsoft_onenote');
    expect(recs[0].metadata.version).toBe('2026-06-26T10:00:00Z');
  });

  it('skips rows without an id', () => {
    const n = new MicrosoftOneNoteNormalizer();
    expect(n.normalize({ results: [{ title: 'no id' }] })).toHaveLength(0);
  });

  it('publishes a Page entity schema', () => {
    const n = new MicrosoftOneNoteNormalizer();
    expect(n.entitySchemas.Page).toBeDefined();
  });
});
