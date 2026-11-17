// Looking at a file before handing it to a person.
//
// A fetch that returns bytes is not a fetch that returned the RIGHT bytes. A
// site that wants a sign-in answers a download with its login page; one that
// rate-limits answers with an error page; an expired link answers with a few
// hundred bytes of JSON. All three are successful responses, and all three
// reached the person as "here is your file".
//
// What is pinned hardest is the direction of the doubt. The structural check
// is certain and may refuse. The judgement is not, and an answer it cannot
// give reads as "fine": refusing to hand over a real file because a vendor
// timed out would be worse than the defect this exists for.

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockAsk = jest.fn();
jest.mock('../../typesafe/client', () => ({ ask: (...a: unknown[]) => mockAsk(...a) }));

import { checkFetchedFile, containerOf } from '../file-check';

const base = { objective: 'the invoice for September', tenantId: 't-1' };
const pdf = Buffer.concat([Buffer.from([0x25, 0x50, 0x44, 0x46]), Buffer.alloc(4_000, 1)]);
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(4_000, 1)]);
const html = Buffer.from('<!DOCTYPE html><html><body>Sign in to continue</body></html>');

/** The judgement, as the vendor shapes it. */
const judged = (noul: number) => mockAsk.mockResolvedValueOnce({ answers: { is_the_file: { noul } } });

beforeEach(() => jest.clearAllMocks());

describe('what the bytes are', () => {
  it('reads the container a file is actually in', () => {
    expect(containerOf(pdf)).toBe('pdf');
    expect(containerOf(png)).toBe('png');
    expect(containerOf(html)).toBe('html');
    expect(containerOf(Buffer.from('plain text, no signature'))).toBe('');
  });

  // The one that happens: a site wanting a sign-in answers a download with
  // its login page, and that is a valid HTML response to a request for a PDF.
  it('catches a web page served as the file, and says what it usually means', async () => {
    const out = await checkFetchedFile({ ...base, filename: 'invoice.pdf', contentType: 'application/pdf', bytes: html });
    expect(out.looksRight).toBe(false);
    expect(out.concern).toMatch(/web page rather than the application\/pdf/);
    expect(out.concern).toMatch(/sign-in, an expired link or an error page/);
    // Certain enough that nothing needs to be asked.
    expect(mockAsk).not.toHaveBeenCalled();
  });

  it('catches a web page with no declared type at all', async () => {
    const out = await checkFetchedFile({ ...base, filename: 'report', contentType: '', bytes: html });
    expect(out.looksRight).toBe(false);
    expect(out.concern).toMatch(/web page rather than a file/);
  });

  it('leaves a page alone when a page is what was fetched', async () => {
    judged(0.9);
    const out = await checkFetchedFile({ ...base, filename: 'page.html', contentType: 'text/html', bytes: html });
    expect(out.looksRight).toBe(true);
  });

  it('says a mismatch plainly for containers that are not pages', async () => {
    const out = await checkFetchedFile({ ...base, filename: 'clip.mp4', contentType: 'video/mp4', bytes: png });
    expect(out.looksRight).toBe(false);
    expect(out.concern).toMatch(/says it is video\/mp4 and its contents are not/);
  });

  it('refuses an empty file without asking anybody', async () => {
    const out = await checkFetchedFile({ ...base, filename: 'x.pdf', contentType: 'application/pdf', bytes: Buffer.alloc(0) });
    expect(out).toEqual({ looksRight: false, concern: 'that file came back empty' });
    expect(mockAsk).not.toHaveBeenCalled();
  });

  // A container with no signature is not evidence of anything either way.
  it('does not judge a csv on its bytes', async () => {
    judged(0.9);
    const out = await checkFetchedFile({ ...base, filename: 'rows.csv', contentType: 'text/csv', bytes: Buffer.from('a,b\n1,2') });
    expect(out.looksRight).toBe(true);
  });
});

describe('whether it is the file that was asked for', () => {
  it('passes an ordinary file of the right kind', async () => {
    judged(0.8);
    expect((await checkFetchedFile({ ...base, filename: 'invoice.pdf', contentType: 'application/pdf', bytes: pdf })).looksRight).toBe(true);
  });

  it('flags one the model says is not it, and says what arrived instead', async () => {
    judged(0.05);
    const out = await checkFetchedFile({ ...base, filename: 'error.json', contentType: 'application/json', bytes: Buffer.from('{"error":"expired"}') });
    expect(out.looksRight).toBe(false);
    expect(out.concern).toMatch(/does not look like the file that was asked for/);
    expect(out.concern).toMatch(/error\.json/);
  });

  // Works on any kind of file: what goes over is the name, the type, the
  // size and, for something text-shaped, its opening words.
  it('shows the opening text of a text file and never of a binary one', async () => {
    judged(0.9);
    await checkFetchedFile({ ...base, filename: 'rows.csv', contentType: 'text/csv', bytes: Buffer.from('name,amount\nAcme,120') });
    expect(JSON.stringify(mockAsk.mock.calls[0])).toContain('name,amount');

    mockAsk.mockClear();
    judged(0.9);
    await checkFetchedFile({ ...base, filename: 'a.pdf', contentType: 'application/pdf', bytes: pdf });
    expect(JSON.stringify(mockAsk.mock.calls[0])).not.toContain('opening_text');
  });

  it('sends the size, which is how a few hundred bytes of error is told from a video', async () => {
    judged(0.9);
    await checkFetchedFile({ ...base, filename: 'clip.mp4', contentType: 'video/mp4', bytes: Buffer.alloc(300) });
    expect(JSON.stringify(mockAsk.mock.calls[0])).toContain('"size_bytes":300');
  });

  // A check that could not run knows nothing, and a real file must not be
  // withheld because a vendor timed out.
  it('hands the file over when the model does not answer', async () => {
    mockAsk.mockResolvedValueOnce(null);
    expect((await checkFetchedFile({ ...base, filename: 'a.pdf', contentType: 'application/pdf', bytes: pdf })).looksRight).toBe(true);
  });

  it('hands the file over when the check throws', async () => {
    mockAsk.mockRejectedValueOnce(new Error('vendor away'));
    expect((await checkFetchedFile({ ...base, filename: 'a.pdf', contentType: 'application/pdf', bytes: pdf })).looksRight).toBe(true);
  });

  it('asks nothing when there is nothing to judge the file against', async () => {
    const out = await checkFetchedFile({ ...base, objective: '  ', filename: 'a.pdf', contentType: 'application/pdf', bytes: pdf });
    expect(out.looksRight).toBe(true);
    expect(mockAsk).not.toHaveBeenCalled();
  });
});
