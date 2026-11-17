// The one seam where a result stops being something a model reads and becomes
// something it queries.
//
// Parking was written for one producer — `run_capability` — and reached one
// route. Three of the five agent surfaces could therefore put an in-process
// tool result of ANY size straight into a model's context: Liftoff for
// everything but `run_capability`, the Insights Manager for everything, and the
// Chief AI Officer for everything. A 200,000-character result there is not a
// slow turn, it is a turn that cannot finish: the window fills, the reply is
// closed or the run errors, and the person gets nothing for work that was
// already paid for.
//
// So the rule lives here and every surface calls it at ONE seam of its own —
// the point where a tool result becomes model context — rather than at each
// tool. A tool added later is then covered by construction, which is the
// property the per-producer version did not have.
//
// WHAT IS COVERED, exactly: an oversized SUCCESSFUL TEXT result. An error
// envelope is small and must reach the model verbatim (it is how the model
// recovers), and a non-text block is not text to replace. Both are left alone.

import { log } from '../infrastructure/logging';
import { listOf, renderCapabilityResult, renderCapabilityResultPage } from '../capability-discovery/result-rendering';
import { renderDatasetView } from './render';
import { appendRecords, createDataset, type DatasetScope } from './store';

/** Records the model is shown in a dataset's view. */
const VIEW_SAMPLE_RECORDS = 2;

/**
 * The size past which a successful text result is parked rather than read.
 *
 * The same figure the tenant runtime's per-result bound uses
 * (`adapter/tool-result-bound.ts`), calibrated there against 30 days of real
 * tool results (n=6043: p50=350, p95=3268, p99=33275, max=77530): at 50,000 it
 * touches only the sub-1% pathological tail and every ordinary result passes
 * through untouched. Kept as one number across the estate on purpose — a
 * result that is "too big to read" on one surface is too big on all of them,
 * and two thresholds would mean a result parked for an agent and inlined for
 * the assistant that asked the same question.
 */
export const TOOL_RESULT_PARK_CHARS = 50_000;

/** JSON when it is JSON, the text itself when it is not. */
function parsedOrText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * The records a payload becomes.
 *
 * THE PAYLOAD CONTRACT, and it is deliberately narrow: what is parked is the
 * model-facing text or the raw data, never the MCP envelope around it. An
 * envelope parked as a record gives the model a dataset of one row whose only
 * field is `content`, which answers no question it could have asked.
 *
 *   an array           → its items, one record each
 *   a list envelope    → the list's items, one record each
 *   an object          → one record
 *   text or a scalar   → one record, `{ value: … }`
 *
 * A string is parsed first, so a tool that serialized its own JSON lands as
 * the records it meant rather than as one enormous string field.
 *
 * THE ENVELOPE CASE is the one that decides whether parking did its job. A
 * paginated result — `{ records: [...], nextCursor }`, `{ items: [...], total }`
 * — is an object, so the narrow rule parked 8,366 rows as ONE record: the
 * window was protected, which is parking's first job, but nothing could be
 * asked of the rows, which is its second. `dataset_query` filters and sorts
 * over records, so a dataset of one record answers a count and nothing else,
 * and the model is left reporting that it cannot produce the breakdown it was
 * asked for.
 *
 * `listOf` is the same unwrap the capability path already applies (and the
 * reason that path never had this defect), so the two agree by construction
 * rather than by having been written to match. Its threshold is what makes it
 * safe: at the top level the largest array must be at least HALF the
 * serialized payload, so a record that merely HAS a list stays one record and
 * only a record that IS a list is unwrapped. The envelope's own scalars
 * (`nextCursor`, `total`) are pagination, not data, and are not carried onto
 * the rows.
 *
 * WHEN THE RECORDS ARE NOT AT THE TOP LEVEL, `listOf` looks inside the
 * envelope for them — `{status, data:{listings}}` is how every Parse response
 * is shaped, and TikHub and Nasdaq keep theirs under `data` too. Without that
 * a Zillow search parked as ONE row holding the whole envelope: the window
 * was protected and the 41 listings could be counted and nothing else.
 */
export function recordsFromPayload(payload: unknown): unknown[] {
  const value = typeof payload === 'string' ? parsedOrText(payload) : payload;
  if (Array.isArray(value)) return value;
  if (value !== null && value !== undefined && typeof value === 'object') {
    const list = listOf(value);
    if (list && list.field !== null) return list.items;
    return [value];
  }
  return [{ value }];
}

/** Where a parked result came from, for the operator-facing columns and the
 *  model-facing name. Never a vendor: `label` is what the model reads. */
export interface ParkSource {
  /** The building block that produced the records, as
   *  capability_usage_evidence names it. Operator-facing only. */
  source: string;
  sourceRef: string;
  /** Model-facing name for what the records are. */
  label: string;
}

/**
 * Park a payload and return the view the model reads in its place, or null
 * when nothing could be kept.
 *
 * Null is a real answer and every caller handles it: the store can be down, the
 * tenant scope can fail, the payload can hold no records. The caller then hands
 * the model a BOUNDED copy of what it had — never the original, which is the
 * whole thing this exists to keep out of the window.
 */
export async function parkPayload(
  tenantId: string,
  payload: unknown,
  scope: DatasetScope,
  src: ParkSource,
): Promise<{ text: string; datasetId: string; recordCount: number } | null> {
  const records = recordsFromPayload(payload);
  const stored = await createDataset(tenantId, {
    scope,
    label: src.label,
    source: src.source,
    sourceRef: src.sourceRef,
    records,
  });
  if (!stored) return null;
  return {
    text: renderDatasetView({
      id: stored.id,
      label: src.label,
      recordCount: stored.recordCount,
      truncated: stored.truncated,
      fields: stored.fields,
      sample: records.slice(0, VIEW_SAMPLE_RECORDS),
    }),
    datasetId: stored.id,
    recordCount: stored.recordCount,
  };
}

/**
 * A bounded copy of an oversized result: shape-preserving where the payload is
 * JSON (keys and early records survive), a visible cut where it is not.
 *
 * This is the failure path, not the happy one. It exists because the
 * alternative — handing back the original when parking failed — is exactly the
 * outcome parking was added to prevent, and a protection that falls back to
 * the unprotected behaviour protects nothing.
 */
const BOUNDED_NOTE =
  '\n\n[This result was larger than one message and could not be kept for querying, so it is shortened here. '
  + 'Ask for a narrower result rather than assuming this is all of it.]';

export function boundedInline(text: string, max: number = TOOL_RESULT_PARK_CHARS): string {
  if (text.length <= max) return text;
  // The note and the cut marker are part of what is handed over, so they come
  // OUT of the budget rather than being added to it. A "bounded" result longer
  // than the one it replaced is not a bound.
  const budget = Math.max(1_000, max - BOUNDED_NOTE.length - CUT_MARKER_RESERVE);
  const parsed = parsedOrText(text);
  if (typeof parsed !== 'string') return renderCapabilityResult(parsed, budget) + BOUNDED_NOTE;
  const kept = text.slice(0, budget);
  return `${kept}\n…[cut: ${text.length - kept.length} more characters]${BOUNDED_NOTE}`;
}

/** Room kept for the cut marker, which names a count whose width is not known
 *  until the cut is made. Generous: it costs characters of payload, and the
 *  alternative is a bound that is occasionally not one. */
const CUT_MARKER_RESERVE = 64;

/**
 * The call every in-process surface makes at its own seam: under the bound the
 * text is returned unchanged, over it the payload is parked and the model gets
 * the dataset's view — and if it could not be parked, a bounded copy.
 *
 * Never throws. A tool call that succeeded must not fail because the thing that
 * makes its result manageable did.
 */
export async function parkOrBoundText(
  tenantId: string,
  text: string,
  scope: DatasetScope,
  src: ParkSource,
  /** The raw value behind the text, when the caller still has it. Parked in
   *  preference to the text: a tool that returns an object should land as the
   *  record it is rather than as its own serialization. */
  raw?: unknown,
): Promise<string> {
  return (await parkValue(tenantId, text, scope, src, raw)).text;
}

/** The same park, with the dataset it landed in NAMED.
 *
 *  `parkOrBoundText` answers with the model-facing text alone, which is all a
 *  caller that only substitutes text needs. A caller that has to POINT a model
 *  at the dataset — "call dataset_query with this id" — needs the id as well,
 *  and reading it back out of the rendered view would be parsing our own prose.
 *
 *  One implementation behind both shapes rather than two that must agree: the
 *  threshold, the preference for the raw value over its serialization, and the
 *  fall back to a bounded copy are each decided once.
 *
 *  `parked` is empty when nothing was parked, which is a real answer and not a
 *  failure: a value under the bound is returned whole, and a park that could not
 *  be stored degrades to a bounded copy exactly as before. */
export async function parkValue(
  tenantId: string,
  text: string,
  scope: DatasetScope,
  src: ParkSource,
  raw?: unknown,
): Promise<{ text: string; parked: Array<{ datasetId: string; recordCount: number }> }> {
  if (text.length <= TOOL_RESULT_PARK_CHARS) return { text, parked: [] };
  try {
    const parked = await parkPayload(tenantId, raw === undefined ? text : raw, scope, src);
    if (parked) {
      return {
        text: parked.text,
        parked: [{ datasetId: parked.datasetId, recordCount: parked.recordCount }],
      };
    }
  } catch (err) {
    log.warn(
      { tenantId, scope, source: src.source, sourceRef: src.sourceRef, err: (err as Error).message },
      'park: an oversized result could not be kept; the model gets a bounded copy',
    );
  }
  return { text: boundedInline(text), parked: [] };
}

/**
 * One round of an in-process assistant's tool results, bounded.
 *
 * THIS is the seam the plan is about: the point where a round of tool results
 * becomes the next model turn's context. Putting the rule here rather than at
 * each tool is what makes a tool added later covered by construction — the
 * per-producer version was wired to `run_capability` alone, and every other
 * tool on three of the five agent surfaces went into the window whole.
 *
 * Sequential on purpose: a round that parks is rare (a result over 50,000
 * characters), and concurrency here would mean several large payloads held in
 * memory at once for no latency that anybody notices.
 */
export async function parkOversizedToolResults<T extends { toolCallId: string; content: string }>(
  tenantId: string,
  results: T[],
  scope: DatasetScope,
  src: (toolCallId: string) => ParkSource,
): Promise<T[]> {
  // `content` is typed a string and is not always one at runtime: a tool that
  // returns `undefined` serializes to `undefined`, and that has always gone
  // into the conversation as it is. Anything that is not a string is not
  // oversized and is passed through — a size rule must not be the thing that
  // turns a malformed result into a failed turn.
  const oversized = (c: unknown): boolean => typeof c === 'string' && c.length > TOOL_RESULT_PARK_CHARS;
  if (!results.some((r) => oversized(r.content))) return results;
  const out: T[] = [];
  for (const r of results) {
    if (!oversized(r.content)) {
      out.push(r);
      continue;
    }
    out.push({ ...r, content: await parkOrBoundText(tenantId, r.content, scope, src(r.toolCallId)) });
  }
  return out;
}

/** The MCP-shaped result the internal route takes and returns. Everything but
 *  the oversized successful text comes back exactly as it went in. */
export interface McpEnvelope {
  content?: unknown[];
  isError?: boolean;
  _meta?: Record<string, unknown>;
  structuredContent?: unknown;
  [key: string]: unknown;
}

/**
 * Replace the oversized successful TEXT blocks of an MCP result with dataset
 * views, leaving the envelope — `_meta`, `isError`, every non-text block, every
 * block under the bound — exactly as it was.
 *
 * An error result is returned untouched: a TOOL_ERROR envelope is small, and it
 * is what the model reads to recover. Parking it would replace the recovery
 * instruction with a dataset id.
 */
export async function parkOversizedTextBlocks(
  tenantId: string,
  result: McpEnvelope,
  scope: DatasetScope,
  src: ParkSource,
): Promise<{ result: McpEnvelope; parked: Array<{ datasetId: string; recordCount: number }> }> {
  const parked: Array<{ datasetId: string; recordCount: number }> = [];
  if (result.isError === true || !Array.isArray(result.content)) return { result, parked };

  const content: unknown[] = [];
  for (const block of result.content) {
    const b = block as { type?: string; text?: string };
    if (b?.type !== 'text' || typeof b.text !== 'string' || b.text.length <= TOOL_RESULT_PARK_CHARS) {
      content.push(block);
      continue;
    }
    let replacement: string | null = null;
    try {
      // `structuredContent` is the same result before serialization when the
      // producer carried one; parking it keeps the records' own shape.
      const raw = result.structuredContent === undefined ? b.text : result.structuredContent;
      const out = await parkPayload(tenantId, raw, scope, src);
      if (out) {
        replacement = out.text;
        parked.push({ datasetId: out.datasetId, recordCount: out.recordCount });
      }
    } catch (err) {
      log.warn(
        { tenantId, scope, source: src.source, sourceRef: src.sourceRef, err: (err as Error).message },
        'park: an oversized MCP text block could not be kept; the model gets a bounded copy',
      );
    }
    content.push({ ...b, text: replacement ?? boundedInline(b.text) });
  }
  return { result: { ...result, content }, parked };
}

/** What a capability run hands the model: the rendering, when the whole result
 *  fits in it; otherwise the result is parked as a dataset (or added to the one
 *  the model named) and the model gets its view — count, fields, a sample, the
 *  id — and the tools to read it by. The records never pass through the context
 *  that asked for them. When nothing could be parked, the rendering (which says
 *  how many records it left out) is all there is, as before.
 *
 *  TWO CONDITIONS park, not one. The list-page condition is the original: a
 *  result with more records than one page shows. The size condition is the
 *  estate's bound, and it catches what the first cannot see — a result that
 *  renders inside the page budget because its records compact well, while the
 *  records themselves run to hundreds of thousands of characters that the model
 *  will never be able to ask for again. */
export async function parkOrInline(
  tenantId: string,
  source: { source: string; sourceRef: string },
  structured: unknown,
  rendered: string,
  scope: DatasetScope,
  label: string,
  appendTo: string | null,
): Promise<string> {
  const page = renderCapabilityResultPage(structured, 0);
  const list = listOf(structured);
  const pagedList = Boolean(page.records && page.nextOffset !== null && list);
  const oversized = serializedLength(structured) > TOOL_RESULT_PARK_CHARS;
  if (!pagedList && !oversized) {
    if (appendTo && list && list.items.length > 0) {
      // A small later run still lands in the dataset the model is building.
      const added = await appendRecords(tenantId, appendTo, list.items);
      if (added) {
        return `${rendered}\n\nThese ${added.added} records were also added to dataset ${appendTo} (now ${added.recordCount} records; this run is _run ${added.run}).`;
      }
    }
    return rendered;
  }
  // The list's own items when the result is a list; otherwise the payload
  // contract's shaping, so a large non-list result is queryable too rather
  // than being cut.
  const records = list ? list.items : recordsFromPayload(structured);
  if (appendTo) {
    const added = await appendRecords(tenantId, appendTo, records);
    if (added) {
      return renderDatasetView({
        id: appendTo, label, recordCount: added.recordCount, truncated: added.truncated, fields: added.fields,
        sample: records.slice(0, VIEW_SAMPLE_RECORDS),
      }) + `\n\nThis run added ${added.added} records (_run ${added.run}); the dataset now holds ${added.recordCount}.`;
    }
    // The named dataset is gone or not this job's: a fresh one, said so.
  }
  const stored = await createDataset(tenantId, { scope, label, ...source, records });
  if (!stored) return boundedInline(rendered);
  return renderDatasetView({
    id: stored.id, label, recordCount: stored.recordCount, truncated: stored.truncated, fields: stored.fields,
    sample: records.slice(0, VIEW_SAMPLE_RECORDS),
  }) + (appendTo ? `\n\n(The dataset ${appendTo} you named could not be added to — it may have expired — so these records are a new dataset.)` : '');
}

/** How big a result is, as the bound counts it. A value that cannot be
 *  serialized (a cycle) is not over the bound by this measure and is left to
 *  the rendering, which handles depth itself. */
function serializedLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}
