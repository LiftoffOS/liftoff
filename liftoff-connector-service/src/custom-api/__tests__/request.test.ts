// Applying the recorded placement, refusing a destination outside the hosts
// the person consented to, and keeping the credential out of anything we write
// down.
//
// The executor's whole job is these three things — the dispatcher it registers
// with already resolves credentials, routes by type and scrubs secrets from
// what comes back — so this is where the boundary is actually tested.

import { BlockedHostError, buildCustomApiRequest } from '../request.js';

const BASE = {
  baseUrl: 'https://api.acme.example',
  apiHosts: ['api.acme.example'],
  credential: 'sk_live_0123456789abcdef',
};

describe('the recorded placement', () => {
  it('sends a bearer token in the Authorization header', () => {
    const built = buildCustomApiRequest({ ...BASE, path: '/v1/deals', placement: { scheme: 'bearer_header' } });
    expect(built.headers.authorization).toBe(`Bearer ${BASE.credential}`);
    expect(built.url).toBe('https://api.acme.example/v1/deals');
  });

  it('sends a named header, with its prefix when one is declared', () => {
    const plain = buildCustomApiRequest({ ...BASE, path: '/v1/deals', placement: { scheme: 'header', name: 'X-Api-Key' } });
    expect(plain.headers['x-api-key']).toBe(BASE.credential);

    const prefixed = buildCustomApiRequest({ ...BASE, path: '/v1/deals', placement: { scheme: 'header', name: 'Authorization', prefix: 'Token ' } });
    expect(prefixed.headers.authorization).toBe(`Token ${BASE.credential}`);
  });

  it('sends a query parameter, beside the operation\'s own', () => {
    const built = buildCustomApiRequest({
      ...BASE,
      path: '/v1/deals',
      query: { limit: '10' },
      placement: { scheme: 'query', name: 'api_key' },
    });
    const url = new URL(built.url);
    expect(url.searchParams.get('api_key')).toBe(BASE.credential);
    expect(url.searchParams.get('limit')).toBe('10');
  });

  it('fills a path segment', () => {
    const built = buildCustomApiRequest({
      ...BASE,
      path: '/v1/{token}/deals',
      placement: { scheme: 'path', name: 'token' },
    });
    expect(built.url).toBe(`https://api.acme.example/v1/${BASE.credential}/deals`);
  });
});

// An array parameter is a different REQUEST, not a different string. Joining
// it sends one value with a comma in it, which is a provider's answer to a
// question nobody asked. TfL's whole API was refused over 53 of these.
describe('a parameter that holds a list', () => {
  it('repeats a query parameter, which is what OpenAPI defaults an array to', () => {
    const built = buildCustomApiRequest({
      ...BASE,
      path: '/Line/Status',
      query: { ids: ['victoria', 'central'], detail: 'true' },
      placement: { scheme: 'bearer_header' },
    });
    const url = new URL(built.url);
    expect(url.searchParams.getAll('ids')).toEqual(['victoria', 'central']);
    expect(url.searchParams.get('detail')).toBe('true');
    // Not one value carrying a separator.
    expect(built.url).not.toContain('victoria%2Ccentral');
  });

  it('encodes each element on its own, so a value containing a comma survives', () => {
    const built = buildCustomApiRequest({
      ...BASE,
      path: '/search',
      query: { q: ['a,b', 'c d'] },
      placement: { scheme: 'bearer_header' },
    });
    expect(new URL(built.url).searchParams.getAll('q')).toEqual(['a,b', 'c d']);
  });

  it('drops nothing but the empty entries, and leaves a single value alone', () => {
    const built = buildCustomApiRequest({
      ...BASE,
      path: '/x',
      query: { a: [], b: 'one' },
      placement: { scheme: 'bearer_header' },
    });
    const url = new URL(built.url);
    expect(url.searchParams.getAll('a')).toEqual([]);
    expect(url.searchParams.get('b')).toBe('one');
  });

  it('still adds the credential when the placement is a query parameter', () => {
    const built = buildCustomApiRequest({
      ...BASE,
      path: '/x',
      query: { ids: ['1', '2'] },
      placement: { scheme: 'query', name: 'app_key' },
    });
    const url = new URL(built.url);
    expect(url.searchParams.getAll('ids')).toEqual(['1', '2']);
    expect(url.searchParams.get('app_key')).toBe(BASE.credential);
    // And it is still redacted in what we write down.
    expect(built.loggableUrl).not.toContain(BASE.credential);
  });
});

// The subset check refuses a declared header that names the credential's own,
// and this is the second half of that: whatever it lets through is applied
// BEFORE the connection's, so no ordering accident can put a model's value
// where the key goes.
// `deepObject` is a provider saying "this parameter carries structure, and
// here is how to write it". Stripe declares it on `expand` and on every range
// filter; accepting the style without writing it would send
// "[object Object]" to a provider that asked a precise question.
describe('a parameter the specification declared deepObject', () => {
  it('brackets an object, which is how a range filter is read back', () => {
    const built = buildCustomApiRequest({
      ...BASE,
      path: '/v1/charges',
      query: { created: { gte: 1690000000, lt: 1700000000 } },
      deepObjectParams: ['created'],
      placement: { scheme: 'bearer_header' },
    });
    const url = decodeURIComponent(built.url);
    expect(url).toContain('created[gte]=1690000000');
    expect(url).toContain('created[lt]=1700000000');
  });

  it('indexes a list, which is what Stripe expand expects', () => {
    const built = buildCustomApiRequest({
      ...BASE,
      path: '/v1/charges',
      query: { expand: ['customer', 'invoice'] },
      deepObjectParams: ['expand'],
      placement: { scheme: 'bearer_header' },
    });
    const url = decodeURIComponent(built.url);
    expect(url).toContain('expand[0]=customer');
    expect(url).toContain('expand[1]=invoice');
  });

  it('leaves a parameter that did NOT declare it as a repeated one', () => {
    const built = buildCustomApiRequest({
      ...BASE,
      path: '/v1/charges',
      query: { expand: ['customer', 'invoice'] },
      placement: { scheme: 'bearer_header' },
    });
    expect(new URL(built.url).searchParams.getAll('expand')).toEqual(['customer', 'invoice']);
  });

  it('brackets an undeclared structure rather than sending the words for it', () => {
    const built = buildCustomApiRequest({
      ...BASE,
      path: '/x',
      query: { filter: { a: 1 } },
      placement: { scheme: 'bearer_header' },
    });
    expect(decodeURIComponent(built.url)).toContain('filter[a]=1');
    expect(built.url).not.toContain('object%20Object');
  });
});

describe('headers the operation declared', () => {
  it('sends them, lower-cased, beside the ones the connection sets', () => {
    const built = buildCustomApiRequest({
      ...BASE,
      path: '/v1/deals',
      placement: { scheme: 'bearer_header' },
      operationHeaders: { 'X-Api-Version': '2026-09-01', 'Idempotency-Key': 'abc' },
    });
    expect(built.headers['x-api-version']).toBe('2026-09-01');
    expect(built.headers['idempotency-key']).toBe('abc');
    expect(built.headers.accept).toBe('application/json');
  });

  it('cannot displace a bearer credential', () => {
    const built = buildCustomApiRequest({
      ...BASE,
      path: '/v1/deals',
      placement: { scheme: 'bearer_header' },
      operationHeaders: { Authorization: 'Bearer not-the-real-key' },
    });
    expect(built.headers.authorization).toBe(`Bearer ${BASE.credential}`);
  });

  it('cannot displace a named-header credential, whatever case it is written in', () => {
    const built = buildCustomApiRequest({
      ...BASE,
      path: '/v1/deals',
      placement: { scheme: 'header', name: 'X-Api-Key' },
      operationHeaders: { 'x-api-key': 'not-the-real-key' },
    });
    expect(built.headers['x-api-key']).toBe(BASE.credential);
  });

  it('is left out entirely when the operation declared none', () => {
    const built = buildCustomApiRequest({ ...BASE, path: '/v1/deals', placement: { scheme: 'bearer_header' } });
    expect(Object.keys(built.headers).sort()).toEqual(['accept', 'authorization']);
  });
});

describe('what gets written down', () => {
  it('redacts a query-parameter placement', () => {
    const built = buildCustomApiRequest({
      ...BASE,
      path: '/v1/deals',
      placement: { scheme: 'query', name: 'api_key' },
    });
    expect(built.loggableUrl).not.toContain(BASE.credential);
    expect(built.loggableUrl).toContain('api_key=%5BREDACTED%5D');
  });

  it('redacts a path-segment placement', () => {
    const built = buildCustomApiRequest({
      ...BASE,
      path: '/v1/{token}/deals',
      placement: { scheme: 'path', name: 'token' },
    });
    expect(built.loggableUrl).not.toContain(BASE.credential);
    expect(built.loggableUrl).toContain('[REDACTED]');
  });

  it('leaves a header placement\'s URL alone, because the value is not in it', () => {
    const built = buildCustomApiRequest({ ...BASE, path: '/v1/deals', placement: { scheme: 'bearer_header' } });
    expect(built.loggableUrl).toBe('https://api.acme.example/v1/deals');
  });
});

describe('the destination', () => {
  it('refuses a host the connection was not described with', () => {
    expect(() => buildCustomApiRequest({
      ...BASE,
      baseUrl: 'https://elsewhere.example',
      path: '/v1/deals',
      placement: { scheme: 'bearer_header' },
    })).toThrow(BlockedHostError);
  });

  it('refuses a plaintext destination, which would put the credential in the clear', () => {
    expect(() => buildCustomApiRequest({
      ...BASE,
      baseUrl: 'http://api.acme.example',
      path: '/v1/deals',
      placement: { scheme: 'bearer_header' },
    })).toThrow(BlockedHostError);
  });
});
