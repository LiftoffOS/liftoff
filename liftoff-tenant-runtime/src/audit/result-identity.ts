// What a tool result is ABOUT, kept even when the result is too big to keep.
//
// An audit summary is capped, and a blind prefix of a JSON blob spends that cap
// on whatever the provider happened to serialise first. For example, both of
// these are rows at the 500-character limit:
//
//   get_document     {"body":{"content":[{"endIndex":1,"sectionBreak":{"sect…
//   update_document  {"display_url":"…","replies":[{},{},{},{},{},{},{},{},{…
//
// The first spends its budget on document body structure; the second on
// hundreds of empty `replies` objects. Neither kept the document's TITLE, which
// both responses contain — so the platform records documents it cannot
// name, and a person is shown "Updated document" over and over for files it
// has the names of.
//
// The fix is not a bigger cap. It is to keep the identifying fields FIRST and
// let the bulk be what gets dropped: a reader of an audit row wants to know
// which thing was touched and where it lives, and only then what came back.

/** Fields that name a thing or locate it, across the providers we speak to.
 *  Ordered: what it is called, then what it is, then where it lives. */
const IDENTITY_KEYS = [
  'title', 'name', 'filename', 'subject',
  'id', 'documentId', 'fileId', 'spreadsheetId', 'presentationId', 'messageId',
  'display_url', 'document_url', 'webViewLink', 'webViewUrl', 'url', 'permalink', 'html_url',
] as const;

/** Pull the identifying fields out of a result, however deeply the provider
 *  nested them. Shallow-first and breadth-limited: an identity that is fifty
 *  levels down is not one anybody authored. */
export function collectIdentity(value: unknown, depth = 0): Record<string, unknown> {
  if (depth > 3 || value === null || typeof value !== 'object') return {};
  const found: Record<string, unknown> = {};
  const source = value as Record<string, unknown>;
  for (const key of IDENTITY_KEYS) {
    const v = source[key];
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      found[key] = typeof v === 'string' ? v.slice(0, 200) : v;
    }
  }
  if (Object.keys(found).length > 0) return found;
  // Not on this level. Look one deeper, taking the first branch that names
  // something — a Docs response carries the title beside `body`, a Drive one
  // inside `file`, and neither is worth a special case.
  for (const child of Object.values(source)) {
    if (child && typeof child === 'object') {
      const deeper = collectIdentity(child, depth + 1);
      if (Object.keys(deeper).length > 0) return deeper;
    }
  }
  return {};
}

/**
 * Summarise a tool result for the audit trail, keeping what identifies it.
 *
 * The identity goes first so it survives the cap; the rest of the result
 * follows and is what gets truncated away. A result with nothing identifying in
 * it degrades to exactly the blind prefix this replaces, so nothing that worked
 * before gets worse.
 */
export function summariseToolResult(result: unknown, limit = 500): string | undefined {
  if (result === undefined) return undefined;
  if (typeof result === 'string') return result.slice(0, limit) || undefined;

  let rest: string;
  try {
    rest = JSON.stringify(result) ?? '';
  } catch {
    return '[unserialisable result]';
  }
  if (!rest) return undefined;

  const identity = collectIdentity(result);
  if (Object.keys(identity).length === 0) return rest.slice(0, limit);

  let head: string;
  try {
    head = JSON.stringify(identity);
  } catch {
    return rest.slice(0, limit);
  }
  // The identity alone can exceed the cap when a provider returns a long name;
  // it is still the more useful half, so it is what survives.
  if (head.length >= limit) return head.slice(0, limit);
  return `${head} ${rest.slice(0, limit - head.length - 1)}`;
}
