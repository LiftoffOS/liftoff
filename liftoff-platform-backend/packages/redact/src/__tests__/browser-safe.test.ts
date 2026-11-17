// The browser record's sanitizers, table by table: what a safe URL keeps and
// what it replaces, what browser text loses and what it must not lose, and
// that `recordedUrl` travels as bare source.

import { recordedUrl, sanitizeBrowserText, RECORDED_URL_CAP } from '../browser-safe';

describe('recordedUrl keeps fidelity data', () => {
  it.each([
    ['an ordinary resource route with a long id', 'https://shop.example.com/orders/3f2a91b8-c07d-4e65-9a1b-0d3e5f7a9b1c/edit'],
    ['a 16-hex id on a resource route', 'https://a.example/orders/3f2a91b8c07d4e65/edit'],
    ['a query filter', 'https://a.example/issues?q=is%3Aopen+label%3Abug&sort=updated&page=2'],
    ['an SPA fragment route with its own query', 'https://a.example/app#/orders/8812?tab=history&filter=open'],
    ['an anchor fragment', 'https://docs.example/guide/install#step-4'],
    ['a generic `key` parameter', 'https://a.example/search?key=quarterly-report'],
    ['a generic `state` parameter', 'https://a.example/list?state=open'],
    ['a generic `code` parameter on an ordinary route', 'https://a.example/promo?code=SPRING25'],
    ['a generic `session` parameter', 'https://a.example/sessions?session=42'],
    ['a generic `auth` parameter', 'https://a.example/report?auth=required'],
    ['a long mixed id on an ordinary route', 'https://a.example/share/aB3dE5fG7hI9jK1lM2nO4p'],
  ])('keeps %s verbatim', (_label, url) => {
    expect(recordedUrl(url)).toEqual({ text: url, truncated: false, protectedDataOmitted: false });
  });
});

describe('recordedUrl replaces protected components', () => {
  it.each([
    ['password', 'https://a.example/x?password=hunter2', 'https://a.example/x?password=[redacted]'],
    ['passcode', 'https://a.example/x?passcode=1234', 'https://a.example/x?passcode=[redacted]'],
    ['secret', 'https://a.example/x?secret=abc', 'https://a.example/x?secret=[redacted]'],
    ['token', 'https://a.example/x?token=abc', 'https://a.example/x?token=[redacted]'],
    ['access_token', 'https://a.example/x?access_token=abc&q=1', 'https://a.example/x?access_token=[redacted]&q=1'],
    ['refreshToken (camel)', 'https://a.example/x?refreshToken=abc', 'https://a.example/x?refreshToken=[redacted]'],
    ['api_key', 'https://a.example/x?api_key=abc', 'https://a.example/x?api_key=[redacted]'],
    ['x-api-key (kebab prefix)', 'https://a.example/x?x-api-key=abc', 'https://a.example/x?x-api-key=[redacted]'],
    ['accessKey', 'https://a.example/x?accessKey=abc', 'https://a.example/x?accessKey=[redacted]'],
    ['private_key', 'https://a.example/x?private_key=abc', 'https://a.example/x?private_key=[redacted]'],
    ['signature', 'https://a.example/x?signature=abc', 'https://a.example/x?signature=[redacted]'],
    ['sig', 'https://a.example/x?sig=abc', 'https://a.example/x?sig=[redacted]'],
    ['credential', 'https://a.example/x?credential=abc', 'https://a.example/x?credential=[redacted]'],
    ['session_id', 'https://a.example/x?session_id=abc', 'https://a.example/x?session_id=[redacted]'],
    ['sessionid', 'https://a.example/x?sessionid=abc', 'https://a.example/x?sessionid=[redacted]'],
    ['jwt', 'https://a.example/x?jwt=abc', 'https://a.example/x?jwt=[redacted]'],
    ['SAMLResponse', 'https://a.example/x?SAMLResponse=abc', 'https://a.example/x?SAMLResponse=[redacted]'],
    ['assertion', 'https://a.example/x?assertion=abc', 'https://a.example/x?assertion=[redacted]'],
    ['auth_token', 'https://a.example/x?auth_token=abc', 'https://a.example/x?auth_token=[redacted]'],
    ['otp', 'https://a.example/x?otp=123456', 'https://a.example/x?otp=[redacted]'],
    ['pin', 'https://a.example/x?pin=1234', 'https://a.example/x?pin=[redacted]'],
    ['cvv', 'https://a.example/x?cvv=123', 'https://a.example/x?cvv=[redacted]'],
    ['cvc', 'https://a.example/x?cvc=123', 'https://a.example/x?cvc=[redacted]'],
    ['card_number', 'https://a.example/x?card_number=4111', 'https://a.example/x?card_number=[redacted]'],
    ['user_token suffix form', 'https://a.example/x?user_token=abc', 'https://a.example/x?user_token=[redacted]'],
    ['a token inside an SPA fragment query', 'https://a.example/app#/verify?tab=1&token=abc', 'https://a.example/app#/verify?tab=1&token=[redacted]'],
    ['an implicit-flow fragment', 'https://a.example/cb#access_token=abc&token_type=bearer&expires_in=3600', 'https://a.example/cb#access_token=[redacted]&token_type=[redacted]&expires_in=3600'],
  ])('replaces %s', (_label, url, expected) => {
    expect(recordedUrl(url)).toEqual({ text: expected, truncated: false, protectedDataOmitted: true });
  });

  it('strips URL credentials', () => {
    expect(recordedUrl('https://jane:hunter2@a.example/reports?tab=1')).toEqual({
      text: 'https://a.example/reports?tab=1', truncated: false, protectedDataOmitted: true,
    });
  });

  it.each([
    ['an OAuth callback', 'https://a.example/oauth/callback?code=abc&state=xyz&next=%2Fhome', 'https://a.example/oauth/callback?code=[redacted]&state=[redacted]&next=%2Fhome'],
    ['a SAML acs', 'https://a.example/saml/acs?SAMLResponse=abc', 'https://a.example/saml/acs?SAMLResponse=[redacted]'],
    ['a password reset token in the path', 'https://a.example/reset-password/3f2a91b8c07d4e659a1b0d3e5f7a9b1c', 'https://a.example/reset-password/[redacted]'],
    ['a magic link', 'https://a.example/magic-link?token=abc', 'https://a.example/magic-link?token=[redacted]'],
    ['an invitation token', 'https://a.example/invites/aB3dE5fG7hI9jK1lM2nO4pQ6', 'https://a.example/invites/[redacted]'],
    ['a verification token', 'https://a.example/verify-email?code=987654', 'https://a.example/verify-email?code=[redacted]'],
    ['an SPA callback route', 'https://a.example/app#/oauth/callback?code=abc&state=s', 'https://a.example/app#/oauth/callback?code=[redacted]&state=[redacted]'],
  ])('on %s also redacts protocol code, state and opaque path tokens', (_label, url, expected) => {
    expect(recordedUrl(url)).toEqual({ text: expected, truncated: false, protectedDataOmitted: true });
  });

  // A hosted sign-in page carries the OAuth transaction state on a route no
  // callback list names (Auth0's `/u/login/identifier`, Okta's `/login/login.htm`).
  // The value's shape is what says it is a transaction, not a business value.
  it.each([
    ['an Auth0 universal-login state', 'https://login.example/u/login/identifier?state=hKFo2SBPTmVUeFRMZnFlSTlrWEYzTWY3OFJ5LUdFMmJianV1RaFur3VuaXZlcnNhbC1sb2dpbq', 'https://login.example/u/login/identifier?state=[redacted]'],
    ['a nonce on an authorize route', 'https://id.example/authorize?client_id=app&nonce=n0nc3V4lu3T0k3nSh4p3dXyZ12&scope=openid', 'https://id.example/authorize?client_id=app&nonce=[redacted]&scope=openid'],
    ['a session_state on a plain route', 'https://app.example/home?session_state=3f2a91b8c07d4e659a1b0d3e5f7a9b1c', 'https://app.example/home?session_state=[redacted]'],
    ['a token-shaped code on a plain route', 'https://app.example/continue?code=aB3dE5fG7hI9jK1lM2nO4pQ6rS8t', 'https://app.example/continue?code=[redacted]'],
  ])('on any route, %s is replaced by its shape', (_label, url, expected) => {
    expect(recordedUrl(url)).toEqual({ text: expected, truncated: false, protectedDataOmitted: true });
  });

  it.each([
    ['a business `state`', 'https://a.example/list?state=open'],
    ['a US state filter', 'https://a.example/stores?state=CA&city=SF'],
    ['a promo code', 'https://a.example/promo?code=SPRING25'],
    ['a short numeric code', 'https://a.example/lookup?code=987654'],
  ])('keeps %s on an ordinary route: a short plain value is not a transaction', (_label, url) => {
    expect(recordedUrl(url)).toEqual({ text: url, truncated: false, protectedDataOmitted: false });
  });
});

describe('recordedUrl bounds and non-URLs', () => {
  it('caps at 2,048 characters and says so', () => {
    const long = 'https://a.example/' + 'a/'.repeat(1200);
    const out = recordedUrl(long);
    expect(out.text).toHaveLength(RECORDED_URL_CAP);
    expect(out.truncated).toBe(true);
    expect(out.protectedDataOmitted).toBe(false);
  });

  it('keeps a hostless URL and strips its credentials only', () => {
    expect(recordedUrl('about:blank')).toEqual({ text: 'about:blank', truncated: false, protectedDataOmitted: false });
  });

  it('keeps non-URL text bounded without parsing it', () => {
    expect(recordedUrl('not a url?token=1')).toEqual({ text: 'not a url?token=1', truncated: false, protectedDataOmitted: false });
    expect(recordedUrl('')).toEqual({ text: '', truncated: false, protectedDataOmitted: false });
    expect(recordedUrl(undefined as unknown as string)).toEqual({ text: '', truncated: false, protectedDataOmitted: false });
  });

  it('is self-contained: its source evaluates in a bare realm and agrees with itself', () => {
    const source = recordedUrl.toString();
    expect(source).not.toMatch(/require\(|import\(|exports\.|redactSensitiveText|MARK_|CAP_/);
    const evaluated = new Function(`return (${source});`)() as typeof recordedUrl;
    for (const url of [
      'https://a.example/orders/3f2a91b8c07d4e65/edit?tab=1#x',
      'https://a.example/oauth/callback?code=abc&state=s',
      'https://jane:pw@a.example/x?token=t',
      'https://a.example/app#/orders/8812?tab=history',
      'about:blank',
      'not a url',
    ]) {
      expect(evaluated(url)).toEqual(recordedUrl(url));
    }
  });
});

describe('sanitizeBrowserText', () => {
  it('passes an embedded URL through recordedUrl and leaves the prose alone', () => {
    const out = sanitizeBrowserText('Open https://a.example/reset-password/3f2a91b8c07d4e659a1b0d3e5f7a9b1c?token=abc and read the banner.');
    expect(out.text).toBe('Open https://a.example/reset-password/[redacted]?token=[redacted] and read the banner.');
    expect(out.protectedDataOmitted).toBe(true);
    expect(out.truncated).toBe(false);
  });

  it.each([
    ['password=', 'sign in with password=hunter2 then continue', 'sign in with password=[redacted] then continue'],
    ['password:', 'use password: Tr0ub4dor&3 for the form', 'use password: [redacted] for the form'],
    ['OTP with no separator', 'enter OTP 123456 when asked', 'enter OTP [redacted] when asked'],
    ['CVV:', 'CVV: 123 goes in the last box', 'CVV: [redacted] goes in the last box'],
    ['api key =', 'the api key = sk-live-abcdef123456 is in the header', 'the api key = [redacted] is in the header'],
    ['a recovery code', 'recovery code: 1234-5678-90ab', 'recovery code: [redacted]'],
    ['a Luhn-valid card number', 'pay with 4111 1111 1111 1111 today', 'pay with [redacted] today'],
    ['an SSN', 'SSN 123-45-6789 on file', 'SSN [redacted] on file'],
    ['a labelled account number', 'account number: 000123456789', 'account number: [redacted]'],
  ])('removes %s', (_label, text, expected) => {
    expect(sanitizeBrowserText(text)).toEqual({ text: expected, truncated: false, protectedDataOmitted: true });
  });

  it.each([
    ['a business email', 'email jane.doe@acme.example about the Q3 numbers'],
    ['a postal address', 'ship to 221B Baker Street, London NW1 6XE'],
    ['an ordinary long number that fails Luhn', 'order 1234567890123456 is pending'],
    ['a phone number', 'call +1 415 555 0134'],
    ['a search term', 'search for "browser" in the issues list'],
    ['prose that mentions a password without a value', 'type the password in the field and press Enter'],
    ['a resource URL with a query', 'open https://a.example/issues?q=is%3Aopen&sort=updated and count them'],
    ['a promo code', 'apply code SPRING25 at checkout'],
  ])('keeps %s unchanged', (_label, text) => {
    expect(sanitizeBrowserText(text)).toEqual({ text, truncated: false, protectedDataOmitted: false });
  });

  it('applies the canonical credential redactor last', () => {
    const out = sanitizeBrowserText('paste ghp_' + 'a'.repeat(36) + ' into the box');
    expect(out.text).toBe('paste [REDACTED] into the box');
    expect(out.protectedDataOmitted).toBe(true);
  });

  it('caps after redaction and reports the cut', () => {
    const out = sanitizeBrowserText('x'.repeat(50) + ' password=hunter2', 60);
    expect(out.text).toHaveLength(60);
    expect(out.text).not.toContain('hunter2');
    expect(out.truncated).toBe(true);
    expect(out.protectedDataOmitted).toBe(true);
  });

  it('is idempotent: a text that already carries the mark is unchanged by a second pass', () => {
    const once = sanitizeBrowserText('could not open https://nope.example/?token=abc: net::ERR_NAME_NOT_RESOLVED');
    expect(once.text).toBe('could not open https://nope.example/?token=[redacted]: net::ERR_NAME_NOT_RESOLVED');
    const twice = sanitizeBrowserText(once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.protectedDataOmitted).toBe(false);
  });

  it('never treats the whole string as a URL', () => {
    expect(sanitizeBrowserText('token bucket refill rate').text).toBe('token bucket refill rate');
  });
});
