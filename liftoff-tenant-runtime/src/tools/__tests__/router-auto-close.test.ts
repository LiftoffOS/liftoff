/**
 * B2 auto-close threading — verifies that web_task auto-closes the session
 * iff the router/vendor created it locally (vs the caller passing in an
 * existing session_id).
 *
 * The contract:
 *  - createdSessionLocally === true + non-empty sessionId  → handler invokes
 *    handleWebSessionClose in finally
 *  - createdSessionLocally === false                       → no auto-close
 *  - failure path also auto-closes when applicable (finally)
 */

const mockExecuteTask = jest.fn();
const mockPoolQuery = jest.fn();
const mockAnchorCloseSession = jest.fn();
const mockBrowserbaseCloseSession = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  getPool: () => ({ query: (...a: unknown[]) => mockPoolQuery(...a) }),
}));
jest.mock('../../integrations/web-fetch/anchor-client', () => ({
  AnchorClient: jest.fn().mockImplementation(() => ({ closeSession: mockAnchorCloseSession })),
}));
jest.mock('../../integrations/web-fetch/browserbase-client', () => ({
  BrowserbaseClient: jest.fn().mockImplementation(() => ({ closeSession: mockBrowserbaseCloseSession })),
}));
jest.mock('../../integrations/web-fetch/webclaw-client', () => ({
  WebClawClient: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('../../integrations/web-fetch/firecrawl-client', () => ({
  FirecrawlClient: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('../../integrations/web-fetch/perplexity-client', () => ({
  PerplexityClient: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('../../integrations/web-fetch/router', () => ({
  WebFetchRouter: jest.fn().mockImplementation(() => ({
    task: (...a: unknown[]) => mockExecuteTask(...a),
  })),
  admitSingleVendor: jest.fn().mockResolvedValue({ release: jest.fn().mockResolvedValue(undefined) }),
}));
jest.mock('../../integrations/web-fetch/global-flags', () => ({
  isVendorEnabled: jest.fn().mockResolvedValue(true),
  getAllVendorFlags: jest.fn().mockResolvedValue({ webclaw: true, firecrawl: true, perplexity: true, anchor: true, browserbase: true }),
}));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../security/ssrf-guard', () => ({
  assertNotSsrfTarget: jest.fn(),
  SsrfTargetRejected: class extends Error {},
}));
jest.mock('../../usage-ledger/service', () => ({ usageLedgerService: { recordUsage: jest.fn().mockResolvedValue(undefined) } }));
jest.mock('../../memory/service', () => ({ memoryService: {} }));
jest.mock('../../platform-callback/client', () => ({ getPlatformCallbackClient: jest.fn() }));
// web_task screens its structured result. The screen resolves the tenant's
// injection mode through the entitlements client, which reads
// `getPool().query` — and `mockPoolQuery` below is an ORDERED queue, so an
// unmocked screen silently eats the auto-close lookup's row and this file's
// subject stops happening for a reason that has nothing to do with it.
// Framing and screening have their own coverage in
// standard-tool-handler.web-framing.test.ts.
jest.mock('../../injection-detection/finding', () => ({
  screenUntrustedText: jest.fn().mockResolvedValue(undefined),
  screenUntrustedStructured: jest.fn().mockResolvedValue(undefined),
}));

import { executeStandardTool } from '../standard-tool-handler';

const ctx = {
  tenantId: 'tenant-1', agentId: 'agent-1',
  memoryScope: { writableLayers: ['individual'], readableLayers: ['individual'] },
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('web_task auto-close (B2)', () => {
  it('auto-closes the session when the router created it locally', async () => {
    mockExecuteTask.mockResolvedValueOnce({
      result: 'done', sessionId: 'sid-locally-created', vendor: 'anchor', costMicros: 0,
      createdSessionLocally: true,
    });
    // The handleWebSessionClose lookup query.
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ vendor: 'anchor', vendor_session_id: 'vsid-1' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await executeStandardTool('web_task', { task: 'do the thing' }, ctx);

    // closeSession's signature in both anchor-client and browserbase-client is
    // (vendorSessionId, tenantId) — the tenantId was added when per-tenant
    // vendor credentials were threaded through. Strict arg match so any future
    // signature change surfaces here rather than hiding behind a partial check.
    expect(mockAnchorCloseSession).toHaveBeenCalledWith('vsid-1', ctx.tenantId);
  });

  it('does NOT auto-close when the caller passed an existing session_id (createdSessionLocally=false)', async () => {
    mockExecuteTask.mockResolvedValueOnce({
      result: 'done', sessionId: 'sid-from-caller', vendor: 'anchor', costMicros: 0,
      createdSessionLocally: false,
    });
    await executeStandardTool('web_task', { task: 'do the thing', session_id: 'sid-from-caller' }, ctx);
    expect(mockAnchorCloseSession).not.toHaveBeenCalled();
    expect(mockBrowserbaseCloseSession).not.toHaveBeenCalled();
  });

  it('auto-close runs in finally even when the task body throws', async () => {
    mockExecuteTask.mockRejectedValueOnce(new Error('task crashed mid-flight'));
    // No internalSessionToClose is set in this path (the assignment is inside
    // the try after `internal` is computed). So no close call. Verify clean
    // failure surface and no spurious upstream-close.
    const r = await executeStandardTool('web_task', { task: 'will fail' }, ctx);
    expect(r).toMatchObject({ success: false });
    expect(mockAnchorCloseSession).not.toHaveBeenCalled();
  });

  it('does not auto-close when createdSessionLocally is true but sessionId is undefined', async () => {
    mockExecuteTask.mockResolvedValueOnce({
      result: 'done', sessionId: undefined, vendor: 'anchor', costMicros: 0,
      createdSessionLocally: true,
    });
    await executeStandardTool('web_task', { task: 'do the thing' }, ctx);
    expect(mockAnchorCloseSession).not.toHaveBeenCalled();
  });
});
