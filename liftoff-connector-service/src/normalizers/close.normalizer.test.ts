// CloseNormalizer — lead → Lead, contact → Contact via __entity discriminator.

import { CloseNormalizer } from './close.normalizer.js';

const norm = new CloseNormalizer();

describe('CloseNormalizer', () => {
  it('normalizes a lead row (__entity=lead) into a Lead record', () => {
    const out = norm.normalize({ results: [
      { id: 'lead_1', __entity: 'lead', display_name: 'Acme', status_label: 'Potential',
        description: 'A co', url: 'https://app.close.com/lead/lead_1',
        date_created: '2026-01-01T00:00:00Z', date_updated: '2026-02-01T00:00:00Z' },
    ] });
    expect(out).toHaveLength(1);
    expect(out[0].entityType).toBe('Lead');
    expect(out[0].externalId).toBe('lead_1');
    expect(out[0].data).toMatchObject({ id: 'lead_1', name: 'Acme', status: 'Potential', description: 'A co' });
    expect(out[0].metadata.version).toBe('2026-02-01T00:00:00Z');
  });

  it('normalizes a contact row (__entity=contact) with emails + injected leadId', () => {
    const out = norm.normalize({ results: [
      { id: 'cont_1', __entity: 'contact', name: 'Jane', title: 'CTO',
        emails: [{ email: 'jane@acme.com', type: 'office' }, { email: 'j@x.com', type: 'home' }],
        phones: [{ phone: '+1555', type: 'office' }], leadId: 'lead_1', leadName: 'Acme',
        date_updated: '2026-02-01T00:00:00Z' },
    ] });
    expect(out[0].entityType).toBe('Contact');
    expect(out[0].data).toMatchObject({ id: 'cont_1', name: 'Jane', title: 'CTO',
      primaryEmail: 'jane@acme.com', phone: '+1555', leadId: 'lead_1', leadName: 'Acme' });
    expect((out[0].data as { emails: string[] }).emails).toEqual(['jane@acme.com', 'j@x.com']);
  });

  it('coalesces missing fields and drops undiscriminated / id-less rows', () => {
    expect(() => norm.normalize({ results: [{ id: 'lead_x', __entity: 'lead', display_name: null, status_label: null }] })).not.toThrow();
    expect(norm.normalize({ results: [{ id: 'x', display_name: 'y' }] })).toHaveLength(0);
    expect(norm.normalize({ results: [{ __entity: 'lead', display_name: 'y' }] })).toHaveLength(0);
  });

  it('exposes Lead + Contact entity schemas', () => {
    expect(Object.keys(norm.entitySchemas).sort()).toEqual(['Contact', 'Lead']);
  });
});
