// BambooHRClient.list('Employee') (native Basic-auth directory polling) + normalizer tests.

import { BambooHRClient } from './bamboohr.js';
import { BambooHRNormalizer } from '../normalizers/bamboohr.normalizer.js';
import type { CredentialProvider } from './types.js';

const credentialProvider: CredentialProvider = async () => ({
  accessToken: 'apikey_test',  // BambooHR API key (Basic auth username)
  instanceUrl: 'acme',         // companyDomain subdomain
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

describe('BambooHRClient.list', () => {
  afterEach(() => jest.restoreAllMocks());

  it('hits the directory endpoint and maps employees to records', async () => {
    const spy = mockFetchOnce({
      fields: [{ id: 'displayName', type: 'text', name: 'Display name' }],
      employees: [
        { id: '42', displayName: 'Ada Lovelace', firstName: 'Ada', lastName: 'Lovelace', jobTitle: 'Engineer', workEmail: 'ada@acme.com', department: 'R&D' },
        { id: 99, displayName: 'Alan Turing' },
      ],
    });
    const client = new BambooHRClient(credentialProvider);
    const res = await client.list('Employee', { limit: 100 });

    expect(res.records).toHaveLength(2);
    expect(res.records[0].id).toBe('42');
    expect(res.records[1].id).toBe('99'); // numeric id coerced to string
    expect(res.records[0].data.workEmail).toBe('ada@acme.com');
    expect(res.hasMore).toBe(false);

    const url = spy.mock.calls[0][0] as string;
    expect(url).toBe('https://acme.bamboohr.com/api/v1/employees/directory');
  });

  it('skips employees without an id', async () => {
    mockFetchOnce({ fields: [], employees: [{ displayName: 'No Id' }, { id: '7' }] });
    const client = new BambooHRClient(credentialProvider);
    const res = await client.list('Employee');
    expect(res.records).toHaveLength(1);
    expect(res.records[0].id).toBe('7');
  });

  it('returns empty for a non-Employee entity without calling the API', async () => {
    const spy = jest.spyOn(global, 'fetch');
    const client = new BambooHRClient(credentialProvider);
    expect((await client.list('TimeOff')).records).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('BambooHRNormalizer', () => {
  it('normalizes an employee from { results: [...] }', () => {
    const n = new BambooHRNormalizer();
    const recs = n.normalize({
      results: [{
        id: '42', displayName: 'Ada Lovelace', firstName: 'Ada', lastName: 'Lovelace',
        jobTitle: 'Engineer', workEmail: 'ada@acme.com', department: 'R&D',
        division: 'Tech', location: 'London', supervisor: 'Charles Babbage',
      }],
    });
    expect(recs).toHaveLength(1);
    expect(recs[0].entityType).toBe('Employee');
    expect(recs[0].externalId).toBe('42');
    expect(recs[0].data.jobTitle).toBe('Engineer');
    expect(recs[0].data.supervisor).toBe('Charles Babbage');
    expect(recs[0].metadata.source).toBe('bamboohr');
    expect(typeof recs[0].metadata.version).toBe('string');
    expect(recs[0].metadata.version.length).toBeGreaterThan(0);
  });

  it('skips records without an id and declares the Employee schema with the supervisor field', () => {
    const n = new BambooHRNormalizer();
    expect(n.normalize({ results: [{ displayName: 'x' }] })).toHaveLength(0);
    expect(JSON.stringify(n.entitySchemas.Employee)).toMatch(/supervisor/);
  });
});
