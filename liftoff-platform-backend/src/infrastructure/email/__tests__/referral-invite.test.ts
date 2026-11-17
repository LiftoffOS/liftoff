// Render tests for the referral invitation.
//
// This is the only email Liftoff sends to somebody who has never used it, at an
// address a paying customer typed, carrying prose that customer wrote. That is
// what makes it the one template where escaping is a security property rather
// than a rendering detail: the endpoint is gated behind a subscription
// precisely because attacker-controlled text inside Liftoff branding is what
// makes a phishing wrapper effective.

import { sendReferralInviteEmail } from '../index';

// The sending address belongs to the deployment, not to the source: there is no
// default (src/infrastructure/mail-identity.ts), and the suite's own value is
// set in src/test-utils/setup.ts. What these tests assert is the DISPLAY NAME,
// which is the half the referral code decides.
const MAIL_FROM = process.env.MAIL_FROM_ADDRESS;

const sent: Array<{ to: string; subject: string; html: string; emailType: string; from: string; replyTo?: string }> = [];

jest.mock('../../secrets', () => ({ getResendApiKey: jest.fn(async () => 'test-key') }));
jest.mock('../../logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

beforeEach(() => {
  sent.length = 0;
  global.fetch = jest.fn(async (_url: unknown, init: unknown) => {
    const body = JSON.parse((init as { body: string }).body);
    sent.push({
      to: body.to[0],
      subject: body.subject,
      html: body.html,
      emailType: body.tags.find((t: { name: string }) => t.name === 'type')?.value,
      from: body.from,
      replyTo: body.reply_to,
    });
    return { ok: true, json: async () => ({ id: 'email_1' }) } as unknown as Response;
  }) as unknown as typeof fetch;
});

const PARAMS = {
  workspaceName: 'Northwind Trading',
  inviteUrl: 'https://app.example/?ref=northwind-7f3a',
  message: null as string | null,
  refereeBonusUsd: 20,
  refereeBonusOus: 800,
};

describe('the referral invitation', () => {
  it('names the sender in the subject and the offer in both denominations', async () => {
    await sendReferralInviteEmail('jordan@example.com', PARAMS);

    const email = sent[0];
    expect(email.subject).toBe('Northwind Trading invites you to try Liftoff');
    expect(email.emailType).toBe('referral-invite');
    // Operating Units because that is what is granted, dollars because the
    // person reading this has never used Liftoff and would have to learn what
    // an Operating Unit is before the offer meant anything.
    expect(email.html).toContain('800 Operating Units');
    expect(email.html).toContain('($20 of usage)');
    expect(email.html).toContain('https://app.example/?ref=northwind-7f3a');
  });

  it('leads with the referrer, and keeps the workspace when somebody named it', async () => {
    await sendReferralInviteEmail('jordan@example.com', { ...PARAMS, inviterName: 'Ada Lovelace' });

    const email = sent[0];
    expect(email.subject).toBe('Ada Lovelace invites you to try Liftoff');
    expect(email.html).toContain('<strong>Ada Lovelace</strong> at <strong>Northwind Trading</strong>');
  });

  // Nobody renames their workspace before sending their first invitation, so
  // this is the common case rather than an edge one. Both defaults come from
  // tenants/service.ts. "Ada Lovelace at Ada's Workspace" is worse than saying
  // nothing about the workspace at all.
  it.each(["Ada's Workspace", 'Personal Workspace'])(
    'drops the workspace when it is still the default (%s)',
    async (workspaceName) => {
      await sendReferralInviteEmail('jordan@example.com', {
        ...PARAMS,
        workspaceName,
        inviterName: 'Ada Lovelace',
      });

      const email = sent[0];
      expect(email.subject).toBe('Ada Lovelace invites you to try Liftoff');
      expect(email.html).toContain('<strong>Ada Lovelace</strong> uses Liftoff');
      expect(email.html).not.toContain(' at <strong>');
      expect(email.html).not.toContain(workspaceName);
    },
  );

  // A customer who typed a name that happens to end that way keeps it: the
  // test for a default is exact, not a guess at what looks generic.
  it('keeps a chosen name that merely resembles a default', async () => {
    await sendReferralInviteEmail('jordan@example.com', {
      ...PARAMS,
      workspaceName: 'The Workspace Company',
      inviterName: 'Ada Lovelace',
    });
    expect(sent[0].html).toContain('at <strong>The Workspace Company</strong>');
  });

  it('sends in the referrer name, without exposing their address', async () => {
    await sendReferralInviteEmail('jordan@example.com', { ...PARAMS, inviterName: 'Ada Lovelace' });
    // Display name only. The address stays noreply@ and the reply-to stays with
    // support: see the sibling test that this email routes replies nowhere near
    // the sender.
    expect(sent[0].from).toBe(`"Ada Lovelace via Liftoff" <${MAIL_FROM}>`);
  });

  it('carries the sender note when there is one, and no quotation when there is not', async () => {
    await sendReferralInviteEmail('jordan@example.com', { ...PARAMS, message: 'We use it daily' });
    expect(sent[0].html).toContain('They added:');
    expect(sent[0].html).toContain('We use it daily');

    sent.length = 0;
    await sendReferralInviteEmail('jordan@example.com', PARAMS);
    expect(sent[0].html).not.toContain('They added:');
  });

  it('escapes the sender note rather than rendering it', async () => {
    await sendReferralInviteEmail('jordan@example.com', {
      ...PARAMS,
      message: '<a href="https://evil.example">Verify your account</a>',
    });

    // The service already strips angle brackets before this point; the encoder
    // here is the second of two independent defences, and only it knows it is
    // producing HTML. Both have to hold on their own.
    expect(sent[0].html).not.toContain('<a href="https://evil.example"');
    expect(sent[0].html).toContain('&lt;a href=');
  });

  it('escapes the workspace name, which the sender also chose', async () => {
    await sendReferralInviteEmail('jordan@example.com', {
      ...PARAMS,
      workspaceName: 'Acme <script>alert(1)</script>',
    });

    expect(sent[0].html).not.toContain('<script>');
  });

  it('routes replies nowhere near the sender', async () => {
    // Unlike a workspace invitation, this address never asked to hear from the
    // person who sent it. Routing replies to them would hand a stranger's inbox
    // to whoever paid for a subscription.
    await sendReferralInviteEmail('jordan@example.com', PARAMS);

    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    // The deployment's own reply address — MAIL_REPLY_TO_ADDRESS, or the From
    // address when that is unset. What matters is only that it is not the
    // referrer's: a support mailbox this install does not read would be the
    // same defect in the other direction.
    expect(body.reply_to).toBe(MAIL_FROM);
    expect(body.reply_to).not.toContain('@example.com');
    // The display name may credit the sender. The ADDRESS never does: that is
    // the part that would expose an inbox.
    expect(body.from).toContain(`<${MAIL_FROM}>`);
    expect(body.from).not.toContain('@example.com');
  });

  // firstName and lastName are both nullable in the database, and the service
  // builds the name by joining whatever is there. Each combination has to
  // produce something sendable rather than a stray space or an empty From.
  describe('when the referrer has a partial name', () => {
    it('uses a first name on its own', async () => {
      await sendReferralInviteEmail('jordan@example.com', { ...PARAMS, inviterName: 'Ada' });
      expect(sent[0].subject).toBe('Ada invites you to try Liftoff');
      expect(sent[0].from).toBe(`"Ada via Liftoff" <${MAIL_FROM}>`);
    });

    it('uses a last name on its own', async () => {
      await sendReferralInviteEmail('jordan@example.com', { ...PARAMS, inviterName: 'Lovelace' });
      expect(sent[0].subject).toBe('Lovelace invites you to try Liftoff');
    });

    // Both names absent. The service passes '' after trimming, so this stands in
    // for firstName and lastName both being null.
    it.each(['', '   ', undefined])('falls back to the workspace when there is no name (%p)', async (inviterName) => {
      await sendReferralInviteEmail('jordan@example.com', { ...PARAMS, inviterName });
      expect(sent[0].subject).toBe('Northwind Trading invites you to try Liftoff');
      expect(sent[0].html).not.toContain('undefined');
    });

    // No name AND a workspace nobody renamed: there is nothing to credit, so
    // the email says so rather than announcing "Personal Workspace invites you".
    it.each(['', undefined])('goes fully unnamed when the workspace is also a default (%p)', async (inviterName) => {
      await sendReferralInviteEmail('jordan@example.com', {
        ...PARAMS,
        workspaceName: 'Personal Workspace',
        inviterName,
      });

      const email = sent[0];
      expect(email.subject).toBe('You have been invited to try Liftoff');
      expect(email.html).toContain('Someone using Liftoff to run an AI workforce recommends it to you.');
      expect(email.html).not.toContain('Personal Workspace');
      expect(email.html).not.toContain('undefined');
      // Nobody to credit, so the From stays plain rather than naming a
      // workspace the customer never chose.
      expect(email.from).toBe(`"Liftoff" <${MAIL_FROM}>`);
      expect(email.emailType).toBe('referral-invite');
    });
  });
});
