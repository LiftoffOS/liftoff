// navigate_browser_session is the tool that makes a non-Anchor browser usable.
// Before it, navigation only happened inside Anchor's in-session agent or from
// a human typing in the pane, so an agent on a Browser Use session could open a
// browser and watch it but never steer it.

const mockGotoUrl = jest.fn();
const mockGetActivePage = jest.fn();
const mockCreateSessionForThread = jest.fn();
jest.mock('../../browser-sessions/session-vendor-proxy', () => ({
  gotoUrl: (...a: unknown[]) => mockGotoUrl(...a),
  getActivePage: (...a: unknown[]) => mockGetActivePage(...a),
  createSessionForThread: (...a: unknown[]) => mockCreateSessionForThread(...a),
}));

// The REAL error classes, not stand-ins. They live in a leaf module with no
// imports precisely so a test can use them, and a look-alike declared here is
// how this test came to assert against a class the handler had stopped
// recognising: `instanceof` was false, the branch never ran, and the test still
// passed because the fallback message happened to match.
import {
  NoSessionVendorConnected, SessionVendorAtCapacity,
} from '../../browser-sessions/session-errors';

const mockGetActiveForThread = jest.fn();
jest.mock('../../browser-sessions/repository', () => ({
  getActiveForThread: (...a: unknown[]) => mockGetActiveForThread(...a),
  getActiveForCallerSession: jest.fn().mockResolvedValue(null),
  clearTakeover: jest.fn(),
}));
jest.mock('../../browser-sessions/current-url', () => ({
  persistCurrentUrl: jest.fn().mockResolvedValue(undefined),
}));

import { executeStandardTool } from '../standard-tool-handler';

const ctx = { tenantId: 't1', agentId: 'a1', threadId: 'th1', messageSenderAccountId: 'acc1' };
const session = {
  id: 'sid', tenantId: 't1', vendorSessionId: 'vsid', vendor: 'browser_use',
  callerSessionId: 'ui:abc', takeoverState: 'none',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetActiveForThread.mockResolvedValue(session);
  mockGetActivePage.mockResolvedValue({ url: 'https://www.espn.com/', title: 'ESPN' });
});

const run = (payload: Record<string, unknown>) =>
  executeStandardTool('navigate_browser_session', payload, ctx as never);

it('drives the thread browser and dispatches to the owning vendor', async () => {
  const r = await run({ url: 'https://espn.com' });
  expect(r!.success).toBe(true);
  expect(mockGotoUrl).toHaveBeenCalledWith('browser_use', 'vsid', 't1', 'https://espn.com/');
});

it('reports where the browser ACTUALLY landed, not what was requested', async () => {
  // A redirect, consent wall or login page changes it. An agent that assumes
  // its request succeeded verbatim describes a page nobody is looking at.
  mockGetActivePage.mockResolvedValue({ url: 'https://www.espn.com/nfl/', title: 'NFL' });
  const r = await run({ url: 'https://espn.com' });
  expect(r!.result).toMatchObject({
    url: 'https://www.espn.com/nfl/', title: 'NFL', requested: 'https://espn.com/',
  });
});

it('refuses a relative URL rather than letting it reach the browser', async () => {
  const r = await run({ url: '/scores' });
  expect(r!.success).toBe(false);
  expect(String(r!.error)).toMatch(/absolute URL/);
  expect(mockGotoUrl).not.toHaveBeenCalled();
});

it('refuses a non-http scheme', async () => {
  // file:// would be a probe of the browser host, not a navigation.
  const r = await run({ url: 'file:///etc/passwd' });
  expect(r!.success).toBe(false);
  expect(String(r!.error)).toMatch(/http or https/);
  expect(mockGotoUrl).not.toHaveBeenCalled();
});

it('opens a browser itself when none exists, instead of telling the agent to try again', async () => {
  // The palette is fixed at turn start, so a tool gated on an existing session
  // could never appear in the turn that creates one. Asking to open a URL
  // implies wanting a browser.
  mockGetActiveForThread.mockResolvedValue(null);
  mockCreateSessionForThread.mockResolvedValue(session);
  const r = await run({ url: 'https://espn.com' });
  expect(r!.success).toBe(true);
  expect(mockCreateSessionForThread).toHaveBeenCalledWith(
    expect.objectContaining({ tenantId: 't1', agentId: 'a1', threadId: 'th1', ownerAccountId: 'acc1' }),
  );
  expect(mockGotoUrl).toHaveBeenCalledWith('browser_use', 'vsid', 't1', 'https://espn.com/');
});

it('says so plainly when no browser is available at all', async () => {
  // Reachable only when an operator has switched the platform browser off,
  // since it otherwise backs every workspace. The copy says "available" rather
  // than "connected", which would send someone to /connections to buy a browser
  // that would not have helped.
  mockGetActiveForThread.mockResolvedValue(null);
  mockCreateSessionForThread.mockRejectedValue(new NoSessionVendorConnected());
  const r = await run({ url: 'https://espn.com' });
  expect(r!.success).toBe(false);
  expect(String(r!.error)).toMatch(/No browser is available/);
  expect(r!.retryable).toBeFalsy();
});

it('asks the agent to retry when every browser on the plan is in use', async () => {
  // A capacity refusal is transient: a slot frees the moment any session ends.
  // Reported as a flat failure it read as "this workspace has no browser", and
  // before the spawn was routed through the classifier at all it escaped the
  // tool as an unhandled exception.
  mockGetActiveForThread.mockResolvedValue(null);
  mockCreateSessionForThread.mockRejectedValue(
    new SessionVendorAtCapacity('browser_use', 10, 10),
  );
  const r = await run({ url: 'https://espn.com' });
  expect(r!.success).toBe(false);
  expect(r!.transient).toBe(true);
  expect(r!.retryable).toBe(true);
  expect(String(r!.error)).toMatch(/in use right now/);
});

it('requires a url', async () => {
  const r = await run({});
  expect(r!.success).toBe(false);
  expect(mockGotoUrl).not.toHaveBeenCalled();
});
