// Unit tests for extractAndPersistItem (plan §9): per-item helper used by
// both the event-driven subscriber path and the backstop cron loop.

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

const outboxMock = {
  publishOutboxRefs: jest.fn(async () => {}),
  publishOutboxRowInline: jest.fn(async () => ({ inlinePublished: true })),
};
jest.mock('../outbox', () => outboxMock);

// Avoid loading the @liftoffos/service-client OIDC machinery in unit tests.
jest.mock('@liftoffos/service-client', () => ({
  buildOidcAuthHeader: jest.fn(async () => ({})),
}));

jest.mock('../../infrastructure/control-plane-url', () => ({
  getBackendUrl: () => 'http://localhost',
}));

import { extractAndPersistItem, runExtractionBatch } from '../service';
import type { KnowledgeItem } from '../types';

const baseItem: KnowledgeItem = {
  id: 'item-1',
  tenantId: 'tenant-1',
  title: 't',
  sourceUrl: null,
  connectorId: 'conn-1',
  connectorType: 'zendesk',
  externalId: 'ext-1',
  contentType: 'document',
  excerpt: null,
  metadata: {},
  importMode: 'auto_import',
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

const ORIG_ENV = { ...process.env };
let fetchMock: jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ORIG_ENV, CONNECTOR_SERVICE_URL: 'http://connector.local' };
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterAll(() => {
  process.env = ORIG_ENV;
});

describe('extractAndPersistItem — happy path (article connector with real fetch)', () => {
  it('zendesk article: fetches /content endpoint, strips HTML, persists extracted_text, returns ok:true', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Map(),
      text: async () => '',
      json: async () => ({ html: '<p>Hello <b>world</b></p>' }),
    } as unknown as Response);

    const result = await extractAndPersistItem(baseItem);

    expect(result).toEqual({ ok: true });
    expect(repoMock.markExtracting).toHaveBeenCalledWith('tenant-1', 'item-1');
    // Hits the connector-service /content endpoint with the right path/query
    const [calledUrl] = fetchMock.mock.calls[0];
    expect(String(calledUrl)).toContain('/api/connectors/conn-1/content/ext-1');
    expect(String(calledUrl)).toContain('tenantId=tenant-1');
    expect(String(calledUrl)).toContain('contentType=document');
    // stripHtml drops tags, joins text — exact whitespace handling tested in stripHtml's own suite
    const persistedText = repoMock.saveExtractedText.mock.calls[0][2] as string;
    expect(persistedText).toMatch(/Hello/);
    expect(persistedText).toMatch(/world/);
    expect(persistedText).not.toMatch(/<p>|<b>/);
    expect(repoMock.markExtractionError).not.toHaveBeenCalled();
  });
});

describe('extractAndPersistItem — skip path (folder/collection short-circuit)', () => {
  it('folder content_type: persists empty string with extraction_status=done, no HTTP call', async () => {
    const folderItem = { ...baseItem, contentType: 'folder' as const };
    const result = await extractAndPersistItem(folderItem);
    expect(result).toEqual({ ok: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(repoMock.saveExtractedText).toHaveBeenCalledWith('tenant-1', 'item-1', '');
  });

  it('collection content_type: same short-circuit as folder', async () => {
    const collItem = { ...baseItem, contentType: 'collection' as const };
    const result = await extractAndPersistItem(collItem);
    expect(result).toEqual({ ok: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('extractAndPersistItem — error path', () => {
  it('connector HTTP non-200: marks extraction_status=error and returns ok:false', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      text: async () => 'bad gateway',
    } as unknown as Response);

    const result = await extractAndPersistItem(baseItem);

    expect(result).toEqual({ ok: false });
    expect(repoMock.markExtractionError).toHaveBeenCalledWith(
      'tenant-1', 'item-1',
      expect.stringMatching(/connector-service 502/),
    );
    expect(repoMock.saveExtractedText).not.toHaveBeenCalled();
  });

  it('repo.saveExtractedText throws: caught, marked error, returns ok:false', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ html: '<p>ok</p>' }),
    } as unknown as Response);
    repoMock.saveExtractedText.mockImplementationOnce(async () => { throw new Error('disk full'); });

    const result = await extractAndPersistItem(baseItem);
    expect(result).toEqual({ ok: false });
    expect(repoMock.markExtractionError).toHaveBeenCalledWith('tenant-1', 'item-1', 'Error: disk full');
  });
});

describe('extractAndPersistItem — idempotency (at-least-once safe)', () => {
  it('re-running on a successful extract is safe: same end-state, no side-effect divergence', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ html: '<p>text</p>' }),
    } as unknown as Response);

    const r1 = await extractAndPersistItem(baseItem);
    const r2 = await extractAndPersistItem(baseItem);

    expect(r1).toEqual({ ok: true });
    expect(r2).toEqual({ ok: true });
    expect(repoMock.markExtracting).toHaveBeenCalledTimes(2);
    expect(repoMock.saveExtractedText).toHaveBeenCalledTimes(2);
    expect(repoMock.markExtractionError).not.toHaveBeenCalled();
  });
});

describe('runExtractionBatch (backstop cron path)', () => {
  it('iterates findPendingExtraction items and delegates to extractAndPersistItem', async () => {
    repoMock.findPendingExtraction.mockResolvedValueOnce([
      { ...baseItem, id: 'a', contentType: 'folder' },
      { ...baseItem, id: 'b', contentType: 'folder' },
    ]);
    const result = await runExtractionBatch();
    expect(result.extracted).toBe(2);
    expect(result.errors).toBe(0);
    expect(repoMock.markExtracting).toHaveBeenCalledTimes(2);
  });

  it('counts errors when extractAndPersistItem fails', async () => {
    repoMock.findPendingExtraction.mockResolvedValueOnce([
      { ...baseItem, id: 'a', contentType: 'folder' },
    ]);
    repoMock.saveExtractedText.mockImplementationOnce(async () => { throw new Error('boom'); });
    const result = await runExtractionBatch();
    expect(result.extracted).toBe(0);
    expect(result.errors).toBe(1);
  });

  it('returns zeros and skips logging when no pending items', async () => {
    repoMock.findPendingExtraction.mockResolvedValueOnce([]);
    const result = await runExtractionBatch();
    // `empty` is reported alongside `errors` (and included in it): a file we
    // fetched that yielded no text points at a format or an empty source,
    // where a plain error points at the connector.
    expect(result).toEqual({ extracted: 0, errors: 0, empty: 0 });
  });
});
