/**
 * web_session_close handler (B2).
 *
 * Verifies:
 *  - closing an existing session closes every open row under the caller
 *    session id through the repository's closeSession (the one writer of
 *    closed_at, which ends an open takeover hold with it) + invokes the
 *    vendor teardown
 *  - closing a missing session returns { closed: false }, no upstream call
 *  - upstream-close failures still return { closed: true } (local close honored)
 *  - close handler does NOT call admitSingleVendor — closing must never wait
 *    for a slot, because closing is what frees slots
 */

const mockPoolQuery = jest.fn();
const mockCloseSessionRow = jest.fn();
const mockAnchorCloseSession = jest.fn();
const mockBrowserbaseCloseSession = jest.fn();
const mockAdmitSingleVendor = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  getPool: () => ({ query: (...a: unknown[]) => mockPoolQuery(...a) }),
}));
jest.mock('../../browser-sessions/repository', () => ({
  ...jest.requireActual('../../browser-sessions/repository'),
  closeSession: (...a: unknown[]) => mockCloseSessionRow(...a),
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
  WebFetchRouter: jest.fn().mockImplementation(() => ({})),
  admitSingleVendor: (...a: unknown[]) => mockAdmitSingleVendor(...a),
}));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../usage-ledger/service', () => ({ usageLedgerService: { recordUsage: jest.fn() } }));
jest.mock('../../memory/service', () => ({ memoryService: {} }));
jest.mock('../../platform-callback/client', () => ({ getPlatformCallbackClient: jest.fn() }));

import { executeStandardTool } from '../standard-tool-handler';

const ctx = {
  tenantId: 'tenant-1', agentId: 'agent-1',
  memoryScope: { writableLayers: ['individual'], readableLayers: ['individual'] },
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('web_session_close', () => {
  it('returns { closed: true } and invokes anchor.closeSession when the session is anchor-owned', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ vendor: 'anchor', vendor_session_id: 'anchor-vsid-1', caller_session_id: 'caller-sid-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'row-a' }, { id: 'row-b' }] });
    mockCloseSessionRow.mockResolvedValue({ id: 'row-a' });
    mockAnchorCloseSession.mockResolvedValueOnce(undefined);

    const out = await executeStandardTool('web_session_close', { session_id: 'caller-sid-1' }, ctx);

    expect(out).toEqual({ success: true, result: { closed: true } });
    // Every open row under the caller session id closes locally, through the
    // one writer of closed_at, BEFORE the vendor is asked.
    const openSql = mockPoolQuery.mock.calls[1][0] as string;
    expect(openSql).toMatch(/SELECT id FROM web_sessions/);
    expect(openSql).toMatch(/caller_session_id = \$2 AND closed_at IS NULL/);
    expect(mockPoolQuery.mock.calls[1][1]).toEqual(['tenant-1', 'caller-sid-1']);
    expect(mockCloseSessionRow.mock.calls).toEqual([['row-a', 'completed'], ['row-b', 'completed']]);
    expect(mockCloseSessionRow.mock.invocationCallOrder[0]).toBeLessThan(mockAnchorCloseSession.mock.invocationCallOrder[0]);
    // closeSession signature is (vendorSessionId, tenantId) — the tenantId
    // is required for the BYOK-aware credential lookup inside AnchorClient.
    expect(mockAnchorCloseSession).toHaveBeenCalledWith('anchor-vsid-1', 'tenant-1');
    expect(mockBrowserbaseCloseSession).not.toHaveBeenCalled();
    expect(mockAdmitSingleVendor).not.toHaveBeenCalled();
  });

  it('returns { closed: false } and skips the vendor teardown when the session is unknown', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const out = await executeStandardTool('web_session_close', { session_id: 'missing' }, ctx);
    expect(out).toEqual({ success: true, result: { closed: false, reason: 'already closed or not found' } });
    expect(mockAnchorCloseSession).not.toHaveBeenCalled();
    expect(mockBrowserbaseCloseSession).not.toHaveBeenCalled();
  });

  it('returns { closed: true } even when the upstream teardown throws (local close honored), and corrects the reason', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ vendor: 'browserbase', vendor_session_id: 'bb-vsid-1', caller_session_id: 'caller-sid-2' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'row-c' }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // the closed_reason correction
    mockCloseSessionRow.mockResolvedValue({ id: 'row-c' });
    mockBrowserbaseCloseSession.mockRejectedValueOnce(new Error('upstream 500'));
    const out = await executeStandardTool('web_session_close', { session_id: 'caller-sid-2' }, ctx);
    expect(out).toEqual({ success: true, result: { closed: true } });
    expect(mockCloseSessionRow).toHaveBeenCalledWith('row-c', 'completed');
    const correction = mockPoolQuery.mock.calls[2][0] as string;
    expect(correction).toMatch(/SET closed_reason = 'failed'/);
  });

  it('defaults to the thread\'s active session when session_id is omitted', async () => {
    // No session_id passed; handler should resolve via (tenant_id, thread_id).
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ vendor: 'anchor', vendor_session_id: 'anchor-vsid-3', caller_session_id: 'ui:auto-3' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'row-d' }] });
    mockCloseSessionRow.mockResolvedValue({ id: 'row-d' });
    mockAnchorCloseSession.mockResolvedValueOnce(undefined);

    const out = await executeStandardTool(
      'web_session_close',
      {},
      { ...ctx, threadId: 'thread-xyz' },
    );

    expect(out).toEqual({ success: true, result: { closed: true } });
    expect(mockCloseSessionRow).toHaveBeenCalledWith('row-d', 'completed');
    // First SELECT keyed by (tenant_id, thread_id), not caller_session_id.
    const firstCallSql = mockPoolQuery.mock.calls[0][0] as string;
    expect(firstCallSql).toMatch(/thread_id = \$2/);
    expect(mockPoolQuery.mock.calls[0][1]).toEqual(['tenant-1', 'thread-xyz']);
    expect(mockAnchorCloseSession).toHaveBeenCalledWith('anchor-vsid-3', 'tenant-1');
  });

  it('errors when session_id AND thread context are both missing', async () => {
    const out = await executeStandardTool('web_session_close', {}, ctx);
    expect(out).toEqual({ success: false, error: 'web_session_close requires session_id or a thread or run context' });
  });
});
