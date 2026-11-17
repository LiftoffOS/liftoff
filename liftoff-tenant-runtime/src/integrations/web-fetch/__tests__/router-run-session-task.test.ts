// `web_task` on the run-session path: with the loop on, a run-owned session
// on the router-picked vendor, `starting_url` opened through the proxy's
// `gotoUrl` BEFORE the task starts (which is where the saved-login fill
// rides: session-vendor-proxy.test.ts pins that the fill follows every
// goto), then the task, then the close.

const mockGetAllVendorFlags = jest.fn();
jest.mock('../global-flags', () => ({
  getAllVendorFlags: (...a: unknown[]) => mockGetAllVendorFlags(...a),
  isVendorEnabled: jest.fn().mockResolvedValue(true),
  isVendorExcludedForTenant: jest.fn().mockResolvedValue(false),
  isEffortRoutingEnabled: jest.fn().mockResolvedValue(false),
}));
jest.mock('../concurrency-limits', () => ({
  acquireInflightSlot: jest.fn().mockResolvedValue({ requestId: 'rid', release: jest.fn().mockResolvedValue(undefined) }),
  VendorPoolBusy: class extends Error {},
}));
jest.mock('../token-bucket', () => ({ consumeToken: jest.fn().mockResolvedValue({ ok: true }) }));
jest.mock('../../../infrastructure/database', () => ({ getPool: () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }) }));
jest.mock('../../../infrastructure/logging', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../web-tool-secrets', () => ({
  ...jest.requireActual('../web-tool-secrets'),
  getTenantConnectedWebVendors: jest.fn().mockResolvedValue(new Set(['anchor_browser'])),
}));
jest.mock('../vendor-scope', () => ({
  usableWebVendors: jest.fn(async () => ({ vendors: new Set(['anchor_browser']), connectorIds: new Map(), excluded: [], basis: 'bound' })),
  logExcludedVendors: jest.fn(),
}));
const mockLoopEnabled = jest.fn();
jest.mock('../../../typesafe/flags', () => ({ isJevBrowserLoopEnabled: () => mockLoopEnabled() }));

const proxy = {
  createSessionForRun: jest.fn(),
  gotoUrl: jest.fn(),
  runAgentTask: jest.fn(),
  closeSession: jest.fn(),
};
jest.mock('../../../browser-sessions/session-vendor-proxy', () => ({
  createSessionForRun: (...a: unknown[]) => proxy.createSessionForRun(...a),
  gotoUrl: (...a: unknown[]) => proxy.gotoUrl(...a),
  runAgentTask: (...a: unknown[]) => proxy.runAgentTask(...a),
  closeSession: (...a: unknown[]) => proxy.closeSession(...a),
}));

import { VendorHealthCache, WebFetchRouter } from '../router';

const client = (vendor: string) => ({ vendor, fetch: jest.fn(), supportsSessions: () => false, task: jest.fn() }) as never;

function buildRouter() {
  return new WebFetchRouter(
    client('webclaw'), client('firecrawl'), client('perplexity'), client('anchor'), client('browserbase'),
    client('tavily'), client('exa'), client('openai'), client('google'), client('browser_use'), client('xai'), client('steel') as never,
    new VendorHealthCache(),
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAllVendorFlags.mockResolvedValue({ anchor: true, steel: true, browser_use: true });
  mockLoopEnabled.mockReturnValue(true);
  proxy.createSessionForRun.mockResolvedValue({ id: 'sid', vendor: 'steel', vendorSessionId: 'vs-1' });
  proxy.gotoUrl.mockResolvedValue(undefined);
  proxy.runAgentTask.mockResolvedValue({ status: 'finished', result: { ok: true }, trail: { message: 'done', steps: [], captureGap: false, gapReason: null, stepsTruncated: false } });
  proxy.closeSession.mockResolvedValue(undefined);
});

describe('web_task on a run-owned session', () => {
  it('opens starting_url through the proxy goto before the task starts, then runs the task on that session, then closes it', async () => {
    const out = await buildRouter().task(
      { task: 'read the orders page', startingUrl: 'https://a.test/login' } as never,
      { tenantId: 't1', agentId: 'a1', invocationId: 'inv-1' },
    );
    expect(proxy.createSessionForRun).toHaveBeenCalledWith({ tenantId: 't1', agentId: 'a1', invocationId: 'inv-1' });
    expect(proxy.gotoUrl).toHaveBeenCalledWith('steel', 'vs-1', 't1', 'https://a.test/login');
    expect(proxy.runAgentTask).toHaveBeenCalledWith('steel', 'vs-1', 't1', 'read the orders page', { invocationId: 'inv-1', runtimeAgentId: 'a1' });
    const order = (m: jest.Mock) => m.mock.invocationCallOrder[0];
    expect(order(proxy.createSessionForRun)).toBeLessThan(order(proxy.gotoUrl));
    expect(order(proxy.gotoUrl)).toBeLessThan(order(proxy.runAgentTask));
    expect(order(proxy.runAgentTask)).toBeLessThan(order(proxy.closeSession));
    expect(out).toMatchObject({ result: { ok: true }, sessionId: 'sid', vendor: 'steel' });
  });

  it('a task without a starting URL makes no navigation of its own', async () => {
    await buildRouter().task({ task: 'x' } as never, { tenantId: 't1', agentId: 'a1', invocationId: 'inv-1' });
    expect(proxy.gotoUrl).not.toHaveBeenCalled();
    expect(proxy.runAgentTask).toHaveBeenCalledTimes(1);
  });

  it('with the loop off the run-session path is not taken', async () => {
    mockLoopEnabled.mockReturnValue(false);
    const router = buildRouter();
    await router.task({ task: 'x', startingUrl: 'https://a.test/' } as never, { tenantId: 't1', agentId: 'a1', invocationId: 'inv-1' }).catch(() => undefined);
    expect(proxy.createSessionForRun).not.toHaveBeenCalled();
    expect(proxy.gotoUrl).not.toHaveBeenCalled();
  });
});
