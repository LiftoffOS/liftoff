// Polling coverage for the Notion (Page) reactive path.
//
// The polling scheduler calls client.list('Page', ...) with the CAPITALIZED
// entity type, then wraps the records as { results: [row.data, ...] } and hands
// them to NotionNormalizer.normalize(). These tests prove:
//   1. list('Page') (capitalized) now routes to the Notion `search` tool and
//      maps the { results, next_cursor, has_more } response into
//      { records:[{id,data}], nextPageToken, hasMore }.
//   2. The normalizer's .results path emits a Page with a title pulled from the
//      page's `properties` (the title-type property's plain_text).
//
// MCPClient is mocked so no network I/O happens.

const mockCallTool = jest.fn();
const mockListTools = jest.fn();
const mockDisconnect = jest.fn();
const mockSetCorrelationId = jest.fn();

jest.mock('../mcp/mcp-client.js', () => ({
  MCPClient: jest.fn().mockImplementation((config: { url: string }) => ({
    _url: config.url,
    callTool: mockCallTool,
    listTools: mockListTools,
    disconnect: mockDisconnect,
    setCorrelationId: mockSetCorrelationId,
  })),
}));

jest.mock('../mcp/token-provider.js', () => ({
  OAuthTokenProvider: jest.fn().mockImplementation(() => ({
    getToken: jest.fn().mockResolvedValue('mock-token'),
  })),
}));

import { NotionMCPClient } from './notion-mcp.js';
import { NotionNormalizer } from '../normalizers/notion.normalizer.js';

function makeCredentialStore() {
  return {
    getCredentials: jest.fn().mockResolvedValue({ accessToken: 'mock-token' }),
    refreshOAuthToken: jest.fn(),
  };
}

function makeTextResult(data: Record<string, unknown>) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], isError: false };
}

// A representative Notion `search` response — one page object with a title-type
// property plus a select-type property (which must NOT be treated as the title).
const SEARCH_RESPONSE = {
  results: [
    {
      object: 'page',
      id: 'page-123',
      url: 'https://www.notion.so/page-123',
      created_time: '2026-06-01T10:00:00.000Z',
      last_edited_time: '2026-06-25T12:30:00.000Z',
      archived: false,
      parent: { type: 'database_id', database_id: 'db-987' },
      properties: {
        Status: { id: 'sx', type: 'select', select: { name: 'In progress' } },
        Name: {
          id: 'title',
          type: 'title',
          title: [{ plain_text: 'Q3 launch ', type: 'text' }, { plain_text: 'plan', type: 'text' }],
        },
      },
    },
  ],
  next_cursor: 'cursor-abc',
  has_more: true,
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('NotionMCPClient.list — Page polling', () => {
  it("list('Page') (capitalized) routes to the search tool and maps the response", async () => {
    mockCallTool.mockResolvedValue(makeTextResult(SEARCH_RESPONSE));
    const client = new NotionMCPClient({ tenantId: 't1', credentialStore: makeCredentialStore() });

    const res = await client.list('Page', {});

    // Capitalized 'Page' must reach the search tool, filtered to lowercase 'page'.
    expect(mockCallTool).toHaveBeenCalledTimes(1);
    const [tool, params] = mockCallTool.mock.calls[0];
    expect(tool).toBe('search');
    expect(params).toMatchObject({ filter: { value: 'page', property: 'object' } });
    // Incremental polling: sort by last_edited_time descending.
    expect(params.sort).toEqual({ direction: 'descending', timestamp: 'last_edited_time' });

    // Response shape mapped to ListResult.
    expect(res.records).toHaveLength(1);
    expect(res.records[0].id).toBe('page-123');
    expect(res.records[0].data.id).toBe('page-123');
    expect(res.nextPageToken).toBe('cursor-abc');
    expect(res.hasMore).toBe(true);
  });

  it("lowercase list('page') still works (legacy tool-gateway caller)", async () => {
    mockCallTool.mockResolvedValue(makeTextResult(SEARCH_RESPONSE));
    const client = new NotionMCPClient({ tenantId: 't1', credentialStore: makeCredentialStore() });

    const res = await client.list('page', {});

    expect(mockCallTool).toHaveBeenCalledWith('search', expect.objectContaining({
      filter: { value: 'page', property: 'object' },
    }));
    expect(res.records).toHaveLength(1);
  });
});

describe('NotionNormalizer — Page', () => {
  it('emits a Page from the .results path with a title pulled from properties', () => {
    const normalizer = new NotionNormalizer();
    // Mirror what the scheduler does: wrap the list() row.data as { results: [...] }.
    const records = normalizer.normalize({ results: SEARCH_RESPONSE.results });

    expect(records).toHaveLength(1);
    const rec = records[0];
    expect(rec.entityType).toBe('Page');
    expect(rec.externalId).toBe('page-123');
    expect(rec.data.title).toBe('Q3 launch plan');
    expect(rec.data.url).toBe('https://www.notion.so/page-123');
    expect(rec.data.parentType).toBe('database_id');
    expect(rec.data.parentId).toBe('db-987');
    expect(rec.data.archived).toBe(false);
    // Version is the last_edited_time, the scheduler's dedup anchor.
    expect(rec.metadata.version).toBe('2026-06-25T12:30:00.000Z');
    expect(rec.metadata.source).toBe('notion');
  });

  it('skips records with no id and reports connectorType notion', () => {
    const normalizer = new NotionNormalizer();
    expect(normalizer.connectorType).toBe('notion');
    expect(normalizer.entitySchemas.Page).toBeDefined();
    const records = normalizer.normalize({ results: [{ object: 'page' }] });
    expect(records).toHaveLength(0);
  });
});
