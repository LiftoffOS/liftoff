// The records of a result that keeps them BELOW the top level.
//
// `listOf` looked at top-level keys only. A Parse response is
// `{status, data:{listings, mapResults, totalResultCount, …}}` — a string and
// an object, no array — so 41 Zillow listings became one dataset row holding
// the whole envelope: the model could count it and nothing else, and reported
// that it could not filter what it had just paid for. TikHub and Nasdaq keep
// their records under `data` in the same way.
//
// The trap behind that one is which array to take. In the real
// `search_recently_sold` response `mapResults` holds 500 map pins (995K chars)
// against 41 `listings` (128K chars), so the largest array is the one nobody
// asked for. The records are told apart by SHAPE — keys per record, and the
// keys every record shares — not by size.
//
// The Parse fixtures here are real responses for Palo Alto. The TikHub and
// Nasdaq ones are representative, built from those executors' own code and
// the vendors' docs; replace them with real responses when one is captured.

import * as fs from 'fs';
import * as path from 'path';
import { CAPABILITY_RESULT_BUDGET, listOf, renderCapabilityResult, renderCapabilityResultPage } from '../result-rendering';

function fixture(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8')) as unknown;
}

const homesForSale = fixture('parse-search-homes-for-sale.json') as { data: { listings: unknown[]; mapResults: unknown[] } };
const recentlySold = fixture('parse-search-recently-sold.json') as { data: { listings: unknown[]; mapResults: unknown[] } };

/** TikHub keeps `{code, router, params, data:{…}}` on purpose. */
const tikhub = {
  code: 200,
  router: '/api/v1/tiktok/web/fetch_search_video',
  params: { keyword: 'palo alto', offset: 0 },
  data: {
    aweme_list: Array.from({ length: 12 }, (_, i) => ({
      aweme_id: `72${i}`,
      desc: `a video ${i}`,
      create_time: 1758500000 + i,
      author: { uid: `u${i}`, nickname: `someone ${i}` },
      statistics: { digg_count: i * 3, comment_count: i },
    })),
    cursor: 12,
    has_more: 1,
  },
};

/** Nasdaq passes `{data, message, status}` whole. */
const nasdaq = {
  data: {
    table: {
      headers: { symbol: 'Symbol', lastsale: 'Last Sale' },
      rows: Array.from({ length: 20 }, (_, i) => ({
        symbol: `SYM${i}`,
        name: `Company ${i}`,
        lastsale: `$${10 + i}.00`,
        netchange: '0.10',
        pctchange: '1.0%',
        marketCap: `${i}00000000`,
      })),
    },
    totalrecords: 20,
  },
  message: null,
  status: { rCode: 200, bCodeMessage: null, developerMessage: null },
};

describe('listOf looks inside an envelope for the records', () => {
  it('takes the 41 listings, not the map pins, from a real search_homes_for_sale response', () => {
    const list = listOf(homesForSale);
    expect(list?.field).toBe('data.listings');
    expect(list?.path).toEqual(['data', 'listings']);
    expect(list?.items).toHaveLength(41);
    expect(list?.items).toBe(homesForSale.data.listings);
  });

  it('takes the 41 listings from a real search_recently_sold response, where the map pins are eight times their size', () => {
    expect(JSON.stringify(recentlySold.data.mapResults).length)
      .toBeGreaterThan(JSON.stringify(recentlySold.data.listings).length * 5);
    const list = listOf(recentlySold);
    expect(list?.field).toBe('data.listings');
    expect(list?.items).toHaveLength(41);
    expect(list?.items).toBe(recentlySold.data.listings);
  });

  it('finds the records in a representative TikHub envelope', () => {
    const list = listOf(tikhub);
    expect(list?.field).toBe('data.aweme_list');
    expect(list?.items).toHaveLength(12);
  });

  it('finds the records in a representative Nasdaq envelope', () => {
    const list = listOf(nasdaq);
    expect(list?.field).toBe('data.table.rows');
    expect(list?.path).toEqual(['data', 'table', 'rows']);
    expect(list?.items).toHaveLength(20);
  });

  it('still leaves a record that merely HAS a list as one record', () => {
    expect(listOf({ a: 1, b: [1, 2, 3] })).toBeNull();
    expect(listOf({ id: 1, title: 'one' })).toBeNull();
  });

  it('does not offer a metadata field as the records', () => {
    // `errors` and `status` describe the request; there is nothing here that
    // answers the question that was asked.
    expect(listOf({ status: { messages: [{ text: 'ok' }] }, errors: [{ code: 1 }] })).toBeNull();
  });

  it('takes the table over a lone wide object beside it', () => {
    // A one-element array shares its keys with nothing, so the agreement term
    // is evidence only from two records up. Counted for a singleton, a wide
    // config blob scores twice its width and beats a real list of rows.
    const value = {
      data: {
        settings: [{ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 9, j: 10, k: 11, l: 12 }],
        rows: Array.from({ length: 20 }, (_, i) => ({ id: i, name: `row ${i}`, value: i * 2, at: '2026-09-23' })),
      },
    };
    expect(listOf(value)?.field).toBe('data.rows');
  });

  it('still takes a single-record array when it is the only thing there', () => {
    const value = { data: { profile: [{ id: 1, name: 'someone', title: 'CFO' }] } };
    expect(listOf(value)?.field).toBe('data.profile');
    expect(listOf(value)?.items).toHaveLength(1);
  });

  it('is null below no floor but above no ceiling: a shape nobody anticipated parks as it always did', () => {
    // Deeper than the cap, and under a metadata NAME: both fall back to the
    // behaviour that was there before — the whole payload as one record.
    expect(listOf({ a: { b: { c: { deep: [{ id: 1 }] } } } })).toBeNull();
    expect(listOf({ query: { results: [{ id: 1 }] } })).toBeNull();
  });
});

describe('rendering a result whose larger array is not the chosen list', () => {
  it('never produces a negative cut, and stays inside the budget', () => {
    const page = renderCapabilityResultPage(recentlySold, 0);
    expect(page.records?.total).toBe(41);
    expect(page.text.length).toBeLessThanOrEqual(CAPABILITY_RESULT_BUDGET);
    expect(page.text).not.toMatch(/shown -\d/);
    expect(page.text).not.toMatch(/-\d+ of \d+ chars/);
  });

  it('renders the same result within an explicit budget without a negative cut', () => {
    const out = renderCapabilityResult(recentlySold, 6_000);
    expect(out.length).toBeLessThanOrEqual(6_000);
    expect(out).not.toMatch(/shown -\d/);
    expect(out).toContain('results shown in "data.listings"');
  });

  it('keeps the scalars that say what the result is, and says how many fields it left out', () => {
    const page = renderCapabilityResultPage(recentlySold, 0);
    const [body, ...notes] = page.text.split('\n\n');
    expect(body).toContain('"totalResultCount":1838');
    expect(body).toContain('"data":');
    // `mapResults` is 995K characters and cannot ride along; the reader is
    // told the count rather than left to assume the result had nothing else.
    expect(body).not.toContain('"mapResults"');
    expect(notes.join(' ')).toMatch(/field(s?) of the result (was|were) omitted for length\./);
  });
});
