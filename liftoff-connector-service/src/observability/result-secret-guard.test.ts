// Unit tests for the connector-result credential echo guard.

import { create } from '@bufbuild/protobuf';
import type { JsonObject } from '@bufbuild/protobuf';
import { ExecuteResponseSchema } from '@liftoffos/proto-gen/liftoff/connector/v1/connector_service_pb.js';

const mockWarn = jest.fn();
const mockError = jest.fn();
jest.mock('../infra/logging.js', () => ({
  logger: {
    info: jest.fn(),
    warn: (...a: unknown[]) => mockWarn(...a),
    error: (...a: unknown[]) => mockError(...a),
    debug: jest.fn(),
  },
}));

import { collectSecretValues, redactResponseSecrets } from './result-secret-guard.js';

const ctx = { connectorType: 'test', functionName: 'fn' };

function okResponse(result: JsonObject) {
  return create(ExecuteResponseSchema, { success: true, result });
}
function errResponse(error: string) {
  return create(ExecuteResponseSchema, { success: false, error, errorCode: 'auth_expired' });
}

beforeEach(() => {
  mockWarn.mockClear();
  mockError.mockClear();
  delete process.env.CONNECTOR_CREDENTIAL_ECHO_FAIL_CLOSED;
});
// Clear after each too, so the opt-in flag (set in tests 14/15) can never leak
// into a later suite sharing the process under --runInBand.
afterEach(() => {
  delete process.env.CONNECTOR_CREDENTIAL_ECHO_FAIL_CLOSED;
});

describe('collectSecretValues', () => {
  it('skips placeholder ("REDACTED") and short (<8) values', () => {
    expect(collectSecretValues({ accessToken: 'REDACTED' })).toEqual([]);
    expect(collectSecretValues({ apiKey: 'abc' })).toEqual([]);
    expect(collectSecretValues(undefined)).toEqual([]);
  });

  it('emits literal + base64 + url-encoded variants, longest-first', () => {
    const token = 'tok/with+special=chars&here12345';
    const needles = collectSecretValues({ apiKey: token });
    expect(needles).toContain(token);
    expect(needles).toContain(Buffer.from(token).toString('base64'));
    expect(needles).toContain(encodeURIComponent(token));
    // longest-first ordering
    for (let i = 1; i < needles.length; i++) {
      expect(needles[i - 1].length).toBeGreaterThanOrEqual(needles[i].length);
    }
  });

  it('includes the platform x402 wallet CDP credentials in EVERY needle set', () => {
    process.env.CDP_API_KEY_ID = 'cdp-key-id-0123456789';
    process.env.CDP_API_KEY_SECRET = 'cdp-key-secret-0123456789';
    process.env.CDP_WALLET_SECRET = 'cdp-wallet-secret-0123456789';
    try {
      // With per-connector creds…
      const withCreds = collectSecretValues({ apiKey: 'a-connector-key-12345' });
      // …and with none at all (composio_managed): the wallet secrets still scrub.
      const withoutCreds = collectSecretValues(undefined);
      for (const needles of [withCreds, withoutCreds]) {
        expect(needles).toContain('cdp-key-id-0123456789');
        expect(needles).toContain('cdp-key-secret-0123456789');
        expect(needles).toContain('cdp-wallet-secret-0123456789');
      }
    } finally {
      delete process.env.CDP_API_KEY_ID;
      delete process.env.CDP_API_KEY_SECRET;
      delete process.env.CDP_WALLET_SECRET;
    }
  });
});

describe('redactResponseSecrets — value layer', () => {
  it('1. redacts an opaque key echoed verbatim in the result (value hit → error-level anomaly, redact-and-continue by default)', () => {
    const creds = { apiKey: 'pipedrive_secret_abcdef123456' };
    const needles = collectSecretValues(creds);
    const r = okResponse({ data: { echoed: 'x pipedrive_secret_abcdef123456 y' } });
    redactResponseSecrets(r, needles, ctx);
    const s = JSON.stringify(r.result);
    expect(s).not.toContain('pipedrive_secret_abcdef123456');
    expect(s).toContain('[REDACTED]');
    // default (fail-closed off): redact-and-continue, response stays successful
    expect(r.success).toBe(true);
    // value hit is an ERROR-level anomaly event, NOT the benign warn event
    expect(mockError.mock.calls[0][0]).toMatchObject({
      event: 'connector_result_credential_echo_detected',
      valueHits: 1,
    });
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('2. redacts the base64 form of a secret', () => {
    const token = 'super-secret-token-value-1234567890';
    const b64 = Buffer.from(token).toString('base64');
    const needles = collectSecretValues({ accessToken: token });
    const r = okResponse({ blob: `prefix ${b64} suffix` });
    redactResponseSecrets(r, needles, ctx);
    const s = JSON.stringify(r.result);
    expect(s).not.toContain(b64);
    expect(s).toContain('[REDACTED]');
  });

  it('3. redacts the URL-encoded form of a secret', () => {
    const token = 'tok/with+special=chars&here12345';
    const enc = encodeURIComponent(token);
    expect(enc).not.toEqual(token);
    const needles = collectSecretValues({ apiKey: token });
    const r = okResponse({ link: `https://x/cb?t=${enc}` });
    redactResponseSecrets(r, needles, ctx);
    expect(JSON.stringify(r.result)).not.toContain(enc);
  });

  it('3b. redacts the hex form of a secret', () => {
    const token = 'hex-echoable-secret-value-123456';
    const hex = Buffer.from(token).toString('hex');
    const needles = collectSecretValues({ accessToken: token });
    const r = okResponse({ debug: `raw=${hex}` });
    redactResponseSecrets(r, needles, ctx);
    expect(JSON.stringify(r.result)).not.toContain(hex);
    expect(JSON.stringify(r.result)).toContain('[REDACTED]');
  });

  it('3c. redacts the HTTP-Basic base64 pair forms of a secret', () => {
    const token = 'basic-auth-echoable-secret-1234';
    const asUser = Buffer.from(`${token}:`).toString('base64');
    const asPass = Buffer.from(`:${token}`).toString('base64');
    const needles = collectSecretValues({ apiKey: token });
    const r = okResponse({ echoedAuthUser: asUser, echoedAuthPass: asPass });
    redactResponseSecrets(r, needles, ctx);
    const s = JSON.stringify(r.result);
    expect(s).not.toContain(asUser);
    expect(s).not.toContain(asPass);
  });

  it('4. never redacts instanceUrl (not a SecretCreds field); redacts the token beside it', () => {
    const needles = collectSecretValues({ accessToken: 'longtokenvalue1234' });
    const r = okResponse({ url: 'https://acme.my.salesforce.com', tok: 'longtokenvalue1234' });
    redactResponseSecrets(r, needles, ctx);
    const s = JSON.stringify(r.result);
    expect(s).toContain('https://acme.my.salesforce.com');
    expect(s).not.toContain('longtokenvalue1234');
  });

  it('5. does not redact the literal word REDACTED (placeholder skipped)', () => {
    const needles = collectSecretValues({ accessToken: 'REDACTED' });
    const r = okResponse({ note: 'the value was REDACTED by vendor' });
    redactResponseSecrets(r, needles, ctx);
    expect(r.result).toEqual({ note: 'the value was REDACTED by vendor' });
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('6. does not redact a short (<8) secret substring', () => {
    const needles = collectSecretValues({ apiKey: 'abc' });
    const r = okResponse({ s: 'abc def abc' });
    redactResponseSecrets(r, needles, ctx);
    expect(r.result).toEqual({ s: 'abc def abc' });
  });
});

describe('redactResponseSecrets — format layer', () => {
  it('7. redacts a recognizable prefixed key from a foreign source (no matching creds)', () => {
    const key = `sk-ant-api03-${'A'.repeat(40)}`;
    const r = okResponse({ note: `key ${key}` });
    redactResponseSecrets(r, [], ctx);
    const s = JSON.stringify(r.result);
    expect(s).not.toContain(key);
    expect(s).toContain('[REDACTED]');
    // format hit is the benign WARN event, NOT the value-echo anomaly
    expect(mockWarn.mock.calls[0][0]).toMatchObject({
      event: 'connector_result_secret_redacted',
      formatHits: 1,
    });
    expect(mockError).not.toHaveBeenCalled();
  });

  it('8. does not false-positive on a git SHA or a bare JWT', () => {
    const r = okResponse({
      sha: 'a'.repeat(40),
      token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dummysignaturevalue',
    });
    redactResponseSecrets(r, [], ctx);
    expect(JSON.stringify(r.result)).not.toContain('[REDACTED]');
    expect(mockWarn).not.toHaveBeenCalled();
  });
});

describe('redactResponseSecrets — error string, no-op, nesting, fail-open', () => {
  it('9. redacts a secret echoed in the error string', () => {
    const token = 'longsecrettoken1234567890';
    const needles = collectSecretValues({ accessToken: token });
    const r = errResponse(`Auth failed for ${token}`);
    redactResponseSecrets(r, needles, ctx);
    expect(r.error).not.toContain(token);
    expect(r.error).toContain('[REDACTED]');
  });

  it('10. leaves a clean result untouched and does not log', () => {
    const r = okResponse({ ok: true, name: 'hello world' });
    redactResponseSecrets(r, [], ctx);
    expect(r.result).toEqual({ ok: true, name: 'hello world' });
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('11. redacts secrets nested inside objects and arrays', () => {
    const token = 'deepnestedsecret1234567890';
    const needles = collectSecretValues({ apiKey: token });
    const r = okResponse({ a: [{ b: `x ${token} y` }, { c: [token] }] });
    redactResponseSecrets(r, needles, ctx);
    const s = JSON.stringify(r.result);
    expect(s).not.toContain(token);
    expect(s.match(/\[REDACTED\]/g)?.length).toBe(2);
  });

  it('12. fails open: returns the original response when redaction throws', () => {
    const r = okResponse({ x: 'y' });
    Object.defineProperty(r, 'result', {
      get() {
        throw new Error('boom');
      },
    });
    const out = redactResponseSecrets(r, [], ctx);
    expect(out).toBe(r);
    expect(
      mockWarn.mock.calls.some(
        (c) => (c[0] as { event?: string }).event === 'connector_result_secret_redaction_failed',
      ),
    ).toBe(true);
  });
});

describe('redactResponseSecrets — fail-closed (value hits only, opt-in)', () => {
  const token = 'failclosed-echoed-secret-1234567890';

  it('13. fail-closed OFF (default): value hit is redacted-and-returned, response stays successful', () => {
    const needles = collectSecretValues({ apiKey: token });
    const r = okResponse({ leaked: `token=${token}` });
    redactResponseSecrets(r, needles, ctx);
    expect(r.success).toBe(true);
    expect(JSON.stringify(r.result)).toContain('[REDACTED]');
    expect(JSON.stringify(r.result)).not.toContain(token);
  });

  it('14. fail-closed ON: value hit refuses the whole result with a safe error (no secret)', () => {
    process.env.CONNECTOR_CREDENTIAL_ECHO_FAIL_CLOSED = 'true';
    const needles = collectSecretValues({ apiKey: token });
    const r = okResponse({ leaked: `token=${token}`, other: 'data' });
    redactResponseSecrets(r, needles, ctx);
    expect(r.success).toBe(false);
    expect(r.result).toBeUndefined();
    expect(r.errorCode).toBe('internal_error');
    expect(r.retryable).toBe(false);
    expect(r.error).toContain('fail-closed');
    // the refused error must not carry the secret (nor a redacted remnant of the result)
    expect(r.error).not.toContain(token);
    expect(r.error).not.toContain('other');
    expect(mockError.mock.calls[0][0]).toMatchObject({
      event: 'connector_result_credential_echo_detected',
      failClosed: true,
    });
  });

  it('15. fail-closed ON never applies to a FORMAT-only hit (benign third-party secret)', () => {
    process.env.CONNECTOR_CREDENTIAL_ECHO_FAIL_CLOSED = 'true';
    const key = `ghp_${'A'.repeat(36)}`;
    const r = okResponse({ note: `found ${key}` });
    redactResponseSecrets(r, [], ctx); // no creds → format layer only
    expect(r.success).toBe(true); // NOT refused
    expect(JSON.stringify(r.result)).toContain('[REDACTED]');
    expect(mockWarn).toHaveBeenCalled();
    expect(mockError).not.toHaveBeenCalled();
  });
});
