// Signup-approval token tests — HMAC roundtrip, tamper rejection, expiry, and
// unconfigured-secret refusal.

import * as crypto from 'crypto';
import { buildSignupApprovalToken, verifySignupApprovalToken } from './signup-approval-tokens';

const SECRET = 'test-signup-approval-secret';

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Re-sign a payload exactly like the module, so tests can craft tokens with
// arbitrary claims (e.g. an already-expired exp).
function sign(payloadObj: Record<string, unknown>): string {
  const payload = base64url(JSON.stringify(payloadObj));
  const sig = base64url(crypto.createHmac('sha256', SECRET).update(payload).digest());
  return `${payload}.${sig}`;
}

describe('signup-approval tokens', () => {
  const prev = process.env.SIGNUP_APPROVAL_SECRET;

  beforeEach(() => {
    process.env.SIGNUP_APPROVAL_SECRET = SECRET;
  });

  afterAll(() => {
    if (prev === undefined) delete process.env.SIGNUP_APPROVAL_SECRET;
    else process.env.SIGNUP_APPROVAL_SECRET = prev;
  });

  it('round-trips a valid token back to its accountId', () => {
    const token = buildSignupApprovalToken('acc-123');
    expect(verifySignupApprovalToken(token)).toEqual({ ok: true, accountId: 'acc-123' });
  });

  it('rejects a tampered signature as invalid', () => {
    const token = buildSignupApprovalToken('acc-123');
    const tampered = token.slice(0, -2) + (token.endsWith('aa') ? 'bb' : 'aa');
    expect(verifySignupApprovalToken(tampered)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a swapped payload (signature no longer matches) as invalid', () => {
    const token = buildSignupApprovalToken('acc-123');
    const sigWithDot = token.slice(token.indexOf('.'));
    const forgedPayload = base64url(JSON.stringify({ aid: 'acc-999', exp: 9999999999 }));
    expect(verifySignupApprovalToken(`${forgedPayload}${sigWithDot}`)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a token with no separator as invalid', () => {
    expect(verifySignupApprovalToken('not-a-token')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('reports a correctly-signed but expired token as expired', () => {
    const expired = sign({ aid: 'acc-123', exp: Math.floor(Date.now() / 1000) - 10 });
    expect(verifySignupApprovalToken(expired)).toEqual({ ok: false, reason: 'expired' });
  });

  it('treats a correctly-signed token missing its exp as invalid, not expired', () => {
    const noExp = sign({ aid: 'acc-123' });
    expect(verifySignupApprovalToken(noExp)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('refuses to build a token when the secret is unconfigured', () => {
    delete process.env.SIGNUP_APPROVAL_SECRET;
    expect(() => buildSignupApprovalToken('acc-123')).toThrow(/SIGNUP_APPROVAL_SECRET/);
  });

  it('rejects every token as invalid when the secret is unconfigured', () => {
    const token = buildSignupApprovalToken('acc-123'); // built while the secret is set
    delete process.env.SIGNUP_APPROVAL_SECRET;
    expect(verifySignupApprovalToken(token)).toEqual({ ok: false, reason: 'invalid' });
  });
});
