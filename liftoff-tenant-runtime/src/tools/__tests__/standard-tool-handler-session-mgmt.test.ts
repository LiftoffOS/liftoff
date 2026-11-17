/**
 * web_session_list / web_session_forget handlers.
 *
 * Verifies:
 *  - list is owner-scoped (a user only sees their own + tenant-shared logins)
 *  - list cross-checks Anchor's live profiles and drops rows Anchor no longer
 *    has (pane sessions that never persisted, out-of-band deletions)
 *  - list degrades OPEN (live=null, unfiltered) when the Anchor call fails
 *  - list labels 'pane' rows as a browser session and 'saved' rows by service
 *  - forget is owner-scoped and deletes the Anchor profile before the local row
 */

class FakeAnchorError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message); this.name = 'AnchorError';
  }
}

const mockDeleteProfile = jest.fn();
const mockListProfiles = jest.fn();

jest.mock('../../integrations/web-fetch/anchor-client', () => ({
  AnchorClient: jest.fn().mockImplementation(() => ({
    deleteProfile: mockDeleteProfile,
    listProfiles: mockListProfiles,
  })),
  AnchorError: FakeAnchorError,
  createAnchorSessionForThread: jest.fn(),
}));

const mockPoolQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  getPool: () => ({ query: (...a: unknown[]) => mockPoolQuery(...a) }),
}));
jest.mock('../../integrations/web-fetch/browserbase-client', () => ({ BrowserbaseClient: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../integrations/web-fetch/webclaw-client', () => ({ WebClawClient: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../integrations/web-fetch/firecrawl-client', () => ({ FirecrawlClient: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../integrations/web-fetch/perplexity-client', () => ({ PerplexityClient: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../integrations/web-fetch/router', () => ({
  WebFetchRouter: jest.fn().mockImplementation(() => ({})),
  admitSingleVendor: jest.fn(),
}));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../usage-ledger/service', () => ({ usageLedgerService: { recordUsage: jest.fn() } }));
jest.mock('../../memory/service', () => ({ memoryService: {} }));
jest.mock('../../platform-callback/client', () => ({ getPlatformCallbackClient: jest.fn() }));
jest.mock('../../browser-sessions/screenshot-storage', () => ({ uploadScreenshotAndSign: jest.fn() }));
jest.mock('../../browser-sessions/repository', () => ({
  getActiveForThread: jest.fn(),
  getActiveForCallerSession: jest.fn(),
}));
jest.mock('../../browser-sessions/current-url', () => ({ persistCurrentUrl: jest.fn() }));

import { executeStandardTool } from '../standard-tool-handler';

const ctx = {
  tenantId: 'tenant-1', agentId: 'agent-1',
  memoryScope: { writableLayers: ['individual'], readableLayers: ['individual'] },
  threadId: 'thread-1',
  messageSenderAccountId: 'acc-1',
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('web_session_list', () => {
  function row(over: Partial<Record<string, unknown>> = {}) {
    return {
      // web_profiles.vendor is NOT NULL; the helper predates a second vendor.
      vendor: 'anchor',
      profile_name: 'salesforce-acme', vendor_profile_id: 'salesforce-acme',
      profile_kind: 'saved', service_name: 'Salesforce',
      login_url: 'https://login.salesforce.com', last_used_at: null, ...over,
    };
  }

  it('is owner+agent-scoped: queries the caller + this agent plus NULL shared rows', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    // No mockListProfiles queued on purpose: with no rows there are no vendors
    // to check, so the liveness call is skipped entirely. Queueing a once-value
    // here would leave it unconsumed and shift every later test's mocks by one.
    await executeStandardTool('web_session_list', {}, ctx as never);
    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/owner_account_id = \$3 OR owner_account_id IS NULL/);
    expect(sql).toMatch(/agent_id = \$4 OR agent_id IS NULL/);
    expect(params).toEqual(['tenant-1', ['anchor', 'browserbase', 'steel', 'browser_use'], 'acc-1', 'agent-1']);
  });

  it('labels saved rows by service and pane rows as a browser session', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [
      row(),
      row({ vendor: 'anchor', profile_name: 't-a-acc', vendor_profile_id: 't-a-acc', profile_kind: 'pane', service_name: null, login_url: null }),
      row({ vendor: 'anchor', profile_name: 'wd', vendor_profile_id: 'wd', service_name: null, login_url: 'https://wd.example/login' }),
    ] });
    mockListProfiles.mockResolvedValueOnce([{ name: 'salesforce-acme' }, { name: 't-a-acc' }, { name: 'wd' }]);
    const result = await executeStandardTool('web_session_list', {}, ctx as never);
    const logins = (result!.result as { logins: Array<Record<string, unknown>> }).logins;
    expect(logins).toEqual([
      { profile_name: 'salesforce-acme', kind: 'saved', service: 'Salesforce', login_url: 'https://login.salesforce.com', last_used_at: null, live: true },
      { profile_name: 't-a-acc', kind: 'pane', service: 'Signed-in browser session', login_url: undefined, last_used_at: null, live: true },
      { profile_name: 'wd', kind: 'saved', service: 'wd.example', login_url: 'https://wd.example/login', last_used_at: null, live: true },
    ]);
  });

  it('drops rows Anchor no longer has (liveness filter)', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [
      row({ vendor: 'anchor', profile_name: 'live-one', vendor_profile_id: 'live-one' }),
      row({ vendor: 'anchor', profile_name: 'stale-one', vendor_profile_id: 'stale-one' }),
    ] });
    mockListProfiles.mockResolvedValueOnce([{ name: 'live-one' }]); // stale-one missing
    const result = await executeStandardTool('web_session_list', {}, ctx as never);
    const logins = (result!.result as { logins: Array<{ profile_name: string }> }).logins;
    expect(logins.map(l => l.profile_name)).toEqual(['live-one']);
  });

  it('degrades open (live=null, unfiltered) when the Anchor call fails', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [
      row({ vendor: 'anchor', profile_name: 'a', vendor_profile_id: 'a' }),
      row({ vendor: 'anchor', profile_name: 'b', vendor_profile_id: 'b' }),
    ] });
    mockListProfiles.mockRejectedValueOnce(new FakeAnchorError('vendor down', 503));
    const result = await executeStandardTool('web_session_list', {}, ctx as never);
    const logins = (result!.result as { logins: Array<{ profile_name: string; live: unknown }> }).logins;
    expect(logins.map(l => l.profile_name)).toEqual(['a', 'b']);
    expect(logins.every(l => l.live === null)).toBe(true);
  });
});

describe('web_session_forget', () => {
  it('requires profile_name', async () => {
    const result = await executeStandardTool('web_session_forget', {}, ctx as never);
    expect(result!.success).toBe(false);
    expect(String(result!.error)).toMatch(/requires profile_name/);
  });

  it('is owner+agent-scoped and returns not-found for a profile outside the caller scope', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // SELECT (scoped) finds nothing
    const result = await executeStandardTool('web_session_forget', { profile_name: 'someone-elses' }, ctx as never);
    expect(result!.success).toBe(false);
    expect(String(result!.error)).toMatch(/No saved login named "someone-elses"/);
    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/owner_account_id = \$4 OR owner_account_id IS NULL/);
    expect(sql).toMatch(/agent_id = \$5 OR agent_id IS NULL/);
    expect(params).toEqual(['tenant-1', 'someone-elses', ['anchor', 'browserbase', 'steel', 'browser_use'], 'acc-1', 'agent-1']);
    expect(mockDeleteProfile).not.toHaveBeenCalled();
  });

  it('deletes the Anchor profile, then the local row (same owner+agent scope)', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ vendor: 'anchor', vendor_profile_id: 'salesforce-acme' }] }) // SELECT
      .mockResolvedValueOnce({ rows: [] }); // DELETE
    mockDeleteProfile.mockResolvedValueOnce(undefined);
    const result = await executeStandardTool('web_session_forget', { profile_name: 'salesforce-acme' }, ctx as never);
    expect(result!.success).toBe(true);
    expect(mockDeleteProfile).toHaveBeenCalledWith('salesforce-acme', 'tenant-1');
    const deleteCall = mockPoolQuery.mock.calls[1] as [string, unknown[]];
    expect(deleteCall[0]).toMatch(/DELETE FROM web_profiles/);
    expect(deleteCall[1]).toEqual(['tenant-1', 'salesforce-acme', ['anchor', 'browserbase', 'steel', 'browser_use'], 'acc-1', 'agent-1']);
  });

  it('does NOT delete the local row when the Anchor delete fails', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ vendor: 'anchor', vendor_profile_id: 'salesforce-acme' }] }); // SELECT only
    mockDeleteProfile.mockRejectedValueOnce(new FakeAnchorError('boom', 500));
    const result = await executeStandardTool('web_session_forget', { profile_name: 'salesforce-acme' }, ctx as never);
    expect(result!.success).toBe(false);
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
  });
});
