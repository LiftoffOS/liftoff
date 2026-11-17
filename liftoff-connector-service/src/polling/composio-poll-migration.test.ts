// Migration regression — the datadog/apollo/folk specs must reproduce the
// behavior of the deleted bespoke clients/normalizers (same Composio call, same
// normalized records, same entity fields). Fixtures mirror the old bespoke tests.

const mockExecute = jest.fn();
jest.mock('../oauth/composio-client.js', () => ({
  getComposio: () => ({ tools: { execute: mockExecute } }),
  composioProxyRequest: jest.fn(),
}));
jest.mock('../infra/logging.js', () => ({ logger: { warn: jest.fn(), info: jest.fn(), debug: jest.fn() } }));

import { COMPOSIO_POLL_SPECS } from './composio-poll-spec.js';
import { ComposioGenericPollClient } from '../clients/composio-generic-poll-client.js';
import { ComposioGenericNormalizer } from '../normalizers/composio-generic.normalizer.js';

beforeEach(() => jest.clearAllMocks());

// normalize a single raw record through a spec's generic normalizer, stamping
// the entity discriminator the client would add.
function norm(connectorType: string, entityType: string, raw: Record<string, unknown>) {
  const spec = COMPOSIO_POLL_SPECS[connectorType];
  const n = new ComposioGenericNormalizer(spec);
  return n.normalize({ results: [{ ...raw, __pollEntity: entityType }] })[0];
}

describe('apollo migration', () => {
  it('calls APOLLO_SEARCH_CONTACTS with sort + page args (like the bespoke client)', async () => {
    mockExecute.mockResolvedValue({ successful: true, data: { contacts: [], pagination: { total_pages: 1 } } });
    const client = new ComposioGenericPollClient(COMPOSIO_POLL_SPECS.apollo, 't', 'ca');
    await client.list('Contact', { since: new Date('2026-01-01T00:00:00Z') });
    expect(mockExecute).toHaveBeenCalledWith('APOLLO_SEARCH_CONTACTS', expect.objectContaining({
      arguments: expect.objectContaining({ sort_by_field: 'contact_updated_at', sort_ascending: false, per_page: 100, page: 1 }),
    }));
  });
  it('normalizes a contact to the same Contact shape', () => {
    const r = norm('apollo', 'Contact', {
      id: 'c1', name: 'Jane Doe', first_name: 'Jane', last_name: 'Doe', email: 'jane@x.com',
      title: 'VP', organization_name: 'Acme', phone_numbers: [{ raw_number: '+1555' }],
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z',
    });
    expect(r.entityType).toBe('Contact');
    expect(r.externalId).toBe('c1');
    expect(r.data).toMatchObject({ id: 'c1', name: 'Jane Doe', firstName: 'Jane', lastName: 'Doe', email: 'jane@x.com', title: 'VP', organizationName: 'Acme', phone: '+1555', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' });
    expect(r.metadata.version).toBe('2026-01-02T00:00:00Z');
  });
  it('resolves organizationName from nested organization.name (bespoke fallback preserved)', () => {
    const r = norm('apollo', 'Contact', { id: 'c2', organization: { name: 'Nested Co' } });
    expect(r.data.organizationName).toBe('Nested Co');
  });
});

describe('folk migration', () => {
  it('sends nested createdAt filter + FOLK_LIST_PEOPLE', async () => {
    mockExecute.mockResolvedValue({ successful: true, data: { data: { items: [], pagination: {} } } });
    const client = new ComposioGenericPollClient(COMPOSIO_POLL_SPECS.folk, 't', 'ca');
    await client.list('Contact', { since: new Date('2026-01-15T00:00:00Z') });
    expect(mockExecute).toHaveBeenCalledWith('FOLK_LIST_PEOPLE', expect.objectContaining({
      arguments: expect.objectContaining({ limit: 100, filter: { createdAt: { gt: '2026-01-14' } } }),
    }));
  });
  it('normalizes a person to the same Contact shape', () => {
    const r = norm('folk', 'Contact', {
      id: 'p1', fullName: 'Jane', firstName: 'Jane', lastName: 'Doe',
      emails: ['jane@x.com', 'alt@x.com'], phones: ['+1555'], jobTitle: 'CTO',
      companies: [{ id: 'co1', name: 'Acme' }], createdAt: '2026-01-01T00:00:00Z',
    });
    expect(r.data).toMatchObject({ id: 'p1', name: 'Jane', firstName: 'Jane', lastName: 'Doe', primaryEmail: 'jane@x.com', phone: '+1555', jobTitle: 'CTO', companyName: 'Acme', createdAt: '2026-01-01T00:00:00Z' });
    expect((r.data as { emails: string[] }).emails).toEqual(['jane@x.com', 'alt@x.com']);
    expect(r.metadata.version).toBe('2026-01-01T00:00:00Z');
  });
});

describe('datadog migration', () => {
  it('sends a start+end unix window + sources=alert', async () => {
    mockExecute.mockResolvedValue({ successful: true, data: { events: [] } });
    const client = new ComposioGenericPollClient(COMPOSIO_POLL_SPECS.datadog, 't', 'ca');
    await client.list('Alert', { since: new Date('2026-01-01T00:00:00Z') });
    const args = mockExecute.mock.calls[0][1].arguments;
    expect(args.sources).toBe('alert');
    expect(typeof args.start).toBe('number');
    expect(typeof args.end).toBe('number');
  });
  it('normalizes an alert, and hashes a stable id when id is null (bespoke behavior preserved)', () => {
    const withId = norm('datadog', 'Alert', { id: 42, title: 'CPU', message: 'high', timestamp: '2026-01-01T00:00:00Z', tags: ['env:prod', 'service:api', 'alert_type:error'] });
    expect(withId.externalId).toBe('42');
    expect(withId.data).toMatchObject({ id: '42', title: 'CPU', message: 'high', tags: ['env:prod', 'service:api', 'alert_type:error'] });
    // derived tag fields preserved from the bespoke normalizer (fromTag)
    expect(withId.data).toMatchObject({ env: 'prod', service: 'api', alertType: 'error' });
    const noId = norm('datadog', 'Alert', { id: null, title: 'X', message: 'y', timestamp: '2026-01-01T00:00:00Z', tags: [] });
    expect(noId.externalId).toBeTruthy();           // hashed, not dropped
    expect(noId.externalId.length).toBeGreaterThan(0);
  });
});
