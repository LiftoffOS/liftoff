// The one URL projection, as this runtime re-exports it: what it keeps, what
// it replaces, and that it travels.
//
// Kept: the HTTP(S) origin, the path with its resource ids, ordinary query
// parameters and SPA fragments. Replaced: URL credentials, protected
// parameter values, and on a callback route the protocol code, state and
// opaque path tokens. The full table lives with the implementation in
// @liftoffos/redact; this file pins the contract this runtime relies on and,
// because the recorder embeds the function's SOURCE into the page, that it
// depends on nothing outside its own body in a bare realm.

import { recordedUrl, RECORDED_URL_CAP } from '../route-template';

describe('recordedUrl (re-exported)', () => {
  it('keeps origin, path, resource ids, query and fragment', () => {
    expect(recordedUrl('https://app.example.com/orders/3f2a91b8-c07d-4e65-9a1b-0d3e5f7a9b1c/edit?tab=1&q=browser#row-4'))
      .toEqual({ text: 'https://app.example.com/orders/3f2a91b8-c07d-4e65-9a1b-0d3e5f7a9b1c/edit?tab=1&q=browser#row-4', truncated: false, protectedDataOmitted: false });
  });

  it('keeps long ids on an ordinary resource route', () => {
    expect(recordedUrl('https://a.example/share/aB3dE5fG7hI9jK1lM2nO4p').text).toBe('https://a.example/share/aB3dE5fG7hI9jK1lM2nO4p');
    expect(recordedUrl('https://a.example/invoices/123456789012').text).toBe('https://a.example/invoices/123456789012');
  });

  it('replaces a protected parameter and says so', () => {
    expect(recordedUrl('https://a.example/x?access_token=abc&page=2'))
      .toEqual({ text: 'https://a.example/x?access_token=[redacted]&page=2', truncated: false, protectedDataOmitted: true });
  });

  it('keeps a generic key, state, code, session or auth parameter', () => {
    const url = 'https://a.example/search?key=quarterly&state=open&code=SPRING25&session=42&auth=required';
    expect(recordedUrl(url)).toEqual({ text: url, truncated: false, protectedDataOmitted: false });
  });

  it('on a callback route also redacts the protocol code and state and an opaque path token', () => {
    expect(recordedUrl('https://a.example/oauth/callback?code=abc&state=xyz').text).toBe('https://a.example/oauth/callback?code=[redacted]&state=[redacted]');
    expect(recordedUrl('https://a.example/reset-password/3f2a91b8c07d4e659a1b0d3e5f7a9b1c').text).toBe('https://a.example/reset-password/[redacted]');
  });

  it('strips URL credentials', () => {
    expect(recordedUrl('https://jane:pw@a.example/reports')).toEqual({ text: 'https://a.example/reports', truncated: false, protectedDataOmitted: true });
  });

  it('caps at 2,048 characters and reports the cut', () => {
    const out = recordedUrl('https://a.example/' + 'a/'.repeat(1200));
    expect(out.text).toHaveLength(RECORDED_URL_CAP);
    expect(out.truncated).toBe(true);
  });

  it('handles hostless and unparsable input without throwing', () => {
    expect(recordedUrl('about:blank').text).toBe('about:blank');
    expect(recordedUrl('not a url?x=1#f').text).toBe('not a url?x=1#f');
    expect(recordedUrl('').text).toBe('');
    expect(recordedUrl(undefined as unknown as string).text).toBe('');
  });

  it('is self-contained: its source evaluates in a bare realm and agrees with itself', () => {
    // The recorder embeds `recordedUrl.toString()` into the page. A reference
    // to a module-level constant would be undefined there and fail silently
    // on the first navigation.
    const source = recordedUrl.toString();
    expect(source).not.toMatch(/require\(|import\(|exports\./);
    const evaluated = new Function(`return (${source});`)() as typeof recordedUrl;
    for (const url of [
      'https://a.example/orders/3f2a91b8c07d4e65/edit?tab=1#x',
      'https://a.example/oauth/callback?code=abc&state=s',
      'https://jane:pw@a.example/x?token=t',
      'https://a.example/app#/orders/8812?tab=history',
      'about:blank',
    ]) {
      expect(evaluated(url)).toEqual(recordedUrl(url));
    }
  });
});
