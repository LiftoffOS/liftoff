// The generated Locus Parse lane: every function is dispatchable at a listed
// price, named for a capability and never for the vendor, with a typed schema
// every provider's tool contract accepts, and no name collides with the
// hand-written Locus functions.

import { LOCUS_FUNCTIONS, LOCUS_DISPATCH } from '../generated/locus';
import { LOCUS_PARSE_FUNCTIONS, LOCUS_PARSE_DISPATCH, LOCUS_PARSE_BUCKETS } from '../generated/locus-parse';
import { LOCUS_PARSE_ALLOWLIST } from '../locus-parse-allowlist';
import { getConnectorFunctions } from '../connector-functions-registry';

const brands = LOCUS_PARSE_ALLOWLIST.flatMap((p) => p.brands);
// An underscore is a boundary here, which `\\b` does not know: a name like
// get_<vendor>_value must fail.
const brandRe = new RegExp(`(^|[^a-z0-9])(${brands.map((b) => b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[ ._-]+/g, '[ ._-]*')).join('|')})(?=$|[^a-z0-9])`, 'i');

function walk(schema: unknown, visit: (node: Record<string, unknown>, path: string) => void, path = ''): void {
  if (!schema || typeof schema !== 'object') return;
  const node = schema as Record<string, unknown>;
  visit(node, path);
  for (const [k, v] of Object.entries((node.properties as Record<string, unknown>) ?? {})) walk(v, visit, `${path}.${k}`);
  if (node.items && typeof node.items === 'object' && Object.keys(node.items as object).length) walk(node.items, visit, `${path}[]`);
}

describe('generated Locus Parse functions', () => {
  it('exist in number, and are what the registry serves for the locus card', () => {
    expect(LOCUS_PARSE_FUNCTIONS.length).toBeGreaterThan(200);
    const served = getConnectorFunctions('locus').map((f) => f.name);
    for (const f of LOCUS_PARSE_FUNCTIONS) expect(served).toContain(f.name);
  });

  it('each has a dispatch slug of the form provider/endpoint and a listed price above zero', () => {
    for (const f of LOCUS_PARSE_FUNCTIONS) {
      const d = LOCUS_PARSE_DISPATCH[f.name];
      expect(d).toBeDefined();
      expect(d.slug).toMatch(/^[a-z0-9-]+\/[a-z0-9_]+$/);
      expect(d.priceUsd).toBeGreaterThan(0);
      expect(LOCUS_PARSE_BUCKETS[f.name]).toMatch(/^[a-z_]+$/);
    }
    expect(Object.keys(LOCUS_PARSE_DISPATCH).sort()).toEqual(LOCUS_PARSE_FUNCTIONS.map((f) => f.name).sort());
  });

  it('names are unique across the hand-written and generated lanes, short, and vendor-free', () => {
    const all = [...LOCUS_FUNCTIONS, ...LOCUS_PARSE_FUNCTIONS].map((f) => f.name);
    expect(new Set(all).size).toBe(all.length);
    for (const f of LOCUS_PARSE_FUNCTIONS) {
      expect(f.name).toMatch(/^[a-z][a-z0-9_]{2,59}$/);
      expect(f.name).not.toMatch(brandRe);
      expect(LOCUS_DISPATCH[f.name]).toBeUndefined();
    }
  });

  it('no description, property description or enum names a vendor', () => {
    for (const f of LOCUS_PARSE_FUNCTIONS) {
      expect(f.description.length).toBeGreaterThan(10);
      expect(f.description).not.toMatch(brandRe);
      walk(f.inputSchema, (node, path) => {
        if (typeof node.description === 'string') expect({ fn: f.name, path, text: node.description }).not.toMatchObject({ text: expect.stringMatching(brandRe) });
      });
    }
  });

  it('every property carries a type, and an array its items — the shape every provider accepts', () => {
    for (const f of LOCUS_PARSE_FUNCTIONS) {
      expect(f.inputSchema.type).toBe('object');
      walk(f.inputSchema, (node, path) => {
        if (path === '') return;
        expect({ fn: f.name, path, type: node.type }).toMatchObject({ type: expect.any(String) });
        if (node.type === 'array') expect({ fn: f.name, path, items: node.items }).toMatchObject({ items: expect.any(Object) });
      });
      for (const r of f.inputSchema.required ?? []) expect(Object.keys(f.inputSchema.properties)).toContain(r);
    }
  });

  it('is read-only, every one', () => {
    for (const f of LOCUS_PARSE_FUNCTIONS) expect(f.categories).toEqual(['read']);
  });
});
