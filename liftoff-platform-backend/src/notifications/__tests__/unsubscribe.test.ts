// Unit tests for the unsubscribe token module (plan §7f verification table).
//   • valid token round-trip
//   • tampered payload → null
//   • expired token → null
//   • unknown action → null
//   • URL builders shape

import {
  buildUnsubscribeToken,
  buildEmailUnsubscribeUrl,
  buildListUnsubscribeUrl,
  verifyAndDecodeToken,
} from '../unsubscribe';

const ACCOUNT_ID = '11111111-2222-3333-4444-555555555555';

beforeAll(() => {
  process.env.UNSUBSCRIBE_SECRET = 'test-secret-do-not-use-in-prod';
  process.env.FRONTEND_URL = 'https://app.test.local';
  process.env.BACKEND_URL = 'https://api.test.local';
});

describe('buildUnsubscribeToken / verifyAndDecodeToken round-trip', () => {
  it('decodes a freshly-built valid token', () => {
    const token = buildUnsubscribeToken(ACCOUNT_ID, 'disable:taskUpdates');
    const decoded = verifyAndDecodeToken(token);
    expect(decoded).toEqual({ accountId: ACCOUNT_ID, action: 'disable:taskUpdates' });
  });

  it('decodes every valid action variant', () => {
    for (const action of [
      'disable:taskUpdates',
      'disable:teamActivity',
      'disable:escalations',
      'disable:weeklyDigest',
      'disable:newsletter',
      'cadence:none',
    ] as const) {
      const token = buildUnsubscribeToken(ACCOUNT_ID, action);
      expect(verifyAndDecodeToken(token)?.action).toBe(action);
    }
  });
});

describe('verifyAndDecodeToken failure modes', () => {
  it('returns null for a tampered payload', () => {
    const token = buildUnsubscribeToken(ACCOUNT_ID, 'disable:taskUpdates');
    // Flip a single character in the payload portion (before the dot).
    const dot = token.indexOf('.');
    const tampered = token.slice(0, dot - 1) + (token[dot - 1] === 'a' ? 'b' : 'a') + token.slice(dot);
    expect(verifyAndDecodeToken(tampered)).toBeNull();
  });

  it('returns null for a tampered signature', () => {
    const token = buildUnsubscribeToken(ACCOUNT_ID, 'disable:taskUpdates');
    const tampered = token.slice(0, -1) + (token.slice(-1) === 'a' ? 'b' : 'a');
    expect(verifyAndDecodeToken(tampered)).toBeNull();
  });

  it('returns null for an expired token', () => {
    // Manually craft a token with exp in the past, signed with the same secret.
    const crypto = require('crypto') as typeof import('crypto');
    const expired = Buffer.from(
      JSON.stringify({
        aid: ACCOUNT_ID,
        act: 'disable:taskUpdates',
        exp: Math.floor(Date.now() / 1000) - 60,
      }),
    )
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const sig = crypto
      .createHmac('sha256', process.env.UNSUBSCRIBE_SECRET!)
      .update(expired)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const token = `${expired}.${sig}`;
    expect(verifyAndDecodeToken(token)).toBeNull();
  });

  it('returns null for an unknown action', () => {
    const crypto = require('crypto') as typeof import('crypto');
    const payload = Buffer.from(
      JSON.stringify({
        aid: ACCOUNT_ID,
        act: 'disable:somethingElse',
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    )
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const sig = crypto
      .createHmac('sha256', process.env.UNSUBSCRIBE_SECRET!)
      .update(payload)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(verifyAndDecodeToken(`${payload}.${sig}`)).toBeNull();
  });

  it('returns null when the token has no dot separator', () => {
    expect(verifyAndDecodeToken('garbage-no-dot')).toBeNull();
  });

  it('returns null when the payload is not valid JSON', () => {
    const crypto = require('crypto') as typeof import('crypto');
    const garbage = 'not-base64-json';
    const sig = crypto
      .createHmac('sha256', process.env.UNSUBSCRIBE_SECRET!)
      .update(garbage)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(verifyAndDecodeToken(`${garbage}.${sig}`)).toBeNull();
  });
});

describe('UNSUBSCRIBE_SECRET guard', () => {
  const ORIGINAL = process.env.UNSUBSCRIBE_SECRET;
  afterEach(() => {
    process.env.UNSUBSCRIBE_SECRET = ORIGINAL;
  });

  it('buildUnsubscribeToken throws when UNSUBSCRIBE_SECRET is unset', () => {
    delete process.env.UNSUBSCRIBE_SECRET;
    expect(() => buildUnsubscribeToken(ACCOUNT_ID, 'disable:taskUpdates')).toThrow(
      /UNSUBSCRIBE_SECRET is not configured/,
    );
  });

  it('verifyAndDecodeToken returns null when UNSUBSCRIBE_SECRET is unset, even for tokens that would otherwise verify', () => {
    // Build a valid token while the secret is set, then delete the secret and verify.
    process.env.UNSUBSCRIBE_SECRET = 'test-secret-do-not-use-in-prod';
    const token = buildUnsubscribeToken(ACCOUNT_ID, 'disable:taskUpdates');
    delete process.env.UNSUBSCRIBE_SECRET;
    expect(verifyAndDecodeToken(token)).toBeNull();
  });
});

describe('URL builders', () => {
  it('buildEmailUnsubscribeUrl points at the FRONTEND with ?unsubscribe_token=', () => {
    const url = buildEmailUnsubscribeUrl(ACCOUNT_ID, 'disable:taskUpdates');
    expect(url).toMatch(/^https:\/\/app\.test\.local\/\?unsubscribe_token=/);
    // The token portion must round-trip via verifyAndDecodeToken.
    const token = url.split('unsubscribe_token=')[1];
    expect(verifyAndDecodeToken(token)).toEqual({
      accountId: ACCOUNT_ID,
      action: 'disable:taskUpdates',
    });
  });

  it('buildListUnsubscribeUrl points at the BACKEND /unsubscribe-direct endpoint', () => {
    const url = buildListUnsubscribeUrl(ACCOUNT_ID, 'cadence:none');
    expect(url).toMatch(
      /^https:\/\/api\.test\.local\/api\/notifications\/unsubscribe-direct\?token=/,
    );
    const token = url.split('token=')[1];
    expect(verifyAndDecodeToken(token)).toEqual({
      accountId: ACCOUNT_ID,
      action: 'cadence:none',
    });
  });
});
