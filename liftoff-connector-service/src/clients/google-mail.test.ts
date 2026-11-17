// Hermetic tests for the Google Mail connector client.

import { GoogleMailClient } from './google-mail.js';
import type { CredentialProvider } from './types.js';

function mockResponse(body: Record<string, unknown>, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function decodeRaw(raw: string): string {
  const norm = raw.replace(/-/g, '+').replace(/_/g, '/');
  const padded = norm + '='.repeat((4 - (norm.length % 4)) % 4);
  return Buffer.from(padded, 'base64').toString('utf-8');
}

describe('GoogleMailClient', () => {
  let fetchSpy: jest.SpyInstance;
  const credentialProvider: CredentialProvider = async () => ({
    accessToken: 'ya29.test',
  });

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(mockResponse({}));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  describe('buildRawMessage via create()', () => {
    it('emits "From:" as the first header line when from is provided', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ id: 'm1', threadId: 't1' }));
      const client = new GoogleMailClient(credentialProvider);
      await client.create('message', {
        from: 'support@example.com',
        to: 'alice@example.com',
        subject: 'Hi',
        body: 'hello',
      });

      const sentBody = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
      const decoded = decodeRaw(sentBody.raw);
      const firstHeader = decoded.split('\r\n')[0];
      expect(firstHeader).toBe('From: support@example.com');
    });

    it('omits "From:" by default when from is absent', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ id: 'm1', threadId: 't1' }));
      const client = new GoogleMailClient(credentialProvider);
      await client.create('message', {
        to: 'alice@example.com',
        subject: 'Hi',
        body: 'hello',
      });

      const sentBody = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
      const decoded = decodeRaw(sentBody.raw);
      expect(decoded).not.toMatch(/^From:/m);
    });

    it('reply forwards from to buildRawMessage as a header', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ id: 'm2', threadId: 't2' }));
      const client = new GoogleMailClient(credentialProvider);
      await client.create('reply', {
        from: 'support@example.com',
        to: 'alice@example.com',
        subject: 'Re: Hi',
        body: 'hello',
        messageId: '<abc@mail>',
        threadId: 't2',
      });

      const sentBody = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
      const decoded = decodeRaw(sentBody.raw);
      expect(decoded.split('\r\n')[0]).toBe('From: support@example.com');
    });

    it('forward forwards from as a header', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ id: 'm3', threadId: 't3' }));
      const client = new GoogleMailClient(credentialProvider);
      await client.create('forward', {
        from: 'support@example.com',
        to: 'alice@example.com',
        subject: 'Fwd: Hi',
        body: 'forwarded',
      });

      const sentBody = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
      const decoded = decodeRaw(sentBody.raw);
      expect(decoded.split('\r\n')[0]).toBe('From: support@example.com');
    });
  });

  describe('list()', () => {
    it('produces request URL containing q=(label:x) when q is provided alone', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ messages: [] }));
      const client = new GoogleMailClient(credentialProvider);
      await client.list('Email', { q: 'label:x' });

      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain('q=%28label%3Ax%29');
    });

    it('composes q with since using a space separator', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ messages: [] }));
      const client = new GoogleMailClient(credentialProvider);
      const since = new Date(1_700_000_000_000);
      await client.list('Email', { since, q: 'label:x' });

      const url = fetchSpy.mock.calls[0][0] as string;
      // URLSearchParams encodes spaces as '+'.
      expect(url).toMatch(/q=after%3A1700000000\+%28label%3Ax%29/);
    });

    it('returns empty result for non-Email entityType', async () => {
      const client = new GoogleMailClient(credentialProvider);
      const result = await client.list('Other');
      expect(result).toEqual({ records: [], hasMore: false, unsupported: true });
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('composio_managed routing', () => {
    it('routes through composioProxyRequest when connectorConfig.composioConnectedAccountId is set', async () => {
      const composioCp = async () => ({
        accessToken: '', // composio_managed has no usable token
        connectorConfig: { composioConnectedAccountId: 'ca_TEST' },
      });
      const proxyMock = jest.fn(async () => ({ historyId: '99', expiration: '7777' }));
      jest.doMock('../oauth/composio-client.js', () => ({
        composioProxyRequest: proxyMock,
      }));
      // Re-import GoogleMailClient AFTER the doMock above so dynamic
      // import inside request() picks up the mock.
      jest.resetModules();
      const { GoogleMailClient: ReimportedClient } = await import('./google-mail.js');
      const client = new ReimportedClient(composioCp);
      const result = await client.registerWebhook('me', 'channel-tok', 'projects/tenant-x/topics/gmail-history-prod');
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(proxyMock).toHaveBeenCalledWith(expect.objectContaining({
        connectedAccountId: 'ca_TEST',
        method: 'POST',
        // Absolute vendor URL — Composio's per-toolkit bases are inconsistent
        // so clients pass the full URL, not a version-prefixed path (see
        // composio-transport.ts + google-composio-endpoint.test.ts).
        endpoint: 'https://www.googleapis.com/gmail/v1/users/me/watch',
        body: expect.objectContaining({
          topicName: 'projects/tenant-x/topics/gmail-history-prod',
          labelIds: ['INBOX'],
        }),
      }));
      expect(result.historyId).toBe('99');
      jest.dontMock('../oauth/composio-client.js');
    });
  });

  describe('registerWebhook (Gmail users.watch)', () => {
    const ORIG_TOPIC = process.env.GMAIL_WATCH_TOPIC;
    afterEach(() => {
      if (ORIG_TOPIC === undefined) delete process.env.GMAIL_WATCH_TOPIC;
      else process.env.GMAIL_WATCH_TOPIC = ORIG_TOPIC;
    });

    it('uses the topicName passed by the caller (starts with projects/)', async () => {
      delete process.env.GMAIL_WATCH_TOPIC;
      fetchSpy.mockResolvedValueOnce(mockResponse({ historyId: '12345', expiration: '9999' }));
      const client = new GoogleMailClient(credentialProvider);
      await client.registerWebhook('me', 'channel-tok', 'projects/tenant-x/topics/gmail-history-prod');
      const body = JSON.parse((fetchSpy.mock.calls[0][1] as { body: string }).body);
      expect(body.topicName).toBe('projects/tenant-x/topics/gmail-history-prod');
      expect(body.labelIds).toEqual(['INBOX']);
    });

    it('falls back to GMAIL_WATCH_TOPIC env var when caller passes non-topic value', async () => {
      process.env.GMAIL_WATCH_TOPIC = 'projects/env-fallback/topics/gmail-history-prod';
      fetchSpy.mockResolvedValueOnce(mockResponse({ historyId: '9', expiration: '0' }));
      const client = new GoogleMailClient(credentialProvider);
      await client.registerWebhook('me', 'channel-tok', '');
      const body = JSON.parse((fetchSpy.mock.calls[0][1] as { body: string }).body);
      expect(body.topicName).toBe('projects/env-fallback/topics/gmail-history-prod');
    });

    it('throws a clear error when no topic resolves', async () => {
      delete process.env.GMAIL_WATCH_TOPIC;
      const client = new GoogleMailClient(credentialProvider);
      await expect(client.registerWebhook('me', 'channel-tok', '')).rejects.toThrow(
        /no Pub\/Sub topic resolved/,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
