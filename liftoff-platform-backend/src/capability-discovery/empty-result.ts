// Whether a capability's result carries anything a caller can use.
//
// "Ran" is not "answered". A vendor that ran and found nothing answers with
// a shape that is all envelope — `[]`, `{ items: [] }`, `{ results: [] }`,
// `{ code: 200, data: { list: [] }, total: 0 }` — and every one of those
// renders as a result and reports as a success. The chain that continues to
// the next source, the `empty` flag on the outcome, and the runtime's count of
// useful results all need ONE answer to "is there anything here", and this is
// it. `isEmpty` in result-rendering.ts is a different question (whether one
// FIELD is worth rendering) and is shallow on purpose; it is not this.
//
// The rule: a value is empty when nothing in it is content. Metadata — a
// count, a status, a cursor, a message about the request — is not content,
// however much of it there is: a response that says `total: 0, code: 200,
// message: 'ok'` has told the caller about the request, not about the world.
// Anything else that is not blank is content, and one piece of content is
// enough.

const METADATA_KEYS = new Set([
  'total', 'total_count', 'totalcount', 'count', 'page', 'pagesize', 'page_size', 'per_page', 'perpage',
  'limit', 'offset', 'cursor', 'next', 'nextcursor', 'next_cursor', 'hasmore', 'has_more', 'more',
  'status', 'statuscode', 'status_code', 'code', 'ok', 'success', 'message', 'msg', 'error', 'errors',
  'warning', 'warnings', 'timestamp', 'time', 'took', 'elapsed', 'duration', 'request_id', 'requestid',
  'router', 'params', 'query', 'meta', 'metadata', 'version', 'api_version', 'cost', 'credits',
  'credits_used', 'usage', 'pagination', 'trace_id', 'traceid',
]);

/** Whether a field name describes the REQUEST rather than the world. Exported
 *  because result-rendering.ts asks the same question of the same names when
 *  it looks inside an envelope for the records: a walk that descended into
 *  `status` or `params` would offer a status list as the result's rows. One
 *  set of names, so the two cannot drift apart. */
export function isMetadataKey(key: string): boolean {
  return METADATA_KEYS.has(key.toLowerCase());
}

/** True when nothing in `value` is content: null, a blank string, an empty
 *  list or a list of empties, an object whose only non-metadata values are
 *  themselves empty. A number or a boolean under a non-metadata key is
 *  content (a price, a flag); a non-blank string is content. */
export function isEmptyCapabilityResult(value: unknown): boolean {
  return emptyAt(value, 0);
}

const MAX_DEPTH = 12;

function emptyAt(value: unknown, depth: number): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return false;
  if (depth >= MAX_DEPTH) return false; // too deep to judge: assume content
  if (Array.isArray(value)) return value.every((item) => emptyAt(item, depth + 1));
  if (typeof value === 'object') {
    for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
      if (isMetadataKey(key)) continue;
      if (!emptyAt(field, depth + 1)) return false;
    }
    return true;
  }
  return false;
}
