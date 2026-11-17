// The two pure decisions a custom API connection rests on: what a
// specification we accept looks like, and how an operation's classification is
// merged.
//
// Both are pure, both are load-bearing, and neither is observable anywhere
// else: a wrong subset check ships a connector whose tiles look right and whose
// calls fail (invariant 4 in a new costume), and a wrong merge is the
// difference between an agent asking before a destructive call and not.

import { checkEditedConnection, checkSupportedSubset, hostAllowed, MAX_CUSTOM_API_OPERATIONS } from '../spec.js';
import { generateOperations, isRefusal, mergeClassification, rebaseOperationPaths } from '../operations.js';
import type { CustomApiSpec } from '../types.js';

const SPEC: CustomApiSpec = {
  providerSlug: 'acme',
  displayName: 'Acme',
  baseUrl: 'https://api.acme.example',
  apiHosts: ['api.acme.example'],
  auth: { scheme: 'bearer_header' },
  verification: { method: 'GET', path: '/v1/me' },
  specSourceUrl: 'https://api.acme.example/openapi.json',
  purpose: 'Reading deals.',
};

/* eslint-disable @typescript-eslint/no-explicit-any */
function doc(paths: Record<string, any>, extra: Record<string, any> = {}): Record<string, any> {
  return {
    openapi: '3.0.3',
    servers: [{ url: 'https://api.acme.example' }],
    paths,
    ...extra,
  };
}

/** What a specification would leave out, in the shape these cases were
 *  written against. A construct being unsupported and a specification being
 *  refused are different things now: the first leaves an operation out, the
 *  second means nothing in the document can be connected at all. */
function unsupported(document: Record<string, unknown>, spec = SPEC) {
  const review = checkSupportedSubset(spec, document);
  if (review.refusal) return review.refusal;
  if (review.skipped.length === 0) return null;
  return {
    refused: 'unsupported_specification' as const,
    message: review.skipped.map((s) => `${s.operation}: ${s.reason}`).join('; '),
    operations: review.skipped.map((s) => s.operation),
  };
}

describe('the supported subset', () => {
  it('accepts an operation the dispatcher can actually build a request for', () => {
    const d = doc({
      '/v1/deals': {
        get: {
          operationId: 'listDeals',
          parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' } }],
          responses: { '200': { content: { 'application/json': { schema: { type: 'object' } } } } },
        },
        post: {
          operationId: 'createDeal',
          requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' } } } } } },
          responses: { '201': {} },
        },
      },
    });
    expect(unsupported(d)).toBeNull();
  });

  // An ordinary declared header is sent now; `Host` is not, because it picks
  // a different server than the one consented to. What this case is really
  // about is that a refusal NAMES the operation, so an assistant can relay
  // which one and a person has something to act on.
  it('names the operation a refusal is about', () => {
    const d = doc({
      '/v1/deals': {
        get: { parameters: [{ name: 'Host', in: 'header', schema: { type: 'string' } }], responses: {} },
      },
    });
    const refusal = unsupported(d);
    expect(refusal?.refused).toBe('unsupported_specification');
    expect(refusal?.message).toContain('GET /v1/deals');
    expect(refusal?.message).toContain('header parameter');
    expect(refusal?.operations).toContain('GET /v1/deals');
  });

  // A declared header was refused outright, which was the single largest
  // reason real APIs could not connect: 601 offences across ten providers,
  // most of Trakt, Slack, Apideck and Box. What must STILL refuse is narrow.
  describe('a declared header parameter', () => {
    const withHeader = (name: string) => doc({
      '/v1/deals': { get: { parameters: [{ name, in: 'header', schema: { type: 'string' } }], responses: {} } },
    });

    it('is ordinary and is sent', () => {
      expect(unsupported(withHeader('X-Api-Version'))).toBeNull();
      expect(unsupported(withHeader('Accept'))).toBeNull();
      expect(unsupported(withHeader('Idempotency-Key'))).toBeNull();
    });

    it('refuses the header this connection puts its key in', () => {
      // SPEC is a bearer connection, so Authorization is where the key goes.
      expect(unsupported(withHeader('Authorization'))?.message)
        .toContain("is where this connection's key goes");
      // Named-header placement is the same rule, on whatever it is named.
      const named = { ...SPEC, auth: { scheme: 'header' as const, name: 'X-Api-Key' } };
      expect(unsupported(withHeader('x-api-key'), named)?.message)
        .toContain("is where this connection's key goes");
      // …and that name is ordinary again on a connection that does not use it.
      expect(unsupported(withHeader('X-Api-Key'))).toBeNull();
    });

    it('refuses the headers that belong to the connection, not the request', () => {
      // Host picks a different server than the one consented to; a
      // Content-Length or Transfer-Encoding that disagrees with the body is a
      // request smuggling primitive; Cookie is where credentials live.
      for (const name of ['Host', 'Content-Length', 'Transfer-Encoding', 'Connection', 'Cookie']) {
        expect(unsupported(withHeader(name))?.message)
          .toContain("is the connection's to set");
      }
    });

    it('still refuses a cookie parameter, which is a different thing', () => {
      const cookie = doc({
        '/v1/deals': { get: { parameters: [{ name: 'session', in: 'cookie', schema: { type: 'string' } }], responses: {} } },
      });
      expect(unsupported(cookie)?.message).toContain('cookie parameter');
    });
  });

  it('takes an array of primitives, typed or untyped, in a query and in a path', () => {
    const query = doc({
      '/v1/deals': { get: { parameters: [{ name: 'ids', in: 'query', schema: { type: 'array', items: { type: 'string' } } }], responses: {} } },
    });
    expect(unsupported(query)).toBeNull();

    // TfL types several of these with no `items` at all: unknown reads as a
    // string, the same reading an untyped scalar parameter gets.
    const untyped = doc({
      '/Line/Mode/{modes}': { get: { parameters: [{ name: 'modes', in: 'path', schema: { type: 'array' } }], responses: {} } },
    });
    expect(unsupported(untyped)).toBeNull();
  });

  it('takes a multipart body, because a file is named rather than pasted', () => {
    const multipart = doc({
      '/v1/files': {
        post: {
          requestBody: {
            content: {
              'multipart/form-data': {
                schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' }, name: { type: 'string' } } },
              },
            },
          },
          responses: {},
        },
      },
    });
    expect(unsupported(multipart)).toBeNull();
  });

  it('refuses a non-primitive parameter and a serialisation style it does not implement', () => {

    // An array of primitives is dispatchable now — the query repeats the
    // parameter, a path joins the elements — so what must still be refused is
    // an array of things that are NOT primitives.
    const objectArray = doc({
      '/v1/deals': {
        get: {
          parameters: [{ name: 'ids', in: 'query', schema: { type: 'array', items: { type: 'object' } } }],
          responses: {},
        },
      },
    });
    expect(unsupported(objectArray)?.message).toContain('not of primitives');

    const objectParam = doc({
      '/v1/deals': { get: { parameters: [{ name: 'filter', in: 'query', schema: { type: 'object' } }], responses: {} } },
    });
    expect(unsupported(objectParam)?.message).toContain('not primitive');

    const style = doc({
      '/v1/deals': { get: { parameters: [{ name: 'q', in: 'query', style: 'spaceDelimited', schema: { type: 'string' } }], responses: {} } },
    });
    expect(unsupported(style)?.message).toContain('style "spaceDelimited"');
  });

  it('leaves out an operation with callbacks or its own servers', () => {
    const callbacks = doc({ '/v1/deals': { post: { callbacks: { onEvent: {} }, responses: {} } } });
    expect(unsupported(callbacks)?.message).toContain('callbacks');

    const override = doc({ '/v1/deals': { get: { servers: [{ url: 'https://other.example' }], responses: {} } } });
    expect(unsupported(override)?.message).toContain('its own servers');
  });

  it('connects a provider that declares webhooks, because a webhook stops no operation', () => {
    // Webhooks are inbound and this family cannot receive one. That is a thing
    // the connection does not do, not a reason its READS and WRITES cannot be
    // dispatched — and refusing the document over it took a whole API away for
    // a feature nobody asked for at connect time.
    const webhooks = doc({ '/v1/deals': { get: { responses: {} } } }, { webhooks: { dealChanged: {} } });
    expect(unsupported(webhooks)).toBeNull();
  });

  it('refuses a specification whose declared servers are not the hosts consented to', () => {
    const d = doc({ '/v1/deals': { get: { responses: {} } } }, { servers: [{ url: 'https://elsewhere.example' }] });
    const refusal = unsupported(d);
    expect(refusal?.refused).toBe('host_not_consented');
    expect(refusal?.message).toContain('elsewhere.example');
  });

  // Two refusals that were the check misreading a specification rather than
  // the specification being unsupported. Between them they accounted for 401
  // of the 480 offences across ten public providers, and DigitalOcean alone
  // went from 336 to 3.
  it('reads a parameter written as a $ref into another operation', () => {
    const doc = {
      openapi: '3.0.3',
      servers: [{ url: 'https://api.acme.example' }],
      paths: {
        '/v2/keys/{id}': {
          get: { parameters: [{ name: 'id', in: 'path', schema: { type: 'string' } }] },
          delete: { parameters: [{ $ref: '#/paths/~1v2~1keys~1%7Bid%7D/get/parameters/0' }] },
        },
      },
    };
    expect(unsupported(doc)).toBeNull();
  });

  it('takes a union of primitives as primitive, and still refuses one with structure in it', () => {
    const union = (branches: unknown[]) => doc({
      '/things/{id}': { get: { parameters: [{ name: 'id', in: 'path', schema: { oneOf: branches } }] } },
    });
    // GitHub types `workflow_id` exactly this way: a number or a word, and
    // identical on the wire either way.
    expect(unsupported(union([{ type: 'integer' }, { type: 'string' }]))).toBeNull();
    // A branch that is an object is not a value the dispatcher can put in a
    // path, and saying so is the point of the check.
    expect(unsupported(union([{ type: 'string' }, { type: 'object' }]))?.message)
      .toContain('composed schema');
  });

  it('refuses a document that is not OpenAPI 3.x', () => {
    expect(checkSupportedSubset(SPEC, { swagger: '2.0', paths: {} }).refusal?.message).toContain('Swagger 2.0');
    expect(checkSupportedSubset(SPEC, { paths: {} }).refusal?.message).toContain('OpenAPI 3.x');
  });

  it('matches a host exactly, never by suffix', () => {
    expect(hostAllowed('api.acme.example', ['api.acme.example'])).toBe(true);
    expect(hostAllowed('evil-api.acme.example', ['acme.example'])).toBe(false);
  });
});

// A provider is not its worst endpoint.
//
// DocuSign has three operations that upload a PNG, a PDF and a multipart form,
// out of 393. GitHub has eleven out of 845. Refusing the specification meant a
// person who asked for an API got nothing at all because a handful of its
// endpoints are shapes we do not send — and the endpoint they actually wanted
// was almost never one of them.
describe('connecting what works and naming what does not', () => {
  const mixed = doc({
    '/v1/deals': { get: { operationId: 'listDeals', responses: {} } },
    '/v1/deals/{id}': { get: { operationId: 'getDeal', responses: {} } },
    // The one that cannot be dispatched: it points somewhere else entirely.
    '/v1/files': {
      post: { operationId: 'uploadFile', servers: [{ url: 'https://files.other.example' }], responses: {} },
    },
  });

  it('leaves the offender out and connects the rest', () => {
    const review = checkSupportedSubset(SPEC, mixed);
    expect(review.refusal).toBeNull();
    expect(review.skipped.map((s) => s.operation)).toEqual(['POST /v1/files']);

    const generated = generateOperations(mixed, 'https://api.acme.example', review.skipped.map((s) => s.operation));
    expect(isRefusal(generated)).toBe(false);
    if (isRefusal(generated)) return;
    expect(generated.operations.map((op) => op.entityType).sort())
      .toEqual(['GET /v1/deals', 'GET /v1/deals/{id}']);
  });

  it('says which operation was left out, and why', () => {
    const [only] = checkSupportedSubset(SPEC, mixed).skipped;
    expect(only!.operation).toBe('POST /v1/files');
    expect(only!.reason).toContain('its own servers');
  });

  it('still refuses when the DOCUMENT is the problem, because nothing in it can be connected', () => {
    // Not a per-operation shape: a Swagger 2.0 document, or servers nobody
    // consented to, means there is nothing to choose between.
    expect(checkSupportedSubset(SPEC, { swagger: '2.0', paths: {} }).refusal).not.toBeNull();
    const elsewhere = doc({ '/v1/deals': { get: { responses: {} } } }, { servers: [{ url: 'https://elsewhere.example' }] });
    expect(checkSupportedSubset(SPEC, elsewhere).refusal).not.toBeNull();
  });

  it('refuses when EVERY operation was left out, rather than making an empty connection', () => {
    const allBad = doc({
      '/a': { get: { servers: [{ url: 'https://other.example' }], responses: {} } },
      '/b': { post: { callbacks: { onEvent: {} }, responses: {} } },
    });
    const review = checkSupportedSubset(SPEC, allBad);
    const generated = generateOperations(allBad, 'https://api.acme.example', review.skipped.map((s) => s.operation));
    expect(isRefusal(generated) && generated.refused).toBe('no_operations');
  });

  it('counts the cap against what would be CONNECTED, not what the document holds', () => {
    const paths: Record<string, unknown> = {};
    for (let i = 0; i < MAX_CUSTOM_API_OPERATIONS + 5; i++) {
      paths[`/thing${i}`] = { get: { responses: {} } };
    }
    // Five of them cannot be dispatched, which brings the rest to exactly the
    // cap. An operation left out is not one this connection carries, so it
    // must not be one that pushes it over.
    for (let i = 0; i < 5; i++) {
      paths[`/thing${i}`] = { get: { servers: [{ url: 'https://other.example' }], responses: {} } };
    }
    const d = doc(paths);
    const review = checkSupportedSubset(SPEC, d);
    const generated = generateOperations(d, 'https://api.acme.example', review.skipped.map((s) => s.operation));
    expect(isRefusal(generated)).toBe(false);
  });
});

describe('generating the operations', () => {
  it('refuses a specification that yields nothing, and one that yields too many', () => {
    expect(generateOperations(doc({}), 'https://api.example.com')).toMatchObject({ refused: 'no_operations' });

    const many: Record<string, unknown> = {};
    for (let i = 0; i <= MAX_CUSTOM_API_OPERATIONS; i++) {
      many[`/v1/thing${i}`] = { get: { responses: {} } };
    }
    const refusal = generateOperations(doc(many), 'https://api.example.com');
    expect(refusal).toMatchObject({ refused: 'too_many_operations' });
    expect(isRefusal(refusal) && refusal.message).toContain(String(MAX_CUSTOM_API_OPERATIONS));
  });

  // NASA's APOD specification is served at https://api.nasa.gov/planetary and
  // its one path is `/apod`. Described against a base of https://api.nasa.gov,
  // the operation was stored as `/apod` and resolved to
  // https://api.nasa.gov/apod, which is a 404. The connection still said
  // `active`, because the verification call carries its own path written out
  // in full and never touches the spec's.
  describe('the server url the paths hang off', () => {
    const apod = { '/apod': { get: { operationId: 'getApod', responses: {} } } };
    const onPlanetary = { servers: [{ url: 'https://api.nasa.gov/planetary' }] };

    function pathOf(document: Record<string, unknown>, baseUrl: string): string {
      const g = generateOperations(document, baseUrl);
      if (isRefusal(g)) throw new Error('refused');
      return g.operations[0]!.path;
    }

    it('carries the server prefix when the base address does not', () => {
      expect(pathOf(doc(apod, onPlanetary), 'https://api.nasa.gov')).toBe('/planetary/apod');
    });

    it('carries none of it when the base address already does', () => {
      expect(pathOf(doc(apod, onPlanetary), 'https://api.nasa.gov/planetary')).toBe('/apod');
    });

    it('carries only the part the base address is missing', () => {
      const deep = { servers: [{ url: 'https://api.acme.example/api/v2' }] };
      expect(pathOf(doc({ '/things': { get: { responses: {} } } }, deep), 'https://api.acme.example/api'))
        .toBe('/v2/things');
    });

    it('leaves the path alone when the server carries no prefix', () => {
      expect(pathOf(doc({ '/v1/things': { get: { responses: {} } } }), 'https://api.acme.example'))
        .toBe('/v1/things');
    });

    it('leaves the path alone when base and server disagree outright', () => {
      const elsewhere = { servers: [{ url: 'https://api.acme.example/other' }] };
      expect(pathOf(doc({ '/things': { get: { responses: {} } } }, elsewhere), 'https://api.acme.example/api'))
        .toBe('/things');
    });
  });

  // Editing the base address is the same defect from the other side: the
  // paths are relative to it, so a base that gains a prefix re-homes every
  // operation and every tool 404s.
  describe('re-expressing the paths when the base address moves', () => {
    const ops = [{ name: 'a', path: '/things' }, { name: 'b', path: '/things/{id}' }];

    // The case this exists for: the paths already carry the prefix the base is
    // gaining, so re-expressing them against it leaves every endpoint where it
    // is. A connection described against api.nasa.gov whose operations sit
    // under /planetary is the shape.
    it('keeps every endpoint where it is when the base gains a prefix the paths carry', () => {
      const under = [{ name: 'a', path: '/planetary/apod' }];
      expect(rebaseOperationPaths(under, 'https://api.nasa.gov', 'https://api.nasa.gov/planetary'))
        .toEqual([{ name: 'a', path: '/apod' }]);
    });

    // Not the same thing: nothing sits under the new prefix, so there is no
    // path that both keeps the endpoint and hangs off the base. The operations
    // go where the base was pointed, which is what the edit asked for.
    it('moves the operations under a prefix the paths do not carry', () => {
      expect(rebaseOperationPaths(ops, 'https://api.acme.example', 'https://api.acme.example/v1'))
        .toEqual(ops);
    });

    it('carries the prefix onto the paths when the base loses one', () => {
      const withPrefix = [{ name: 'a', path: '/things' }];
      expect(rebaseOperationPaths(withPrefix, 'https://api.acme.example/v1', 'https://api.acme.example'))
        .toEqual([{ name: 'a', path: '/v1/things' }]);
    });

    it('leaves every path alone when only the host changes', () => {
      expect(rebaseOperationPaths(ops, 'https://api.acme.example', 'https://api-eu.acme.example'))
        .toEqual(ops);
    });

    it('moves the operations with the base when the new base is somewhere else', () => {
      expect(rebaseOperationPaths(ops, 'https://api.acme.example/v1', 'https://api.acme.example/other'))
        .toEqual(ops);
    });
  });

  it('carries the operation template the dispatcher parses', () => {
    const generated = generateOperations(doc({ '/v1/deals/{id}': { get: { operationId: 'getDeal', responses: {} } } }), 'https://api.example.com');
    expect(isRefusal(generated)).toBe(false);
    if (isRefusal(generated)) return;
    expect(generated.operations[0]).toMatchObject({
      name: 'getdeal',
      entityType: 'GET /v1/deals/{id}',
      method: 'GET',
    });
  });
});

describe('merging the seed with the classifier', () => {
  const seedGet = { method: 'GET', categories: ['read'], classification: [] as string[] };
  const seedPost = { method: 'POST', categories: ['write'], classification: ['dataChanges'] };
  const seedDelete = { method: 'DELETE', categories: ['destructive'], classification: ['dataChanges'] };

  it('unions the seed with the classifier answer', () => {
    expect(mergeClassification(seedPost, {
      name: 'x', categories: ['financialActions'], effectClass: 'write',
    })).toEqual(expect.arrayContaining(['write', 'dataChanges', 'financialActions']));
  });

  it('lets the classifier make an operation MORE restrictive', () => {
    const merged = mergeClassification(seedGet, { name: 'x', categories: [], effectClass: 'destructive' });
    expect(merged).toContain('destructive');
    expect(merged).not.toContain('read');
  });

  it('never lets the classifier make an operation LESS restrictive', () => {
    // A POST the classifier read as a read is still a write: the HTTP method
    // is evidence and a model's reading of a name is not.
    const write = mergeClassification(seedPost, { name: 'x', categories: [], effectClass: 'read' });
    expect(write).toContain('write');
    expect(write).not.toContain('read');

    // And a DELETE stays destructive whatever it says.
    const del = mergeClassification(seedDelete, { name: 'x', categories: [], effectClass: 'read' });
    expect(del).toContain('destructive');
    expect(del).not.toContain('read');

    // A sensitivity category the seed asserted is never removed.
    expect(mergeClassification(seedPost, { name: 'x', categories: [], effectClass: null }))
      .toContain('dataChanges');
  });

  it('keeps the conservative seed when there is no confident answer', () => {
    expect(mergeClassification(seedPost, undefined)).toEqual(expect.arrayContaining(['write', 'dataChanges']));
    expect(mergeClassification(seedGet, undefined)).toEqual(['read']);
  });

  it('adds outbound rather than ranking it', () => {
    const merged = mergeClassification(seedPost, { name: 'x', categories: [], effectClass: 'outbound' });
    expect(merged).toContain('outbound');
    expect(merged).toContain('write');
  });

  it('ignores a sensitivity name that is not in the vocabulary the gate matches', () => {
    expect(mergeClassification(seedPost, { name: 'x', categories: ['somethingElse'], effectClass: null }))
      .not.toContain('somethingElse');
  });
});

describe('editing a connection in place', () => {
  const current = { baseUrl: 'https://api.acme.example', apiHosts: ['api.acme.example'] };

  it('accepts an edit that leaves the base address on a listed host', () => {
    // Adding a host changes nothing about where requests go.
    expect(checkEditedConnection(current, { apiHosts: ['api.acme.example', 'api-eu.acme.example'] })).toBeNull();
    // Moving both together is the ordinary case.
    expect(checkEditedConnection(current, {
      baseUrl: 'https://api-eu.acme.example',
      apiHosts: ['api-eu.acme.example'],
    })).toBeNull();
  });

  it('refuses the two halves of the same mistake', () => {
    // A new base address against the OLD hosts...
    expect(checkEditedConnection(current, { baseUrl: 'https://api-eu.acme.example' }))
      .toMatchObject({ refused: 'host_not_consented' });
    // ...and new hosts that no longer contain the old base address.
    expect(checkEditedConnection(current, { apiHosts: ['api-eu.acme.example'] }))
      .toMatchObject({ refused: 'host_not_consented' });
  });

  it('refuses plain http and an empty host list', () => {
    expect(checkEditedConnection(current, { baseUrl: 'http://api.acme.example' })?.message)
      .toContain('https');
    expect(checkEditedConnection(current, { apiHosts: [] })?.message)
      .toContain('can reach nothing');
  });

  it('is checked on the MERGED result, so an unrelated edit is not judged', () => {
    // Nothing about the address changed, so there is nothing to refuse.
    expect(checkEditedConnection(current, {})).toBeNull();
  });
});
