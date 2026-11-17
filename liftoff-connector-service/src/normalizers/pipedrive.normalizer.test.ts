// PipedriveNormalizer — deal → Deal, person → Contact via __entity discriminator.

import { PipedriveNormalizer } from './pipedrive.normalizer.js';

const norm = new PipedriveNormalizer();

describe('PipedriveNormalizer', () => {
  it('normalizes a deal row (__entity=deal) into a Deal record', () => {
    const out = norm.normalize({ results: [
      { id: 11, __entity: 'deal', title: 'Big deal', value: 5000, currency: 'USD', status: 'open',
        stage_id: 3, person_id: { value: 22 }, org_id: 7, add_time: '2026-01-01 09:00:00', update_time: '2026-01-02 10:00:00' },
    ] });
    expect(out).toHaveLength(1);
    expect(out[0].entityType).toBe('Deal');
    expect(out[0].externalId).toBe('11');
    expect(out[0].data).toMatchObject({ id: '11', name: 'Big deal', amount: 5000, currencyCode: 'USD', status: 'open', stageId: 3, personId: 22, orgId: 7 });
    expect(out[0].metadata.version).toBe('2026-01-02 10:00:00');
  });

  it('normalizes a person row (__entity=person) into a Contact record with primary email', () => {
    const out = norm.normalize({ results: [
      { id: 22, __entity: 'person', name: 'Jane Doe', first_name: 'Jane', last_name: 'Doe',
        email: [{ value: 'alt@x.com', primary: false }, { value: 'jane@x.com', primary: true }],
        phone: [{ value: '+1555', primary: true }], org_id: 7, update_time: '2026-01-02 11:00:00' },
    ] });
    expect(out[0].entityType).toBe('Contact');
    expect(out[0].data).toMatchObject({ id: '22', name: 'Jane Doe', firstName: 'Jane', lastName: 'Doe', primaryEmail: 'jane@x.com', phone: '+1555', orgId: 7 });
    expect((out[0].data as { emails: string[] }).emails).toEqual(['alt@x.com', 'jane@x.com']);
  });

  it('coalesces null fields without throwing (Zod .optional accepts undefined only)', () => {
    expect(() => norm.normalize({ results: [
      { id: 1, __entity: 'deal', title: null, value: null, currency: null, status: null, update_time: null, add_time: null },
    ] })).not.toThrow();
  });

  it('drops rows without a discriminator or id', () => {
    expect(norm.normalize({ results: [{ id: 5, title: 'x' }] })).toHaveLength(0);
    expect(norm.normalize({ results: [{ __entity: 'deal', title: 'x' }] })).toHaveLength(0);
  });

  it('exposes Deal + Contact entity schemas', () => {
    expect(Object.keys(norm.entitySchemas).sort()).toEqual(['Contact', 'Deal']);
  });
});
