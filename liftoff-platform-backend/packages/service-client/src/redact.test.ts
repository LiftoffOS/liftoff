import { redactHeaders, redactUrl } from './redact.js';

describe('redactHeaders', () => {
  it('redacts Authorization, Cookie, X-Service-Auth, etc', () => {
    const out = redactHeaders({
      Authorization: 'Bearer abc',
      Cookie: 'session=xyz',
      'X-Service-Auth': 'token',
      'X-Api-Key': 'key',
      'Content-Type': 'application/json',
    });
    expect(out.Authorization).toBe('[REDACTED]');
    expect(out.Cookie).toBe('[REDACTED]');
    expect(out['X-Service-Auth']).toBe('[REDACTED]');
    expect(out['X-Api-Key']).toBe('[REDACTED]');
    expect(out['Content-Type']).toBe('application/json');
  });

  it('is case-insensitive on header names', () => {
    const out = redactHeaders({ AUTHORIZATION: 'Bearer x' });
    expect(out.AUTHORIZATION).toBe('[REDACTED]');
  });

  it('honours extra header names from options', () => {
    const out = redactHeaders({ 'X-Custom-Secret': 'value' }, { extraHeaderNames: ['X-Custom-Secret'] });
    expect(out['X-Custom-Secret']).toBe('[REDACTED]');
  });

  it('supports custom replacement', () => {
    const out = redactHeaders({ Authorization: 'Bearer x' }, { replacement: '***' });
    expect(out.Authorization).toBe('***');
  });
});

describe('redactUrl', () => {
  it('redacts sensitive query params', () => {
    const out = redactUrl('https://api.example.com/oauth?code=abc&state=ok&access_token=xyz');
    const u = new URL(out);
    expect(u.searchParams.get('code')).toBe('[REDACTED]');
    expect(u.searchParams.get('access_token')).toBe('[REDACTED]');
    expect(u.searchParams.get('state')).toBe('ok');
  });

  it('leaves URLs without sensitive params untouched', () => {
    const url = 'https://api.example.com/foo?bar=baz';
    expect(redactUrl(url)).toBe(url);
  });

  it('returns non-URL strings unchanged', () => {
    expect(redactUrl('not a url')).toBe('not a url');
  });

  it('honours extra query params from options', () => {
    const out = redactUrl('https://api.example.com/?custom_secret=x', {
      extraQueryParams: ['custom_secret'],
    });
    expect(new URL(out).searchParams.get('custom_secret')).toBe('[REDACTED]');
  });
});
