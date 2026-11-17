/**
 * Browserbase can drive the pane.
 *
 * For a long time it could not, and the shape of that is worth keeping: it
 * reported supportsSessions() true while implementing ONE of the ten operations
 * the pane needs. The dispatch casts through `unknown`, so nothing caught it at
 * compile time — a `goto` on a Browserbase session would have been
 * "undefined is not a function", which a person experiences as a page that
 * never moves.
 */

const sessionsMock = {
  create: jest.fn(),
  retrieve: jest.fn(),
  update: jest.fn(),
  debug: jest.fn(),
};
const contextsMock = { create: jest.fn(), retrieve: jest.fn(), delete: jest.fn() };
jest.mock('@browserbasehq/sdk', () => ({
  __esModule: true,
  default: class { sessions = sessionsMock; contexts = contextsMock; },
}));

const pageMock = {
  goto: jest.fn().mockResolvedValue(undefined),
  url: jest.fn().mockReturnValue('https://www.espn.com/'),
  title: jest.fn().mockResolvedValue('ESPN'),
  screenshot: jest.fn().mockResolvedValue(Buffer.from('png')),
  content: jest.fn().mockResolvedValue('<h1>Scores</h1>'),
  emulateMedia: jest.fn().mockResolvedValue(undefined),
  pdf: jest.fn().mockResolvedValue(Buffer.from('pdf')),
};
const browserMock = {
  contexts: () => [{ pages: () => [pageMock] }],
  close: jest.fn().mockResolvedValue(undefined),
  // The pooled connection (browser-sessions/cdp-page.ts) listens for the
  // disconnect and checks liveness before reusing the browser.
  on: jest.fn(), off: jest.fn(),
  isConnected: () => true,
};
const connectOverCDPMock = jest.fn().mockResolvedValue(browserMock);
jest.mock('playwright-core', () => ({ chromium: { connectOverCDP: (...a: unknown[]) => connectOverCDPMock(...a) } }));

jest.mock('../web-tool-secrets', () => ({
  getWebToolCredential: jest.fn().mockResolvedValue({
    apiKey: 'bb-key', connectorId: 'conn-1', extra: { projectId: 'proj-1' },
  }),
}));
jest.mock('../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const recordSettledSessionCostMock = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../browser-sessions/session-cost', () => ({
  recordSettledSessionCost: (...a: unknown[]) => recordSettledSessionCostMock(...a),
}));

const poolQueryMock = jest.fn();
jest.mock('../../../infrastructure/database', () => ({
  getPool: () => ({ query: (...a: unknown[]) => poolQueryMock(...a) }),
}));

import { BrowserbaseClient } from '../browserbase-client';
import { _closeCdpPool } from '../../../browser-sessions/cdp-page';

const client = new BrowserbaseClient();

// The pane path is pooled per process; each test starts with an empty pool.
afterEach(async () => { await _closeCdpPool(); });

beforeEach(() => {
  jest.clearAllMocks();
  sessionsMock.retrieve.mockResolvedValue({
    id: 'bb-1', status: 'RUNNING', connectUrl: 'wss://cdp/bb-1',
    startedAt: '2026-09-04T10:00:00.000Z', proxyBytes: 0,
  });
  poolQueryMock.mockResolvedValue({ rows: [] });
});

describe('driving the pane over CDP', () => {
  it('navigates the session the person is watching', async () => {
    await client.gotoUrl('bb-1', 't1', 'https://espn.com');
    expect(connectOverCDPMock).toHaveBeenCalledWith('wss://cdp/bb-1');
    expect(pageMock.goto).toHaveBeenCalledWith(
      'https://espn.com', expect.objectContaining({ waitUntil: 'domcontentloaded' }),
    );
  });

  it('reports where the browser actually is', async () => {
    await expect(client.getActivePage('bb-1', 't1'))
      .resolves.toEqual({ url: 'https://www.espn.com/', title: 'ESPN' });
  });

  it('screenshots, reads the page and prints it', async () => {
    await expect(client.fetchScreenshotPng('bb-1', 't1')).resolves.toEqual(Buffer.from('png'));
    await expect(client.fetchActivePageContent('bb-1', 't1')).resolves.toContain('Scores');
    await expect(client.fetchActivePagePdf('bb-1', 't1')).resolves.toEqual(Buffer.from('pdf'));
    // Headful sessions render a blank PDF unless the print stylesheet is asked
    // for explicitly, so this is not decoration.
    expect(pageMock.emulateMedia).toHaveBeenCalledWith({ media: 'print' });
  });

  it('captures the full scrollable height when asked', async () => {
    await client.fetchToolsScreenshot('bb-1', 't1', { captureFullHeight: true });
    expect(pageMock.screenshot).toHaveBeenCalledWith({ type: 'png', fullPage: true });
  });

  it('drives the pane over the ONE pooled connection: a second operation on the session connects nothing', async () => {
    await client.getActivePage('bb-1', 't1');
    await client.fetchScreenshotPng('bb-1', 't1');
    expect(connectOverCDPMock).toHaveBeenCalledTimes(1);
    expect(browserMock.close).not.toHaveBeenCalled();
  });

  it('pause and resume are no-ops, because there is no vendor-side agent', async () => {
    // Our takeover_state row is the entire mechanism here. Throwing instead
    // would break takeover for this vendor completely.
    await expect(client.pauseAgent('bb-1', 't1')).resolves.toBeUndefined();
    await expect(client.resumeAgent('bb-1', 't1')).resolves.toBeUndefined();
  });

  it('refuses to drive a session that is no longer running', async () => {
    // A stale connect url fails in a way that reads as a broken page rather
    // than a session that ended, so the status is checked before connecting.
    sessionsMock.retrieve.mockResolvedValue({ id: 'bb-1', status: 'COMPLETED' });
    await expect(client.gotoUrl('bb-1', 't1', 'https://espn.com')).rejects.toThrow(/COMPLETED/);
    expect(connectOverCDPMock).not.toHaveBeenCalled();
  });
});

describe('closing a session', () => {
  it('releases it at the vendor and records what it cost', async () => {
    sessionsMock.retrieve.mockResolvedValue({
      id: 'bb-1', status: 'COMPLETED',
      startedAt: '2026-09-04T10:00:00.000Z',
      endedAt: '2026-09-04T11:00:00.000Z',
      proxyBytes: 1024,
    });
    await client.closeSession('bb-1', 't1');
    // keepAlive means the session outlives every disconnect, so it has to be
    // released explicitly or it burns its whole timeout holding a slot.
    expect(sessionsMock.update).toHaveBeenCalledWith(
      'bb-1', expect.objectContaining({ status: 'REQUEST_RELEASE' }),
    );
    expect(recordSettledSessionCostMock).toHaveBeenCalledWith(expect.objectContaining({
      vendor: 'browserbase',
      tenantId: 't1',
      // One hour at the published $0.10/hr rate.
      costUsd: 0.1,
      funding: 'tenant_key',
    }));
  });

  it('records nothing for a session that has not ended', async () => {
    // Browserbase bills by the hour, so a figure read before the session ends
    // is still climbing. Publishing it would charge for minutes nobody used and
    // burn the idempotency key against the real figure.
    sessionsMock.retrieve.mockResolvedValue({
      id: 'bb-1', status: 'RUNNING', startedAt: '2026-09-04T10:00:00.000Z',
    });
    await client.closeSession('bb-1', 't1');
    expect(recordSettledSessionCostMock).toHaveBeenCalledWith(
      expect.objectContaining({ settledAt: null }),
    );
  });
});

describe('contexts, which are the saved logins', () => {
  it('reuses the context recorded for this profile name', async () => {
    // Browserbase contexts have an id and no name, so the local row is the ONLY
    // place the readable name and the vendor id are held together.
    poolQueryMock.mockResolvedValue({ rows: [{ vendor_profile_id: 'ctx-1' }] });
    contextsMock.retrieve.mockResolvedValue({ id: 'ctx-1' });
    await expect(client.ensureProfile('t1', 'a-b-c'))
      .resolves.toEqual({ id: 'ctx-1', name: 'a-b-c' });
    expect(contextsMock.create).not.toHaveBeenCalled();
  });

  it('mints a new context when the vendor no longer has the recorded one', async () => {
    // Attaching a deleted context makes Browserbase refuse the session, so the
    // person would lose the pane rather than just the stored login.
    poolQueryMock.mockResolvedValue({ rows: [{ vendor_profile_id: 'ctx-gone' }] });
    contextsMock.retrieve.mockRejectedValue(new Error('404'));
    contextsMock.create.mockResolvedValue({ id: 'ctx-2' });
    await expect(client.ensureProfile('t1', 'a-b-c'))
      .resolves.toEqual({ id: 'ctx-2', name: 'a-b-c' });
  });

  it('lists only the contexts the vendor still holds', async () => {
    poolQueryMock.mockResolvedValue({
      rows: [
        { profile_name: 'p-live', vendor_profile_id: 'ctx-live' },
        { profile_name: 'p-dead', vendor_profile_id: 'ctx-dead' },
      ],
    });
    contextsMock.retrieve.mockImplementation((id: string) =>
      id === 'ctx-live' ? Promise.resolve({ id }) : Promise.reject(new Error('404')));
    await expect(client.listProfiles('t1')).resolves.toEqual([
      { name: 'p-live', vendorProfileId: 'ctx-live', cookieDomains: null },
    ]);
  });

  it('treats a context already gone as forgotten', async () => {
    // Surfacing a 404 would strand a local row the person cannot clear.
    contextsMock.delete.mockRejectedValue(Object.assign(new Error('gone'), { status: 404 }));
    await expect(client.deleteProfile('ctx-1', 't1')).resolves.toBeUndefined();
  });
});
