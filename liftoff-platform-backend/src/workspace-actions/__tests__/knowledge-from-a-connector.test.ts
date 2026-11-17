// An assistant can add a file the way the Knowledge page adds one, and read an
// entry again instead of adding a second copy.
//
// Without these, `knowledge_add_url` is the only write. Asked to fix a Google
// Doc whose text would not read, an assistant can only offer to add the same
// document again AS A WEB LINK — knowing the library would probably pick up a
// Google sign-in page instead of the notes and that the broken entry would
// stay. It knows the remedy is bad and has no other. The page has both.

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

const mockListConnectors = jest.fn();
jest.mock('../../connectors/connector-service-client', () => ({
  listConnectorsForTenant: (...a: unknown[]) => mockListConnectors(...a),
  getCatalog: jest.fn(),
  getConnectorHealthStats: jest.fn(),
}));

const mockBrowse = jest.fn();
const mockCreate = jest.fn();
const mockGetById = jest.fn();
const mockExtract = jest.fn();
jest.mock('../../knowledge/service', () => ({
  listItems: jest.fn(),
  browseConnector: (...a: unknown[]) => mockBrowse(...a),
  createItem: (...a: unknown[]) => mockCreate(...a),
  getById: (...a: unknown[]) => mockGetById(...a),
  extractAndPersistItem: (...a: unknown[]) => mockExtract(...a),
}));
jest.mock('../audit', () => ({ writeAudit: jest.fn() }));

import { addKnowledgeFile, browseKnowledgeSource, resyncKnowledgeItem } from '../knowledge';
import type { Actor } from '../actor';

const actor: Actor = {
  tenantId: '22222222-2222-2222-2222-222222222222',
  accountId: 'acct-1',
  role: 'owner',
  displayName: 'Ada',
  surface: 'liftoff',
};

const CONNECTED = [{ id: 'conn-1', type: 'google_drive', name: 'Google Drive', status: 'active', installState: null }];

beforeEach(() => {
  jest.clearAllMocks();
  mockListConnectors.mockResolvedValue(CONNECTED);
});

describe('browsing a connected app', () => {
  it('hands back the file id, the link and the provider type the add needs', async () => {
    mockBrowse.mockResolvedValue({
      results: [{
        id: 'file-1',
        title: 'Shawkat (Papr.ai) 4/20/26',
        url: 'https://docs.google.com/document/d/1jNM',
        contentType: 'document',
        metadata: { mimeType: 'application/vnd.google-apps.document' },
      }],
      nextCursor: null,
    });

    const out = await browseKnowledgeSource(actor, { connectorId: 'conn-1', query: 'Shawkat' });

    expect(out).toEqual({
      files: [{
        externalId: 'file-1',
        title: 'Shawkat (Papr.ai) 4/20/26',
        url: 'https://docs.google.com/document/d/1jNM',
        contentType: 'document',
        mimeType: 'application/vnd.google-apps.document',
      }],
      nextCursor: null,
    });
  });

  it('says when the app cannot list, which is not the same as holding nothing', async () => {
    mockBrowse.mockResolvedValue({ results: [], nextCursor: null, unsupported: true });
    const out = await browseKnowledgeSource(actor, { connectorId: 'conn-1' });
    expect(out).toMatchObject({ files: [], cannotList: true });
  });

  it('carries entityType and mimeTypes, which the page carries', async () => {
    // A source holding more than one kind of thing — a help centre with articles
    // and collections — answers for the kind it is asked about. Without this it
    // answers for its default, which for some sources is nothing at all, and an
    // empty list reads as an empty account.
    mockBrowse.mockResolvedValue({ results: [], nextCursor: null });
    await browseKnowledgeSource(actor, {
      connectorId: 'conn-1', entityType: 'article', mimeTypes: 'application/pdf', folderId: 'f-1', query: 'q', cursor: 'c',
    });
    expect(mockBrowse).toHaveBeenCalledWith(actor.tenantId, 'conn-1', {
      query: 'q', folderId: 'f-1', cursor: 'c', entityType: 'article', mimeTypes: 'application/pdf',
    });
  });

  it('reports an article from a help centre as an article', async () => {
    mockBrowse.mockResolvedValue({
      results: [{ id: 'art-1', title: 'Refund policy', url: 'https://help.example.com/a/1', contentType: 'article', metadata: {} }],
      nextCursor: null,
    });
    const out = await browseKnowledgeSource(actor, { connectorId: 'conn-1', entityType: 'article' });
    expect((out as { files: Array<{ contentType: string }> }).files[0]!.contentType).toBe('article');
  });
});

describe('adding a file from a connected app', () => {
  it('creates the entry against the file itself, not a web address', async () => {
    mockCreate.mockImplementation(async (_t: string, input: Record<string, unknown>) => ({
      id: 'k-9', tenantId: actor.tenantId, syncStatus: 'pending', syncError: null,
      extractionStatus: 'pending', extractedText: null, excerpt: null, parentId: null,
      lastSyncedAt: null, extractedAt: null, createdAt: 'now', updatedAt: 'now', metadata: {},
      ...input,
    }));

    const out = await addKnowledgeFile(actor, {
      connectorId: 'conn-1',
      externalId: 'file-1',
      title: 'Shawkat (Papr.ai) 4/20/26',
      sourceUrl: 'https://docs.google.com/document/d/1jNM',
      mimeType: 'application/vnd.google-apps.document',
    });

    expect(out).toMatchObject({ added: true });
    const input = mockCreate.mock.calls[0]![1] as Record<string, unknown>;
    expect(input).toMatchObject({
      connectorId: 'conn-1',
      connectorType: 'google_drive',
      externalId: 'file-1',
      importMode: 'file_select',
      // Which is what puts the row on the retry budget rather than ending it.
      extractionStatus: 'pending',
      // Stored, so extraction reads the type the provider gave rather than
      // inferring one. Every row created so far carries metadata {}.
      metadata: { mimeType: 'application/vnd.google-apps.document' },
    });
  });

  // The library is not only Drive files, and the first version of this tool
  // forced every kind to document or folder. A Zendesk or Intercom article, and a
  // Confluence or OneNote page, are read over a DIFFERENT call from a file — and
  // that call is handed this very field, so narrowing it here would have stored
  // four whole source families as the wrong kind of thing. The page takes what
  // browse said and passes it through; so does this.
  it.each([
    ['article', 'pending'],
    ['document', 'pending'],
    ['page', 'pending'],
    ['folder', 'none'],
    ['collection', 'none'],
  ])('keeps %s as the source called it, and reads it when it holds text', async (contentType, extraction) => {
    mockCreate.mockImplementation(async (_t: string, input: Record<string, unknown>) => ({
      id: 'k-9', syncError: null, metadata: {}, ...input,
    }));

    await addKnowledgeFile(actor, { connectorId: 'conn-1', externalId: 'x-1', title: 'Anything', contentType });

    const input = mockCreate.mock.calls[0]![1] as Record<string, unknown>;
    expect(input.contentType).toBe(contentType);
    // Exactly the rule POST /api/knowledge/batch applies: a container is
    // legitimately empty, everything else is waiting to be read. A container
    // marked pending would be retried forever for text it never had.
    expect(input.extractionStatus).toBe(extraction);
  });

  it('falls back to document for a kind it does not recognise, rather than storing it', async () => {
    mockCreate.mockImplementation(async (_t: string, input: Record<string, unknown>) => ({
      id: 'k-9', syncError: null, metadata: {}, ...input,
    }));
    await addKnowledgeFile(actor, { connectorId: 'conn-1', externalId: 'x-1', title: 'Anything', contentType: 'whatever' });
    expect((mockCreate.mock.calls[0]![1] as Record<string, unknown>).contentType).toBe('document');
  });

  it('refuses an app the workspace does not have connected', async () => {
    mockListConnectors.mockResolvedValue([{ id: 'conn-1', type: 'google_drive', status: 'disconnected', installState: null }]);
    const out = await addKnowledgeFile(actor, { connectorId: 'conn-1', externalId: 'file-1', title: 'Anything' });
    // Rather than creating a row that can never read, which is what the person
    // was left with twice over.
    expect(out).toMatchObject({ refused: 'validation' });
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('reading an entry again', () => {
  const errored = {
    id: 'k-1', tenantId: actor.tenantId, title: 'Shawkat (Papr.ai) 4/20/26',
    sourceUrl: 'https://docs.google.com/document/d/1jNM', connectorId: 'conn-1',
    connectorType: 'google_drive', externalId: 'file-1', contentType: 'document',
    excerpt: null, metadata: {}, importMode: 'file_select', syncStatus: 'synced',
    lastSyncedAt: 'then', syncError: 'This file contains only its title, so there is nothing to read.',
    parentId: null, extractionStatus: 'error', extractedText: '', extractedAt: 'then',
    createdAt: 'then', updatedAt: 'then',
  };

  it('reads the same entry and returns the reason when it fails again', async () => {
    mockGetById.mockResolvedValue(errored);
    mockExtract.mockResolvedValue({ ok: false, empty: true });

    const out = await resyncKnowledgeItem(actor, { id: 'k-1' });

    expect(mockExtract).toHaveBeenCalledWith(errored);
    expect(out).toMatchObject({ read: false });
    // The point of the tool: one entry either way, and the reason comes back
    // instead of a guess.
    expect((out as { item: { syncError: string | null } }).item.syncError)
      .toBe('This file contains only its title, so there is nothing to read.');
  });

  it('refuses a URL entry, which has no file to read again', async () => {
    mockGetById.mockResolvedValue({ ...errored, connectorId: null, externalId: null });
    const out = await resyncKnowledgeItem(actor, { id: 'k-1' });
    expect(out).toMatchObject({ refused: 'validation' });
    expect(mockExtract).not.toHaveBeenCalled();
  });

  it('refuses an id that is not in the library', async () => {
    mockGetById.mockResolvedValue(null);
    expect(await resyncKnowledgeItem(actor, { id: 'nope' })).toMatchObject({ refused: 'validation' });
  });
});
