// An item that extracts to nothing is a failed import, not a finished one.
//
// It used to be saved as '' with extraction_status='done' and reported as
// ok:true, so the row rendered like any working one while holding no text —
// unreadable by corpus_search, uncounted in the error totals, and listed in
// the library as if it carried content. Two real bugs hid behind that state
// for months: spreadsheets exported as .xlsx that no parser in this estate can
// open, and Drive files on Composio-managed connectors that could not be
// fetched at all. Both produced a library full of confident blanks.

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const repoMock = {
  markExtracting: jest.fn(async () => {}),
  saveExtractedText: jest.fn(async () => {}),
  markExtractionError: jest.fn(async () => {}),
  findPendingExtraction: jest.fn(async () => [] as unknown[]),
  updateMetadataField: jest.fn(async () => {}),
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

import { extractAndPersistItem, runExtractionBatch } from '../service';
import type { KnowledgeItem } from '../types';

const ORIG_ENV = { ...process.env };
let fetchMock: jest.Mock;

const driveItem: KnowledgeItem = {
  id: 'item-1',
  tenantId: 'tenant-1',
  title: 'Shawkat (Papr.ai) 4/20/26',
  sourceUrl: null,
  connectorId: 'conn-1',
  connectorType: 'google_drive',
  externalId: 'file-1',
  contentType: 'document',
  excerpt: null,
  metadata: { mimeType: 'application/vnd.google-apps.document' },
  importMode: 'file_select',
  syncStatus: 'synced',
  lastSyncedAt: null,
  syncError: null,
  parentId: null,
  extractionStatus: 'pending',
  extractedText: null,
  extractedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function fileResponse(body: string, contentType = 'text/plain') {
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? contentType : null) },
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    text: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ORIG_ENV, CONNECTOR_SERVICE_URL: 'http://connector.local' };
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterAll(() => {
  process.env = ORIG_ENV;
});

describe('empty extraction', () => {
  it('records an error instead of a completed import', async () => {
    fetchMock.mockResolvedValueOnce(fileResponse(''));

    const result = await extractAndPersistItem(driveItem);

    expect(result).toEqual({ ok: false, empty: true });
    expect(repoMock.saveExtractedText).not.toHaveBeenCalled();
    expect(repoMock.markExtractionError).toHaveBeenCalledTimes(1);
  });

  it('treats whitespace as empty, since a page of newlines is not content', async () => {
    fetchMock.mockResolvedValueOnce(fileResponse('   \n\n  \t '));

    const result = await extractAndPersistItem(driveItem);

    expect(result.ok).toBe(false);
    expect(repoMock.saveExtractedText).not.toHaveBeenCalled();
  });

  it('names the source type in the reason, so the operator can tell empty from unsupported', async () => {
    fetchMock.mockResolvedValueOnce(fileResponse(''));

    await extractAndPersistItem(driveItem);

    const reason = repoMock.markExtractionError.mock.calls[0][2] as string;
    expect(reason).toContain('application/vnd.google-apps.document');
    expect(reason).toMatch(/no readable text/i);
  });

  it('still stores a real extraction', async () => {
    fetchMock.mockResolvedValueOnce(fileResponse('the report body'));

    const result = await extractAndPersistItem(driveItem);

    expect(result).toEqual({ ok: true });
    expect(repoMock.saveExtractedText).toHaveBeenCalledWith('tenant-1', 'item-1', 'the report body');
    expect(repoMock.markExtractionError).not.toHaveBeenCalled();
  });
});

describe('containers are exempt', () => {
  it('a folder still completes with empty text and never calls the connector', async () => {
    const folder = { ...driveItem, contentType: 'folder' as const };

    const result = await extractAndPersistItem(folder);

    expect(result).toEqual({ ok: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(repoMock.saveExtractedText).toHaveBeenCalledWith('tenant-1', 'item-1', '');
    expect(repoMock.markExtractionError).not.toHaveBeenCalled();
  });

  it('a failure writing a folder is still caught, not thrown at the batch', async () => {
    const folder = { ...driveItem, contentType: 'collection' as const };
    repoMock.saveExtractedText.mockImplementationOnce(async () => {
      throw new Error('db down');
    });

    const result = await extractAndPersistItem(folder);

    expect(result).toEqual({ ok: false });
    expect(repoMock.markExtractionError).toHaveBeenCalledTimes(1);
  });
});

describe('batch reporting', () => {
  it('counts an empty separately from a connector failure', async () => {
    repoMock.findPendingExtraction.mockResolvedValueOnce([
      { ...driveItem, id: 'empty-1' },
      { ...driveItem, id: 'broken-1' },
      { ...driveItem, id: 'good-1' },
    ]);
    fetchMock
      .mockResolvedValueOnce(fileResponse(''))
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        headers: { get: () => null },
        text: async () => 'upstream exploded',
        arrayBuffer: async () => new ArrayBuffer(0),
      } as unknown as Response)
      .mockResolvedValueOnce(fileResponse('real content'));

    const result = await runExtractionBatch();

    expect(result.extracted).toBe(1);
    expect(result.errors).toBe(2);
    // Both failed, but only one of them was "we read the file and it said
    // nothing" — the other points at the connector.
    expect(result.empty).toBe(1);
  });
});

describe('a file whose whole body is its own title', () => {
  // The observed case: a doc named "Shawkat (Papr.ai) 4/20/26" whose complete
  // text is "Shawkat (Papr.ai)". 17 characters, so an is-it-empty check passes
  // it, while the item carries nothing the row did not already have.
  it('is recorded as unreadable, not as a completed import', async () => {
    fetchMock.mockResolvedValueOnce(fileResponse('Shawkat (Papr.ai)\n\n'));

    const result = await extractAndPersistItem({
      ...driveItem,
      title: 'Shawkat (Papr.ai) 4/20/26',
    });

    expect(result).toEqual({ ok: false, empty: true });
    expect(repoMock.saveExtractedText).not.toHaveBeenCalled();
    const reason = repoMock.markExtractionError.mock.calls[0][2] as string;
    expect(reason).toMatch(/only its title/i);
  });

  it('ignores punctuation and casing when comparing', async () => {
    fetchMock.mockResolvedValueOnce(fileResponse('q3   REPORT'));

    const result = await extractAndPersistItem({ ...driveItem, title: 'Q3 Report' });

    expect(result.ok).toBe(false);
  });

  it('keeps a short file that says something of its own', async () => {
    fetchMock.mockResolvedValueOnce(fileResponse('Approved by the board on 4 April.'));

    const result = await extractAndPersistItem({ ...driveItem, title: 'Board approval' });

    expect(result).toEqual({ ok: true });
    expect(repoMock.saveExtractedText).toHaveBeenCalled();
  });

  it('keeps a document that opens with its own title and then continues', async () => {
    fetchMock.mockResolvedValueOnce(
      fileResponse('Q3 Report\n\nRevenue grew 12% against a flat pipeline.'),
    );

    const result = await extractAndPersistItem({ ...driveItem, title: 'Q3 Report' });

    expect(result).toEqual({ ok: true });
  });
});

describe('the character ceiling', () => {
  // A partial import that presents as a complete one is the same defect as an
  // empty one that presents as complete. The 1,313-row dev spreadsheet exports
  // to 274,390 characters; under the old 100,000 ceiling the library held its
  // first 480 rows and said "Synced".
  it('stores a document larger than the old 100k limit in full', async () => {
    const big = 'row,value\n'.repeat(30_000); // 300,000 chars
    fetchMock.mockResolvedValueOnce(fileResponse(big, 'text/csv'));

    const result = await extractAndPersistItem(driveItem);

    expect(result).toEqual({ ok: true });
    const stored = repoMock.saveExtractedText.mock.calls[0][2] as string;
    expect(stored.length).toBe(big.length);
    expect(repoMock.updateMetadataField).not.toHaveBeenCalled();
  });

  it('flags the row when the text really is cut, rather than cutting silently', async () => {
    const huge = 'x'.repeat(1_200_000); // past the 1,000,000 ceiling
    fetchMock.mockResolvedValueOnce(fileResponse(huge));

    await extractAndPersistItem(driveItem);

    const stored = repoMock.saveExtractedText.mock.calls[0][2] as string;
    expect(stored.length).toBe(1_000_000);
    expect(repoMock.updateMetadataField).toHaveBeenCalledWith(
      'tenant-1',
      'item-1',
      'extractionTruncated',
      true,
    );
  });

  it('clears a stale truncation flag when the file now fits', async () => {
    fetchMock.mockResolvedValueOnce(fileResponse('short body'));

    await extractAndPersistItem({
      ...driveItem,
      metadata: { ...driveItem.metadata, extractionTruncated: true },
    });

    expect(repoMock.updateMetadataField).toHaveBeenCalledWith(
      'tenant-1',
      'item-1',
      'extractionTruncated',
      false,
    );
  });
});
