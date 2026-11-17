// SendGridClient.list('Contact') (api_key search polling) + normalizer tests.

import { SendGridClient } from './sendgrid.js';
import { SendGridNormalizer } from '../normalizers/sendgrid.normalizer.js';
import type { CredentialProvider } from './types.js';

const credentialProvider: CredentialProvider = async () => ({
  accessToken: 'SG.test_api_key',
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

describe('SendGridClient.list', () => {
  afterEach(() => jest.restoreAllMocks());

  it('POSTs a search with an updated_at SGQL query for incremental sync', async () => {
    const spy = mockFetchOnce({
      result: [
        { id: 'abc-1', email: 'a@b.com', first_name: 'A', last_name: 'B', updated_at: '2026-06-26T10:00:00Z' },
      ],
      contact_count: 1,
    });
    const client = new SendGridClient(credentialProvider);
    const res = await client.list('Contact', { since: new Date('2026-06-26T00:00:00Z'), limit: 100 });

    expect(res.records).toHaveLength(1);
    expect(res.records[0].id).toBe('abc-1');
    // SendGrid search caps at 50, no offset paging — never paginate.
    expect(res.hasMore).toBe(false);

    const url = spy.mock.calls[0][0] as string;
    const init = spy.mock.calls[0][1] as RequestInit;
    expect(url).toContain('/v3/marketing/contacts/search');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.query).toContain('updated_at');
    expect(body.query).toContain("TIMESTAMP '2026-06-26T00:00:00.000Z'");
  });

  it('queries all contacts when no since cursor is provided', async () => {
    const spy = mockFetchOnce({ result: [], contact_count: 0 });
    const client = new SendGridClient(credentialProvider);
    const res = await client.list('Contact', {});
    expect(res.records).toEqual([]);
    const body = JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.query).toContain('email LIKE');
  });

  it('returns empty for a non-Contact entity without calling the API', async () => {
    const spy = jest.spyOn(global, 'fetch');
    const client = new SendGridClient(credentialProvider);
    expect((await client.list('List')).records).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('SendGridNormalizer', () => {
  it('normalizes a Contact from { results: [...] }', () => {
    const n = new SendGridNormalizer();
    const recs = n.normalize({
      results: [{
        id: 'abc-1', email: 'a@b.com', first_name: 'A', last_name: 'B',
        phone_number: '+15551234567', created_at: '2026-06-01T00:00:00Z',
        updated_at: '2026-06-26T10:00:00Z', list_ids: ['l1', 'l2'],
      }],
    });
    expect(recs).toHaveLength(1);
    expect(recs[0].entityType).toBe('Contact');
    expect(recs[0].externalId).toBe('abc-1');
    expect(recs[0].data.email).toBe('a@b.com');
    expect(recs[0].data.firstName).toBe('A');
    expect(recs[0].data.listIds).toEqual(['l1', 'l2']);
    expect(recs[0].metadata.source).toBe('sendgrid');
    expect(recs[0].metadata.version).toBe('2026-06-26T10:00:00Z');
  });

  it('skips records without an id and declares the Contact schema with updatedAt', () => {
    const n = new SendGridNormalizer();
    expect(n.normalize({ results: [{ email: 'x@y.com' }] })).toHaveLength(0);
    expect(JSON.stringify(n.entitySchemas.Contact)).toMatch(/updatedAt/);
  });
});
