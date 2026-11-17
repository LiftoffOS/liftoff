import { validateResponse, toStrictJsonSchema, checkResponseConformance, _clearValidatorCache } from './response-conformance';
import {
  HIBOB_FUNCTIONS,
  DAYFORCE_FUNCTIONS,
  ORACLE_HCM_FUNCTIONS,
  ADP_WORKFORCE_NOW_FUNCTIONS,
} from '../catalog/native-hris-functions';
import type { ConnectorFunction } from '../types';

describe('validateResponse (drift detection)', () => {
  const schema = {
    type: 'object',
    properties: {
      data: {
        type: 'array',
        items: { type: 'object', properties: { id: { type: 'string' }, first_name: { type: 'string' } } },
      },
    },
  };

  it('conforming payload → no violations', () => {
    expect(validateResponse(schema, { data: [{ id: '1', first_name: 'A' }] })).toEqual([]);
  });

  it('extra/undocumented fields are allowed (additionalProperties)', () => {
    expect(validateResponse(schema, { data: [{ id: '1', first_name: 'A', surprise: true }], meta: {} })).toEqual([]);
  });

  it('type mismatch on a documented field → drift reported', () => {
    const v = validateResponse(schema, { data: [{ id: 42, first_name: 'A' }] }); // id should be a string
    expect(v.length).toBeGreaterThan(0);
  });

  it('no schema → no-op (large-spec / OData / WSDL tools)', () => {
    expect(validateResponse(undefined, { anything: true })).toEqual([]);
  });
});

describe('toStrictJsonSchema', () => {
  it('maps requiredFields→required (when enforced) and strips descriptions', () => {
    const out = toStrictJsonSchema(
      { type: 'object', description: 'x', properties: { a: { type: 'string', description: 'y' } }, requiredFields: ['a'] },
      true,
    );
    expect(out).toEqual({ type: 'object', additionalProperties: true, properties: { a: { type: 'string' } }, required: ['a'] });
  });

  it('does not enforce required for responses (specs over-declare)', () => {
    const out = toStrictJsonSchema({ type: 'object', properties: { a: { type: 'string' } }, requiredFields: ['a'] }, false);
    expect(out.required).toBeUndefined();
  });
});

describe('checkResponseConformance (cached, fn-driven)', () => {
  beforeEach(() => _clearValidatorCache());
  const fn = { responseSchema: { type: 'object', properties: { data: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } } } } };

  it('conforming payload → no drift', () => {
    expect(checkResponseConformance('personio', 'get_a', fn, { data: [{ id: '1' }] })).toEqual({ drift: false, violations: [] });
  });
  it('type mismatch → drift with violations', () => {
    const r = checkResponseConformance('personio', 'get_b', fn, { data: [{ id: 42 }] });
    expect(r?.drift).toBe(true);
    expect(r?.violations.length).toBeGreaterThan(0);
  });
  it('no responseSchema on the tool → null (drift not applicable)', () => {
    expect(checkResponseConformance('personio', 'get_c', {}, { anything: true })).toBeNull();
    expect(checkResponseConformance('personio', 'get_d', undefined, { anything: true })).toBeNull();
  });
  it('unwraps the adapter ExternalRecord {id,data} envelope before validating', () => {
    const listFn = { responseSchema: { type: 'object', properties: { data: { type: 'array', items: { type: 'object' } } } } };
    // A read dispatch wraps the raw vendor body { data:[...] } as { id, data: { data:[...] } }.
    expect(checkResponseConformance('personio', 'get_list', listFn, { id: 'generated', data: { data: [{ x: 1 }] } }))
      .toEqual({ drift: false, violations: [] });
    // A wrong vendor-body type is still caught through the envelope.
    const bad = checkResponseConformance('personio', 'get_list2', listFn, { id: 'generated', data: { data: 'not-an-array' } });
    expect(bad?.drift).toBe(true);
  });

  it('reuses the cached validator across calls for the same (connector, function)', () => {
    expect(checkResponseConformance('personio', 'get_e', fn, { data: [] })).toEqual({ drift: false, violations: [] });
    // second call hits the cache (a different-shaped fn is ignored because the key is cached)
    expect(checkResponseConformance('personio', 'get_e', { responseSchema: { type: 'string' } }, { data: [] })).toEqual({ drift: false, violations: [] });
  });
});

// Hand-authored curated connectors (no fetchable vendor spec): bind each connector's REAL
// responseSchema to the REAL adapter envelope its client produces at runtime, so a future change to
// either side (a renamed container key, or a client that stops returning the raw body in `.data`)
// fails here. The envelopes below are exactly what the client returns:
//   - HiBob/Dayforce/ADP list reads → templatedRead → { id, data: <raw vendor body> }
//   - Oracle list_workers → OracleHcmClient.read('workers') → { id:'workers', data: { items: [...] } }
describe('curated native-HRIS list reads: responseSchema ↔ runtime envelope alignment', () => {
  beforeEach(() => _clearValidatorCache());
  const read = (set: ConnectorFunction[], name: string): ConnectorFunction => {
    const f = set.find((t) => t.name === name);
    if (!f) throw new Error(`missing curated tool ${name}`);
    return f;
  };
  const CASES: Array<{ ct: string; fn: ConnectorFunction; key: string }> = [
    { ct: 'hibob', fn: read(HIBOB_FUNCTIONS, 'list_people'), key: 'employees' },
    { ct: 'dayforce', fn: read(DAYFORCE_FUNCTIONS, 'list_employees'), key: 'Data' },
    { ct: 'adp_workforce_now', fn: read(ADP_WORKFORCE_NOW_FUNCTIONS, 'list_workers'), key: 'workers' },
    { ct: 'oracle_hcm', fn: read(ORACLE_HCM_FUNCTIONS, 'list_workers'), key: 'items' },
  ];

  it.each(CASES.map((c) => [c.ct, c] as const))('%s: carries a responseSchema', (_ct, c) => {
    expect(c.fn.responseSchema).toBeDefined();
  });

  it.each(CASES.map((c) => [c.ct, c] as const))('%s: the real { id, data } envelope conforms', (_ct, c) => {
    const envelope = { id: 'x', data: { [c.key]: [{ id: '1' }, { id: '2' }] } };
    expect(checkResponseConformance(c.ct, c.fn.name, c.fn, envelope)).toEqual({ drift: false, violations: [] });
  });

  it.each(CASES.map((c) => [c.ct, c] as const))('%s: a bare-array vendor body (no container) drifts', (_ct, c) => {
    // If the vendor ever returned the list un-wrapped, the object-typed schema catches it.
    const envelope = { id: 'x', data: [{ id: '1' }] };
    const r = checkResponseConformance(c.ct, c.fn.name, c.fn, envelope);
    expect(r?.drift).toBe(true);
  });

  it.each(CASES.map((c) => [c.ct, c] as const))('%s: a scalar where the container should be an array drifts', (_ct, c) => {
    const envelope = { id: 'x', data: { [c.key]: 'not-an-array' } };
    const r = checkResponseConformance(c.ct, c.fn.name, c.fn, envelope);
    expect(r?.drift).toBe(true);
  });
});
