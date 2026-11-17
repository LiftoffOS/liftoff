import { redactUrl } from '../url-redactor';

describe('redactUrl', () => {
  it('redacts sensitive query parameters', () => {
    const out = redactUrl('https://example.com/x?token=abc&safe=hi');
    expect(out).toContain('token=%5BREDACTED%5D');
    expect(out).toContain('safe=hi');
  });

  it('redacts multiple sensitive params at once', () => {
    const out = redactUrl('https://x/y?api_key=k&password=p&email=e&keep=ok');
    expect(out).toContain('api_key=%5BREDACTED%5D');
    expect(out).toContain('password=%5BREDACTED%5D');
    expect(out).toContain('email=%5BREDACTED%5D');
    expect(out).toContain('keep=ok');
  });

  it('strips basic-auth credentials from the userinfo segment', () => {
    const out = redactUrl('https://user:pw@example.com/path');
    expect(out).not.toContain('user');
    expect(out).not.toContain('pw');
    expect(out).toContain('example.com/path');
  });

  it('returns [INVALID_URL] on malformed input', () => {
    expect(redactUrl('not a url')).toBe('[INVALID_URL]');
  });

  it('parameter matching is case-insensitive', () => {
    const out = redactUrl('https://x?Token=abc&Email=e');
    expect(out).toContain('Token=%5BREDACTED%5D');
    expect(out).toContain('Email=%5BREDACTED%5D');
  });
});
