// MicrosoftSharePointClient.list('Document') polling path + normalizer .results
// branch tests. The scheduler calls list('Document', { since, pageToken, limit }),
// the client enumerates driveItems via /me/drive/root/search(q=''), folders are
// skipped (Documents = files only), and the normalizer's { results: [...] } branch
// emits entityType:'Document'.

import { MicrosoftSharePointClient } from './microsoft-sharepoint.js';
import { MicrosoftSharePointNormalizer } from '../normalizers/microsoft-sharepoint.normalizer.js';
import type { CredentialProvider } from './types.js';

const credentialProvider: CredentialProvider = async () => ({
  accessToken: 'graph_token',
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

describe("MicrosoftSharePointClient.list('Document')", () => {
  afterEach(() => jest.restoreAllMocks());

  it('hits the driveItem search endpoint with $orderby and maps files, skipping folders', async () => {
    const spy = mockFetchOnce({
      value: [
        {
          id: 'D1',
          name: 'spec.docx',
          webUrl: 'https://contoso.sharepoint.com/spec.docx',
          size: 2048,
          file: { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
          lastModifiedDateTime: '2026-06-26T10:00:00Z',
          parentReference: { siteId: 'site-1', path: '/drive/root:/Specs' },
        },
        { id: 'F1', name: 'folder', folder: { childCount: 3 }, lastModifiedDateTime: '2026-06-25T10:00:00Z' },
      ],
    });

    const client = new MicrosoftSharePointClient(credentialProvider);
    const res = await client.list('Document', { since: new Date('2026-06-01T00:00:00Z'), limit: 100 });

    // Folder F1 skipped → only the file D1 maps.
    expect(res.records).toHaveLength(1);
    expect(res.records[0].id).toBe('D1');
    expect(res.records[0].data.name).toBe('spec.docx');
    expect(res.hasMore).toBe(false);

    const url = spy.mock.calls[0][0] as string;
    expect(url).toContain("/me/drive/root/search(q='')");
    expect(url).toContain('%24orderby=lastModifiedDateTime+desc');
    expect(url).toContain('%24top=100');
  });

  it('surfaces the skip token from @odata.nextLink and signals hasMore', async () => {
    mockFetchOnce({
      value: [{ id: 'D2', name: 'plan.xlsx', file: { mimeType: 'x' }, lastModifiedDateTime: '2026-06-26T11:00:00Z' }],
      '@odata.nextLink':
        "https://graph.microsoft.com/v1.0/me/drive/root/search(q='')?$skiptoken=ABC123&$top=100",
    });

    const client = new MicrosoftSharePointClient(credentialProvider);
    const res = await client.list('Document', { limit: 100 });

    expect(res.hasMore).toBe(true);
    expect(res.nextPageToken).toBe('ABC123');
  });
});

describe('MicrosoftSharePointNormalizer .results → Document', () => {
  it('normalizes a wrapped driveItem to entityType Document', () => {
    const normalizer = new MicrosoftSharePointNormalizer();
    const out = normalizer.normalize({
      results: [
        {
          id: 'D1',
          name: 'spec.docx',
          webUrl: 'https://contoso.sharepoint.com/spec.docx',
          size: 2048,
          file: { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
          createdDateTime: '2026-06-20T09:00:00Z',
          lastModifiedDateTime: '2026-06-26T10:00:00Z',
          parentReference: { siteId: 'site-1', path: '/drive/root:/Specs', driveId: 'drive-9' },
        },
      ],
    });

    expect(out).toHaveLength(1);
    const rec = out[0];
    expect(rec.entityType).toBe('Document');
    expect(rec.externalId).toBe('site-1:D1');
    expect(rec.data.name).toBe('spec.docx');
    expect(rec.data.mimeType).toContain('wordprocessingml');
    expect(rec.data.parentPath).toBe('/drive/root:/Specs');
    expect(rec.data.modifiedAt).toBe('2026-06-26T10:00:00Z');
    // lastModifiedDateTime is the dedup version for the no-$filter search path.
    expect(rec.metadata.version).toBe('2026-06-26T10:00:00Z');
  });

  it('registers a Document entity schema', () => {
    const normalizer = new MicrosoftSharePointNormalizer();
    expect(normalizer.entitySchemas.Document).toBeDefined();
  });
});
