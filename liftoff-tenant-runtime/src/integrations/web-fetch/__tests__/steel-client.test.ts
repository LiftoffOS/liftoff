/**
 * Steel: whose account pays, what a session cost, and how a profile is bound.
 *
 * The precedence rule is the same one browser-use-client carries and is the
 * whole feature: a workspace that connected its own Steel key uses that key
 * and is billed by Steel directly; a workspace that connected nothing browses
 * on the platform key and is billed by us in Operating Units. The cost figure
 * is the plan's rate card applied to the vendor's own duration and proxy
 * egress, because `creditsUsed` is not documented in dollars.
 */

const getWebToolCredentialMock = jest.fn();
const getWebToolSecretMock = jest.fn();

class VendorNotConnected extends Error {
  constructor(public readonly vendor: string) {
    super(`No connected ${vendor} connector for tenant`);
    this.name = 'VendorNotConnected';
  }
}
class VendorConnectorErrored extends Error {
  constructor(public readonly vendor: string, public readonly errorCode: string) {
    super(`${vendor} connector in error state: ${errorCode}`);
    this.name = 'VendorConnectorErrored';
  }
}

jest.mock('../web-tool-secrets', () => ({
  getWebToolCredential: (...a: unknown[]) => getWebToolCredentialMock(...a),
  getWebToolSecret: (...a: unknown[]) => getWebToolSecretMock(...a),
  VendorNotConnected,
  VendorConnectorErrored,
}));

jest.mock('../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const poolQueryMock = jest.fn();
jest.mock('../../../infrastructure/database', () => ({
  getPool: () => ({ query: (...a: unknown[]) => poolQueryMock(...a) }),
}));

const recordSettledSessionCostMock = jest.fn();
jest.mock('../../../browser-sessions/session-cost', () => ({
  recordSettledSessionCost: (...a: unknown[]) => recordSettledSessionCostMock(...a),
}));

/** The browser behind a headless fetch: one page whose navigation the test
 *  scripts (the origin's answer itself is browser-navigation's, pinned in
 *  its own suite). */
const gotoMock = jest.fn();
const contentMock = jest.fn(async () => '<html><body><h1>Hello</h1></body></html>');
const mainFrame = { name: 'main' };
const evaluateMock = jest.fn(async () => ({ width: 1280, height: 800 }));
const setViewportSizeMock = jest.fn(async () => undefined);
const screenshotMock = jest.fn(async () => Buffer.from('png'));
const fakePage = {
  on: jest.fn(), off: jest.fn(),
  goto: (...a: unknown[]) => gotoMock(...a),
  content: () => contentMock(),
  url: () => 'https://x.test/page',
  evaluate: (...a: unknown[]) => evaluateMock(...(a as [])),
  setViewportSize: (...a: unknown[]) => setViewportSizeMock(...(a as [])),
  screenshot: (...a: unknown[]) => screenshotMock(...(a as [])),
  mainFrame: () => mainFrame,
  waitForSelector: jest.fn(), waitForLoadState: jest.fn(), waitForTimeout: jest.fn(),
};
const browserCloseMock = jest.fn(async () => undefined);
const connectOverCDPMock = jest.fn(async () => ({
  contexts: () => [{ pages: () => [fakePage] }],
  close: () => browserCloseMock(),
  // The pooled connection (browser-sessions/cdp-page.ts) listens for the
  // disconnect and asks whether the browser is still connected before
  // reusing it; a headless fetch never reaches either.
  on: jest.fn(), off: jest.fn(),
  isConnected: () => true,
}));
jest.mock('playwright-core', () => ({
  chromium: { connectOverCDP: (...a: unknown[]) => connectOverCDPMock(...a) },
}));
function navigationResponse(status: number) {
  return {
    status: () => status,
    request: () => ({ isNavigationRequest: () => true, frame: () => mainFrame }),
  };
}

import {
  SteelClient, SteelError, steelFundingOf, steelSessionCostUsd, steelLiveViewUrl,
  createSteelSessionForThread,
} from '../steel-client';
import { PlatformBrowserUnavailable } from '../browser-use-client';
import { ANY_CONNECTOR } from '../credential-scope';
import { _closeCdpPool } from '../../../browser-sessions/cdp-page';

const client = new SteelClient();

// The pane path is pooled per process; each test starts with an empty pool.
afterEach(async () => { await _closeCdpPool(); });

/** A fetch stub answering one request per queued response. */
type Reply = { status: number; body?: unknown };
const replies: Reply[] = [];
const calls: Array<{ url: string; method: string; body?: unknown; key?: string }> = [];
const fetchMock = jest.fn(async (url: string, init: RequestInit) => {
  const headers = init.headers as Record<string, string>;
  calls.push({
    url, method: init.method ?? 'GET',
    body: init.body ? JSON.parse(String(init.body)) : undefined,
    key: headers['steel-api-key'],
  });
  const reply = replies.shift() ?? { status: 200, body: {} };
  return {
    ok: reply.status < 400,
    status: reply.status,
    text: async () => (reply.body === undefined ? '' : JSON.stringify(reply.body)),
  };
});

beforeEach(() => {
  jest.clearAllMocks();
  replies.length = 0;
  calls.length = 0;
  (global as unknown as { fetch: unknown }).fetch = fetchMock;
  getWebToolSecretMock.mockResolvedValue('platform-key');
  poolQueryMock.mockResolvedValue({ rows: [] });
  recordSettledSessionCostMock.mockResolvedValue(undefined);
});

describe('the precedence rule', () => {
  it("uses the workspace's OWN key when it has one", async () => {
    getWebToolCredentialMock.mockResolvedValue({ apiKey: 'tenant-key', connectorId: 'conn-1', extra: {} });
    const cred = await client.resolveCredential('t1');
    expect(cred.apiKey).toBe('tenant-key');
    expect(steelFundingOf(cred)).toBe('tenant_key');
    expect(getWebToolSecretMock).not.toHaveBeenCalled();
  });

  it('falls back to the platform key when nothing is connected', async () => {
    getWebToolCredentialMock.mockRejectedValue(new VendorNotConnected('steel'));
    const cred = await client.resolveCredential('t1');
    expect(cred.apiKey).toBe('platform-key');
    expect(cred.connectorId).toBeNull();
    expect(steelFundingOf(cred)).toBe('platform');
    expect(getWebToolSecretMock).toHaveBeenCalledWith('steel-api-key');
  });

  it('keeps FAILING when the workspace key is cooling, rather than failing over', async () => {
    getWebToolCredentialMock.mockRejectedValue(new VendorConnectorErrored('steel', 'byok_invalid_key'));
    await expect(client.resolveCredential('t1')).rejects.toBeInstanceOf(VendorConnectorErrored);
    expect(getWebToolSecretMock).not.toHaveBeenCalled();
  });
});

describe('what a session cost', () => {
  it('prices duration at the plan rate and proxy egress per GiB', () => {
    // Thirty minutes at $0.10/h plus half a GiB at $10/GiB.
    expect(steelSessionCostUsd({
      id: 's', status: 'released', duration: 30 * 60_000, proxyBytesUsed: 536_870_912,
    })).toBeCloseTo(0.05 + 5, 6);
  });

  it('treats an absent meter as a genuine zero, and an unread session as unknown', () => {
    expect(steelSessionCostUsd({ id: 's', status: 'released' })).toBe(0);
    expect(steelSessionCostUsd(null)).toBeNull();
  });
});

describe('the live view', () => {
  it('asks for the interactive view without the vendor chrome or its interaction gate', () => {
    // Without hideInteractionDialog the player shows "Click to interact /
    // View-only mode active" on hover until the person clicks; the pane has
    // its own take-control flow.
    expect(steelLiveViewUrl('https://app.steel.dev/sessions/abc'))
      .toBe('https://app.steel.dev/sessions/abc?interactive=true&showControls=false&hideInteractionDialog=true');
    expect(steelLiveViewUrl('https://app.steel.dev/sessions/abc?x=1'))
      .toBe('https://app.steel.dev/sessions/abc?x=1&interactive=true&showControls=false&hideInteractionDialog=true');
  });
});

describe('classifying a vendor failure', () => {
  it('maps the status codes the way the BYOK handler expects', () => {
    expect(client.classifyVendorError(new SteelError('x', 401))).toBe('invalid_key');
    expect(client.classifyVendorError(new SteelError('x', 403))).toBe('invalid_key');
    expect(client.classifyVendorError(new SteelError('x', 402))).toBe('insufficient_funds');
    expect(client.classifyVendorError(new SteelError('x', 429))).toBe('rate_limited');
    expect(client.classifyVendorError(new SteelError('x', 503))).toBe('vendor_down');
    expect(client.classifyVendorError(new SteelError('x', 404))).toBeNull();
    expect(client.classifyVendorError(new Error('not ours'))).toBeNull();
  });
});

describe('profiles', () => {
  beforeEach(() => {
    getWebToolCredentialMock.mockRejectedValue(new VendorNotConnected('steel'));
  });

  it('resolves a known profile name from our row without touching the vendor', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [{ vendor_profile_id: 'prof-1' }] });
    await expect(client.ensureProfile('t1', 'team:a')).resolves.toEqual({ id: 'prof-1', name: 'team:a' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers null for a name with no row, and never POSTs /profiles', async () => {
    // POST /v1/profiles is an upload of an existing archive (multipart; a JSON
    // body answers 400), not a way to mint an empty profile. The session mints
    // one with persistProfile instead.
    await expect(client.ensureProfile('t1', 'team:a')).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lists the profiles the vendor still holds, with the id standing in for the name', async () => {
    replies.push({ status: 200, body: { profiles: [
      { id: 'p1', status: 'READY' }, { id: 'p2', status: 'FAILED' },
    ] } });
    await expect(client.listProfiles('t1')).resolves.toEqual([
      { name: 'p1', vendorProfileId: 'p1', cookieDomains: null },
    ]);
  });

  it('forgets a profile, and treats one already gone as forgotten', async () => {
    replies.push({ status: 404, body: { message: 'not found' } });
    // A workspace on its own key: the platform account is tried too.
    getWebToolCredentialMock.mockResolvedValue({ apiKey: 'tenant-key', connectorId: 'conn-1', extra: {} });
    replies.push({ status: 200, body: { success: true } });
    await expect(client.deleteProfile('p1', 't1')).resolves.toBeUndefined();
    expect(calls.map((c) => [c.method, c.key])).toEqual([
      ['DELETE', 'tenant-key'],
      ['DELETE', 'platform-key'],
    ]);
  });

  it('does not treat a vendor outage as a login gone', async () => {
    replies.push({ status: 503, body: { message: 'down' } });
    await expect(client.deleteProfile('p1', 't1')).rejects.toBeInstanceOf(SteelError);
  });
});

describe('a thread session', () => {
  beforeEach(() => {
    getWebToolCredentialMock.mockRejectedValue(new VendorNotConnected('steel'));
  });

  const sessionRow = {
    id: 'row-1', tenant_id: 't1', agent_id: 'a1', thread_id: 'th', invocation_id: null,
    owner_account_id: null, caller_session_id: 'ui:x', vendor: 'steel', vendor_session_id: 'sess-1',
    vendor_metadata: { cdp_url: 'wss://cdp', live_view_url: 'https://view?interactive=true&showControls=false&hideInteractionDialog=true', funding: 'platform' },
    created_at: new Date(), expires_at: new Date(Date.now() + 60_000), closed_at: null,
  };

  it('lets the session mint the profile for a new name, caps the window, and records funding', async () => {
    // No web_profiles row, then the session create (which carries the minted
    // profile id), then the web_sessions insert and the web_profiles upsert.
    poolQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [sessionRow] })
      .mockResolvedValueOnce({ rows: [] });
    replies.push({ status: 200, body: {
      id: 'sess-1', status: 'live', websocketUrl: 'wss://cdp', debugUrl: 'https://view', profileId: 'prof-9',
    } });

    const session = await createSteelSessionForThread({
      tenantId: 't1', agentId: 'a1', threadId: 'th',
      profile: { name: 'team:a1', kind: 'team', ownerAccountId: null } as never,
      idleTimeoutMinutes: 45,
    });

    expect(session.vendor).toBe('steel');
    expect(session.vendorSessionId).toBe('sess-1');
    const create = calls.find((c) => c.url.endsWith('/sessions') && c.method === 'POST');
    expect(create?.body).toMatchObject({ timeout: 15 * 60_000, persistProfile: true });
    expect(create?.body).not.toHaveProperty('profileId');
    const insert = poolQueryMock.mock.calls[1];
    expect(String(insert[0])).toContain('INSERT INTO web_sessions');
    const metadata = JSON.parse(insert[1][7]);
    expect(metadata).toEqual({
      cdp_url: 'wss://cdp',
      live_view_url: 'https://view?interactive=true&showControls=false&hideInteractionDialog=true',
      funding: 'platform',
    });
    const upsert = poolQueryMock.mock.calls[2];
    expect(String(upsert[0])).toContain('INSERT INTO web_profiles');
    // The row follows the vendor: every client reads its id back with
    // vendor = '<self>', so a row left under another vendor's name is one no
    // client can read.
    expect(String(upsert[0])).toMatch(/DO UPDATE SET vendor\s+= EXCLUDED\.vendor/);
    expect(upsert[1]).toEqual(['t1', 'team:a1', 'prof-9', null, 'a1', 'team']);
  });

  it('logs when it takes a profile name another vendor held, and leaves that profile alone', async () => {
    const { logger } = jest.requireMock('../../../infrastructure/logging') as { logger: { info: jest.Mock } };
    poolQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [sessionRow] })
      .mockResolvedValueOnce({ rows: [{ prev_vendor: 'browser_use', prev_id: 'bu-prof-1' }] });
    replies.push({ status: 200, body: {
      id: 'sess-1', status: 'live', websocketUrl: 'wss://cdp', debugUrl: 'https://view', profileId: 'prof-9',
    } });
    await createSteelSessionForThread({
      tenantId: 't1', agentId: 'a1', threadId: 'th',
      profile: { name: 'team:a1', kind: 'team', ownerAccountId: null } as never,
    });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'web_profile_vendor_switched', previous_vendor: 'browser_use', previous_vendor_profile_id: 'bu-prof-1' }),
      expect.any(String),
    );
    // No DELETE went to either vendor.
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });

  it('binds a known profile by id and keeps persisting into it', async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rows: [{ vendor_profile_id: 'prof-known' }] })
      .mockResolvedValueOnce({ rows: [sessionRow] })
      .mockResolvedValueOnce({ rows: [] });
    replies.push({ status: 200, body: {
      id: 'sess-1', status: 'live', websocketUrl: 'wss://cdp', debugUrl: 'https://view', profileId: 'prof-known',
    } });
    await createSteelSessionForThread({
      tenantId: 't1', agentId: 'a1', threadId: 'th',
      profile: { name: 'team:a1', kind: 'team', ownerAccountId: null } as never,
    });
    const create = calls.find((c) => c.url.endsWith('/sessions') && c.method === 'POST');
    expect(create?.body).toMatchObject({ profileId: 'prof-known', persistProfile: true });
  });

  it('re-reads the session once when the create response omits the minted id', async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [sessionRow] })
      .mockResolvedValueOnce({ rows: [] });
    replies.push({ status: 200, body: { id: 'sess-1', status: 'live', websocketUrl: 'wss://cdp', debugUrl: 'https://view' } });
    replies.push({ status: 200, body: { id: 'sess-1', status: 'live', profileId: 'prof-late' } });
    await createSteelSessionForThread({
      tenantId: 't1', agentId: 'a1', threadId: 'th',
      profile: { name: 'team:a1', kind: 'team', ownerAccountId: null } as never,
    });
    expect(calls.map((c) => [c.method, c.url.replace('https://api.steel.dev/v1', '')])).toEqual([
      ['POST', '/sessions'], ['GET', '/sessions/sess-1'],
    ]);
    expect(poolQueryMock.mock.calls[2][1]).toEqual(['t1', 'team:a1', 'prof-late', null, 'a1', 'team']);
  });

  it('surfaces a platform-key spend refusal as PlatformBrowserUnavailable, not retryable', async () => {
    replies.push({ status: 402, body: { message: 'Account is out of credits. Add funds to continue.' } });
    const err = await createSteelSessionForThread({
      tenantId: 't1', agentId: 'a1', threadId: 'th', profile: null,
    }).catch((e: unknown) => e) as PlatformBrowserUnavailable;
    expect(err).toBeInstanceOf(PlatformBrowserUnavailable);
    expect(err.code).toBe('insufficient_funds');
    expect(err.retryable).toBe(false);
  });

  it('releases and settles a session that came back with no browser to drive', async () => {
    replies.push({ status: 200, body: { id: 'sess-2', status: 'live' } });
    replies.push({ status: 200, body: { success: true } });
    replies.push({ status: 200, body: { id: 'sess-2', status: 'released', duration: 1_000 } });

    await expect(createSteelSessionForThread({
      tenantId: 't1', agentId: 'a1', threadId: 'th', profile: null,
    })).rejects.toThrow(/without websocketUrl/);

    expect(calls.map((c) => [c.method, c.url.replace('https://api.steel.dev/v1', '')])).toEqual([
      ['POST', '/sessions'],
      ['POST', '/sessions/sess-2/release'],
      ['GET', '/sessions/sess-2'],
    ]);
    expect(recordSettledSessionCostMock).toHaveBeenCalledWith(expect.objectContaining({
      vendor: 'steel', vendorSessionId: 'sess-2', funding: 'platform',
    }));
    // No row was written for a browser nobody can reach.
    expect(poolQueryMock.mock.calls.some((c) => String(c[0]).includes('INSERT INTO web_sessions'))).toBe(false);
  });
});

describe('closing a session', () => {
  it('releases at the vendor and records the settled cost on the funding that opened it', async () => {
    getWebToolCredentialMock.mockResolvedValue({ apiKey: 'tenant-key', connectorId: 'conn-1', extra: {} });
    replies.push({ status: 200, body: { success: true } });
    replies.push({ status: 200, body: {
      id: 'sess-3', status: 'released', duration: 6 * 60_000, proxyBytesUsed: 0,
      creditsUsed: 1, releaseReason: 'manual', createdAt: '2026-09-17T00:00:00.000Z',
    } });

    await client.closeSession('sess-3', 't1');

    expect(recordSettledSessionCostMock).toHaveBeenCalledWith(expect.objectContaining({
      vendor: 'steel', tenantId: 't1', vendorSessionId: 'sess-3',
      costUsd: expect.closeTo(0.01, 6),
      funding: 'tenant_key',
      settledAt: new Date('2026-09-17T00:06:00.000Z'),
      breakdown: { duration_sec: 360, proxy_bytes: 0, credits_used: 1, release_reason: 'manual' },
    }));
  });

  it('still releases when the vendor cannot be re-read afterwards', async () => {
    getWebToolCredentialMock.mockRejectedValue(new VendorNotConnected('steel'));
    replies.push({ status: 200, body: { success: true } });
    replies.push({ status: 500, body: { message: 'boom' } });
    await client.closeSession('sess-4', 't1');
    expect(recordSettledSessionCostMock).toHaveBeenCalledWith(expect.objectContaining({
      vendorSessionId: 'sess-4', costUsd: null, settledAt: null,
    }));
  });
});

describe('a pane screenshot', () => {
  beforeEach(() => {
    // The stored CDP endpoint answers, so no vendor round trip is needed.
    poolQueryMock.mockResolvedValue({ rows: [{ cdp_url: 'wss://cdp-stored' }] });
    evaluateMock.mockResolvedValue({ width: 1280, height: 800 });
  });

  it('leaves a page with a real viewport alone', async () => {
    await client.fetchScreenshotPng('sess-p', 't1');
    expect(setViewportSizeMock).not.toHaveBeenCalled();
    expect(screenshotMock).toHaveBeenCalledWith({ type: 'png' });
  });

  it('puts a collapsed viewport back at the pane size before rendering from it', async () => {
    // After the interactive live view disconnects on a hand-back, the page can
    // be 0 wide and Page.captureScreenshot refuses.
    evaluateMock.mockResolvedValue({ width: 0, height: 0 });
    await client.fetchScreenshotPng('sess-p', 't1');
    expect(setViewportSizeMock).toHaveBeenCalledWith({ width: 1280, height: 800 });
    expect(screenshotMock).toHaveBeenCalled();
  });

  it('restores the size the pane reported for the session, when it did, instead of the constant', async () => {
    // The stored endpoint and the stored viewport come off the same row.
    poolQueryMock.mockResolvedValue({ rows: [{ cdp_url: 'wss://cdp-stored', viewport: { width: 900, height: 640 } }] });
    evaluateMock.mockResolvedValue({ width: 0, height: 0 });
    await client.fetchScreenshotPng('sess-p', 't1');
    expect(setViewportSizeMock).toHaveBeenCalledWith({ width: 900, height: 640 });
  });

  it('drives the pane over the ONE pooled connection: a second operation on the session connects nothing', async () => {
    await client.fetchScreenshotPng('sess-p', 't1');
    await client.fetchScreenshotPng('sess-p', 't1');
    expect(connectOverCDPMock).toHaveBeenCalledTimes(1);
    expect(connectOverCDPMock).toHaveBeenCalledWith('wss://cdp-stored');
    // The connection outlives the operation: nothing closed it.
    expect(browserCloseMock).not.toHaveBeenCalled();
  });
});

describe('a headless fetch', () => {
  beforeEach(() => {
    getWebToolCredentialMock.mockRejectedValue(new VendorNotConnected('steel'));
    replies.push({ status: 200, body: { id: 'sess-f', status: 'live', websocketUrl: 'wss://cdp', debugUrl: 'https://view' } });
  });

  const request = { url: 'https://x.test/page', tenantId: 't1', credentialScope: ANY_CONNECTOR };

  it('returns the page the origin served, over a session it releases', async () => {
    gotoMock.mockResolvedValue(navigationResponse(200));

    const out = await client.fetch(request);

    expect(out.vendor).toBe('steel');
    expect(out.content).toContain('Hello');
    expect(out.finalUrl).toBe('https://x.test/page');
    expect(calls.some((c) => c.url.endsWith('/sessions/sess-f/release'))).toBe(true);
    expect(browserCloseMock).toHaveBeenCalled();
  });

  it("reports the origin's client status as the browsers' empty answer, never the site's error page as content", async () => {
    gotoMock.mockResolvedValue(navigationResponse(404));

    await expect(client.fetch(request)).rejects.toMatchObject({ name: 'OriginAnsweredForPage', originStatus: 404 });
    expect(contentMock).not.toHaveBeenCalled();
    // The session is still released: a page that is not there bills nothing further.
    expect(calls.some((c) => c.url.endsWith('/sessions/sess-f/release'))).toBe(true);
    expect(browserCloseMock).toHaveBeenCalled();
  });

  it("keeps Chromium's own error, and still releases the session", async () => {
    const chromiums = new Error('page.goto: net::ERR_NAME_NOT_RESOLVED at https://x.test/page');
    gotoMock.mockRejectedValue(chromiums);

    await expect(client.fetch(request)).rejects.toBe(chromiums);
    expect(calls.some((c) => c.url.endsWith('/sessions/sess-f/release'))).toBe(true);
  });
});
