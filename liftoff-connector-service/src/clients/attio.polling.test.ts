// AttioClient.list('Contact'|'Deal') (objects/records/query polling) +
// AttioNormalizer multi-entity discrimination tests.

import { AttioClient } from './attio.js';
import { AttioNormalizer } from '../normalizers/attio.normalizer.js';
import type { CredentialProvider } from './types.js';

const credentialProvider: CredentialProvider = async () => ({
  accessToken: 'attio_test_token',
  tenantId: 't1',
  connectorId: 'c1',
});

function mockFetchOnce(body: unknown, status = 200) {
  return jest.spyOn(global, 'fetch').mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response);
}

describe('AttioClient.list', () => {
  afterEach(() => jest.restoreAllMocks());

  it("list('Contact') queries the people object and stamps __attioObject", async () => {
    const spy = mockFetchOnce({
      data: [
        {
          id: { record_id: 'person-1' },
          created_at: '2026-06-26T10:00:00Z',
          values: {
            name: [{ full_name: 'Ada Lovelace', first_name: 'Ada', last_name: 'Lovelace' }],
            email_addresses: [{ email_address: 'ada@example.com' }],
          },
        },
      ],
    });

    const client = new AttioClient(credentialProvider);
    const res = await client.list('Contact', { limit: 100 });

    const url = spy.mock.calls[0][0] as string;
    const init = spy.mock.calls[0][1] as RequestInit;
    expect(url).toContain('/objects/people/records/query');
    expect(init.method).toBe('POST');
    const reqBody = JSON.parse(init.body as string);
    expect(reqBody.limit).toBe(100);
    expect(reqBody.offset).toBe(0);
    expect(reqBody.sorts[0]).toMatchObject({ attribute: 'created_at', direction: 'desc' });

    expect(res.records).toHaveLength(1);
    expect(res.records[0].id).toBe('person-1');
    expect(res.records[0].data.__attioObject).toBe('people');
    expect(res.hasMore).toBe(false);
  });

  it("list('Deal') queries the deals object and stamps __attioObject", async () => {
    const spy = mockFetchOnce({
      data: [{ id: { record_id: 'deal-1' }, created_at: '2026-06-26T11:00:00Z', values: {} }],
    });

    const client = new AttioClient(credentialProvider);
    const res = await client.list('Deal', { limit: 100 });

    const url = spy.mock.calls[0][0] as string;
    expect(url).toContain('/objects/deals/records/query');
    expect(res.records[0].data.__attioObject).toBe('deals');
    expect(res.records[0].id).toBe('deal-1');
  });

  it('paginates via offset when a full page returns', async () => {
    mockFetchOnce({ data: Array.from({ length: 2 }, (_, i) => ({ id: { record_id: `p${i}` }, values: {} })) });
    const client = new AttioClient(credentialProvider);
    const res = await client.list('Contact', { limit: 2 });
    expect(res.hasMore).toBe(true);
    expect(res.nextPageToken).toBe('2');
  });

  it('returns empty for an unknown entity without calling the API', async () => {
    const spy = jest.spyOn(global, 'fetch');
    const client = new AttioClient(credentialProvider);
    expect((await client.list('Note')).records).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('AttioNormalizer', () => {
  it('emits Contact for a people row from { results: [...] }', () => {
    const n = new AttioNormalizer();
    const recs = n.normalize({
      results: [
        {
          id: { record_id: 'person-1' },
          created_at: '2026-06-26T10:00:00Z',
          web_url: 'https://app.attio.com/x/person-1',
          __attioObject: 'people',
          values: {
            name: [{ full_name: 'Ada Lovelace', first_name: 'Ada', last_name: 'Lovelace' }],
            email_addresses: [{ email_address: 'ada@example.com' }],
          },
        },
      ],
    });

    expect(recs).toHaveLength(1);
    expect(recs[0].entityType).toBe('Contact');
    expect(recs[0].externalId).toBe('person-1');
    expect(recs[0].data.fullName).toBe('Ada Lovelace');
    expect(recs[0].data.emails).toEqual(['ada@example.com']);
    expect(recs[0].data.primaryEmail).toBe('ada@example.com');
    expect(recs[0].metadata.source).toBe('attio');
    expect(recs[0].metadata.version).toBe('2026-06-26T10:00:00Z');
  });

  it('emits Deal for a deals row from { results: [...] }', () => {
    const n = new AttioNormalizer();
    const recs = n.normalize({
      results: [
        {
          id: { record_id: 'deal-1' },
          created_at: '2026-06-26T11:00:00Z',
          __attioObject: 'deals',
          values: {
            name: [{ value: 'Acme renewal' }],
            value: [{ currency_value: 50000, currency_code: 'USD' }],
            stage: [{ status: { title: 'Negotiation' } }],
            associated_company: [{ target_record_id: 'company-9', target_object: 'companies' }],
          },
        },
      ],
    });

    expect(recs).toHaveLength(1);
    expect(recs[0].entityType).toBe('Deal');
    expect(recs[0].externalId).toBe('deal-1');
    expect(recs[0].data.name).toBe('Acme renewal');
    expect(recs[0].data.amount).toBe(50000);
    expect(recs[0].data.currencyCode).toBe('USD');
    expect(recs[0].data.stage).toBe('Negotiation');
    expect(recs[0].data.associatedCompanyId).toBe('company-9');
  });

  it('discriminates a mixed { results: [...] } batch by __attioObject', () => {
    const n = new AttioNormalizer();
    const recs = n.normalize({
      results: [
        { id: { record_id: 'p1' }, __attioObject: 'people', values: { name: [{ full_name: 'X' }] } },
        { id: { record_id: 'd1' }, __attioObject: 'deals', values: { name: [{ value: 'Deal' }] } },
      ],
    });
    expect(recs.map(r => r.entityType)).toEqual(['Contact', 'Deal']);
  });

  it('skips rows without a record id and declares both entity schemas', () => {
    const n = new AttioNormalizer();
    expect(n.normalize({ results: [{ __attioObject: 'people', values: {} }] })).toHaveLength(0);
    expect(Object.keys(n.entitySchemas).sort()).toEqual(['Contact', 'Deal']);
  });
});
