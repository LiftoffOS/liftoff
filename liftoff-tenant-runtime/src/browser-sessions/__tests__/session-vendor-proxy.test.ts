// The pane used to be Anchor-only, so every operation could safely assume its
// vendor. These prove the dispatch actually reaches the right client, and that
// the creation preference is honoured — a wrong-vendor dispatch would fail in
// production as a hung page rather than an error.

const anchorClientMock = {
  listProfiles: jest.fn(), deleteProfile: jest.fn(),
  pauseAgent: jest.fn(), resumeAgent: jest.fn(), gotoUrl: jest.fn(),
  getActivePage: jest.fn().mockResolvedValue({ url: 'https://a.example', title: 'A' }),
  fetchScreenshotPng: jest.fn().mockResolvedValue(Buffer.from('anchor-png')),
  closeSession: jest.fn(),
};
const browserbaseClientMock = {
  listProfiles: jest.fn(), deleteProfile: jest.fn(),
  pauseAgent: jest.fn(), resumeAgent: jest.fn(), gotoUrl: jest.fn(),
  getActivePage: jest.fn().mockResolvedValue({ url: 'https://c.example', title: 'C' }),
  fetchScreenshotPng: jest.fn().mockResolvedValue(Buffer.from('bb-png')),
  closeSession: jest.fn(),
};
const browserUseClientMock = {
  listProfiles: jest.fn(), deleteProfile: jest.fn(),
  pauseAgent: jest.fn(), resumeAgent: jest.fn(), gotoUrl: jest.fn(),
  getActivePage: jest.fn().mockResolvedValue({ url: 'https://b.example', title: 'B' }),
  fetchScreenshotPng: jest.fn().mockResolvedValue(Buffer.from('bu-png')),
  closeSession: jest.fn(),
};
const steelClientMock = {
  listProfiles: jest.fn(), deleteProfile: jest.fn(),
  pauseAgent: jest.fn(), resumeAgent: jest.fn(), gotoUrl: jest.fn(),
  getActivePage: jest.fn().mockResolvedValue({ url: 'https://s.example', title: 'S' }),
  fetchScreenshotPng: jest.fn().mockResolvedValue(Buffer.from('st-png')),
  closeSession: jest.fn(),
  getSessionDetails: jest.fn(),
};
jest.mock('../../tools/standard-tool-handler', () => ({
  anchorClient: anchorClientMock,
  browserUseClient: browserUseClientMock,
  browserbaseClient: browserbaseClientMock,
  steelClient: steelClientMock,
}));

const mockResolveRuntimeAgentId = jest.fn();
jest.mock('../../agent-lifecycle/resolve-runtime-agent-id', () => ({
  resolveRuntimeAgentId: (...a: unknown[]) => mockResolveRuntimeAgentId(...a),
}));

const mockPoolQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  getPool: () => ({ query: (...a: unknown[]) => mockPoolQuery(...a) }),
}));
// The run's session is closed through the repository's closeSession, the one
// writer of closed_at; the reads stay on the real repository over the pool.
const closeSessionRowMock = jest.fn();
const endTakeoverHoldForCloseMock = jest.fn();
jest.mock('../repository', () => ({
  ...jest.requireActual('../repository'),
  closeSession: (...a: unknown[]) => closeSessionRowMock(...a),
  endTakeoverHoldForClose: (...a: unknown[]) => endTakeoverHoldForCloseMock(...a),
}));

const getTenantConnectedWebVendorsMock = jest.fn();
// The platform tier also checks that the platform HOLDS the vendor's key, so
// a mock without getWebToolSecret would fail the gate closed and every
// platform-tier case below would pass for the wrong reason.
const getWebToolSecretMock = jest.fn();
jest.mock('../../integrations/web-fetch/web-tool-secrets', () => ({
  getTenantConnectedWebVendors: (...a: unknown[]) => getTenantConnectedWebVendorsMock(...a),
  getWebToolSecret: (...a: unknown[]) => getWebToolSecretMock(...a),
}));
// The saved-login fill that follows every goto (integrations/onepassword).
const applySavedLoginAfterNavigationMock = jest.fn(async () => 'none');
jest.mock('../../integrations/onepassword/autofill', () => ({
  applySavedLoginAfterNavigation: (...a: unknown[]) => applySavedLoginAfterNavigationMock(...(a as [])),
}));

// The platform's own Browser Use key, which backs a pane when the workspace
// connected nothing. Mocked EXPLICITLY rather than left to fail closed: an
// unmocked flag lookup throws, platformPaneBrowserOn() answers false, and every
// "no vendor" case below would pass for the wrong reason.
const getAllVendorFlagsMock = jest.fn();
const isVendorExcludedForTenantMock = jest.fn();
jest.mock('../../integrations/web-fetch/global-flags', () => ({
  getAllVendorFlags: (...a: unknown[]) => getAllVendorFlagsMock(...a),
  isVendorExcludedForTenant: (...a: unknown[]) => isVendorExcludedForTenantMock(...a),
}));
/** The platform tier's switches. Browser Use alone by default, so the older
 *  cases keep proving the fallback vendor; `steel` turns the first choice on. */
const platformBrowser = (on: boolean, steel = false) =>
  getAllVendorFlagsMock.mockResolvedValue({ browser_use: on, steel });
/** Which platform keys Secret Manager actually holds. */
const platformKeys = (...held: string[]) =>
  getWebToolSecretMock.mockImplementation((name: string) =>
    held.includes(name) ? Promise.resolve('k') : Promise.reject(new Error(`no secret ${name}`)));

const getVendorConcurrencyLimitsMock = jest.fn();
jest.mock('../../integrations/web-fetch/limits-config', () => ({
  getVendorConcurrencyLimits: (...a: unknown[]) => getVendorConcurrencyLimitsMock(...a),
}));
/** How many browsers the vendor's plan allows at once. */
const ceiling = (n: number) =>
  getVendorConcurrencyLimitsMock.mockResolvedValue({ maxConcurrentGlobal: n });
/** How many the count query finds already open. */
const openSessions = (n: number) =>
  mockPoolQuery.mockResolvedValue({ rows: [{ n: String(n) }] });
/** The per-workspace kill-switch, which is the second half of the platform
 *  gate. Mocked separately because an operator reaches for whichever switch
 *  matches the blast radius, and the two must be independently testable. */
const excludedForTenant = (excluded: boolean) =>
  isVendorExcludedForTenantMock.mockResolvedValue(excluded);

const createAnchorMock = jest.fn().mockResolvedValue({ id: 'a1', vendor: 'anchor' });
jest.mock('../../integrations/web-fetch/anchor-client', () => ({
  createAnchorSessionForThread: (...a: unknown[]) => createAnchorMock(...a),
}));
const createBrowserbaseMock = jest.fn().mockResolvedValue({ id: 'c1', vendor: 'browserbase' });
jest.mock('../../integrations/web-fetch/browserbase-client', () => ({
  createBrowserbaseSessionForThread: (...a: unknown[]) => createBrowserbaseMock(...a),
}));
const createBrowserUseMock = jest.fn().mockResolvedValue({ id: 'b1', vendor: 'browser_use' });
jest.mock('../../integrations/web-fetch/browser-use-client', () => ({
  createBrowserUseSessionForThread: (...a: unknown[]) => createBrowserUseMock(...a),
  // The real class: the proxy's platform fallback dispatches on instanceof.
  PlatformBrowserUnavailable: jest.requireActual('../../integrations/web-fetch/browser-use-client').PlatformBrowserUnavailable,
}));
const createSteelMock = jest.fn().mockResolvedValue({ id: 's1', vendor: 'steel' });
jest.mock('../../integrations/web-fetch/steel-client', () => ({
  createSteelSessionForThread: (...a: unknown[]) => createSteelMock(...a),
}));

const closeExpiredSessionMock = jest.fn().mockResolvedValue({ outcome: 'closed', byokUnreachable: false });
jest.mock('../../integrations/web-fetch/session-reaper', () => ({
  closeExpiredSession: (...a: unknown[]) => closeExpiredSessionMock(...a),
}));

import * as proxy from '../session-vendor-proxy';
import { NO_AGENT_SENTINEL } from '../types';
import { _resetPlatformKeyCache } from '../session-vendor-connectors';
import { PlatformBrowserUnavailable } from '../../integrations/web-fetch/browser-use-client';

beforeEach(() => {
  jest.clearAllMocks();
  _resetPlatformKeyCache();
  platformKeys('steel-api-key', 'browser-use-api-key');
  // Default: no active compiled instruction, i.e. "no opinion on bindings", so
  // the older cases keep exercising tenant-level selection on its own.
  mockPoolQuery.mockResolvedValue({ rows: [] });
  // Default: no mapping row, so the resolver returns the input unchanged.
  mockResolveRuntimeAgentId.mockImplementation((_t: string, id: string) => Promise.resolve(id));
  // Default: the platform tier is on, which is the shipped default
  // (web_fetch_vendor_browser_use defaults enabled) and no workspace-level
  // exclusion is set.
  platformBrowser(true);
  excludedForTenant(false);
  // No open sessions, so the concurrency ceiling never bites in these cases.
  mockPoolQuery.mockResolvedValue({ rows: [] });
  ceiling(10);
});

describe('pane operation dispatch', () => {
  it('routes an anchor session to the Anchor client', async () => {
    await proxy.gotoUrl('anchor', 'vs1', 't1', 'https://x.example');
    expect(anchorClientMock.gotoUrl).toHaveBeenCalledWith('vs1', 't1', 'https://x.example');
    expect(browserUseClientMock.gotoUrl).not.toHaveBeenCalled();
  });

  it('routes a browser_use session to the Browser Use client', async () => {
    await proxy.gotoUrl('browser_use', 'vs2', 't1', 'https://y.example');
    expect(browserUseClientMock.gotoUrl).toHaveBeenCalledWith('vs2', 't1', 'https://y.example');
    expect(anchorClientMock.gotoUrl).not.toHaveBeenCalled();
  });

  it('every goto is followed, on every vendor, by the saved-login fill on that session, awaited after the vendor\'s own goto', async () => {
    for (const [vendor, client] of [['anchor', anchorClientMock], ['browser_use', browserUseClientMock], ['browserbase', browserbaseClientMock], ['steel', steelClientMock]] as const) {
      applySavedLoginAfterNavigationMock.mockClear();
      client.gotoUrl.mockClear();
      await proxy.gotoUrl(vendor, `vs-${vendor}`, 't1', 'https://z.example/login');
      expect(applySavedLoginAfterNavigationMock).toHaveBeenCalledTimes(1);
      expect(applySavedLoginAfterNavigationMock).toHaveBeenCalledWith(vendor, `vs-${vendor}`, 't1');
      expect(client.gotoUrl.mock.invocationCallOrder[0]).toBeLessThan(applySavedLoginAfterNavigationMock.mock.invocationCallOrder[0]);
    }
  });

  it('a goto the vendor refused fills nothing', async () => {
    steelClientMock.gotoUrl.mockRejectedValueOnce(new Error('session gone'));
    await expect(proxy.gotoUrl('steel', 'vs-steel', 't1', 'https://z.example/')).rejects.toThrow('session gone');
    expect(applySavedLoginAfterNavigationMock).not.toHaveBeenCalled();
  });

  it('reads page state and screenshots from the owning vendor', async () => {
    await expect(proxy.getActivePage('browser_use', 'vs2', 't1'))
      .resolves.toEqual({ url: 'https://b.example', title: 'B' });
    await expect(proxy.fetchScreenshotPng('anchor', 'vs1', 't1'))
      .resolves.toEqual(Buffer.from('anchor-png'));
  });

  it('routes a browserbase session to the Browserbase client', async () => {
    await proxy.gotoUrl('browserbase', 'vs3', 't1', 'https://z.example');
    expect(browserbaseClientMock.gotoUrl).toHaveBeenCalledWith('vs3', 't1', 'https://z.example');
  });

  it('throws on an unregistered vendor rather than silently doing nothing', async () => {
    // A no-op here would surface as a browser that accepted a command and
    // ignored it, which reads as a hung page rather than a bug.
    await expect(proxy.gotoUrl('webclaw', 'vs4', 't1', 'https://z.example'))
      .rejects.toThrow(/no pane operations registered/);
  });
});

describe('session vendor selection', () => {
  const connected = (...v: string[]) => getTenantConnectedWebVendorsMock.mockResolvedValue(new Set(v));

  it('prefers Anchor when the tenant has both', async () => {
    connected('anchor_browser', 'browser_use');
    await expect(proxy.selectSessionVendor('t1')).resolves.toBe('anchor');
    await proxy.createSessionForThread({ tenantId: 't1', agentId: 'a', threadId: 'th' });
    expect(createAnchorMock).toHaveBeenCalled();
    expect(createBrowserUseMock).not.toHaveBeenCalled();
  });

  it('falls to Browser Use when Anchor is not connected', async () => {
    connected('browser_use');
    await expect(proxy.selectSessionVendor('t1')).resolves.toBe('browser_use');
    await proxy.createSessionForThread({ tenantId: 't1', agentId: 'a', threadId: 'th' });
    expect(createBrowserUseMock).toHaveBeenCalled();
    expect(createAnchorMock).not.toHaveBeenCalled();
  });

  it('picks browserbase now that it can drive a pane', async () => {
    // It declared supportsSessions() true for a long time while implementing
    // one of the ten pane operations, so selecting it would have handed a
    // thread to a browser that accepted commands and did nothing.
    connected('browserbase');
    platformBrowser(false);
    await expect(proxy.selectSessionVendor('t1')).resolves.toBe('browserbase');
    await proxy.createSessionForThread({ tenantId: 't1', agentId: 'a', threadId: 'th' });
    expect(createBrowserbaseMock).toHaveBeenCalled();
  });

  it('prefers a browserbase connector over the platform browser', async () => {
    // The charging rule made structural: a workspace paying Browserbase must
    // not also be billed for hours on our Browser Use key.
    connected('browserbase');
    await expect(proxy.selectSessionVendor('t1')).resolves.toBe('browserbase');
  });

  it('refuses to create only when the platform tier is off too', async () => {
    connected();
    platformBrowser(false);
    await expect(proxy.createSessionForThread({ tenantId: 't1', agentId: 'a', threadId: 'th' }))
      .rejects.toThrow(/no browser vendor is available/);
  });
});

describe('the platform key backs a browser nobody connected', () => {
  const connected = (...v: string[]) => getTenantConnectedWebVendorsMock.mockResolvedValue(new Set(v));

  it('gives a workspace with no connectors at all a Browser Use session', async () => {
    // The whole point: a browser is a product default, not something a
    // workspace has to buy before an agent can navigate.
    connected();
    await expect(proxy.selectSessionVendor('t1')).resolves.toBe('browser_use');
    await proxy.createSessionForThread({ tenantId: 't1', agentId: 'a', threadId: 'th' });
    expect(createBrowserUseMock).toHaveBeenCalled();
  });

  it('reaches an agent bound to no browser connector', async () => {
    // Binding scopes what the WORKSPACE brought. A platform-backed capability
    // is not something the agent was equipped with, so binding cannot gate it,
    // exactly as it does not gate web_research.
    connected();
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ integrations: [{ id: 'gmail-1', type: 'gmail' }] }],
    });
    await expect(proxy.selectSessionVendor('t1', 'agent-1')).resolves.toBe('browser_use');
  });

  it("keeps a workspace's OWN connector ahead of the platform key", async () => {
    // The charging rule made structural. A workspace that connected Anchor has
    // already paid Anchor; handing it our Browser Use key would bill it twice.
    connected('anchor_browser');
    await expect(proxy.selectSessionVendor('t1')).resolves.toBe('anchor');
  });

  it('gives no browser when the operator kill-switch is down', async () => {
    connected();
    platformBrowser(false);
    await expect(proxy.selectSessionVendor('t1')).resolves.toBeNull();
  });

  it('gives no browser to a workspace an operator excluded', async () => {
    // The per-workspace switch, which every other vendor path already respects
    // through isVendorExcludedForTenant. A gate that read only the global flag
    // kept handing a browser to the one workspace just switched off.
    connected();
    excludedForTenant(true);
    await expect(proxy.selectSessionVendor('t1')).resolves.toBeNull();
  });
});

// Sign-in that persists: a team's pane session and its run-owned session
// bind the SAME profile, so a login the person completed in the team's pane
// is what the team's unattended run is signed in as. One assertion pins it,
// because a profile name spelled two ways is two profiles and a run signed
// in as nobody.
describe('one profile per team, pane and run alike', () => {
  const connected = (...v: string[]) => getTenantConnectedWebVendorsMock.mockResolvedValue(new Set(v));

  it('createSessionForRun and createSessionForThread for one team pass the same profile.name to the spawn', async () => {
    connected();
    platformBrowser(true, true);
    const agentId = '11111111-1111-4111-8111-111111111111';
    await proxy.createSessionForThread({ tenantId: 't1', agentId, threadId: 'th', ownerAccountId: 'acc-1' });
    await proxy.createSessionForRun({ tenantId: 't1', agentId, invocationId: 'inv-1' });
    expect(createSteelMock).toHaveBeenCalledTimes(2);
    const [paneArgs, runArgs] = createSteelMock.mock.calls.map((c) => c[0] as { profile: { name: string } | null; threadId: string | null; invocationId?: string | null });
    expect(paneArgs.profile?.name).toBeTruthy();
    expect(runArgs.profile?.name).toBe(paneArgs.profile?.name);
    expect(paneArgs.threadId).toBe('th');
    expect(runArgs.threadId).toBeNull();
    expect(runArgs.invocationId).toBe('inv-1');
  });
});

describe('Steel is the platform browser, Browser Use the fallback', () => {
  const connected = (...v: string[]) => getTenantConnectedWebVendorsMock.mockResolvedValue(new Set(v));

  it('backs a workspace with no connectors with Steel when it is on', async () => {
    connected();
    platformBrowser(true, true);
    await expect(proxy.selectSessionVendor('t1')).resolves.toBe('steel');
    await proxy.createSessionForThread({ tenantId: 't1', agentId: 'a', threadId: 'th' });
    expect(createSteelMock).toHaveBeenCalled();
    expect(createBrowserUseMock).not.toHaveBeenCalled();
  });

  it('falls to Browser Use when the Steel kill-switch is down', async () => {
    connected();
    platformBrowser(true, false);
    await expect(proxy.selectSessionVendor('t1')).resolves.toBe('browser_use');
  });

  it('falls to Browser Use when this runtime holds no Steel key', async () => {
    // A dedicated runtime whose service account was never granted the secret
    // must degrade to the vendor it can reach, not offer a pane whose spawn
    // fails on a missing credential.
    connected();
    platformBrowser(true, true);
    platformKeys('browser-use-api-key');
    await expect(proxy.selectSessionVendor('t1')).resolves.toBe('browser_use');
  });

  it('falls to Browser Use for a workspace excluded from Steel alone', async () => {
    connected();
    platformBrowser(true, true);
    isVendorExcludedForTenantMock.mockImplementation((_t: string, v: string) =>
      Promise.resolve(v === 'steel'));
    await expect(proxy.selectSessionVendor('t1')).resolves.toBe('browser_use');
  });

  it("prefers a workspace's OWN Steel connector over the platform key", async () => {
    // Same charging rule: a workspace paying Steel directly must not be billed
    // Operating Units for hours on our key.
    connected('steel');
    platformBrowser(true, true);
    await expect(proxy.selectSessionVendor('t1')).resolves.toBe('steel');
    await proxy.createSessionForThread({ tenantId: 't1', agentId: 'a', threadId: 'th' });
    expect(createSteelMock).toHaveBeenCalled();
  });

  it('keeps Anchor and Browserbase ahead of a Steel connector', async () => {
    connected('browserbase', 'steel');
    await expect(proxy.selectSessionVendor('t1')).resolves.toBe('browserbase');
  });

  it('falls to Browser Use when the platform Steel account refuses the spawn', async () => {
    // The whole reason the platform holds two keys. A 402 on ours (the
    // account out of credit) is PlatformBrowserUnavailable; the next platform
    // vendor takes the spawn, and Steel is left alone for a while so the
    // refused call is not paid for on every spawn in between.
    connected();
    platformBrowser(true, true);
    createSteelMock.mockRejectedValueOnce(new PlatformBrowserUnavailable('insufficient_funds', false, 'out of credit'));
    const session = await proxy.createSessionForThread({ tenantId: 't1', agentId: 'a', threadId: 'th' });
    expect(session.vendor).toBe('browser_use');
    expect(createSteelMock).toHaveBeenCalledTimes(1);
    expect(createBrowserUseMock).toHaveBeenCalledTimes(1);
    // Memoised: the next selection skips Steel without asking it again.
    await expect(proxy.selectSessionVendor('t1')).resolves.toBe('browser_use');
  });

  it('does not move a workspace off its OWN refused Steel key onto ours', async () => {
    // Its account, its problem to fix; failing over would hide that and start
    // charging it Operating Units for a browser it is already paying for.
    connected('steel');
    platformBrowser(true, true);
    createSteelMock.mockRejectedValueOnce(new PlatformBrowserUnavailable('insufficient_funds', false, 'out of credit'));
    await expect(proxy.createSessionForThread({ tenantId: 't1', agentId: 'a', threadId: 'th' }))
      .rejects.toBeInstanceOf(PlatformBrowserUnavailable);
    expect(createBrowserUseMock).not.toHaveBeenCalled();
  });

  it('gives up when every platform vendor refuses', async () => {
    connected();
    platformBrowser(true, true);
    createSteelMock.mockRejectedValueOnce(new PlatformBrowserUnavailable('insufficient_funds', false, 'steel'));
    createBrowserUseMock.mockRejectedValueOnce(new PlatformBrowserUnavailable('insufficient_funds', false, 'bu'));
    await expect(proxy.createSessionForThread({ tenantId: 't1', agentId: 'a', threadId: 'th' }))
      .rejects.toThrow('bu');
  });

  it('routes a steel session to the Steel client', async () => {
    await proxy.gotoUrl('steel', 'vs5', 't1', 'https://s.example');
    expect(steelClientMock.gotoUrl).toHaveBeenCalledWith('vs5', 't1', 'https://s.example');
    await proxy.closeSession('steel', 'vs5', 't1');
    expect(steelClientMock.closeSession).toHaveBeenCalledWith('vs5', 't1');
  });

  it('lists and forgets Steel profiles', async () => {
    steelClientMock.listProfiles.mockResolvedValueOnce([
      { name: 'prof-1', vendorProfileId: 'prof-1', cookieDomains: null },
    ]);
    await expect(proxy.listProfiles('steel', 't1')).resolves.toEqual([
      { name: 'prof-1', vendorProfileId: 'prof-1', cookieDomains: null },
    ]);
    await proxy.deleteProfile('steel', 'prof-1', 't1');
    expect(steelClientMock.deleteProfile).toHaveBeenCalledWith('prof-1', 't1');
    expect(proxy.PROFILE_VENDORS).toContain('steel');
  });
});

describe('stored profiles (the saved logins behind "stay signed in")', () => {
  it('normalises Anchor, whose reuse key is the NAME not an id', async () => {
    anchorClientMock.listProfiles.mockResolvedValueOnce([{ name: 'p1', description: null }]);
    await expect(proxy.listProfiles('anchor', 't1')).resolves.toEqual([
      { name: 'p1', vendorProfileId: 'p1', cookieDomains: null },
    ]);
  });

  it('passes Browser Use through, keeping the domains it reports', async () => {
    // cookieDomains has no Anchor equivalent, so a person can see WHICH logins
    // a profile holds rather than only that it exists.
    browserUseClientMock.listProfiles.mockResolvedValueOnce([
      { name: 'p2', vendorProfileId: 'uuid-2', cookieDomains: ['github.com'] },
    ]);
    await expect(proxy.listProfiles('browser_use', 't1')).resolves.toEqual([
      { name: 'p2', vendorProfileId: 'uuid-2', cookieDomains: ['github.com'] },
    ]);
  });

  it('passes Browserbase through, which keys its contexts by id alone', async () => {
    browserbaseClientMock.listProfiles.mockResolvedValueOnce([
      { name: 'p3', vendorProfileId: 'ctx-3', cookieDomains: null },
    ]);
    await expect(proxy.listProfiles('browserbase', 't1')).resolves.toEqual([
      { name: 'p3', vendorProfileId: 'ctx-3', cookieDomains: null },
    ]);
  });

  it('THROWS on an unknown vendor rather than reporting an empty profile list', async () => {
    // This is the sharp edge. The caller uses the returned list to FILTER which
    // saved logins it shows, so an empty array for a vendor we cannot ask would
    // read as "this vendor holds nothing" and hide every login the person has.
    // Throwing makes the caller degrade OPEN, which is its stated contract.
    await expect(proxy.listProfiles('webclaw', 't1')).rejects.toThrow(/cannot list profiles/);
  });

  it('sends a delete to the vendor that actually owns the profile', async () => {
    await proxy.deleteProfile('browser_use', 'uuid-2', 't1');
    expect(browserUseClientMock.deleteProfile).toHaveBeenCalledWith('uuid-2', 't1');
    expect(anchorClientMock.deleteProfile).not.toHaveBeenCalled();
  });

  it('refuses to delete for a vendor it cannot address', async () => {
    await expect(proxy.deleteProfile('webclaw', 'x', 't1')).rejects.toThrow(/cannot delete a profile/);
  });
});

describe('vendor selection respects what the AGENT is bound to', () => {
  const boundTo = (...types: string[]) =>
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ integrations: types.map((t) => ({ id: `${t}-1`, type: t })) }],
    })

  it('picks Browser Use for an agent bound to it, even when the tenant also has Anchor', async () => {
    // The reported bug. The workspace had BOTH connected, so tenant-only
    // selection handed an Anchor session to an agent distilled for Browser Use,
    // and the preference order made Anchor win every time.
    getTenantConnectedWebVendorsMock.mockResolvedValue(new Set(['anchor_browser', 'browser_use']))
    boundTo('browser_use')
    await expect(proxy.selectSessionVendor('t1', 'agent-1')).resolves.toBe('browser_use')
  })

  it('still prefers Anchor when the agent is bound to both', async () => {
    getTenantConnectedWebVendorsMock.mockResolvedValue(new Set(['anchor_browser', 'browser_use']))
    boundTo('anchor_browser', 'browser_use')
    await expect(proxy.selectSessionVendor('t1', 'agent-1')).resolves.toBe('anchor')
  })

  it("gives no vendor from the workspace's own set when the binding and the connector disagree", async () => {
    // Anchor is connected but this agent is not bound to it, and the connector
    // it IS bound to has no credential, so neither of the workspace's own
    // vendors qualifies. The platform tier is off here so the assertion is
    // about that rule alone.
    getTenantConnectedWebVendorsMock.mockResolvedValue(new Set(['anchor_browser']))
    platformBrowser(false)
    boundTo('browser_use')
    await expect(proxy.selectSessionVendor('t1', 'agent-1')).resolves.toBeNull()
  })

  it('falls back to tenant-level when there is no active compiled instruction', async () => {
    // No rows means "no opinion", not "bound to nothing" — an agent mid-compile
    // must not lose its browser.
    getTenantConnectedWebVendorsMock.mockResolvedValue(new Set(['anchor_browser']))
    mockPoolQuery.mockResolvedValueOnce({ rows: [] })
    await expect(proxy.selectSessionVendor('t1', 'agent-1')).resolves.toBe('anchor')
  })
})

describe('agent id spaces (INV-8 / ADR-039)', () => {
  it('translates a control-plane id before reading bindings', async () => {
    // The pane's ensure RPC passes internal_agents.id straight from the
    // frontend, but compiled_instructions is keyed by the RUNTIME agents.id.
    // Querying the wrong space matches zero rows and raises nothing, which
    // read as "no bindings" and silently handed the agent an Anchor session.
    mockResolveRuntimeAgentId.mockResolvedValueOnce('runtime-agent-1')
    getTenantConnectedWebVendorsMock.mockResolvedValue(new Set(['anchor_browser', 'browser_use']))
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ integrations: [{ id: 'x', type: 'browser_use' }] }],
    })

    await expect(proxy.selectSessionVendor('t1', 'internal-agent-1')).resolves.toBe('browser_use')

    expect(mockResolveRuntimeAgentId).toHaveBeenCalledWith('t1', 'internal-agent-1', 'boundWebVendorConnectors')
    // The DB must be queried with the TRANSLATED id, never the one passed in.
    expect(mockPoolQuery).toHaveBeenCalledWith(expect.any(String), ['t1', 'runtime-agent-1'])
  })
})

describe("the vendor plan's concurrent-browser ceiling", () => {
  const connected = (...v: string[]) => getTenantConnectedWebVendorsMock.mockResolvedValue(new Set(v));

  it('refuses a spawn once every browser on the plan is open', async () => {
    // Pane spawns took no slot at ALL before this: the web-fetch admission pool
    // is built for in-flight requests with a five-minute TTL, and a pane session
    // outlives that and is released by another process. So the plan ceiling was
    // enforced by nothing until the vendor started answering 429.
    connected();
    ceiling(10);
    openSessions(10);
    await expect(proxy.createSessionForThread({ tenantId: 't1', agentId: 'a', threadId: 'th' }))
      .rejects.toThrow(proxy.SessionVendorAtCapacity);
    expect(createBrowserUseMock).not.toHaveBeenCalled();
  });

  it('allows a spawn while a slot is free', async () => {
    connected();
    ceiling(10);
    openSessions(9);
    await proxy.createSessionForThread({ tenantId: 't1', agentId: 'a', threadId: 'th' });
    expect(createBrowserUseMock).toHaveBeenCalled();
  });

  it('counts EVERY tenant when the platform key is paying', async () => {
    // One shared account, so a per-tenant count would let ten workspaces each
    // believe they had ten browsers.
    connected();
    openSessions(0);
    await proxy.createSessionForThread({ tenantId: 't1', agentId: 'a', threadId: 'th' });
    const countCall = mockPoolQuery.mock.calls.find(
      (c) => String(c[0]).includes('COUNT(*)') && String(c[0]).includes('web_sessions'),
    );
    expect(countCall).toBeDefined();
    expect(String(countCall![0])).not.toContain('tenant_id = $2');
    expect(countCall![1]).toEqual(['browser_use']);
  });

  it("counts only the workspace's OWN sessions when it brought the key", async () => {
    // Their account, their ceiling: a busy neighbour must not spend slots the
    // workspace is paying for.
    connected('browser_use');
    openSessions(0);
    await proxy.createSessionForThread({ tenantId: 't1', agentId: 'a', threadId: 'th' });
    const countCall = mockPoolQuery.mock.calls.find(
      (c) => String(c[0]).includes('COUNT(*)') && String(c[0]).includes('web_sessions'),
    );
    expect(String(countCall![0])).toContain('tenant_id = $2');
    expect(countCall![1]).toEqual(['browser_use', 't1']);
  });

  it('ignores rows the vendor has already timed out', async () => {
    // An expired-but-unreaped row is a slot the vendor freed on its side.
    // Counting it would refuse spawns against browsers that no longer exist.
    connected();
    openSessions(0);
    await proxy.createSessionForThread({ tenantId: 't1', agentId: 'a', threadId: 'th' });
    const countCall = mockPoolQuery.mock.calls.find(
      (c) => String(c[0]).includes('COUNT(*)') && String(c[0]).includes('web_sessions'),
    );
    expect(String(countCall![0])).toContain('expires_at > now()');
    expect(String(countCall![0])).toContain('closed_at IS NULL');
  });
});

it('checks EVERY pane vendor against its plan ceiling, not just the shared one', () => {
  // It matters most on the platform key, where one vendor plan is shared
  // across every workspace in the runtime. But a pane session takes no slot in
  // the web-fetch admission pool for ANY vendor, so the ceiling was enforced by
  // nothing anywhere until the vendor started refusing.
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'session-vendor-proxy.ts'), 'utf8',
  );
  expect(src).toMatch(/PLATFORM_SESSION_VENDORS: ReadonlySet<WebVendor> = new Set<WebVendor>\(\['steel', 'browser_use'\]\)/);
  expect(src).toMatch(/CAPACITY_CHECKED_VENDORS = new Set<WebVendor>\(\[\s*'anchor', 'browserbase', \.\.\.PLATFORM_SESSION_VENDORS,?\s*\]\)/);
  expect(src).toMatch(/CAPACITY_CHECKED_VENDORS\.has\(vendor\)/);
});

/** A platform assistant — Liftoff, the Insights Manager, the Chief AI Officer —
 *  has no agent row anywhere, and three different callers spell that three
 *  different ways.
 *
 *  This is the bug these exist for: the RPC path sent '' (proto3's default for
 *  an unset string) straight through to a UUID NOT NULL column, and every
 *  platform-assistant session died on `invalid input syntax for type uuid: ""`.
 *  The normalization had been written into runBrowserTaskCore and nowhere else,
 *  so the tool path worked and the ensure path — the one the pane button uses —
 *  did not. Pinned at the choke point, because that is the only place all eight
 *  callers pass through. */
describe('a spawn with no agent', () => {
  const connected = (...v: string[]) => getTenantConnectedWebVendorsMock.mockResolvedValue(new Set(v));

  it.each([
    ['an empty string, as a Connect-RPC caller sends it', ''],
    ['undefined, as an in-process caller sends it', undefined],
  ])('writes the nil sentinel when the agent is %s', async (_label, agentId) => {
    connected();
    await proxy.createSessionForThread({
      tenantId: 't1', threadId: 'th',
      ...(agentId === undefined ? {} : { agentId }),
    });

    // The row carries a real UUID. Anything else is a Postgres type error, not
    // a soft failure: the spawn dies and the person is told the browser is
    // unavailable.
    expect(createBrowserUseMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: NO_AGENT_SENTINEL }),
    );
  });

  it('does not go looking for the sentinel\'s bindings', async () => {
    // Selection must read an absent agent as "no opinion about connectors".
    // Resolving the sentinel would log a mapping miss that never happened, and
    // — worse — reading it as "bound to nothing" would skip a workspace's own
    // browser key and bill them a second time for a browser they already fund.
    connected();
    await proxy.createSessionForThread({ tenantId: 't1', threadId: 'th', agentId: '' });

    expect(mockResolveRuntimeAgentId).not.toHaveBeenCalled();
  });

  it('still lets the workspace\'s own connector win', async () => {
    // The charging rule, made structural. A workspace paying Anchor directly
    // must get its Anchor session even though the caller named no agent.
    connected('anchor_browser');
    await proxy.createSessionForThread({ tenantId: 't1', threadId: 'th', agentId: '' });

    expect(createAnchorMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: NO_AGENT_SENTINEL }),
    );
    expect(createBrowserUseMock).not.toHaveBeenCalled();
  });
});

// ── A team's browser is the team's ──────────────────────────────────────────
//
// Whose logins a session carries is decided once, in the proxy, for every
// vendor: a team agent's browser binds the team's own profile — in its pane
// with a person and on its own in a run — and a platform assistant's binds
// the person's. The vendor clients record what they are handed.
describe('whose logins a session carries', () => {
  const connected = (...v: string[]) => getTenantConnectedWebVendorsMock.mockResolvedValue(new Set(v));
  const TEAM = '11111111-1111-4111-8111-111111111111';

  it("a team agent's pane binds the team's profile, whoever opened it", async () => {
    connected();
    await proxy.createSessionForThread({ tenantId: 't1', agentId: TEAM, threadId: 'th', ownerAccountId: 'acc-1' });
    const args = createBrowserUseMock.mock.calls[0][0] as { profile: unknown; ownerAccountId?: string; threadId: string };
    expect(args.profile).toEqual({ name: `liftoff-t1-${TEAM}-team`, kind: 'team', ownerAccountId: null });
    // The person still owns the SESSION: they drive this pane.
    expect(args.ownerAccountId).toBe('acc-1');
    expect(args.threadId).toBe('th');
  });

  it("a pane opened with the control-plane id binds the SAME profile a run opens with the runtime id", async () => {
    // The login store is keyed by the agent, and the two entry points arrive
    // with the agent's two ids. Named by whichever arrived, the sign-in a
    // person completed in the pane sat in one profile while every run opened
    // another.
    connected();
    const INTERNAL = '1cab3621-70ff-467f-b834-9149e1855198';
    mockResolveRuntimeAgentId.mockImplementation((_t: string, id: string) => Promise.resolve(id === INTERNAL ? TEAM : id));
    await proxy.createSessionForThread({ tenantId: 't1', agentId: INTERNAL, threadId: 'th', ownerAccountId: 'acc-1' });
    await proxy.createSessionForRun({ tenantId: 't1', agentId: TEAM, invocationId: '22222222-2222-4222-8222-222222222222' });
    const pane = createBrowserUseMock.mock.calls[0][0] as { profile: { name: string }; agentId: string };
    const run = createBrowserUseMock.mock.calls[1][0] as { profile: { name: string } };
    expect(pane.profile.name).toBe(`liftoff-t1-${TEAM}-team`);
    expect(run.profile.name).toBe(pane.profile.name);
    // The session row too, so the takeover gate a tool call checks under the
    // runtime id finds the pane's row.
    expect(pane.agentId).toBe(TEAM);
    expect(mockResolveRuntimeAgentId).toHaveBeenCalledWith('t1', INTERNAL, 'createSessionForThread');
  });

  it("a platform assistant's pane binds the workspace's profile for that assistant, whoever opened it", async () => {
    connected();
    await proxy.createSessionForThread({ tenantId: 't1', threadId: 'th', ownerAccountId: 'acc-1', assistant: 'liftoff' });
    await proxy.createSessionForThread({ tenantId: 't1', threadId: 'th2', ownerAccountId: 'acc-2', assistant: 'liftoff' });
    const first = createBrowserUseMock.mock.calls[0][0] as { profile: unknown; ownerAccountId?: string };
    const second = createBrowserUseMock.mock.calls[1][0] as { profile: unknown };
    expect(first.profile).toEqual({ name: 'liftoff-t1-liftoff-workspace', kind: 'assistant', ownerAccountId: null });
    expect(second.profile).toEqual(first.profile);
    // The person still owns the SESSION they opened.
    expect(first.ownerAccountId).toBe('acc-1');
  });

  it('a caller naming no team and no assistant gets an ephemeral browser', async () => {
    connected();
    await proxy.createSessionForThread({ tenantId: 't1', threadId: 'th' });
    const args = createBrowserUseMock.mock.calls[0][0] as { profile: unknown };
    expect(args.profile).toBeNull();
  });
});

// ── A run may own a browser for its lifetime ────────────────────────────────
describe('createSessionForRun', () => {
  const connected = (...v: string[]) => getTenantConnectedWebVendorsMock.mockResolvedValue(new Set(v));
  const TEAM = '11111111-1111-4111-8111-111111111111';
  const INV = '22222222-2222-4222-8222-222222222222';

  it("opens the team's browser keyed by the run, with no thread and no person", async () => {
    connected();
    await proxy.createSessionForRun({ tenantId: 't1', agentId: TEAM, invocationId: INV, idleTimeoutMinutes: 10 });
    expect(createBrowserUseMock).toHaveBeenCalledTimes(1);
    const args = createBrowserUseMock.mock.calls[0][0] as Record<string, unknown>;
    expect(args).toMatchObject({
      tenantId: 't1', agentId: TEAM, threadId: null, invocationId: INV, idleTimeoutMinutes: 10,
      profile: { name: `liftoff-t1-${TEAM}-team`, kind: 'team', ownerAccountId: null },
    });
    expect(args.ownerAccountId).toBeUndefined();
  });

  it('uses the same vendor selection a pane does: the workspace\'s own connector first', async () => {
    connected('anchor_browser');
    await proxy.createSessionForRun({ tenantId: 't1', agentId: TEAM, invocationId: INV });
    expect(createAnchorMock).toHaveBeenCalledTimes(1);
    expect(createBrowserUseMock).not.toHaveBeenCalled();
  });

  it('refuses a run with no team: there is nothing for the browser to belong to', async () => {
    connected();
    await expect(proxy.createSessionForRun({ tenantId: 't1', agentId: NO_AGENT_SENTINEL, invocationId: INV }))
      .rejects.toThrow(/needs the team/);
    expect(createBrowserUseMock).not.toHaveBeenCalled();
  });

  it('refuses when no vendor serves the workspace, like a pane', async () => {
    connected();
    platformBrowser(false);
    await expect(proxy.createSessionForRun({ tenantId: 't1', agentId: TEAM, invocationId: INV }))
      .rejects.toBeInstanceOf(proxy.NoSessionVendorConnected);
  });
});

describe('closeActiveForInvocation', () => {
  const INV = '22222222-2222-4222-8222-222222222222';

  it("closes the run's session at the vendor and marks it run_ended through the one writer", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{
        id: 's1', tenant_id: 't1', agent_id: 'a', thread_id: null, invocation_id: INV,
        vendor: 'browser_use', vendor_session_id: 'bu-1', vendor_metadata: {},
        created_at: new Date(), closed_at: null,
      }] });   // getActiveForInvocation
    closeSessionRowMock.mockResolvedValueOnce({ id: 's1', closedAt: new Date() });
    endTakeoverHoldForCloseMock.mockResolvedValueOnce(false);
    await proxy.closeActiveForInvocation('t1', INV);
    // The hold ends before the vendor stops the browser; the row closes after.
    expect(endTakeoverHoldForCloseMock).toHaveBeenCalledWith('s1');
    expect(browserUseClientMock.closeSession).toHaveBeenCalledWith('bu-1', 't1');
    expect(closeSessionRowMock).toHaveBeenCalledWith('s1', 'run_ended');
    expect(endTakeoverHoldForCloseMock.mock.invocationCallOrder[0])
      .toBeLessThan(browserUseClientMock.closeSession.mock.invocationCallOrder[0]);
  });

  it('is a no-op when the run opened none', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await proxy.closeActiveForInvocation('t1', INV);
    expect(browserUseClientMock.closeSession).not.toHaveBeenCalled();
  });

  it('never throws: a failed close is logged and left to the reaper', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{
      id: 's1', tenant_id: 't1', agent_id: 'a', thread_id: null, invocation_id: INV,
      vendor: 'browser_use', vendor_session_id: 'bu-1', vendor_metadata: {}, created_at: new Date(), closed_at: null,
    }] });
    browserUseClientMock.closeSession.mockRejectedValueOnce(new Error('vendor down'));
    await expect(proxy.closeActiveForInvocation('t1', INV)).resolves.toBeUndefined();
  });
});

// A scope holds ONE open row (web_sessions_one_active_per_thread /
// _per_invocation, partial unique on closed_at IS NULL). The reaper closes an
// expired row minutes after the vendor released the browser, and until it
// does, a spawn that ignored the dead row would insert a second open row for
// the scope and the database would refuse it.
describe('a spawn for a scope whose session has already expired', () => {
  const expiredRow = { id: 'dead-1', tenant_id: 't1', vendor: 'steel', vendor_session_id: 'vs-dead' };
  const connected = (...v: string[]) => getTenantConnectedWebVendorsMock.mockResolvedValue(new Set(v));
  /** When the session was opened, whichever vendor's client opened it. */
  const firstSpawnOrder = (): number => Math.min(...[createAnchorMock, createBrowserUseMock, createBrowserbaseMock, createSteelMock]
    .flatMap((m) => m.mock.invocationCallOrder));

  it('closes the dead row first, so the new session has somewhere to be', async () => {
    connected('anchor');
    // The first query of the spawn is the expired-row lookup.
    mockPoolQuery.mockResolvedValueOnce({ rows: [expiredRow] });
    await proxy.createSessionForThread({ tenantId: 't1', agentId: 'a', threadId: 'th' });
    expect(closeExpiredSessionMock).toHaveBeenCalledWith(expiredRow);
    // Whichever vendor served, the dead row was closed before it did.
    expect(closeExpiredSessionMock.mock.invocationCallOrder[0]).toBeLessThan(firstSpawnOrder());
  });

  it('closes nothing when the scope has no expired session', async () => {
    connected('anchor');
    await proxy.createSessionForThread({ tenantId: 't1', agentId: 'a', threadId: 'th' });
    expect(closeExpiredSessionMock).not.toHaveBeenCalled();
  });

  it('does the same for a run, which has a one-open-row index of its own', async () => {
    connected('anchor');
    mockPoolQuery.mockResolvedValueOnce({ rows: [expiredRow] });
    await proxy.createSessionForRun({ tenantId: 't1', agentId: 'a', invocationId: 'inv-1' });
    expect(closeExpiredSessionMock).toHaveBeenCalledWith(expiredRow);
  });

  it('spawns anyway when the dead row could not be closed: the spawn is what the person is waiting for', async () => {
    connected('anchor');
    mockPoolQuery.mockResolvedValueOnce({ rows: [expiredRow] });
    closeExpiredSessionMock.mockRejectedValueOnce(new Error('the vendor did not answer'));
    await expect(proxy.createSessionForThread({ tenantId: 't1', agentId: 'a', threadId: 'th' })).resolves.toBeDefined();
    expect(Number.isFinite(firstSpawnOrder())).toBe(true);
  });
});
