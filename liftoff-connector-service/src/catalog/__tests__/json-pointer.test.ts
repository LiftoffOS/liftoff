/**
 * A `$ref` may name any node, and providers use that.
 *
 * The resolver this replaces understood `#/components/<section>/<name>` and
 * nothing else, so a pointer into `paths` came back as the ref object itself.
 * Callers then read it as the thing it points at and found no `name`, no `in`
 * and no `schema`: DigitalOcean's specification produced 330 ordinary
 * parameters reported as `"(unnamed)" in an unsupported location "undefined"`,
 * and the provider was refused outright.
 */
import { resolveRef } from '../json-pointer.js';

const doc = {
  openapi: '3.0.0',
  paths: {
    '/v2/account/keys/{ssh_key_identifier}': {
      get: { parameters: [{ name: 'ssh_key_identifier', in: 'path', schema: { type: 'string' } }] },
      delete: {
        parameters: [
          { $ref: '#/paths/~1v2~1account~1keys~1%7Bssh_key_identifier%7D/get/parameters/0' },
        ],
      },
    },
    'a~b/c': { note: 'tilde and slash in one key' },
  },
  components: {
    parameters: { PerPage: { name: 'per_page', in: 'query', schema: { type: 'integer' } } },
    schemas: { Hop: { $ref: '#/components/schemas/Landing' }, Landing: { type: 'string' } },
  },
} as Record<string, unknown>;

describe('resolving a $ref', () => {
  it('follows a pointer into paths, unescaping ~1 and percent-encoding', () => {
    const ref = { $ref: '#/paths/~1v2~1account~1keys~1%7Bssh_key_identifier%7D/get/parameters/0' };
    expect(resolveRef(ref, doc)).toEqual({
      name: 'ssh_key_identifier', in: 'path', schema: { type: 'string' },
    });
  });

  it('still resolves the component refs it always did', () => {
    expect(resolveRef({ $ref: '#/components/parameters/PerPage' }, doc))
      .toEqual({ name: 'per_page', in: 'query', schema: { type: 'integer' } });
  });

  it('unescapes ~0 as a tilde, and ~1 before it', () => {
    expect(resolveRef({ $ref: '#/paths/a~0b~1c' }, doc)).toEqual({ note: 'tilde and slash in one key' });
  });

  it('follows a ref that points at another ref', () => {
    expect(resolveRef({ $ref: '#/components/schemas/Hop' }, doc)).toEqual({ type: 'string' });
  });

  it('returns the node untouched when it is not a ref', () => {
    const plain = { name: 'x', in: 'query' };
    expect(resolveRef(plain, doc)).toBe(plain);
  });

  it('leaves an EXTERNAL ref alone rather than reaching for another document', () => {
    // The fetcher reads one document. Nothing else may be reached from a
    // specification a tenant supplied.
    const external = { $ref: 'https://elsewhere.example/schema.json#/Thing' };
    expect(resolveRef(external, doc)).toBe(external);
  });

  it('says nothing is there when the pointer names nothing', () => {
    expect(resolveRef({ $ref: '#/components/parameters/Missing' }, doc)).toBeUndefined();
  });

  it('gives up on a ref that points at itself instead of spinning', () => {
    const cyclic = { components: { schemas: { Loop: { $ref: '#/components/schemas/Loop' } } } };
    expect(resolveRef({ $ref: '#/components/schemas/Loop' }, cyclic)).toEqual({
      $ref: '#/components/schemas/Loop',
    });
  });
});
