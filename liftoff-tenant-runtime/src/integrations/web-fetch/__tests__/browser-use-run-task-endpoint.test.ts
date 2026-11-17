// A browser task drives the endpoint recorded when the session was created,
// and asks the vendor for it only when the row carries none.
//
// The task is the first thing a run does with a browser it just opened, and
// the vendor answered "Session not found" for a session it had created a
// second earlier — while the recorded endpoint drove it. Every page operation
// already read the row first; the task did not.

const storedCdpUrlMock = jest.fn();
jest.mock('../../../browser-sessions/cdp-endpoint', () => ({
  storedCdpUrl: (...a: unknown[]) => storedCdpUrlMock(...a),
  PhaseTimer: class { mark() {} summary() { return {}; } },
}));
// The one entry for every vendor (browser-task.ts): the client hands it the
// session's endpoint and it decides between the loop and the tail.
const runBrowserTaskMock = jest.fn();
jest.mock('../browser-task', () => ({
  runBrowserTask: (...a: unknown[]) => runBrowserTaskMock(...a),
}));
jest.mock('../web-tool-secrets', () => {
  class VendorNotConnected extends Error { constructor(public readonly vendor: string) { super('none'); this.name = 'VendorNotConnected'; } }
  class VendorConnectorErrored extends Error { constructor(public readonly vendor: string, public readonly errorCode: string) { super('err'); this.name = 'VendorConnectorErrored'; } }
  return {
    // The workspace connected nothing: the platform key pays.
    getWebToolCredential: jest.fn().mockImplementation(() => Promise.reject(new VendorNotConnected('browser_use'))),
    getWebToolSecret: jest.fn().mockResolvedValue('platform-key'),
    VendorNotConnected,
    VendorConnectorErrored,
  };
});
jest.mock('../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { BrowserUseClient } from '../browser-use-client';

const client = new BrowserUseClient();

beforeEach(() => {
  jest.clearAllMocks();
  runBrowserTaskMock.mockResolvedValue({ status: 'finished', result: { ok: true } });
});

describe('runAgentTask', () => {
  it('drives the recorded endpoint without asking the vendor', async () => {
    storedCdpUrlMock.mockResolvedValue('wss://cdp.example/recorded');
    const callSpy = jest.spyOn(client, 'call').mockRejectedValue(new Error('vendor must not be asked'));

    const res = await client.runAgentTask('sess-1', 't1', 'open the page', { invocationId: 'inv-1' });

    expect(res).toEqual({ status: 'finished', result: { ok: true } });
    expect(runBrowserTaskMock).toHaveBeenCalledWith(expect.objectContaining({ vendor: 'browser_use', vendorSessionId: 'sess-1', cdpUrl: 'wss://cdp.example/recorded', prompt: 'open the page', tenantId: 't1', invocationId: 'inv-1' }));
    expect(callSpy).not.toHaveBeenCalled();
  });

  it('asks the vendor only when the row carries no endpoint', async () => {
    storedCdpUrlMock.mockResolvedValue(null);
    const callSpy = jest.spyOn(client, 'call').mockResolvedValue({ id: 'sess-1', status: 'active', cdpUrl: 'wss://cdp.example/live' });

    await client.runAgentTask('sess-1', 't1', 'open the page');

    expect(callSpy).toHaveBeenCalledWith('/browsers/sess-1', 'platform-key', { method: 'GET' });
    expect(runBrowserTaskMock).toHaveBeenCalledWith(expect.objectContaining({ vendor: 'browser_use', cdpUrl: 'wss://cdp.example/live' }));
  });
});
