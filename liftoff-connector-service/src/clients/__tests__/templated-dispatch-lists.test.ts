/**
 * A parameter that holds a list is a different REQUEST, not a longer string.
 *
 * `String(['a','b'])` is `"a,b"`, so a list used to arrive at the provider as
 * ONE value with a comma in it — a question nobody asked, answered wrongly.
 * OpenAPI's defaults are a repeated parameter in the query (`form`, exploded)
 * and comma-joined elements in a path (`simple`), and until this the
 * dispatcher could express neither. TfL's entire API was refused over 53 array
 * parameters, and Asana's and GitHub's last blockers were the same thing.
 *
 * The path half lives here because the path is built in the dispatcher; the
 * query half is finished in the request builder, which repeats the parameter
 * (`custom-api/__tests__/request.test.ts`).
 */
import { runTemplatedRequest } from '../templated-dispatch.js';

type Seen = {
  method: string;
  path: string;
  body?: Record<string, unknown>;
  query?: Record<string, string | string[]>;
};

async function dispatch(entityType: string, input: Record<string, unknown>): Promise<Seen> {
  let seen: Seen | undefined;
  await runTemplatedRequest(
    async (method: string, path: string, body?: Record<string, unknown>, query?: Record<string, string | string[]>) => {
      seen = { method, path, body, query };
      return {};
    },
    entityType,
    input,
  );
  return seen!;
}

describe('a path parameter that holds a list', () => {
  it('joins the elements with commas, which is OpenAPI simple style', async () => {
    const seen = await dispatch('GET /Line/Mode/{modes}/Status', { modes: ['tube', 'dlr'] });
    expect(seen.path).toBe('/Line/Mode/tube,dlr/Status');
  });

  it('encodes each element on its own, so the separators stay separators', async () => {
    // `encodeURIComponent(String(list))` would send `p%2Fq%2Cr%20s`: one
    // segment whose commas are data, which is a different URL.
    const seen = await dispatch('GET /x/{a}', { a: ['p/q', 'r s'] });
    expect(seen.path).toBe('/x/p%2Fq,r%20s');
  });

  it('leaves a single value exactly as it was', async () => {
    const seen = await dispatch('GET /Line/{id}', { id: 'victoria' });
    expect(seen.path).toBe('/Line/victoria');
  });
});

describe('a query parameter that holds a list', () => {
  it('reaches the request builder as a list, not as a joined string', async () => {
    const seen = await dispatch('GET /search', { ids: ['1', '2'], q: 'hi' });
    expect(seen.query).toEqual({ ids: ['1', '2'], q: 'hi' });
  });

  it('carries a list given through an explicit query object too', async () => {
    const seen = await dispatch('GET /search', { query: { ids: ['1', '2'] } });
    expect(seen.query).toEqual({ ids: ['1', '2'] });
  });

  it('still stringifies everything that is not a list', async () => {
    const seen = await dispatch('GET /search', { limit: 10, exact: true });
    expect(seen.query).toEqual({ limit: '10', exact: 'true' });
  });

  it('leaves a write body alone: a list there is JSON and needs no wire form', async () => {
    const seen = await dispatch('POST /things', { tags: ['a', 'b'], name: 'x' });
    expect(seen.body).toEqual({ tags: ['a', 'b'], name: 'x' });
    expect(seen.query).toEqual({});
  });
});
