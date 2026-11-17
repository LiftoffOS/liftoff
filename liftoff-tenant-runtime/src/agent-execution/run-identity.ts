// The run's workflow and task ids, and the one rule every reader and writer
// of them shares.
//
// Both ids feed uuid columns. A uuid column accepts a well-formed uuid or NULL
// and rejects everything else — an empty string, and equally a non-uuid label
// such as a trace id. So a value is an id only when it is well-formed; any
// other value is treated as absent rather than passed along. Readers ask for
// the first present candidate in order of preference; writers to a nullable
// column turn absence into NULL; a writer that structurally needs an id (a
// primary key) resolves absence itself, at its own boundary.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `value` is a well-formed uuid string. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value.trim());
}

/** The first candidate that is an actual id, or undefined when none is.
 *  Callers hand this every place an id could have come from, most preferred
 *  first — the live caller, then whatever was persisted with the pause, then
 *  any row the resume already loaded. */
export function firstPresentId(...candidates: Array<string | null | undefined>): string | undefined {
  for (const candidate of candidates) {
    if (isUuid(candidate)) return candidate.trim();
  }
  return undefined;
}

/** A value for a NULLABLE uuid column: the id when well-formed, NULL otherwise. */
export function uuidOrNull(value: string | null | undefined): string | null {
  return isUuid(value) ? value.trim() : null;
}
