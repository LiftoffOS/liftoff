/**
 * An answer made of bytes goes to the file store, not into a model's context.
 *
 * Before this, a provider that answered with a PDF fell through to `{ text }`
 * and reached the model as mangled UTF-8: a successful call that looks like
 * corrupt data, and no way for anyone to open the thing that was actually
 * returned. What travels back now is a HANDLE — an id, a name, a type, a size
 * — and the bytes are in the one store every other produced file goes to, so a
 * person sees the same card and opens it the same way.
 *
 * The decision is made on what the provider SAID its answer is. Sniffing the
 * bytes would turn an unusual text format into a download nobody asked for.
 */
import { isFileResponse, filenameFor } from '../file-response.js';

function headers(init: Record<string, string>): Response {
  return new Response(null, { headers: init });
}

describe('deciding whether an answer is a file', () => {
  it('leaves everything a model can actually read on the JSON path', () => {
    for (const type of [
      'application/json',
      'application/json; charset=utf-8',
      'application/vnd.acme+json',
      'text/plain',
      'text/csv',
      'text/html; charset=utf-8',
      'application/xml',
      'image/svg+xml',
      'application/x-www-form-urlencoded',
    ]) {
      expect(isFileResponse(type)).toBe(false);
    }
  });

  it('takes the ones that are bytes', () => {
    for (const type of [
      'application/pdf',
      'image/png',
      'image/jpeg',
      'application/zip',
      'application/octet-stream',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ]) {
      expect(isFileResponse(type)).toBe(true);
    }
  });

  it('says no when the provider said nothing, rather than guessing', () => {
    expect(isFileResponse('')).toBe(false);
  });
});

describe('naming the file', () => {
  it('uses the name the provider gave, which is the one a person recognises', () => {
    expect(filenameFor(headers({ 'content-disposition': 'attachment; filename="invoice-2026-09.pdf"' }), '/v1/invoices/42/pdf', 'application/pdf'))
      .toBe('invoice-2026-09.pdf');
  });

  it('decodes an encoded name', () => {
    expect(filenameFor(headers({ 'content-disposition': "attachment; filename*=UTF-8''report%20Q3.pdf" }), '/x', 'application/pdf'))
      .toBe('report Q3.pdf');
  });

  it('falls back to the operation path, with the extension its type implies', () => {
    expect(filenameFor(headers({}), '/v1/invoices/42/statement', 'application/pdf'))
      .toBe('statement.pdf');
  });

  it('leaves a name that already has an extension alone', () => {
    expect(filenameFor(headers({}), '/files/report.xlsx', 'application/pdf')).toBe('report.xlsx');
  });

  it('adds no extension for a type it does not know, rather than inventing one', () => {
    expect(filenameFor(headers({}), '/v1/thing/blob', 'application/x-acme')).toBe('blob');
  });

  it('has something to call a file even when the path ends in a slash', () => {
    expect(filenameFor(headers({}), '/', 'application/pdf')).toBe('download.pdf');
  });
});
