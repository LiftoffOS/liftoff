// Tests for how the extractor asks connector-service for a file, and what it
// does with the answer.
//
// Three defects live here, all of which produced a knowledge item that looked
// fine and held nothing:
//
//   1. The request never said it wanted text, so a composio_managed connector
//      answered 401 (it has no access token to use — Composio signs
//      server-side) and a Google Sheet came back as .xlsx, which
//      extractFromBuffer cannot open. Both dev files a user pinned to test
//      extraction failed on the first; every spreadsheet ever imported failed
//      on the second.
//   2. The MIME type was inferred from stored metadata (the file's type at the
//      provider) rather than read from the response (the type it arrived as).
//      Those differ precisely when the connector service exports a
//      Google-native file.
//   3. A failed fetch threw with only the status, so `binary fetch failed:
//      401` was the entire diagnostic. The body said "No access token for
//      connector", which is a different problem from a revoked grant and
//      points straight at the cause.

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const repoMock = {
  markExtracting: jest.fn(async () => {}),
  saveExtractedText: jest.fn(async () => {}),
  markExtractionError: jest.fn(async () => {}),
  findPendingExtraction: jest.fn(async () => [] as unknown[]),
  create: jest.fn(),
  batchCreate: jest.fn(),
};
jest.mock('../repository', () => repoMock);
jest.mock('../outbox', () => ({
  publishOutboxRefs: jest.fn(async () => {}),
  publishOutboxRowInline: jest.fn(async () => ({ inlinePublished: true })),
}));
jest.mock('@liftoffos/service-client', () => ({
  buildOidcAuthHeader: jest.fn(async () => ({})),
}));
jest.mock('../../infrastructure/control-plane-url', () => ({
  getBackendUrl: () => 'http://localhost',
}));

import { extractConnectorFileText } from '../service';

const ORIG_ENV = { ...process.env };
let fetchMock: jest.Mock;

function fileResponse(body: string, contentType?: string) {
  const headers = new Map<string, string>();
  if (contentType) headers.set('content-type', contentType);
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    text: async () => body,
  } as unknown as Response;
}

const driveRef = {
  tenantId: 'tenant-1',
  connectorId: 'conn-1',
  connectorType: 'google_drive',
  externalId: 'file-1',
  contentType: 'document',
};

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ORIG_ENV, CONNECTOR_SERVICE_URL: 'http://connector.local' };
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterAll(() => {
  process.env = ORIG_ENV;
});

describe('extractConnectorFileText — request shape', () => {
  it('asks for the file as text, which is the only shape Composio can return', async () => {
    fetchMock.mockResolvedValueOnce(fileResponse('body text', 'text/plain'));

    await extractConnectorFileText(driveRef);

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/api/connectors/conn-1/files/file-1/content');
    expect(url).toContain('exportAs=text');
  });

  it('still passes siteId through for SharePoint drives', async () => {
    fetchMock.mockResolvedValueOnce(fileResponse('body', 'text/plain'));

    await extractConnectorFileText({
      ...driveRef,
      connectorType: 'microsoft_sharepoint',
      siteId: 'site-9',
    });

    expect(String(fetchMock.mock.calls[0][0])).toContain('siteId=site-9');
  });

  // The test above passes siteId explicitly — and that is the case that never
  // happens. `ref.siteId` is read from `item.metadata.siteId`, which nothing in
  // this repo writes, so without derivation the param is never appended and
  // every SharePoint file resolves against /me/drive: the connecting user's
  // personal OneDrive. Graph 404s, extraction stores '' and marks the item done,
  // so it reads as an empty document rather than a failure.
  describe('SharePoint site id, when no caller supplies one', () => {
    it('derives the site from the externalId that /browse minted', async () => {
      fetchMock.mockResolvedValueOnce(fileResponse('quarterly plan', 'text/plain'));

      await extractConnectorFileText({
        ...driveRef,
        connectorType: 'microsoft_sharepoint',
        // /browse emits `item:{siteId}:{driveItemId}` — the site was in the id
        // the whole time.
        externalId: 'item:contoso.sharepoint.com,g1,g2:01DRIVEITEM',
        // no siteId — matching every real knowledge item
      });

      const url = String(fetchMock.mock.calls[0][0]);
      expect(url).toContain('siteId=contoso.sharepoint.com%2Cg1%2Cg2');
      // and the item id is still the LAST segment, not the whole compound id
      expect(url).toContain('/files/01DRIVEITEM/content');
    });

    it('prefers an explicit siteId over the derived one', async () => {
      fetchMock.mockResolvedValueOnce(fileResponse('x', 'text/plain'));

      await extractConnectorFileText({
        ...driveRef,
        connectorType: 'microsoft_sharepoint',
        externalId: 'item:derived-site:01ITEM',
        siteId: 'explicit-site',
      });

      const url = String(fetchMock.mock.calls[0][0]);
      expect(url).toContain('siteId=explicit-site');
      expect(url).not.toContain('derived-site');
    });

    it('does not invent a site for OneDrive, where /me/drive is correct', async () => {
      fetchMock.mockResolvedValueOnce(fileResponse('x', 'text/plain'));

      await extractConnectorFileText({
        ...driveRef,
        connectorType: 'microsoft_onedrive',
        externalId: 'item:something:01ITEM',
      });

      expect(String(fetchMock.mock.calls[0][0])).not.toContain('siteId=');
    });

    it('sends no siteId when the id carries no site, rather than an empty one', async () => {
      fetchMock.mockResolvedValueOnce(fileResponse('x', 'text/plain'));

      await extractConnectorFileText({
        ...driveRef,
        connectorType: 'microsoft_sharepoint',
        externalId: 'item::01ITEM',
      });

      expect(String(fetchMock.mock.calls[0][0])).not.toContain('siteId=');
    });
  });
});

describe('extractConnectorFileText — trusting the response over the guess', () => {
  it('reads a spreadsheet exported as CSV, where the stored type says google-apps', async () => {
    fetchMock.mockResolvedValueOnce(fileResponse('stage,count\nqualified,12\n', 'text/csv'));

    const text = await extractConnectorFileText({
      ...driveRef,
      // What the provider calls it. The bytes are CSV.
      mimeType: 'application/vnd.google-apps.spreadsheet',
    });

    expect(text).toContain('stage,count');
    expect(text).toContain('qualified,12');
  });

  it('reads a doc exported as text/plain', async () => {
    fetchMock.mockResolvedValueOnce(fileResponse('the report body', 'text/plain'));

    const text = await extractConnectorFileText({
      ...driveRef,
      mimeType: 'application/vnd.google-apps.document',
    });

    expect(text).toBe('the report body');
  });

  it('falls back to the stored type when the response is unlabelled', async () => {
    fetchMock.mockResolvedValueOnce(fileResponse('plain body', undefined));

    const text = await extractConnectorFileText({ ...driveRef, mimeType: 'text/plain' });

    expect(text).toBe('plain body');
  });

  it('ignores a generic octet-stream label and uses the stored type', async () => {
    fetchMock.mockResolvedValueOnce(fileResponse('markdown body', 'application/octet-stream'));

    const text = await extractConnectorFileText({ ...driveRef, mimeType: 'text/markdown' });

    expect(text).toBe('markdown body');
  });
});

describe('extractConnectorFileText — failure reporting', () => {
  it('carries the response body into the error, not just the status', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      headers: { get: () => null },
      text: async () => '{"error":"No access token for connector"}',
      arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as Response);

    await expect(extractConnectorFileText(driveRef)).rejects.toThrow(
      /401.*No access token for connector/s,
    );
  });

  it('reports a 415 refusal verbatim so the reason reaches sync_error', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 415,
      headers: { get: () => null },
      text: async () => '{"error":"Cannot download application/pdf through a Composio-managed connector"}',
      arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as Response);

    await expect(extractConnectorFileText(driveRef)).rejects.toThrow(/Composio-managed/);
  });
});
