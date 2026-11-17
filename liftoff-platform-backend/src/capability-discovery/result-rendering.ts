// The model-facing rendering of a capability's result.
//
// A result is a list of records more often than not, and a record from a data
// source is wide: dozens of fields, most of them empty for any one row, a body
// text that can run to pages, and lists of its own — the comments under a
// post, the line items of an order — that can outweigh the record they hang
// off. Bounding that as a byte count of the raw JSON cuts a record in half and
// shows one or two of a page of ten, with nothing saying that the others
// exist. A model asked for ten then goes looking for the other eight —
// narrower queries, one source at a time — and each of those returns the same
// first two.
//
// So the bound is a rendering, not a cut. A record keeps every field that
// carries a value and loses the ones that do not; a long text is shortened and
// says by how much; a record that is still large has the lists inside it
// shortened the same way; and a list shows whole records up to the budget and
// then says how many it is not showing. What the model reads is smaller than
// the raw result and truthful about what was left out, which is what lets it
// decide whether it needs another call at all.

import { isMetadataKey } from './empty-result';

/** Characters of rendered result a single capability run hands the model.
 *  Ten compacted records of the widest shape seen so far fit here; one raw
 *  record of that shape is 4–6 KB. Under the runtime's own per-result bound. */
export const CAPABILITY_RESULT_BUDGET = 16_000;

/** A string field longer than this is shortened in place. Enough for the gist
 *  of a body text; the marker says how much more there was. */
const MAX_FIELD_CHARS = 800;

/** A record still larger than this once its fields are compacted has the
 *  lists inside it shortened, so that a handful of records fit the budget. */
const LARGE_RECORD_CHARS = 3_000;

/** Items kept of a list inside a large record. */
const NESTED_LIST_ITEMS = 5;

const MAX_DEPTH = 8;

/** Room kept for the trailer, so a list that fills the budget can still say
 *  what it left out. */
const TRAILER_RESERVE = 200;

const SHORTENED_TEXT_NOTE = 'Long text fields were shortened.';
const SHORTENED_LISTS_NOTE = 'Lists inside records were shortened.';

function omittedNote(shown: number, total: number, field: string | null): string {
  const where = field ? ` in "${field}"` : '';
  return `${shown} of ${total} results shown${where}; ${total - shown} omitted for length — ask for fewer results or narrow the request to see the others.`;
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value as object).length === 0;
  return false;
}

interface Compacted {
  value: unknown;
  /** Whether any string was shortened. */
  shortenedText: boolean;
  /** Whether any list inside the value was shortened. */
  shortenedLists: boolean;
}

/** Drop the fields that say nothing, shorten the ones that say too much.
 *  With `capLists`, a list below the top level keeps its first items and says
 *  how many more it had. */
function compact(value: unknown, capLists: boolean): Compacted {
  const out: Compacted = { value: undefined, shortenedText: false, shortenedLists: false };
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') {
      if (v.length <= MAX_FIELD_CHARS) return v;
      out.shortenedText = true;
      return `${v.slice(0, MAX_FIELD_CHARS)}…[+${v.length - MAX_FIELD_CHARS} chars]`;
    }
    if (v === null || typeof v !== 'object') return v;
    if (depth >= MAX_DEPTH) return '[…]';
    if (Array.isArray(v)) {
      if (capLists && depth > 0 && v.length > NESTED_LIST_ITEMS) {
        out.shortenedLists = true;
        return [
          ...v.slice(0, NESTED_LIST_ITEMS).map((item) => walk(item, depth + 1)),
          `…[+${v.length - NESTED_LIST_ITEMS} more items]`,
        ];
      }
      return v.map((item) => walk(item, depth + 1));
    }
    const record: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(v as Record<string, unknown>)) {
      if (isEmpty(field)) continue;
      record[key] = walk(field, depth + 1);
    }
    return record;
  };
  out.value = walk(value, 0);
  return out;
}

function serialize(value: unknown): string {
  try {
    const out = JSON.stringify(value);
    return out === undefined ? 'null' : out;
  } catch {
    return '"[unserializable]"';
  }
}

/** A cut that says it is one. */
function cut(text: string, budget: number): string {
  const marker = `…[cut: shown ${budget} of ${text.length} chars]`;
  return `${text.slice(0, Math.max(0, budget - marker.length))}${marker}`;
}

/** The field of a record that holds its list of results, when one field holds
 *  the bulk of the record: the `{ items: [...], total: n }` shape a connector
 *  function returns. Null when no array field carries at least half of it. */
function listField(record: Record<string, unknown>): string | null {
  let best: { key: string; size: number } | null = null;
  for (const [key, value] of Object.entries(record)) {
    if (!Array.isArray(value)) continue;
    const size = serialize(value).length;
    if (!best || size > best.size) best = { key, size };
  }
  // The whole record is serialized only when there is something to compare
  // it against: an envelope with no top-level array at all — every Parse,
  // TikHub and Nasdaq response — never pays for it.
  return best && best.size * 2 >= serialize(record).length ? best.key : null;
}

/** How deep inside an envelope the records may sit. A vendor that does not
 *  put its list at the top level puts it one or two objects down —
 *  `data.listings`, `data.aweme_list`, `data.table.rows` — and three is
 *  enough for every shape seen. A cap, because the walk is over a payload
 *  that can be a megabyte of envelope. */
const MAX_ENVELOPE_DEPTH = 3;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Every array of records reachable through an envelope's own object fields,
 *  with the path to it.
 *
 *  THE DEFECT THIS EXISTS FOR: the top-level rule above sees `{status, data}`
 *  — a string and an object — and finds no array, so a Parse response of 41
 *  listings became ONE record holding the whole envelope, and `dataset_query`
 *  could count it and nothing more. TikHub (`{code, router, params, data}`)
 *  and Nasdaq (`{data:{table:{rows}}, message, status}`) keep their records
 *  below the top level the same way.
 *
 *  A metadata field — `status`, `code`, `message`, `params`, `errors` — is
 *  neither descended into nor offered: those describe the request, not the
 *  world, and empty-result.ts skips the same names when it asks whether a
 *  result carries anything at all. Only arrays that hold records qualify: a
 *  list of bare strings is a field of the envelope, not its rows.
 *
 *  Depth two at least, because the top level has already had its turn under
 *  the half-of-the-payload rule: a record that merely HAS a list stays one
 *  record, which is the property that rule is there for.
 *
 *  WHERE THIS DELIBERATELY STOPS, and why that is safe: a result deeper than
 *  three objects, or one that keeps its rows under a metadata NAME
 *  (`{query:{results:[…]}}`), finds no candidate here and falls back to the
 *  behaviour that was there before — the whole payload as one record. Every
 *  boundary in this walk fails in that direction, so a shape nobody
 *  anticipated is rendered and parked exactly as it was, never as the wrong
 *  rows. */
function envelopeCandidates(value: unknown): Array<{ path: string[]; items: unknown[] }> {
  const out: Array<{ path: string[]; items: unknown[] }> = [];
  const walk = (node: unknown, path: string[]): void => {
    if (path.length >= MAX_ENVELOPE_DEPTH || !isPlainRecord(node)) return;
    for (const [key, field] of Object.entries(node)) {
      if (isMetadataKey(key)) continue;
      const here = [...path, key];
      if (Array.isArray(field)) {
        if (here.length >= 2 && field.some(isPlainRecord)) out.push({ path: here, items: field });
        continue;
      }
      walk(field, here);
    }
  };
  walk(value, []);
  return out;
}

/** How much of a record shape an array's items carry. Null when none of them
 *  is a record at all. */
interface Shape {
  /** How many items are records. */
  records: number;
  /** Keys EVERY record has — the common schema the array is a table of, and
   *  zero when there is only one record, which is a table of nothing. */
  agreed: number;
  /** Keys per record. */
  width: number;
}

function shapeOf(items: unknown[]): Shape | null {
  let keys = 0;
  let records = 0;
  let shared: Set<string> | null = null;
  for (const item of items) {
    if (!isPlainRecord(item)) continue;
    const own = Object.keys(item);
    keys += own.length;
    records += 1;
    if (shared === null) shared = new Set(own);
    else for (const key of [...shared]) if (!(key in item)) shared.delete(key);
  }
  if (records === 0) return null;
  return { records, agreed: records > 1 ? (shared?.size ?? 0) : 0, width: keys / records };
}

/**
 * Which of two candidate arrays is the result's records: positive when `a`
 * is, negative when `b` is. Three questions in order, and the order is the
 * whole point.
 *
 * FIRST, WHAT THEY AGREE ON. A result's records are a TABLE: every row
 * carries the same fields. `search_recently_sold` returns 41 listings (44
 * keys each, 37 on every one) beside 500 map pins (35 keys each, only 17 on
 * every one), and the map pins outweigh the listings eight to one — so size
 * cannot decide this, and agreement can. A one-item array agrees with
 * nothing and scores zero here: a lone wide object (a `regionState`, a
 * settings blob) must not beat a real list of narrower rows just for being
 * wide.
 *
 * THEN HOW MUCH EACH ROW CARRIES, which separates two tables of the same
 * common width, and ADMITS a single record when it is all there is.
 *
 * SIZE LAST, and only to break a tie.
 */
function moreRecordLike(a: Shape, b: Shape): number {
  if (a.agreed !== b.agreed) return a.agreed - b.agreed;
  return a.width - b.width;
}

/** The candidate whose items most look like the result's records; the larger
 *  of two that are indistinguishable. Null when the envelope holds no array
 *  of records. */
function bestEnvelopeList(value: unknown): { path: string[]; items: unknown[] } | null {
  let best: { path: string[]; items: unknown[]; shape: Shape } | null = null;
  let bestSize: number | null = null;
  for (const candidate of envelopeCandidates(value)) {
    const shape = shapeOf(candidate.items);
    if (!shape) continue;
    if (!best) {
      best = { ...candidate, shape };
      bestSize = null;
      continue;
    }
    const verdict = moreRecordLike(shape, best.shape);
    if (verdict > 0) {
      best = { ...candidate, shape };
      bestSize = null;
      continue;
    }
    if (verdict === 0) {
      bestSize = bestSize ?? serialize(best.items).length;
      const size = serialize(candidate.items).length;
      if (size > bestSize) {
        best = { ...candidate, shape };
        bestSize = size;
      }
    }
  }
  return best ? { path: best.path, items: best.items } : null;
}

interface Fitted {
  body: string;
  shown: number;
  notes: string[];
}

/** One record, rendered: compacted, and with its lists shortened when it is
 *  still large. */
function renderRecord(item: unknown): { text: string; shortenedText: boolean; shortenedLists: boolean } {
  let c = compact(item, false);
  let text = serialize(c.value);
  if (text.length > LARGE_RECORD_CHARS) {
    c = compact(item, true);
    text = serialize(c.value);
  }
  return { text, shortenedText: c.shortenedText, shortenedLists: c.shortenedLists };
}

/** Whole records up to `budget`, and how many were left out. */
function fitRecords(items: unknown[], budget: number, field: string | null, note = true): Fitted {
  const kept: string[] = [];
  let length = 2; // the brackets
  let shortenedText = false;
  let shortenedLists = false;
  let first: string | null = null;
  for (const item of items) {
    const rendered = renderRecord(item);
    if (first === null) first = rendered.text;
    const cost = rendered.text.length + (kept.length > 0 ? 1 : 0);
    if (length + cost > budget) break;
    kept.push(rendered.text);
    length += cost;
    shortenedText = shortenedText || rendered.shortenedText;
    shortenedLists = shortenedLists || rendered.shortenedLists;
  }
  const notes: string[] = [];
  let body: string;
  let shown: number;
  if (kept.length === 0) {
    // Not even the first record fits: cut it where the cut is visible. Never
    // below zero — a negative budget is a negative "shown" figure in the
    // marker, which is what a frame nobody bounded once produced.
    body = `[${cut(first ?? 'null', Math.max(0, budget - 2))}]`;
    shown = 1;
  } else {
    body = `[${kept.join(',')}]`;
    shown = kept.length;
  }
  if (note && shown < items.length) notes.push(omittedNote(shown, items.length, field));
  if (shortenedText) notes.push(SHORTENED_TEXT_NOTE);
  if (shortenedLists) notes.push(SHORTENED_LISTS_NOTE);
  return { body, shown, notes };
}

/** The most of a body's budget the frame — everything around the records —
 *  may take. A third: the records are what was asked for, and a sibling array
 *  that outweighs them (500 map pins beside 41 listings) must not eat the
 *  page. Unbounded, the frame can run past the whole budget and the page
 *  reports a nonsense cut such as `…[cut: shown -29803 of 1097 chars]`. */
const MAX_FRAME_SHARE = 3;

const FRAME_MARK = ' records ';

interface Frame {
  /** Everything before the records, and everything after. */
  prefix: string;
  suffix: string;
  /** Fields of the result that did not fit beside them. */
  omitted: number;
}

function omittedFieldsNote(n: number): string {
  return `${n} other field${n === 1 ? '' : 's'} of the result ${n === 1 ? 'was' : 'were'} omitted for length.`;
}

/**
 * The result with the records taken out of it: what comes before them, and
 * what comes after, within `budget`.
 *
 * Bounded, and the bound is the point. The fields around the records are the
 * envelope's own — a total, a page number, a region, and sometimes another
 * array as big as the payload — and nothing capped them: the frame was
 * serialized whole and subtracted from the body's budget, so one oversized
 * sibling took the budget past zero and the cut marker named a negative
 * count.
 *
 * Smallest first, so the scalars that say what the result IS survive a
 * sibling that does not fit; kept in the result's own order, so the rendering
 * still reads like the response. What is left out is counted and said.
 */
function frameAround(value: unknown, path: string[], budget: number): Frame {
  let remaining = Math.max(0, budget);
  let omitted = 0;
  const build = (node: unknown, depth: number): string => {
    if (depth >= path.length) return FRAME_MARK;
    const record = isPlainRecord(node) ? node : {};
    const key = path[depth];
    // The braces, the colon and the records' own key are structure, not
    // content, and come out of the budget before any field does.
    remaining = Math.max(0, remaining - (JSON.stringify(key).length + 4));
    const entries = Object.entries(record)
      .filter(([k]) => k !== key)
      .map(([k, v]) => ({ key: k, text: `${JSON.stringify(k)}:${serialize(v)}` }));
    const kept = new Set<string>();
    for (const entry of [...entries].sort((a, b) => a.text.length - b.text.length)) {
      if (entry.text.length + 1 > remaining) {
        omitted += 1;
        continue;
      }
      remaining -= entry.text.length + 1;
      kept.add(entry.key);
    }
    const shown = entries.filter((e) => kept.has(e.key)).map((e) => e.text);
    const inner = build(record[key], depth + 1);
    return `{${[...shown, `${JSON.stringify(key)}:${inner}`].join(',')}}`;
  };
  const text = build(value, 0);
  const at = text.indexOf(FRAME_MARK);
  return { prefix: text.slice(0, at), suffix: text.slice(at + FRAME_MARK.length), omitted };
}

/**
 * Render a capability's result for the model within `budget` characters. A
 * list — bare, or the list a record carries, at the top level or inside its
 * envelope — renders whole records and states how many it left out; anything
 * else renders compacted and, when it still does not fit, is cut where the
 * cut is visible.
 */
export function renderCapabilityResult(value: unknown, budget: number = CAPABILITY_RESULT_BUDGET): string {
  const compacted = compact(value, false);
  const whole = serialize(compacted.value);
  const join = (body: string, notes: string[]): string => [body, ...notes].join('\n\n');

  if (whole.length <= budget) {
    return join(whole, compacted.shortenedText ? [SHORTENED_TEXT_NOTE] : []);
  }

  const bodyBudget = budget - TRAILER_RESERVE;

  // The compaction above is the one this needs: `listOf` would make its own.
  const list = Array.isArray(value)
    ? { items: value, field: null, path: [] as string[] }
    : value && typeof value === 'object'
      ? listIn(value as Record<string, unknown>, compacted.value)
      : null;
  if (list) {
    const frame = frameAround(compacted.value, list.path, Math.max(0, Math.floor(bodyBudget / MAX_FRAME_SHARE)));
    const fit = fitRecords(list.items, Math.max(0, bodyBudget - frame.prefix.length - frame.suffix.length), list.field);
    return join(
      `${frame.prefix}${fit.body}${frame.suffix}`,
      frame.omitted > 0 ? [...fit.notes, omittedFieldsNote(frame.omitted)] : fit.notes,
    );
  }

  return join(cut(whole, bodyBudget), compacted.shortenedText ? [SHORTENED_TEXT_NOTE] : []);
}

/** One page of a list-shaped result: the records from `offset` that fit the
 *  budget, and where the page ends. `records` is null for a result that is
 *  not a list (a single record, a scalar), which has no pages. */
export interface RenderedPage {
  text: string;
  /** Which records this page shows (1-based, inclusive) and how many exist. */
  records: { from: number; to: number; total: number } | null;
  /** The offset of the next page, or null when this page reached the end. */
  nextOffset: number | null;
}

/** The records of a result, and where they sit. */
export interface ResultList {
  items: unknown[];
  /** The path to the records, as the rendering names it — `items`,
   *  `data.listings` — or null when the result IS the list. */
  field: string | null;
  /** The same path, as the keys to walk. Empty when the result IS the list. */
  path: string[];
}

/**
 * The records of a result, given the result AND the compaction of it the
 * caller has already made.
 *
 * Compaction walks the whole payload, and the payloads this runs on reach a
 * megabyte — so the two renderers below, which compact before they do
 * anything else, pass theirs in rather than paying for a second walk of the
 * same object to answer the same question.
 */
function listIn(value: Record<string, unknown>, compacted: unknown): ResultList | null {
  const field = listField(compacted as Record<string, unknown>);
  if (field) {
    const items = value[field];
    if (Array.isArray(items)) return { items, field, path: [field] };
  }
  // No array at the top level carries the result: the records may still be
  // inside the envelope (`{status, data:{listings}}`), which is where every
  // Parse, TikHub and Nasdaq list result keeps them.
  const nested = bestEnvelopeList(value);
  return nested ? { items: nested.items, field: nested.path.join('.'), path: nested.path } : null;
}

/** The records of a result, and the field they sit under when the result is
 *  a record whose bulk is one list — or the path into its envelope when the
 *  records are below the top level. */
export function listOf(value: unknown): ResultList | null {
  if (Array.isArray(value)) return { items: value, field: null, path: [] };
  if (value && typeof value === 'object') {
    return listIn(value as Record<string, unknown>, compact(value, false).value);
  }
  return null;
}

/**
 * Render the page of a result that starts at record `offset`, within
 * `budget`. The page says which records it shows and whether more follow,
 * and never says how many were "omitted": the caller states how to read on,
 * because from here on the records are already fetched and paid for.
 */
export function renderCapabilityResultPage(value: unknown, offset: number, budget: number = CAPABILITY_RESULT_BUDGET): RenderedPage {
  // Compacted ONCE, here: the list lookup and the frame both need it, and the
  // payload can be a megabyte.
  const record = value && typeof value === 'object' && !Array.isArray(value) ? compact(value, false).value : null;
  const list = Array.isArray(value)
    ? { items: value, field: null, path: [] as string[] }
    : record !== null
      ? listIn(value as Record<string, unknown>, record)
      : null;
  if (!list) {
    return { text: renderCapabilityResult(value, budget), records: null, nextOffset: null };
  }
  const total = list.items.length;
  const start = Math.min(Math.max(0, Math.floor(offset)), Math.max(0, total - 1));
  const bodyBudget = budget - TRAILER_RESERVE;
  const join = (body: string, notes: string[]): string => [body, ...notes].join('\n\n');
  if (list.field === null) {
    const fit = fitRecords(list.items.slice(start), bodyBudget, null, false);
    const to = start + fit.shown;
    return { text: join(fit.body, fit.notes), records: { from: start + 1, to, total }, nextOffset: to < total ? to : null };
  }
  const frame = frameAround(record, list.path, Math.max(0, Math.floor(bodyBudget / MAX_FRAME_SHARE)));
  const fit = fitRecords(
    list.items.slice(start),
    Math.max(0, bodyBudget - frame.prefix.length - frame.suffix.length),
    list.field,
    false,
  );
  const to = start + fit.shown;
  return {
    text: join(
      `${frame.prefix}${fit.body}${frame.suffix}`,
      frame.omitted > 0 ? [...fit.notes, omittedFieldsNote(frame.omitted)] : fit.notes,
    ),
    records: { from: start + 1, to, total },
    nextOffset: to < total ? to : null,
  };
}
