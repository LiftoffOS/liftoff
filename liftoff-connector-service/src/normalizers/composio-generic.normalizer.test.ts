// ComposioGenericNormalizer — spec-driven field mapping + entity schema build.

import { ComposioGenericNormalizer } from './composio-generic.normalizer.js';
import type { ComposioPollSpec } from '../polling/composio-poll-spec.js';

const spec: ComposioPollSpec = {
  connectorType: 'x',
  entities: [
    {
      entityType: 'Contact', eventTopics: ['contact.created'], action: 'A', idField: 'id',
      since: { mode: 'sortDesc', field: 'updated_at' },
      fields: {
        name: { path: 'name', kind: 'string' },
        primaryEmail: { path: 'emails', kind: 'string', pick: 'first' },
        emails: { path: 'emails', kind: 'string[]' },
        phone: { path: 'phone_numbers', kind: 'string', pick: 'first', from: 'raw_number' },
        orgName: { path: 'organization', kind: 'string', from: 'name' },
        count: { path: 'count', kind: 'number' },
      },
    },
    { entityType: 'Deal', eventTopics: ['deal.updated'], action: 'B', idField: 'deal_id', fields: { title: { path: 'title', kind: 'string' } } },
  ],
};

const norm = new ComposioGenericNormalizer(spec);

describe('ComposioGenericNormalizer', () => {
  it('maps fields via __pollEntity discriminator (Contact)', () => {
    const out = norm.normalize({ results: [{
      __pollEntity: 'Contact', id: 'c1', name: 'Jane',
      emails: ['jane@x.com', 'alt@x.com'],
      phone_numbers: [{ raw_number: '+1555' }],
      organization: { name: 'Acme' },
      count: '7',
      updated_at: '2026-01-02T00:00:00Z',
    }] });
    expect(out).toHaveLength(1);
    expect(out[0].entityType).toBe('Contact');
    expect(out[0].externalId).toBe('c1');
    expect(out[0].data).toMatchObject({ id: 'c1', name: 'Jane', primaryEmail: 'jane@x.com', phone: '+1555', orgName: 'Acme', count: 7 });
    expect((out[0].data as { emails: string[] }).emails).toEqual(['jane@x.com', 'alt@x.com']);
    expect(out[0].metadata.version).toBe('2026-01-02T00:00:00Z'); // since.field
  });

  it('uses the entity-specific idField (Deal.deal_id)', () => {
    const out = norm.normalize({ results: [{ __pollEntity: 'Deal', deal_id: 'd9', title: 'Big' }] });
    expect(out[0].entityType).toBe('Deal');
    expect(out[0].externalId).toBe('d9');
    expect(out[0].data).toMatchObject({ id: 'd9', title: 'Big' });
  });

  it('drops rows with no id and tolerates missing fields', () => {
    expect(norm.normalize({ results: [{ __pollEntity: 'Contact', name: 'x' }] })).toHaveLength(0);
    expect(() => norm.normalize({ results: [{ __pollEntity: 'Contact', id: 'c2' }] })).not.toThrow();
  });

  it('publishes an entity schema per entity, each with an id field', () => {
    expect(Object.keys(norm.entitySchemas).sort()).toEqual(['Contact', 'Deal']);
    const props = (norm.entitySchemas.Contact as { properties?: Record<string, unknown> }).properties ?? {};
    expect(props.id).toBeDefined();
    expect(props.emails).toBeDefined();
  });

  it('versions on versionField when it differs from since.field (PagerDuty pattern)', () => {
    // since filters by created_at (list-window arg) but a status change bumps
    // updated_at — versionField makes the version track the change timestamp.
    const pd = new ComposioGenericNormalizer({
      connectorType: 'pd',
      entities: [{
        entityType: 'Incident', eventTopics: ['incident.triggered'], action: 'A', idField: 'id',
        since: { mode: 'server', field: 'created_at', serverArg: { name: 'since', format: 'iso' } },
        versionField: 'updated_at',
        fields: { status: { path: 'status', kind: 'string' } },
      }],
    });
    const out = pd.normalize({ results: [{
      __pollEntity: 'Incident', id: 'i1', status: 'resolved',
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-03T09:00:00Z',
    }] });
    expect(out[0].metadata.version).toBe('2026-01-03T09:00:00Z'); // updated_at, not created_at
    expect(pd.extractVersion({ __pollEntity: 'Incident', updated_at: '2026-01-03T09:00:00Z' }))
      .toBe('2026-01-03T09:00:00Z');
  });

  it('reads alternate field paths (paths[], first-defined wins — Datadog raw vs remapped)', () => {
    const dd = new ComposioGenericNormalizer({
      connectorType: 'dd',
      entities: [{
        entityType: 'Alert', eventTopics: ['alert.created'], action: 'A', idFallbackHash: true,
        fields: {
          message: { path: 'message', paths: ['message', 'text'], kind: 'string' },
          timestamp: { path: 'timestamp', paths: ['timestamp', 'date_happened'], kind: 'string' },
        },
      }],
    });
    // raw Datadog form: text/date_happened (Composio did not remap)
    const out = dd.normalize({ results: [{ __pollEntity: 'Alert', id: 'a1', text: 'disk full', date_happened: '1700000000' }] });
    expect(out[0].data).toMatchObject({ message: 'disk full', timestamp: '1700000000' });
  });
});
