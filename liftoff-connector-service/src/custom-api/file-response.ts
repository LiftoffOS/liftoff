// Telling an answer made of bytes from one a model can read, and naming it.
//
// Its own module because the executor registers itself with the dispatcher on
// import, and these two decisions are worth testing without starting that.

/** Is this answer a FILE rather than a document a model can read?
 *
 *  By what the provider said it is, never by sniffing the bytes: a provider
 *  that labels its answer is telling the truth about it, and guessing would
 *  turn an unusual text format into a download nobody asked for. JSON, text,
 *  XML, HTML and anything `+json` stay on the path they were on. */
export function isFileResponse(contentType: string): boolean {
  const type = contentType.split(';')[0]!.trim().toLowerCase();
  if (!type) return false;
  if (type.startsWith('text/')) return false;
  if (type === 'application/json' || type.endsWith('+json')) return false;
  if (type === 'application/xml' || type.endsWith('+xml')) return false;
  if (type === 'application/x-www-form-urlencoded') return false;
  return true;
}

/** What to call the file. The provider's own name when it gave one, because
 *  that is the name a person will recognise; otherwise the operation's last
 *  path segment, which is the next most recognisable thing. */
export function filenameFor(response: Response, path: string, contentType: string): string {
  const disposition = response.headers.get('content-disposition') ?? '';
  const named = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1];
  if (named) {
    try {
      return decodeURIComponent(named);
    } catch {
      return named;
    }
  }
  const segment = path.split('?')[0]!.split('/').filter(Boolean).pop() ?? 'download';
  const extension = EXTENSION_BY_TYPE[contentType.split(';')[0]!.trim().toLowerCase()];
  return segment.includes('.') || !extension ? segment : `${segment}.${extension}`;
}

/** Enough to name the common answers. An unknown type keeps the bare segment
 *  rather than being given an extension that would be a guess. */
const EXTENSION_BY_TYPE: Record<string, string> = {
  'application/pdf': 'pdf',
  'text/csv': 'csv',
  'application/zip': 'zip',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};
