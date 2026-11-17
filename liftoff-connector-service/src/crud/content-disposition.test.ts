// A document title is user text, and it must never reach a header raw.
//
// Node rejects any header value outside Latin-1, so a title carrying an em
// dash, a curly quote or an emoji made res.setHeader throw ERR_INVALID_CHAR
// and the route return 500 — a file that is not slow or forbidden, but
// permanently unreadable.

import { createServer, get as httpGet, type ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { contentDisposition } from './router';

/** What Node itself does with the value, which is the only opinion that counts. */
async function setHeaderOnRealResponse(value: string): Promise<{ ok: boolean; code?: string }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res: ServerResponse) => {
      try {
        res.setHeader('Content-Disposition', value);
        res.end('ok');
        resolve({ ok: true });
      } catch (err) {
        res.statusCode = 500;
        res.end('err');
        resolve({ ok: false, code: (err as NodeJS.ErrnoException).code });
      }
    });
    server.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      httpGet({ port }, (res) => { res.resume(); res.on('end', () => server.close()); });
    });
  });
}

/** Above Latin-1. Node throws on these, so raw interpolation is a 500. */
const ABOVE_LATIN1 = [
  ['an em dash', 'Competitor snapshot — week 36'],
  ['curly quotes', '“Q3 board pack”'],
  ['an ellipsis', 'Draft… v2'],
  ['an emoji', 'Launch plan 🚀'],
] as const;

/** Inside Latin-1. Node accepts these raw, so they are not what broke — but
 *  the byte a client reads is charset-dependent, so they are encoded too
 *  rather than left to chance. */
const LATIN1_NON_ASCII = [
  ['an accented letter', 'Résumé for Ada Lovelace'],
  ['a section sign', '§4 pricing review'],
] as const;

const HOSTILE = [...ABOVE_LATIN1, ...LATIN1_NON_ASCII] as const;

describe('contentDisposition', () => {
  it.each(HOSTILE)('produces a header Node accepts for %s', async (_label, title) => {
    const result = await setHeaderOnRealResponse(contentDisposition(title));
    expect(result).toEqual({ ok: true });
  });

  it.each(ABOVE_LATIN1)('the raw title would NOT have been accepted — %s', async (_label, title) => {
    // Guards the reason this helper exists. If Node ever starts accepting
    // these, this test says so rather than the helper quietly being pointless.
    // Only the above-Latin-1 set: Node takes é and § raw, which is why the
    // failure looked arbitrary from the outside.
    const result = await setHeaderOnRealResponse(`attachment; filename="${title}"`);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('ERR_INVALID_CHAR');
  });

  it('carries the real name in filename* so nothing is lost', () => {
    const value = contentDisposition('Competitor snapshot — week 36');
    expect(value).toContain("filename*=UTF-8''");
    expect(decodeURIComponent(value.split("filename*=UTF-8''")[1])).toBe('Competitor snapshot — week 36');
  });

  it('keeps an ASCII name exactly as it was', () => {
    expect(contentDisposition('report.csv')).toContain('filename="report.csv"');
  });

  it('does not let a quote or backslash end the quoted string early', () => {
    const value = contentDisposition('we"ird\\name.txt');
    const quoted = value.slice(value.indexOf('filename="') + 10);
    expect(quoted.slice(0, quoted.indexOf('"'))).toBe('we_ird_name.txt');
  });

  it.each(LATIN1_NON_ASCII)('encodes %s even though Node would take it raw', (_label, title) => {
    expect(decodeURIComponent(contentDisposition(title).split("filename*=UTF-8''")[1])).toBe(title);
  });

  it('keeps two different titles different', () => {
    // Replacing rather than dropping: otherwise "a—b" and "ab" collide.
    expect(contentDisposition('a—b')).not.toEqual(contentDisposition('ab'));
  });

  it('falls back to a name rather than emitting an empty one', () => {
    expect(contentDisposition('')).toContain('filename="download"');
  });
});
