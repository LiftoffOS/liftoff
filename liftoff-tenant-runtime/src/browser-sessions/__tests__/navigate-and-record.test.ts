// The one navigation helper: navigate, read the ACTUAL destination, persist
// the safe URL, record once under the caller's id, and return only the safe
// projection with its flags. A failure after session resolution is recorded
// before the rethrow.

const gotoUrl = jest.fn();
const getActivePage = jest.fn();
jest.mock('../session-vendor-proxy', () => ({
  gotoUrl: (...a: unknown[]) => gotoUrl(...a),
  getActivePage: (...a: unknown[]) => getActivePage(...a),
}));
const persistCurrentUrl = jest.fn();
jest.mock('../current-url', () => ({ persistCurrentUrl: (...a: unknown[]) => persistCurrentUrl(...a) }));
const recordBrowserActivity = jest.fn(async (input: { id: string }) => input.id);
jest.mock('../activity-repository', () => ({
  recordBrowserActivity: (...a: unknown[]) => recordBrowserActivity(...(a as [{ id: string }])),
}));
jest.mock('../../infrastructure/logging', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { navigateAndRecord } from '../navigate-and-record';

const session = {
  id: 'sid', tenantId: 't', agentId: 'a', threadId: 'th', invocationId: null, vendor: 'steel', vendorSessionId: 'vsid',
  liveViewUrl: null, createdAt: new Date(), lastUsedAt: null, expiresAt: null, closedAt: null, closedReason: null,
  takeoverState: 'none' as const, takenOverAt: null, ownerAccountId: null, callerSessionId: null, currentUrl: null,
  lastScreenshotObjectPath: null, lastScreenshotAt: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  recordBrowserActivity.mockImplementation(async (input: { id: string }) => input.id);
});

describe('navigateAndRecord', () => {
  it('uses the raw URL for the navigation only, and records the safe requested and actual URLs under the caller\'s id', async () => {
    const raw = 'https://a.example/magic-link?token=abc123&next=%2Fhome';
    gotoUrl.mockResolvedValueOnce(undefined);
    getActivePage.mockResolvedValueOnce({ url: 'https://a.example/home?welcome=1', title: 'Home for jane@acme.example' });
    persistCurrentUrl.mockResolvedValueOnce({ ...session, currentUrl: 'https://a.example/home?welcome=1' });
    const out = await navigateAndRecord({ tenantId: 't', session, url: raw, activityId: 'act-1' });
    expect(gotoUrl).toHaveBeenCalledWith('steel', 'vsid', 't', raw);
    // The title rides with the URL, so the cached page carries both and the
    // Browser block can name it without a live read.
    expect(persistCurrentUrl).toHaveBeenCalledWith('vsid', 'https://a.example/home?welcome=1', 'Home for jane@acme.example');
    expect(recordBrowserActivity).toHaveBeenCalledTimes(1);
    expect(recordBrowserActivity.mock.calls[0][0]).toMatchObject({
      id: 'act-1', tenantId: 't', threadId: 'th', sessionId: 'sid', tool: 'navigate_browser_session',
      instruction: 'https://a.example/magic-link?token=[redacted]&next=%2Fhome', instructionProtectedDataOmitted: true,
      outcome: 'opened https://a.example/home?welcome=1; title: Home for jane@acme.example', steps: null, personTookOver: false,
    });
    expect(out).toEqual({
      finalUrl: 'https://a.example/home?welcome=1', finalUrlTruncated: false, finalUrlProtectedDataOmitted: false,
      title: 'Home for jane@acme.example', titleTruncated: false, titleProtectedDataOmitted: false,
      requestedUrl: 'https://a.example/magic-link?token=[redacted]&next=%2Fhome', requestedUrlProtectedDataOmitted: true,
      activityId: 'act-1', session: expect.objectContaining({ currentUrl: 'https://a.example/home?welcome=1' }),
    });
    expect(JSON.stringify(out)).not.toContain('abc123');
  });

  it('reads the landing only after the proxy goto has returned, so a saved login the goto applied is what is read and recorded', async () => {
    // The fill rides inside the proxy's gotoUrl (session-vendor-proxy.ts) and
    // is awaited there; this helper's read and record come after it.
    gotoUrl.mockImplementationOnce(() => new Promise((r) => setTimeout(r, 20)));
    getActivePage.mockResolvedValueOnce({ url: 'https://a.example/home', title: 'Home' });
    persistCurrentUrl.mockResolvedValueOnce(session);
    const out = await navigateAndRecord({ tenantId: 't', session, url: 'https://a.example/login', activityId: 'act-9' });
    expect(gotoUrl.mock.invocationCallOrder[0]).toBeLessThan(getActivePage.mock.invocationCallOrder[0]);
    expect(out.finalUrl).toBe('https://a.example/home');
    expect(recordBrowserActivity.mock.calls[0][0]).toMatchObject({ outcome: 'opened https://a.example/home; title: Home' });
  });

  it('flags a redirected destination that carries a protected component, and a long title', async () => {
    gotoUrl.mockResolvedValueOnce(undefined);
    getActivePage.mockResolvedValueOnce({ url: 'https://a.example/oauth/callback?code=xyz&state=s', title: 't'.repeat(500) });
    persistCurrentUrl.mockResolvedValueOnce(null);
    const out = await navigateAndRecord({ tenantId: 't', session, url: 'https://a.example/start' });
    expect(out.finalUrl).toBe('https://a.example/oauth/callback?code=[redacted]&state=[redacted]');
    expect(out.finalUrlProtectedDataOmitted).toBe(true);
    expect(out.title).toHaveLength(400);
    expect(out.titleTruncated).toBe(true);
    expect(out.activityId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('records the failure under the caller\'s id BEFORE rethrowing, so the error and the row agree', async () => {
    gotoUrl.mockRejectedValueOnce(new Error('net::ERR_NAME_NOT_RESOLVED'));
    await expect(navigateAndRecord({ tenantId: 't', session, url: 'https://nope.example/?token=abc', activityId: 'act-2' }))
      .rejects.toThrow('ERR_NAME_NOT_RESOLVED');
    expect(recordBrowserActivity).toHaveBeenCalledTimes(1);
    expect(recordBrowserActivity.mock.calls[0][0]).toMatchObject({
      id: 'act-2', tool: 'navigate_browser_session',
      outcome: 'could not open https://nope.example/?token=[redacted]: net::ERR_NAME_NOT_RESOLVED',
    });
    expect(getActivePage).not.toHaveBeenCalled();
  });

  it('a run-scoped session (no thread) navigates but records nothing: its sandbox browser is not pane work', async () => {
    gotoUrl.mockResolvedValueOnce(undefined);
    getActivePage.mockResolvedValueOnce({ url: 'https://a.example/', title: 'A' });
    persistCurrentUrl.mockResolvedValueOnce(null);
    const out = await navigateAndRecord({ tenantId: 't', session: { ...session, threadId: null, invocationId: 'inv' }, url: 'https://a.example/' });
    expect(gotoUrl).toHaveBeenCalledTimes(1);
    expect(recordBrowserActivity).not.toHaveBeenCalled();
    expect(out).toMatchObject({ activityId: null, finalUrl: 'https://a.example/', title: 'A' });
  });

  it('a failed insert leaves the navigation done and answers with no id', async () => {
    gotoUrl.mockResolvedValueOnce(undefined);
    getActivePage.mockResolvedValueOnce({ url: 'https://a.example/', title: '' });
    persistCurrentUrl.mockResolvedValueOnce(null);
    recordBrowserActivity.mockResolvedValueOnce(null);
    const out = await navigateAndRecord({ tenantId: 't', session, url: 'https://a.example/' });
    expect(out.activityId).toBeNull();
    expect(out.finalUrl).toBe('https://a.example/');
  });
});
