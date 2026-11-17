// fetch_browser_download + web_session_save schema-rejection coverage.
//
// fetch_browser_download needs an active browser session, and something to
// name the file: a download id from list_browser_downloads, or the address of
// a file the page points at. Either one, never neither: a call that names
// nothing has nothing to fetch and must say so rather than guess.
//
// web_session_save requires a non-empty name (it's the slot key under
// which the session is persisted for later restore). A regression that
// allowed empty names would let two saves collide silently.

jest.mock('../../infrastructure/database', () => ({
  getPool: jest.fn().mockReturnValue({
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  }),
  getPoolForService: jest.fn().mockReturnValue({
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  }),
}));

jest.mock('../../browser-sessions/repository', () => ({
  getActiveForThread: jest.fn().mockResolvedValue(null),
}));

jest.mock('../../integrations/web-fetch/router', () => ({
  WebFetchRouter: jest.fn(),
  webFetchRouter: {
    sessionSave: jest.fn(),
  },
}));

import { executeStandardTool, StandardToolContext } from '../standard-tool-handler';

const ctx: StandardToolContext = {
  tenantId: 'tenant-1',
  agentId: 'agent-1',
  memoryScope: { writableLayers: [], readableLayers: [] },
  traceId: 'trace-1',
  threadId: '00000000-0000-0000-0000-000000000099',
};

beforeEach(() => jest.clearAllMocks());

describe('fetch_browser_download — schema rejection', () => {
  it('rejects a call that names neither a download nor an address', async () => {
    const r = await executeStandardTool('fetch_browser_download', {}, ctx);
    expect(r?.success).toBe(false);
    expect(r?.error).toMatch(/id/);
    expect(r?.error).toMatch(/url/);
  });

  it('rejects whitespace-only id', async () => {
    const r = await executeStandardTool('fetch_browser_download', { id: '   ' }, ctx);
    expect(r?.success).toBe(false);
  });

  it('rejects non-string id', async () => {
    const r = await executeStandardTool('fetch_browser_download', { id: 42 }, ctx);
    expect(r?.success).toBe(false);
  });

  it('reports "no active session" when the thread has none', async () => {
    const r = await executeStandardTool('fetch_browser_download', { id: 'dl-1' }, ctx);
    expect(r?.success).toBe(false);
    expect(r?.error).toMatch(/no active browser session/);
  });

  // The half that was missing entirely: a page that generates a video puts it
  // at a plain address and downloads nothing, so an id can never name it.
  it('takes an address on its own, and gets as far as the session lookup', async () => {
    const r = await executeStandardTool('fetch_browser_download', { url: 'https://cdn.example/clip.mp4' }, ctx);
    expect(r?.success).toBe(false);
    expect(r?.error).toMatch(/no active browser session/);
  });

  it('rejects when no thread context is supplied', async () => {
    const ctxNoThread: StandardToolContext = { ...ctx, threadId: undefined };
    const r = await executeStandardTool('fetch_browser_download', { id: 'dl-1' }, ctxNoThread);
    expect(r?.success).toBe(false);
    expect(r?.error).toMatch(/thread/);
  });
});

describe('web_session_save — schema rejection', () => {
  it('rejects missing name', async () => {
    const r = await executeStandardTool('web_session_save', {}, ctx);
    expect(r?.success).toBe(false);
  });

  it('rejects empty-string name', async () => {
    const r = await executeStandardTool('web_session_save', { name: '' }, ctx);
    expect(r?.success).toBe(false);
  });
});
