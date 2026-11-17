// Adapter-driven response-shape tests for REST-direct connectors.
//
// REST-direct clients (BambooHR, Calendly, DocuSign, ...) call the
// vendor's REST API directly via fetch. We mock fetch with each fixture
// as the response body, run the client method, and assert the adapter
// parses + re-shapes correctly.

import { readFileSync } from 'fs';
import { resolve } from 'path';

import { BambooHRClient } from '../../clients/bamboohr.js';
import type { CredentialProvider } from '../../clients/types.js';

function loadFixture(connectorType: string, action: string): unknown {
  return JSON.parse(
    readFileSync(resolve(__dirname, '__fixtures__', connectorType, `${action}.json`), 'utf-8'),
  );
}

function mockFetch(body: unknown, status = 200): jest.SpyInstance {
  return jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    text: async () => JSON.stringify(body),
    json: async () => body,
    headers: new Headers(),
  } as unknown as Response);
}

afterEach(() => jest.restoreAllMocks());

describe('BambooHR REST adapter', () => {
  it('employees.directory: fixture survives client wrapping into {data}', async () => {
    const fixture = loadFixture('bamboohr', 'employees_directory') as {
      fields: Array<{ id: string }>;
      employees: Array<{ id: string; displayName: string }>;
    };
    const fetchSpy = mockFetch(fixture);

    const creds: CredentialProvider = async () => ({
      accessToken: 'apikey',
      instanceUrl: 'test-subdomain',
    });
    const client = new BambooHRClient(creds);
    const result = await client.read('GET /api/v1/employees/directory', undefined);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const data = result.data as { employees: Array<{ id: string }>; fields: unknown[] };
    expect(data.employees[0].id).toBe(fixture.employees[0].id);
    expect(data.fields[0]).toEqual(fixture.fields[0]);
  });

  it('hits the correct BambooHR API path (<subdomain>.bamboohr.com/api/v1)', async () => {
    mockFetch(loadFixture('bamboohr', 'employees_directory'));
    const creds: CredentialProvider = async () => ({
      accessToken: 'apikey',
      instanceUrl: 'acme-co',
    });
    const client = new BambooHRClient(creds);
    await client.read('GET /api/v1/employees/directory', undefined);
    const url = (global.fetch as unknown as jest.Mock).mock.calls[0][0] as string;
    expect(url).toContain('acme-co.bamboohr.com/api/v1');
    expect(url).toMatch(/employees\/directory/);
  });

  it('surfaces a 5xx as a thrown error so the caller can retry/escalate', async () => {
    mockFetch({ error: 'maintenance' }, 503);
    const creds: CredentialProvider = async () => ({ accessToken: 'apikey', instanceUrl: 'acme-co' });
    const client = new BambooHRClient(creds);
    await expect(client.read('GET /api/v1/employees/directory', undefined)).rejects.toThrow();
  });
});
