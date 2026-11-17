// A screenshot the person asked to be SHOWN, at most once per turn.
//
// Three behaviours here are only observable across a seam, which is exactly the
// class this codebase keeps shipping broken:
//
//   1. `show_to_user` is what decides whether anything is posted at all. An
//      agent taking working screenshots for its own reasoning must leave the
//      thread alone; the live browser pane already shows the person what the
//      browser is doing.
//   2. The one-per-turn cap is enforced HERE, not in the prompt, and the second
//      call in a turn must SAY it already shared rather than duplicating the
//      picture or failing in a way the model cannot explain.
//   3. A sharing failure must not take the screenshot away from the model. The
//      capture succeeded and the PNG is already on its way back as an MCP image
//      block; reporting a failed screenshot would be a lie in the other
//      direction.

const mockFetchToolsScreenshot = jest.fn();
const mockUploadGeneratedFile = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  getPool: jest.fn().mockReturnValue({ query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) }),
  getPoolForService: jest.fn().mockReturnValue({
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  }),
}));

jest.mock('../../browser-sessions/repository', () => ({
  getActiveForThread: jest.fn().mockResolvedValue({
    id: 'session-row-1',
    // web_sessions.vendor is NOT NULL and now decides which client the
    // screenshot is fetched from, so a row without it is not a real row.
    vendor: 'anchor',
    vendorSessionId: 'vendor-session-1',
  }),
  setLastScreenshot: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../browser-sessions/screenshot-storage', () => ({
  uploadScreenshotAndSign: jest.fn().mockResolvedValue({
    url: 'https://storage.example/ephemeral-signed',
    objectPath: 'tenants/t/sessions/s/frame.png',
  }),
}));

jest.mock('../../integrations/web-fetch/anchor-client', () => ({
  AnchorClient: jest.fn().mockImplementation(() => ({
    fetchToolsScreenshot: (...args: unknown[]) => mockFetchToolsScreenshot(...(args as [])),
  })),
  AnchorError: class AnchorError extends Error {},
}));

jest.mock('../../clients/generated-files-client', () => ({
  uploadGeneratedFile: (...args: unknown[]) => mockUploadGeneratedFile(...(args as [])),
}));

import { executeStandardTool, StandardToolContext } from '../standard-tool-handler';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function ctxForTurn(invocationId: string): StandardToolContext {
  return {
    tenantId: '00000000-0000-0000-0000-0000000000t1',
    agentId: '00000000-0000-0000-0000-0000000000a1',
    memoryScope: { writableLayers: [], readableLayers: [] },
    traceId: 'trace-1',
    threadId: '00000000-0000-0000-0000-000000000099',
    invocationId,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFetchToolsScreenshot.mockResolvedValue(PNG);
  mockUploadGeneratedFile.mockResolvedValue({
    generatedFileId: 'media-1',
    filename: 'browser-screenshot_v1.png',
    version: 1,
    downloadUrl: 'https://storage.example/media-signed',
  });
});

describe('screenshot_browser_session — sharing is opt-in', () => {
  it('posts nothing when the model is only looking for itself', async () => {
    const r = await executeStandardTool('screenshot_browser_session', {}, ctxForTurn('turn-a'));
    expect(r?.success).toBe(true);
    expect(mockUploadGeneratedFile).not.toHaveBeenCalled();
    // The model still sees the picture, and the pane still gets its frame.
    expect(r?.mcpContent?.[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect((r?.result as Record<string, unknown>).screenshot_url).toBe(
      'https://storage.example/ephemeral-signed',
    );
    expect((r?.result as Record<string, unknown>).shown_to_user).toBeUndefined();
  });

  it('posts it once when the person asked to be shown', async () => {
    const r = await executeStandardTool(
      'screenshot_browser_session',
      { show_to_user: true },
      ctxForTurn('turn-b'),
    );
    expect(mockUploadGeneratedFile).toHaveBeenCalledTimes(1);
    expect(mockUploadGeneratedFile.mock.calls[0][0]).toMatchObject({
      outputType: 'media',
      contentType: 'image/png',
      conversationId: '00000000-0000-0000-0000-000000000099',
    });
    expect(r?.result).toMatchObject({
      shown_to_user: true,
      mediaId: 'media-1',
      already_shared: false,
    });
  });

  it('does not post a second copy in the same turn, and says so', async () => {
    const ctx = ctxForTurn('turn-c');
    await executeStandardTool('screenshot_browser_session', { show_to_user: true }, ctx);
    const second = await executeStandardTool('screenshot_browser_session', { show_to_user: true }, ctx);
    expect(mockUploadGeneratedFile).toHaveBeenCalledTimes(1);
    expect(second?.result).toMatchObject({
      shown_to_user: true,
      mediaId: 'media-1',
      already_shared: true,
    });
    // Still a real screenshot: the model gets the current frame either way.
    expect(second?.mcpContent?.[0]).toMatchObject({ type: 'image' });
  });

  it('posts again on the NEXT turn of the same thread', async () => {
    // The cap is per turn, not per thread. A person who asks for a screenshot
    // twice in one conversation must get two.
    await executeStandardTool('screenshot_browser_session', { show_to_user: true }, ctxForTurn('turn-d'));
    await executeStandardTool('screenshot_browser_session', { show_to_user: true }, ctxForTurn('turn-e'));
    expect(mockUploadGeneratedFile).toHaveBeenCalledTimes(2);
  });

  it('keeps the screenshot when posting it fails, and says posting failed', async () => {
    mockUploadGeneratedFile.mockRejectedValue(new Error('platform-backend 503'));
    const r = await executeStandardTool(
      'screenshot_browser_session',
      { show_to_user: true },
      ctxForTurn('turn-f'),
    );
    expect(r?.success).toBe(true);
    expect(r?.mcpContent?.[0]).toMatchObject({ type: 'image' });
    const result = r?.result as Record<string, unknown>;
    expect(result.shown_to_user).toBe(false);
    expect(String(result.share_error)).toMatch(/could not be posted/);
  });

  it('lets a later call retry after a failed one, rather than caching the failure', async () => {
    const ctx = ctxForTurn('turn-g');
    mockUploadGeneratedFile.mockRejectedValueOnce(new Error('platform-backend 503'));
    const first = await executeStandardTool('screenshot_browser_session', { show_to_user: true }, ctx);
    expect((first?.result as Record<string, unknown>).shown_to_user).toBe(false);
    const second = await executeStandardTool('screenshot_browser_session', { show_to_user: true }, ctx);
    expect((second?.result as Record<string, unknown>).shown_to_user).toBe(true);
    expect(mockUploadGeneratedFile).toHaveBeenCalledTimes(2);
  });
});
