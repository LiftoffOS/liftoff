import { CAPABILITY_RESULT_BUDGET, listOf, renderCapabilityResult, renderCapabilityResultPage } from '../result-rendering';

/** A record the shape a post search returns: wide, mostly empty, one long body. */
function post(i: number, bodyChars = 3000): Record<string, unknown> {
  return {
    id: `1wi${i}`,
    name: `t3_1wi${i}`,
    subreddit: 'shopify',
    subreddit_prefixed: 'r/shopify',
    subreddit_subscribers: null,
    title: `Post number ${i}`,
    author: 'someone',
    author_fullname: null,
    selftext: 'x'.repeat(bodyChars),
    is_self: true,
    url: null,
    domain: null,
    permalink: `https://www.reddit.com/r/shopify/comments/1wi${i}/`,
    score: null,
    ups: null,
    downs: null,
    num_comments: 0,
    created_utc: '2026-09-15T10:00:00Z',
    flair: '',
    awards: [],
    media: {},
    tags: undefined,
  };
}

describe('renderCapabilityResult', () => {
  it('keeps every field that carries a value and drops the ones that do not', () => {
    const out = renderCapabilityResult([post(1, 10)]);
    const [record] = JSON.parse(out) as Array<Record<string, unknown>>;
    expect(Object.keys(record).sort()).toEqual(
      ['author', 'created_utc', 'id', 'is_self', 'name', 'num_comments', 'permalink', 'selftext', 'subreddit', 'subreddit_prefixed', 'title'].sort(),
    );
    // A false or a zero is a value; only null, undefined and the empty string,
    // list and object say nothing.
    expect(record.num_comments).toBe(0);
    expect(record.is_self).toBe(true);
  });

  it('shortens a long text field in place and says by how much', () => {
    const out = renderCapabilityResult([post(1, 3000)]);
    const [body, note] = out.split('\n\n');
    const [record] = JSON.parse(body) as Array<{ selftext: string }>;
    expect(record.selftext.endsWith('…[+2200 chars]')).toBe(true);
    expect(record.selftext.length).toBe(800 + '…[+2200 chars]'.length);
    expect(note).toBe('Long text fields were shortened.');
  });

  it('shows ten wide records whole within the default budget', () => {
    const items = Array.from({ length: 10 }, (_, i) => post(i, 4000));
    expect(JSON.stringify(items).length).toBeGreaterThan(CAPABILITY_RESULT_BUDGET);
    const out = renderCapabilityResult(items);
    expect(out.length).toBeLessThanOrEqual(CAPABILITY_RESULT_BUDGET);
    const [body] = out.split('\n\n');
    expect((JSON.parse(body) as unknown[]).length).toBe(10);
    expect(out).not.toContain('omitted for length');
  });

  it('shows whole records up to the budget and says how many it left out', () => {
    const items = Array.from({ length: 40 }, (_, i) => post(i, 4000));
    const out = renderCapabilityResult(items, 6000);
    expect(out.length).toBeLessThanOrEqual(6000);
    const [body, omitted, shortened] = out.split('\n\n');
    const shown = JSON.parse(body) as Array<{ id: string }>;
    expect(shown.length).toBeGreaterThan(1);
    expect(shown.length).toBeLessThan(40);
    // The records shown are the first ones, whole: the last one parses and
    // carries its link.
    expect(shown[shown.length - 1].permalink).toBeDefined();
    expect(omitted).toBe(
      `${shown.length} of 40 results shown; ${40 - shown.length} omitted for length — ask for fewer results or narrow the request to see the others.`,
    );
    expect(shortened).toBe('Long text fields were shortened.');
  });

  it('shortens the lists inside a large record so whole records still fit', () => {
    // A post carrying its comment thread: the comments outweigh the post.
    const thread = (i: number) => ({
      ...post(i, 200),
      comments: Array.from({ length: 40 }, (_, c) => ({ id: `c${i}-${c}`, body: 'y'.repeat(300), author: 'someone', score: null })),
    });
    const items = Array.from({ length: 10 }, (_, i) => thread(i));
    const out = renderCapabilityResult(items);
    expect(out.length).toBeLessThanOrEqual(CAPABILITY_RESULT_BUDGET);
    const [body, ...notes] = out.split('\n\n');
    const shown = JSON.parse(body) as Array<{ permalink: string; comments: unknown[] }>;
    expect(shown.length).toBeGreaterThanOrEqual(5);
    // Every record shown is whole — its link is there — and its comments are
    // the first five plus a count of the rest.
    for (const record of shown) {
      expect(record.permalink).toMatch(/^https:/);
      expect(record.comments).toHaveLength(6);
      expect(record.comments[5]).toBe('…[+35 more items]');
    }
    expect(notes).toContain('Lists inside records were shortened.');
  });

  it('leaves the lists inside a small record alone', () => {
    const items = [{ ...post(1, 100), tags_list: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }, ...Array.from({ length: 30 }, (_, i) => post(i + 2, 4000))];
    const out = renderCapabilityResult(items, 8000);
    const [body] = out.split('\n\n');
    const [first] = JSON.parse(body) as Array<{ tags_list: string[] }>;
    expect(first.tags_list).toHaveLength(7);
    expect(out).not.toContain('Lists inside records were shortened.');
  });

  it('cuts a single record that is larger than the budget where the cut is visible', () => {
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 200; i++) wide[`field_${i}`] = `value ${i} `.repeat(5);
    const out = renderCapabilityResult([wide, wide], 1500);
    expect(out.length).toBeLessThanOrEqual(1500);
    expect(out).toMatch(/…\[cut: shown \d+ of \d+ chars\]\]/);
    expect(out).toContain('1 of 2 results shown; 1 omitted for length');
  });

  it('renders the list field of a record the same way and names the field', () => {
    const value = { total: 40, page: 1, items: Array.from({ length: 40 }, (_, i) => post(i, 4000)) };
    const out = renderCapabilityResult(value, 6000);
    expect(out.length).toBeLessThanOrEqual(6000);
    const [body, omitted] = out.split('\n\n');
    const parsed = JSON.parse(body) as { total: number; page: number; items: unknown[] };
    expect(parsed.total).toBe(40);
    expect(parsed.page).toBe(1);
    expect(parsed.items.length).toBeGreaterThan(1);
    expect(omitted).toBe(
      `${parsed.items.length} of 40 results shown in "items"; ${40 - parsed.items.length} omitted for length — ask for fewer results or narrow the request to see the others.`,
    );
  });

  it('cuts a record with no list field where the cut is visible', () => {
    const value = { summary: 'a'.repeat(700), detail: 'b'.repeat(700), more: 'c'.repeat(700) };
    const out = renderCapabilityResult(value, 1000);
    expect(out.length).toBeLessThanOrEqual(1000);
    expect(out).toMatch(/…\[cut: shown 800 of \d+ chars\]$/);
  });

  it('leaves a result that fits alone', () => {
    expect(renderCapabilityResult([])).toBe('[]');
    expect(renderCapabilityResult({ ok: true, count: 3 })).toBe('{"ok":true,"count":3}');
    expect(renderCapabilityResult('plain text')).toBe('"plain text"');
    expect(renderCapabilityResult(null)).toBe('null');
  });
});

// A result larger than one page is read by offset: each page shows whole
// records from where the last one stopped, says which records it shows and
// whether more follow, and never asks the model to fetch again.
describe('renderCapabilityResultPage', () => {
  const posts = Array.from({ length: 27 }, (_, i) => post(i, 2500));

  it('the first page starts at record 1 and hands over the offset of the next', () => {
    const page = renderCapabilityResultPage(posts, 0);
    expect(page.records?.from).toBe(1);
    expect(page.records?.total).toBe(27);
    expect(page.records!.to).toBeGreaterThan(1);
    expect(page.records!.to).toBeLessThan(27);
    expect(page.nextOffset).toBe(page.records!.to);
    expect(page.text.length).toBeLessThanOrEqual(CAPABILITY_RESULT_BUDGET);
    expect(page.text).not.toMatch(/more record/);
  });

  it('pages walk the whole list without overlap or gap and the last says so', () => {
    let offset: number | null = 0;
    const seen: number[] = [];
    while (offset !== null) {
      const page: ReturnType<typeof renderCapabilityResultPage> = renderCapabilityResultPage(posts, offset);
      expect(page.records!.from).toBe(offset + 1);
      for (let i = page.records!.from; i <= page.records!.to; i++) seen.push(i);
      offset = page.nextOffset;
    }
    expect(seen).toEqual(Array.from({ length: 27 }, (_, i) => i + 1));
  });

  it('a record whose bulk is one list pages that list inside its frame', () => {
    const value = { subreddit: 'founder', fetchedAt: '2026-09-22', posts };
    const page = renderCapabilityResultPage(value, 5);
    expect(page.records).toEqual(expect.objectContaining({ from: 6, total: 27 }));
    expect(page.text.startsWith('{"subreddit":"founder","fetchedAt":"2026-09-22","posts":[')).toBe(true);
    expect(listOf(value)?.field).toBe('posts');
  });

  it('a result that is not a list has no pages', () => {
    const page = renderCapabilityResultPage({ id: 1, title: 'one' }, 0);
    expect(page.records).toBeNull();
    expect(page.nextOffset).toBeNull();
    expect(page.text).toBe(renderCapabilityResult({ id: 1, title: 'one' }));
  });

  it('a small list is one page, whole', () => {
    const page = renderCapabilityResultPage(posts.slice(0, 3), 0);
    expect(page.records).toEqual({ from: 1, to: 3, total: 3 });
    expect(page.nextOffset).toBeNull();
  });
});
