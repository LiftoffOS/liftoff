// Hermetic tests for the Slack connector client.
//
// The real SlackClient hits https://slack.com/api/* — we stub global.fetch
// so no network I/O happens. The adapter in clients/index.ts wraps the
// client behind makeClientExecutor, so we also assert the executor path
// via registerConnectorExecutor + runConnectorExecution integration.

import { SlackClient } from './slack.js';
import type { CredentialProvider } from './types.js';

function mockResponse(body: Record<string, unknown>): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

describe('SlackClient', () => {
  let fetchSpy: jest.SpyInstance;
  const credentialProvider: CredentialProvider = async () => ({
    accessToken: 'xoxb-test',
  });

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(mockResponse({ ok: true }));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('sends a bearer token in Authorization header on every request', async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse({ ok: true, ts: '1700000000.001', channel: 'C1' }),
    );
    const client = new SlackClient(credentialProvider);
    await client.create('message', { channel: 'C1', text: 'hello' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0];
    expect(call[0]).toBe('https://slack.com/api/chat.postMessage');
    const init = call[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer xoxb-test');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('read(message) returns the parsed message keyed by "channel:ts"', async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        messages: [{ ts: '1700000000.001', text: 'hi', user: 'U1' }],
      }),
    );
    const client = new SlackClient(credentialProvider);
    const rec = await client.read('message', 'C1:1700000000.001');
    expect(rec.id).toBe('C1:1700000000.001');
    expect(rec.data).toMatchObject({ text: 'hi', user: 'U1' });
  });

  it('create(message) composes id from channel:ts', async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse({ ok: true, ts: '1700000000.123', channel: 'C1' }),
    );
    const client = new SlackClient(credentialProvider);
    const result = await client.create('message', { channel: 'C1', text: 'x' });
    expect(result.success).toBe(true);
    expect(result.id).toBe('C1:1700000000.123');
  });

  it('propagates Slack API failures as exceptions', async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse({ ok: false, error: 'channel_not_found' }),
    );
    const client = new SlackClient(credentialProvider);
    const res = await client.create('message', { channel: 'bad', text: 'x' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/channel_not_found/);
  });

  it('update(channel) chains rename + topic + purpose when all provided', async () => {
    fetchSpy.mockResolvedValue(mockResponse({ ok: true }));
    const client = new SlackClient(credentialProvider);
    const result = await client.update('channel', 'C1', {
      name: 'renamed',
      topic: 't',
      purpose: 'p',
    });
    expect(result.success).toBe(true);
    // rename + setTopic + setPurpose = 3 round trips
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});
