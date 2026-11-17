// Hermetic tests for the Microsoft Outlook Mail connector client.

import { MicrosoftOutlookMailClient } from './microsoft-outlook-mail.js';
import { OAuthRefreshError, isReconnectRequiredOAuthError } from '../credentials/service.js';
import type { CredentialProvider } from './types.js';

function mockResponse(body: Record<string, unknown>, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('MicrosoftOutlookMailClient', () => {
  let fetchSpy: jest.SpyInstance;
  const credentialProvider: CredentialProvider = async () => ({
    accessToken: 'graph.test',
  });

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(mockResponse({}, 204));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  describe('create() — URL switching on data.from', () => {
    it('send_email with `from` posts to /users/{from}/sendMail', async () => {
      const client = new MicrosoftOutlookMailClient(credentialProvider);
      await client.create('message', {
        from: 'support@example.com',
        to: ['a@b.com'],
        subject: 's',
        body: 'b',
      });
      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toBe('https://graph.microsoft.com/v1.0/users/support%40example.com/sendMail');
    });

    it('send_email without `from` posts to /me/sendMail', async () => {
      const client = new MicrosoftOutlookMailClient(credentialProvider);
      await client.create('message', {
        to: ['a@b.com'],
        subject: 's',
        body: 'b',
      });
      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toBe('https://graph.microsoft.com/v1.0/me/sendMail');
    });

    it('reply with `from` posts to /users/{from}/messages/{id}/reply', async () => {
      const client = new MicrosoftOutlookMailClient(credentialProvider);
      await client.create('reply', {
        from: 'support@example.com',
        messageId: 'abc',
        body: 'hi',
      });
      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toBe(
        'https://graph.microsoft.com/v1.0/users/support%40example.com/messages/abc/reply',
      );
    });

    it('reply_draft with `from` routes both createReply and PATCH under /users/{from}', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ id: 'draft1' }));
      fetchSpy.mockResolvedValueOnce(mockResponse({}, 204));
      const client = new MicrosoftOutlookMailClient(credentialProvider);
      await client.create('reply_draft', {
        from: 'support@example.com',
        messageId: 'abc',
        body: 'hi',
      });
      const createUrl = fetchSpy.mock.calls[0][0] as string;
      const patchUrl = fetchSpy.mock.calls[1][0] as string;
      expect(createUrl).toBe(
        'https://graph.microsoft.com/v1.0/users/support%40example.com/messages/abc/createReply',
      );
      expect(patchUrl).toBe(
        'https://graph.microsoft.com/v1.0/users/support%40example.com/messages/draft1',
      );
    });

    it('forward with `from` posts to /users/{from}/messages/{id}/forward with comment populated', async () => {
      const client = new MicrosoftOutlookMailClient(credentialProvider);
      await client.create('forward', {
        from: 'support@example.com',
        messageId: 'abc',
        to: ['c@d.com'],
        body: 'see below',
      });
      const url = fetchSpy.mock.calls[0][0] as string;
      const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
      expect(url).toBe(
        'https://graph.microsoft.com/v1.0/users/support%40example.com/messages/abc/forward',
      );
      expect(body.comment).toBe('see below');
      expect(body.toRecipients).toEqual([{ emailAddress: { address: 'c@d.com' } }]);
    });

    it('forward without `from` posts to /me/messages/{id}/forward', async () => {
      const client = new MicrosoftOutlookMailClient(credentialProvider);
      await client.create('forward', {
        messageId: 'abc',
        to: ['c@d.com'],
      });
      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toBe('https://graph.microsoft.com/v1.0/me/messages/abc/forward');
    });
  });

  describe('read("mail_messages") — filter forwarding', () => {
    it('forwards $filter when payload.filter is set', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ value: [] }));
      const client = new MicrosoftOutlookMailClient(credentialProvider);
      await client.read('mail_messages', undefined, {
        filter: "from/emailAddress/address eq 'a@b.com'",
      });
      const url = fetchSpy.mock.calls[0][0] as string;
      // URLSearchParams encodes space as `+`, so decode and normalize before asserting.
      const decoded = decodeURIComponent(url).replace(/\+/g, ' ');
      expect(url).toContain('%24filter=');
      expect(decoded).toContain(
        "$filter=from/emailAddress/address eq 'a@b.com'",
      );
    });
  });

  describe('list("Email") — $filter composition', () => {
    it('composes receivedDateTime ge ISO AND (q) when both since and q are set', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ value: [] }));
      const client = new MicrosoftOutlookMailClient(credentialProvider);
      const since = new Date('2026-01-01T00:00:00.000Z');
      await client.list('Email', {
        since,
        q: "categories/any(c:c eq 'Support')",
      });
      const url = fetchSpy.mock.calls[0][0] as string;
      const decoded = decodeURIComponent(url).replace(/\+/g, ' ');
      expect(decoded).toContain(
        "$filter=receivedDateTime ge 2026-01-01T00:00:00.000Z and (categories/any(c:c eq 'Support'))",
      );
    });

    it('returns empty result for non-Email entityType', async () => {
      const client = new MicrosoftOutlookMailClient(credentialProvider);
      const result = await client.list('Other');
      expect(result).toEqual({ records: [], hasMore: false, unsupported: true });
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('semanticInverse() — forward', () => {
    it('cannot unsend a sent forward', async () => {
      const client = new MicrosoftOutlookMailClient(credentialProvider);
      const result = await client.semanticInverse('forward', 'create', 'abc', {});
      expect(result).toEqual({ success: false, error: 'Cannot unsend a sent forward' });
    });
  });

  // Graph 403 with an insufficient-scope-shaped body (typically from sending as
  // a shared mailbox without Mail.Send.Shared) must throw OAuthRefreshError so
  // the existing job-error path surfaces `reconnect_required` to the frontend
  // and prompts a reconnect. Generic 4xx errors stay as plain Error.
  describe('403 insufficient_scope → OAuthRefreshError', () => {
    const cpWithIds: CredentialProvider = async () => ({
      accessToken: 'graph.test',
      tenantId: 'tenant-1',
      connectorId: 'conn-1',
    });

    it('propagates OAuthRefreshError from create() on 403 insufficient_scope (not swallowed into { success: false })', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ error: { code: 'ErrorAccessDenied', message: 'insufficient_scope' } }, 403),
      );
      const client = new MicrosoftOutlookMailClient(cpWithIds);
      await expect(
        client.create('message', {
          from: 'support@example.com',
          to: ['a@b.com'],
          subject: 's',
          body: 'b',
        }),
      ).rejects.toBeInstanceOf(OAuthRefreshError);
    });

    it('still wraps non-OAuth errors from create() in { success: false }', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ error: { code: 'ErrorBadRequest', message: 'bad' } }, 400),
      );
      const client = new MicrosoftOutlookMailClient(cpWithIds);
      const result = await client.create('message', {
        to: ['a@b.com'],
        subject: 's',
        body: 'b',
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Microsoft Outlook Mail API error: 400/);
    });

    it('propagates OAuthRefreshError from read() on 403 insufficient_scope', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ error: { code: 'ErrorAccessDenied', message: 'insufficient privileges' } }, 403),
      );
      const client = new MicrosoftOutlookMailClient(cpWithIds);
      await expect(client.read('mail_messages', undefined, {})).rejects.toBeInstanceOf(
        OAuthRefreshError,
      );
    });

    it('propagates OAuthRefreshError from list() on 403 ErrorAccessDenied', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ error: { code: 'ErrorAccessDenied', message: 'denied' } }, 403),
      );
      const client = new MicrosoftOutlookMailClient(cpWithIds);
      let caught: unknown;
      try {
        await client.list('Email');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(OAuthRefreshError);
      expect(isReconnectRequiredOAuthError(caught)).toBe(true);
      expect((caught as OAuthRefreshError).tenantId).toBe('tenant-1');
      expect((caught as OAuthRefreshError).connectorId).toBe('conn-1');
      expect((caught as OAuthRefreshError).vendor).toBe('microsoft_outlook_mail');
    });

    it('falls back to plain Error on 403 when tenantId/connectorId are absent', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ error: { code: 'ErrorAccessDenied', message: 'insufficient_scope' } }, 403),
      );
      const client = new MicrosoftOutlookMailClient(credentialProvider); // no ids
      await expect(client.list('Email')).rejects.toThrow(/Microsoft Outlook Mail API error: 403/);
    });

    it('does NOT throw OAuthRefreshError on non-403 errors', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ error: { code: 'ErrorItemNotFound', message: 'not found' } }, 404),
      );
      const client = new MicrosoftOutlookMailClient(cpWithIds);
      await expect(client.list('Email')).rejects.toThrow(/Microsoft Outlook Mail API error: 404/);
    });

    it('does NOT throw OAuthRefreshError on 403 with unrelated body', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ error: { code: 'ErrorThrottle', message: 'too many requests' } }, 403),
      );
      const client = new MicrosoftOutlookMailClient(cpWithIds);
      await expect(client.list('Email')).rejects.toThrow(/Microsoft Outlook Mail API error: 403/);
    });
  });
});
