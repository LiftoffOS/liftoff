// Finding the operation that ENUMERATES an entity, when the vendor surface is a
// bag of named operations rather than a set of tables.
//
// Both remote surfaces we integrate through — vendor MCP servers and Composio
// toolkits — expose tools, not collections. Neither has a generic "list what is
// in this account" verb. What they do have is a naming convention: the tool that
// lists invoices is called something like `list_invoices`, `GET_ALL_INVOICES` or
// `INVOICES_SEARCH`. That convention is reliable enough to search, and searching
// it is the difference between supporting every connector and hand-writing a
// tool name per vendor per entity — the latter being exactly the unmaintainable
// per-vendor mapping this whole area was refactored to remove.
//
// Shared by mcp-entity-list.ts and composio-entity-list.ts so the two tiers
// agree on what counts as an enumerator. They differ only in how they fetch the
// tool list and how they invoke one.

/** Singular and plural both occur in the wild (`list_invoice`, `LIST_INVOICES`),
 *  and callers use either, so match on stems rather than the literal string. */
export function entityStems(entityType: string): string[] {
  const base = entityType.toLowerCase().replace(/[\s-]+/g, '_');
  const singular = base.replace(/(ies|es|s)$/, m => (m === 'ies' ? 'y' : ''));
  return [...new Set([base, singular, `${singular}s`, base.replace(/y$/, 'ies')])];
}

/**
 * Choose the tool that lists `entityType`, or null when none does.
 *
 * Two things disqualify a candidate, and both matter:
 *
 *  - It must mention the entity. Returning `list_accounts` for a request about
 *    invoices would produce a confidently wrong list, which is worse than an
 *    honest refusal.
 *  - It must not be a single-record read. `get_invoice` needs an id we do not
 *    have; calling it would surface a vendor validation error to someone who
 *    only wanted to see their invoices. `get_all_invoices` is fine, hence the
 *    check for a plural/all marker rather than a blanket ban on `get`.
 */
export function pickEnumeratingTool<T extends { name: string }>(
  tools: T[],
  entityType: string,
): T | null {
  const wanted = entityStems(entityType);
  const named = tools.filter(t => {
    const n = t.name.toLowerCase();
    return wanted.some(s => n.includes(s));
  });
  if (!named.length) return null;

  const isSingleRead = (name: string) => {
    const n = name.toLowerCase();
    if (!/(^|_)(get|fetch|read|retrieve)(_|$)/.test(n)) return false;
    // `get_all_*` / `get_*s` / `*_list` are enumerators wearing a `get` prefix.
    return !/(^|_)(all|list|search)(_|$)/.test(n) && !/s(_|$)/.test(n);
  };

  const candidates = named.filter(t => !isSingleRead(t.name));
  if (!candidates.length) return null;

  // Prefer an explicit enumeration verb, then anything left that survived the
  // single-read filter.
  for (const re of [/(^|_)(list|search)(_|$)/i, /(^|_)(all|find|query)(_|$)/i]) {
    const hit = candidates.find(t => re.test(t.name));
    if (hit) return hit;
  }
  return candidates[0];
}

/**
 * Pull the record array out of whatever envelope came back.
 *
 * These responses are free-form JSON: a bare array, a single-key wrapper
 * (`{items: []}`, `{records: []}`), or a nested one (`{data: {results: []}}`).
 * Rather than guess per vendor, take the first array found, breadth-first so a
 * top-level collection wins over some incidental nested array.
 */
export function extractRecordArray(data: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(data)) return data as Array<Record<string, unknown>>;
  if (!data || typeof data !== 'object') return [];

  const queue: unknown[] = [data];
  let depth = 0;
  while (queue.length && depth < 4) {
    const next: unknown[] = [];
    for (const node of queue) {
      if (!node || typeof node !== 'object') continue;
      const values = Object.values(node as Record<string, unknown>);
      const arr = values.find(v => Array.isArray(v) && v.every(x => x && typeof x === 'object'));
      if (arr) return arr as Array<Record<string, unknown>>;
      next.push(...values);
    }
    queue.length = 0;
    queue.push(...next);
    depth++;
  }
  return [];
}

/** Normalise vendor rows into ExternalRecord shape. Ids and names vary by
 *  vendor and by case; a row with neither still renders, because a destination
 *  the person can see and pick beats silently dropping it. */
export function toExternalRecords(
  rows: Array<Record<string, unknown> | string>,
): Array<{ id: string; data: Record<string, unknown> }> {
  return rows.map(row => {
    if (typeof row === 'string') return { id: row, data: { name: row } };
    const r = row as Record<string, any>;
    return {
      id: String(r.id ?? r.Id ?? r.ID ?? r.uuid ?? r.key ?? r.name ?? r.Name ?? ''),
      data: r,
    };
  });
}
