// Unit tests for the native BambooHRClient: OAuth Bearer auth, subdomain resolution
// from every persisted field, templated dispatch, and the native passthrough.

import { BambooHRClient } from '../bamboohr.js';
import type { ConnectorCredentials } from '../types.js';

interface Call { url: string; method: string; headers: Record<string, string>; body?: unknown }

function mockFetch(responder: (call: Call) => { status?: number; json?: unknown }) {
  const calls: Call[] = [];
  const parseBody = (b?: string): unknown => { if (!b) return undefined; try { return JSON.parse(b); } catch { return b; } };
  (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
    const call: Call = { url, method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: parseBody(init?.body) };
    calls.push(call);
    const r = responder(call);
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      headers: { get: () => null },
      json: async () => r.json ?? {},
      text: async () => JSON.stringify(r.json ?? {}),
    } as unknown as Response;
  });
  return calls;
}

const provider = (creds: Partial<ConnectorCredentials>) => async () => ({ accessToken: 'tok', ...creds } as ConnectorCredentials);

afterEach(() => { jest.restoreAllMocks(); });

describe('BambooHRClient — subdomain resolution', () => {
  it('resolves the subdomain from instanceUrl and hits the versioned path', async () => {
    const calls = mockFetch(() => ({ json: {} }));
    await new BambooHRClient(provider({ accessToken: 'apikey123', instanceUrl: 'acme' })).read('GET /api/v1/employees/{id}', '42');
    expect(calls[0].url).toBe('https://acme.bamboohr.com/api/v1/employees/42');
  });

  it('resolves the subdomain from connectorConfig.externalAccountId (api-key identity fetcher)', async () => {
    const calls = mockFetch(() => ({ json: {} }));
    await new BambooHRClient(provider({ accessToken: 'k', connectorConfig: { externalAccountId: 'globex' } })).read('GET /api/v1/employees/directory', undefined);
    expect(calls[0].url).toBe('https://globex.bamboohr.com/api/v1/employees/directory');
  });

  it('strips scheme/host when instanceUrl is a full URL', async () => {
    const calls = mockFetch(() => ({ json: {} }));
    await new BambooHRClient(provider({ accessToken: 'k', instanceUrl: 'https://initech.bamboohr.com' })).read('GET /api/v1/meta/fields', undefined);
    expect(calls[0].url).toBe('https://initech.bamboohr.com/api/v1/meta/fields');
  });
});

describe('BambooHRClient — native OAuth mode', () => {

  it('uses Bearer auth with the vaulted OAuth token', async () => {
    const calls = mockFetch(() => ({ json: {} }));
    await new BambooHRClient(provider({ accessToken: 'oauth-tok', connectorConfig: { subdomain: 'acme' } })).read('GET /api/v1/employees/directory', undefined);
    expect(calls[0].url).toBe('https://acme.bamboohr.com/api/v1/employees/directory');
    expect(calls[0].headers.Authorization).toBe('Bearer oauth-tok');
  });

  it('fills a path param and PUTs a templated write body (time-off status)', async () => {
    const calls = mockFetch(() => ({ json: { ok: true } }));
    const res = await new BambooHRClient(provider({ accessToken: 't', connectorConfig: { subdomain: 'acme' } }))
      .update('PUT /api/v1/time_off/requests/{id}/status', '7', { id: '7', status: 'approved', note: 'ok' });
    expect(res.success).toBe(true);
    expect(calls[0].url).toBe('https://acme.bamboohr.com/api/v1/time_off/requests/7/status');
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].body).toEqual({ status: 'approved', note: 'ok' });
  });

  it('compensation: reads the comp table and returns ONLY the latest row under `compensation`', async () => {
    const rows = [
      { id: '1', startDate: '2022-01-01', rate: '40000.00', paidPer: 'Year', type: 'Salary' },
      { id: '2', startDate: '2024-06-01', rate: { value: '50000.00', currency: 'USD' }, paidPer: 'Year', type: 'Salary' },
    ];
    const calls = mockFetch(() => ({ json: rows }));
    const rec = await new BambooHRClient(provider({ accessToken: 't', connectorConfig: { subdomain: 'acme' } }))
      .read('employee_compensation_current', '99');
    expect(calls[0].url).toBe('https://acme.bamboohr.com/api/v1/employees/99/tables/compensation');
    expect(rec.data).toEqual({ compensation: [{ id: '2', startDate: '2024-06-01', rate: { value: '50000.00', currency: 'USD' }, paidPer: 'Year', type: 'Salary' }] });
  });

  it('native passthrough hits an arbitrary path/method', async () => {
    const calls = mockFetch(() => ({ json: { rows: [] } }));
    await new BambooHRClient(provider({ accessToken: 't', connectorConfig: { subdomain: 'acme' } }))
      .read('native', undefined, { method: 'GET', path: '/scheduling/schedules', query: { start: '2026-01-01' } });
    expect(calls[0].url).toBe('https://acme.bamboohr.com/api/v1/scheduling/schedules?start=2026-01-01');
    expect(calls[0].headers.Authorization).toBe('Bearer t');
  });

  it('throws when the subdomain cannot be resolved', async () => {
    mockFetch(() => ({ json: {} }));
    await expect(new BambooHRClient(provider({ accessToken: 't' })).read('GET /api/v1/employees/directory', undefined)).rejects.toThrow(/missing company subdomain/);
  });
});
