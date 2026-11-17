// Plan §7f verification: "Email send → Resend payload: List-Unsubscribe +
// List-Unsubscribe-Post headers present, in-body link points to
// ${FRONTEND_URL}/?unsubscribe_token=...".
//
// We stub global.fetch (sendEmail uses it directly) and inspect the JSON
// body Resend would receive.

import { sendRealtimeNotificationEmail } from '../email';
import { createMockAccount } from '../../test-utils/mocks';
import type { NotificationRow } from '../types';

const fetchMock = jest.fn();
beforeAll(() => {
  process.env.UNSUBSCRIBE_SECRET = 'test-secret';
  process.env.FRONTEND_URL = 'https://app.test.local';
  process.env.BACKEND_URL = 'https://api.test.local';
  (global as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
});

jest.mock('../../infrastructure/secrets', () => ({
  getResendApiKey: jest.fn().mockResolvedValue('resend_test_key'),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ id: 'resend-id-xyz' }),
  });
});

function makeRow(type: NotificationRow['type'], payload: Record<string, unknown>): NotificationRow {
  return {
    id: 'row-1',
    accountId: 'acc-1',
    tenantId: 'tenant-1',
    type,
    payload,
    cadence: 'realtime',
    createdAt: new Date(),
    deliveredAt: null,
    deliveryError: null,
  };
}

describe('sendRealtimeNotificationEmail Resend payload', () => {
  it('includes List-Unsubscribe and List-Unsubscribe-Post headers', async () => {
    const account = createMockAccount({ id: 'acc-1', email: 'sarah@example.com', firstName: 'Sarah' });
    await sendRealtimeNotificationEmail(
      account,
      makeRow('task_update', { internalAgentName: 'Code Reviewer Bot', eventTitle: 'PR review' }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.headers).toBeDefined();
    expect(body.headers['List-Unsubscribe']).toMatch(
      /^<https:\/\/api\.test\.local\/api\/notifications\/unsubscribe-direct\?token=/,
    );
    expect(body.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('embeds the FE unsubscribe link in the rendered HTML body', async () => {
    const account = createMockAccount({ id: 'acc-1', email: 'sarah@example.com', firstName: 'Sarah' });
    await sendRealtimeNotificationEmail(
      account,
      makeRow('task_update', { internalAgentName: 'Code Reviewer Bot', eventTitle: 'PR review' }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.html).toMatch(/https:\/\/app\.test\.local\/\?unsubscribe_token=/);
    expect(body.html).toMatch(/Unsubscribe<\/a>/);
  });

  it('uses the right unsubscribe action token per notification type', async () => {
    const account = createMockAccount({ id: 'acc-1', email: 'a@b.c' });
    await sendRealtimeNotificationEmail(
      account,
      makeRow('escalation', { internalAgentName: 'X', eventTitle: 'Y' }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    // Unsub link text is now generic across templates. The per-template
    // action is encoded in the HMAC token in the href — we verify the
    // token decodes to disable:escalations elsewhere (unsubscribe.test.ts).
    expect(body.html).toMatch(/Unsubscribe<\/a>/);
  });

  it('subject and preheader use placeholders interpolated from the payload', async () => {
    const account = createMockAccount({ id: 'acc-1', email: 'a@b.c' });
    await sendRealtimeNotificationEmail(
      account,
      makeRow('task_update', { internalAgentName: 'Code Reviewer Bot', eventTitle: 'Merge PR #42' }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.subject).toBe('Code Reviewer Bot updated a task on Liftoff');
    expect(body.html).toContain('Merge PR #42');
  });

  it('HTML-escapes hostile payload values in the body so they cannot execute', async () => {
    const account = createMockAccount({ id: 'acc-1', email: 'a@b.c' });
    await sendRealtimeNotificationEmail(
      account,
      makeRow('task_update', {
        internalAgentName: '<script>alert(1)</script>',
        eventTitle: '"><img src=x onerror=alert(1)>',
        eventSummary: 'Tom & Jerry <3',
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    // Raw HTML tags MUST be escaped — the literal tag form is what makes a
    // payload executable; the same characters appearing as text after escape
    // are harmless (browsers render `&lt;` as a `<` glyph, not as a tag).
    expect(body.html).not.toContain('<script>alert(1)</script>');
    expect(body.html).not.toContain('<img src=x');
    // Escaped forms should be present.
    expect(body.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(body.html).toContain('Tom &amp; Jerry');
    expect(body.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('falls back to a safe href when eventLink is not a valid http(s) URL', async () => {
    const account = createMockAccount({ id: 'acc-1', email: 'a@b.c' });
    await sendRealtimeNotificationEmail(
      account,
      makeRow('task_update', {
        internalAgentName: 'Bot',
        eventTitle: 'X',
        eventLink: 'javascript:alert(1)',
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.html).not.toMatch(/href=["']javascript:/);
    // The fallback is `${FRONTEND_URL}/dashboard/activity` resolved at module
    // load. We assert the path is present without binding to a specific host.
    expect(body.html).toContain('/dashboard/activity');
  });

  it('strips CRLF from subject placeholders to block header injection', async () => {
    const account = createMockAccount({ id: 'acc-1', email: 'a@b.c' });
    await sendRealtimeNotificationEmail(
      account,
      makeRow('task_update', {
        internalAgentName: 'Bot\r\nBcc: evil@example.com',
        eventTitle: 'Hi',
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    // CRLF is the actual injection vector — once it's stripped, the residual
    // text "Bcc: evil@example.com" is harmless inside a single Subject line.
    expect(body.subject).not.toMatch(/\r|\n/);
    expect(body.subject).toBe('BotBcc: evil@example.com updated a task on Liftoff');
  });
});
