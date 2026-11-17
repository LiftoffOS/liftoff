// Focused tests for the hottest connectors — ensure each ported client
// talks to the right endpoint, handles credentials correctly, and surfaces
// vendor errors without leaking stack traces. All network I/O is stubbed.

import { GoogleDriveClient } from './google-drive.js';
import { SalesforceClient } from './salesforce.js';
import type { CredentialProvider } from './types.js';

function mockOk(body: Record<string, unknown>, status = 200): Response {
  return {
    ok: true,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}
function mockErr(status: number, msg: string): Response {
  return {
    ok: false,
    status,
    text: async () => msg,
    json: async () => ({ error: msg }),
  } as unknown as Response;
}

describe('GoogleDriveClient', () => {
  let fetchSpy: jest.SpyInstance;
  const credentialProvider: CredentialProvider = async () => ({ accessToken: 'ya29.x' });

  beforeEach(() => {
    fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(mockOk({ id: 'F', name: 'file.txt' }));
  });
  afterEach(() => fetchSpy.mockRestore());

  it('read(file) hits /drive/v3/files/<id> with fields param', async () => {
    fetchSpy.mockResolvedValueOnce(
      mockOk({ id: 'F', name: 'f.txt', modifiedTime: '2026-01-01T00:00:00Z', version: '2' }),
    );
    const client = new GoogleDriveClient(credentialProvider);
    const rec = await client.read('file', 'F');
    expect(rec.id).toBe('F');
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain('https://www.googleapis.com/drive/v3/files/F');
    expect(url).toContain('fields=');
    expect(rec.versionToken).toBe('2');
  });

  it('throws with status code on 4xx vendor errors', async () => {
    fetchSpy.mockResolvedValueOnce(mockErr(404, 'notFound'));
    const client = new GoogleDriveClient(credentialProvider);
    await expect(client.read('file', 'missing')).rejects.toThrow(/404/);
  });
});

describe('SalesforceClient', () => {
  let fetchSpy: jest.SpyInstance;
  const credentialProvider: CredentialProvider = async () => ({
    accessToken: 'sf-token',
    instanceUrl: 'https://example.my.salesforce.com',
  });

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(mockOk({}));
  });
  afterEach(() => fetchSpy.mockRestore());

  it('uses the per-request instanceUrl rather than caching it', async () => {
    fetchSpy.mockResolvedValueOnce(
      mockOk({
        Id: 'a01',
        SystemModstamp: '2026-01-01T00:00:00.000+0000',
        LastModifiedDate: '2026-01-01T00:00:00.000+0000',
      }),
    );
    const client = new SalesforceClient(credentialProvider);
    await client.read('Contact', 'a01');
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toBe('https://example.my.salesforce.com/services/data/v59.0/sobjects/Contact/a01');
  });

  it('create returns success=false and error string on vendor failure', async () => {
    fetchSpy.mockResolvedValueOnce(mockErr(400, 'required fields missing'));
    const client = new SalesforceClient(credentialProvider);
    const result = await client.create('Contact', {});
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/400/);
  });

  it('update reads back to surface the updated versionToken', async () => {
    // PATCH returns 204, then read() returns the record.
    fetchSpy.mockResolvedValueOnce(
      { ok: true, status: 204, text: async () => '', json: async () => ({}) } as unknown as Response,
    );
    fetchSpy.mockResolvedValueOnce(
      mockOk({ Id: 'a01', SystemModstamp: 'v2', LastModifiedDate: '2026-01-01T00:00:00Z' }),
    );
    const client = new SalesforceClient(credentialProvider);
    const res = await client.update('Contact', 'a01', { FirstName: 'new' });
    expect(res.success).toBe(true);
    expect(res.versionToken).toBe('v2');
  });
});
