// The park rule, the payload contract, and what happens when parking fails.
//
// The store itself is mocked: what is under test here is the decision (park or
// not), the SHAPE the payload becomes, what survives of an MCP envelope, and —
// the one that matters most — that a failure never hands the model back the
// oversized payload it was protecting it from.

const mockCreateDataset = jest.fn();
const mockAppendRecords = jest.fn();
jest.mock('../store', () => ({
  createDataset: (...args: unknown[]) => mockCreateDataset(...args),
  appendRecords: (...args: unknown[]) => mockAppendRecords(...args),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  TOOL_RESULT_PARK_CHARS,
  boundedInline,
  parkOrBoundText,
  parkOrInline,
  parkOversizedTextBlocks,
  parkOversizedToolResults,
  recordsFromPayload,
} from '../park';
import { listOf } from '../../capability-discovery/result-rendering';
import * as fs from 'fs';
import * as path from 'path';

/** A real Parse response for Palo Alto: 41 listings and 71 map pins under
 *  `data`, 310,000 characters in all. */
const PARSE_ENVELOPE = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '..', '..', 'capability-discovery', '__tests__', 'fixtures', 'parse-search-homes-for-sale.json'),
    'utf8',
  ),
) as { status: string; data: { listings: unknown[]; mapResults: unknown[] } };

const scope = { kind: 'liftoff_thread' as const, id: 'thread-1' };
const src = { label: 'search result', source: 'liftoff_tool', sourceRef: 'web_search' };
const DATASET_ID = '2f6f2a2e-0d4c-4e0e-9a6e-2c6b7f3f1a11';

/** A payload whose serialization is comfortably over the bound. */
function oversizedText(): string {
  return 'x'.repeat(TOOL_RESULT_PARK_CHARS + 1);
}

function stored(recordCount: number) {
  return { id: DATASET_ID, recordCount, added: recordCount, truncated: false, fields: [{ name: 'value', type: 'text', present: 1 }], run: 1 };
}

beforeEach(() => {
  mockCreateDataset.mockReset();
  mockAppendRecords.mockReset();
});

describe('the payload contract', () => {
  it('turns an array into one record per item', () => {
    expect(recordsFromPayload([{ a: 1 }, { a: 2 }])).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('turns an object that merely HAS a list into ONE record', () => {
    // The list is a minority of the payload, so the object is the thing —
    // unwrapping here would throw away the fields that give it meaning.
    expect(recordsFromPayload({ a: 1, b: [1, 2, 3] })).toEqual([{ a: 1, b: [1, 2, 3] }]);
  });

  it('unwraps an object that IS a list: a paginated envelope parks as its rows', () => {
    // The defect this exists for: `activity_list` returns
    // `{records: [...], nextCursor}`, which is an object, so thousands of rows
    // park as ONE record. The window was protected and nothing could be asked of
    // the rows — `dataset_query` filters and sorts over RECORDS, so a dataset
    // of one answers a count and nothing else, and the model ends up saying it
    // cannot produce the breakdown it was asked for.
    const rows = Array.from({ length: 40 }, (_, i) => ({ id: i, actor: 'someone', action: 'ran' }));
    expect(recordsFromPayload({ records: rows, nextCursor: 'abc' })).toEqual(rows);
    expect(recordsFromPayload({ items: rows, total: 8366 })).toEqual(rows);
  });

  it('drops the envelope\'s pagination and never folds it onto a row', () => {
    // `nextCursor` and `total` describe the FETCH, not the data. Carried onto
    // every row they would be 8,366 copies of a value that answers nothing,
    // and a filter on them would mean nothing either.
    const rows = Array.from({ length: 40 }, (_, i) => ({ id: i, actor: 'someone' }));
    const out = recordsFromPayload({ records: rows, nextCursor: 'abc', total: 8366 });
    expect(out).toHaveLength(40);
    expect(out.every((r) => !('nextCursor' in (r as object)) && !('total' in (r as object)))).toBe(true);
  });

  it('unwraps the SAME way the capability path does, which is why that path never had this defect', () => {
    // Same input, same records: `listOf` is the one rule, imported rather than
    // restated, so the two cannot drift into disagreeing about what a result is.
    const rows = Array.from({ length: 40 }, (_, i) => ({ id: i, name: `row ${i}` }));
    const payload = { records: rows, nextCursor: 'abc' };
    expect(recordsFromPayload(payload)).toEqual(listOf(payload)?.items);
  });

  it('unwraps an envelope that keeps its records below the top level', () => {
    // A real Parse response: `{status, data:{listings:[41], mapResults:[71],
    // totalResultCount, …}}`. Nothing is an array at the top level, so the
    // top-level rule found none and the whole envelope parked as one row.
    const records = recordsFromPayload(PARSE_ENVELOPE);
    expect(records).toHaveLength(41);
    expect(records).toBe(PARSE_ENVELOPE.data.listings);
    expect(records).toEqual(listOf(PARSE_ENVELOPE)?.items);
  });

  it('turns plain text into one record under `value`', () => {
    expect(recordsFromPayload('not json at all')).toEqual([{ value: 'not json at all' }]);
  });

  it('turns a scalar into one record under `value`', () => {
    expect(recordsFromPayload(42)).toEqual([{ value: 42 }]);
    expect(recordsFromPayload(null)).toEqual([{ value: null }]);
    expect(recordsFromPayload('"a string that is json"')).toEqual([{ value: 'a string that is json' }]);
  });

  it('parses a string that IS json, so a tool that serialized its own records lands as records', () => {
    expect(recordsFromPayload('[{"a":1},{"a":2}]')).toEqual([{ a: 1 }, { a: 2 }]);
    expect(recordsFromPayload('{"a":1}')).toEqual([{ a: 1 }]);
  });
});

describe('parkOrBoundText', () => {
  it('leaves a result under the bound exactly as it was', async () => {
    const small = 'a small answer';
    await expect(parkOrBoundText('t1', small, scope, src)).resolves.toBe(small);
    expect(mockCreateDataset).not.toHaveBeenCalled();
  });

  it('parks an oversized result and hands back the dataset view', async () => {
    mockCreateDataset.mockResolvedValueOnce(stored(3));
    const out = await parkOrBoundText('t1', JSON.stringify([{ a: 1 }, { a: 2 }, { a: 3 }]) + oversizedText(), scope, src, [{ a: 1 }, { a: 2 }, { a: 3 }]);
    expect(mockCreateDataset).toHaveBeenCalledWith('t1', expect.objectContaining({
      scope, label: 'search result', source: 'liftoff_tool', sourceRef: 'web_search',
      records: [{ a: 1 }, { a: 2 }, { a: 3 }],
    }));
    expect(out).toContain(DATASET_ID);
    expect(out).toContain('dataset_query');
  });

  it('BOUNDS rather than returning the payload when the store answers null', async () => {
    mockCreateDataset.mockResolvedValueOnce(null);
    const text = oversizedText();
    const out = await parkOrBoundText('t1', text, scope, src);
    expect(out).not.toBe(text);
    expect(out.length).toBeLessThan(text.length);
    expect(out).toContain('could not be kept');
  });

  it('BOUNDS rather than returning the payload when the store throws', async () => {
    mockCreateDataset.mockRejectedValueOnce(new Error('pool exhausted'));
    const text = oversizedText();
    const out = await parkOrBoundText('t1', text, scope, src);
    expect(out).not.toBe(text);
    expect(out.length).toBeLessThan(text.length);
  });
});

describe('boundedInline', () => {
  it('keeps the shape of json rather than cutting it mid-record', () => {
    const rows = Array.from({ length: 5_000 }, (_, i) => ({ id: i, body: 'y'.repeat(50) }));
    const out = boundedInline(JSON.stringify(rows));
    expect(out.length).toBeLessThan(JSON.stringify(rows).length);
    expect(out).toContain('"id"');
  });

  it('cuts plain text visibly, and fits the bound it was given', () => {
    const text = 'z'.repeat(TOOL_RESULT_PARK_CHARS + 100);
    const out = boundedInline(text);
    expect(out).toMatch(/\[cut: \d+ more characters\]/);
    // The note and the marker come OUT of the budget: a "bounded" result
    // longer than the one it replaced is not a bound.
    expect(out.length).toBeLessThanOrEqual(TOOL_RESULT_PARK_CHARS);
    const dropped = Number(/\[cut: (\d+) more characters\]/.exec(out)![1]);
    expect(dropped).toBeGreaterThan(100);
  });

  it('leaves anything under the bound alone', () => {
    expect(boundedInline('short')).toBe('short');
  });
});

describe('parkOversizedToolResults (the in-process seam)', () => {
  it('leaves a round with nothing oversized untouched, and never reaches the store', async () => {
    const results = [{ toolCallId: 'a', content: 'one' }, { toolCallId: 'b', content: 'two' }];
    await expect(parkOversizedToolResults('t1', results, scope, () => src)).resolves.toBe(results);
    expect(mockCreateDataset).not.toHaveBeenCalled();
  });

  it('parks only the oversized result of a round and keeps the others as they were', async () => {
    mockCreateDataset.mockResolvedValueOnce(stored(1));
    const small = { toolCallId: 'a', content: 'one' };
    const big = { toolCallId: 'b', content: oversizedText() };
    const out = await parkOversizedToolResults('t1', [small, big], scope, () => src);
    expect(out[0]).toEqual(small);
    expect(out[1].toolCallId).toBe('b');
    expect(out[1].content).toContain(DATASET_ID);
    expect(mockCreateDataset).toHaveBeenCalledTimes(1);
  });

  it('passes a result whose content is not a string straight through', async () => {
    // A tool that returns `undefined` serializes to `undefined`, and that has
    // always gone into the conversation as it is. A size rule must not be what
    // turns a malformed result into a failed turn.
    const odd = [{ toolCallId: 'a', content: undefined as unknown as string }];
    await expect(parkOversizedToolResults('t1', odd, scope, () => src)).resolves.toBe(odd);
    expect(mockCreateDataset).not.toHaveBeenCalled();
  });

  it('names each parked result by the tool that produced it', async () => {
    mockCreateDataset.mockResolvedValueOnce(stored(1));
    await parkOversizedToolResults(
      't1',
      [{ toolCallId: 'b', content: oversizedText() }],
      scope,
      (id) => ({ label: `${id} result`, source: 'liftoff_tool', sourceRef: id }),
    );
    expect(mockCreateDataset).toHaveBeenCalledWith('t1', expect.objectContaining({ label: 'b result', sourceRef: 'b' }));
  });
});

describe('parkOversizedTextBlocks (the MCP envelope)', () => {
  const meta = { 'liftoff/bounded': true };

  it('replaces only the oversized text block and keeps the envelope around it', async () => {
    mockCreateDataset.mockResolvedValueOnce(stored(2));
    const result = {
      content: [
        { type: 'text', text: 'a small note' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        { type: 'text', text: oversizedText() },
      ],
      isError: false,
      _meta: meta,
      structuredContent: [{ a: 1 }, { a: 2 }],
    };
    const out = await parkOversizedTextBlocks('t1', result, scope, src);
    expect(out.result._meta).toEqual(meta);
    expect(out.result.isError).toBe(false);
    expect(out.result.content![0]).toEqual({ type: 'text', text: 'a small note' });
    expect(out.result.content![1]).toEqual({ type: 'image', data: 'AAAA', mimeType: 'image/png' });
    expect((out.result.content![2] as { text: string }).text).toContain(DATASET_ID);
    expect(out.parked).toEqual([{ datasetId: DATASET_ID, recordCount: 2 }]);
    // The records came from structuredContent, not from the serialized text.
    expect(mockCreateDataset).toHaveBeenCalledWith('t1', expect.objectContaining({ records: [{ a: 1 }, { a: 2 }] }));
  });

  it('leaves an ERROR result entirely alone — it is what the model recovers from', async () => {
    const result = { content: [{ type: 'text', text: oversizedText() }], isError: true };
    const out = await parkOversizedTextBlocks('t1', result, scope, src);
    expect(out.result).toBe(result);
    expect(out.parked).toEqual([]);
    expect(mockCreateDataset).not.toHaveBeenCalled();
  });

  it('leaves a result with no content array alone', async () => {
    const result = { isError: false, structuredContent: { a: 1 } };
    const out = await parkOversizedTextBlocks('t1', result, scope, src);
    expect(out.result).toBe(result);
  });

  it('BOUNDS the block rather than returning it when the store fails', async () => {
    mockCreateDataset.mockResolvedValueOnce(null);
    const text = oversizedText();
    const out = await parkOversizedTextBlocks('t1', { content: [{ type: 'text', text }] }, scope, src);
    const replaced = (out.result.content![0] as { text: string }).text;
    expect(replaced).not.toBe(text);
    expect(replaced.length).toBeLessThan(text.length);
    expect(out.parked).toEqual([]);
  });
});

describe('parkOrInline (the capability path)', () => {
  it('still inlines a small single-page result', async () => {
    const out = await parkOrInline('t1', { source: 'connector_registry', sourceRef: 'x:y' }, { a: 1 }, 'the rendering', scope, 'label', null);
    expect(out).toBe('the rendering');
    expect(mockCreateDataset).not.toHaveBeenCalled();
  });

  it('parks a list that does not fit one page, as it always did', async () => {
    mockCreateDataset.mockResolvedValueOnce(stored(400));
    const items = Array.from({ length: 400 }, (_, i) => ({ id: i, body: 'q'.repeat(200) }));
    const out = await parkOrInline('t1', { source: 'apify_store', sourceRef: 'a/b' }, items, 'the rendering', scope, 'label', null);
    expect(out).toContain(DATASET_ID);
    expect(mockCreateDataset).toHaveBeenCalledWith('t1', expect.objectContaining({ records: items }));
  });

  it('ALSO parks a result whose records are over the bound even though the page fitted', async () => {
    // A single record, so there is no page to run out of — and 60,000
    // characters of it, which the rendering compacts out of sight and the
    // model can then never ask for again.
    mockCreateDataset.mockResolvedValueOnce(stored(1));
    const fat = { id: 1, body: 'w'.repeat(60_000) };
    const out = await parkOrInline('t1', { source: 'connector_registry', sourceRef: 'x:y' }, fat, 'the rendering', scope, 'label', null);
    expect(mockCreateDataset).toHaveBeenCalledWith('t1', expect.objectContaining({ records: [fat] }));
    expect(out).toContain(DATASET_ID);
  });

  it('bounds the rendering rather than returning it whole when the store could not keep the records', async () => {
    mockCreateDataset.mockResolvedValueOnce(null);
    const items = Array.from({ length: 400 }, (_, i) => ({ id: i, body: 'q'.repeat(200) }));
    const rendering = 'r'.repeat(TOOL_RESULT_PARK_CHARS + 10);
    const out = await parkOrInline('t1', { source: 'apify_store', sourceRef: 'a/b' }, items, rendering, scope, 'label', null);
    expect(out).not.toBe(rendering);
    expect(out.length).toBeLessThan(rendering.length);
  });

  it('parks a real enveloped response as its 41 listings, not as one envelope row', async () => {
    // The defect, end to end: `{status, data:{listings, mapResults, …}}` has no
    // array at the top level, so the whole 310,000-character envelope became
    // ONE record. The model could count it and nothing else — no filter, no
    // median, no breakdown of what it had just paid for.
    mockCreateDataset.mockResolvedValueOnce(stored(41));
    const out = await parkOrInline(
      't1', { source: 'connector_registry', sourceRef: 'locus:home_listings_search_homes_for_sale' },
      PARSE_ENVELOPE, 'the rendering', scope, 'zillow listings', null,
    );
    expect(mockCreateDataset).toHaveBeenCalledWith('t1', expect.objectContaining({
      records: PARSE_ENVELOPE.data.listings,
    }));
    const [, stored41] = mockCreateDataset.mock.calls[0] as [string, { records: unknown[] }];
    expect(stored41.records).toHaveLength(41);
    expect(out).toContain(DATASET_ID);
  });
});
