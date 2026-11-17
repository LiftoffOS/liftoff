// Unit tests for the batch-2 native HRIS clients (Deel, Factorial, HiBob,
// Personio, UKG Pro, UKG Ready, Dayforce, ADP). Asserts the base URL, auth
// header, and templated dispatch for each. Follows native-hris-clients.test.ts.

import { EventEmitter } from 'node:events';
import { DeelClient } from '../deel.js';
import { FactorialClient } from '../factorial.js';
import { HiBobClient } from '../hibob.js';
import { PersonioClient } from '../personio.js';
import { UkgProClient } from '../ukg-pro.js';
import { UkgReadyClient } from '../ukg-ready.js';
import { DayforceClient } from '../dayforce.js';
import { AdpClient } from '../adp.js';
import type { ConnectorCredentials } from '../types.js';

interface Call { url: string; method: string; headers: Record<string, string>; body?: unknown }

/** fetch mock that records url/method/headers/body and replays queued responses. */
function mockFetch(responder: (call: Call) => { status?: number; json?: unknown }) {
  const calls: Call[] = [];
  const parseBody = (b?: string): unknown => {
    if (!b) return undefined;
    try { return JSON.parse(b); } catch { return b; }
  };
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

const provider = (creds: Partial<ConnectorCredentials>) => async () =>
  ({ accessToken: 'tok', ...creds } as ConnectorCredentials);

afterEach(() => jest.restoreAllMocks());

describe('DeelClient', () => {
  const client = () => new DeelClient(provider({ connectorConfig: { apiToken: 'deel-tok' } }));

  it('reads via Bearer auth against the rest/v2 base', async () => {
    const calls = mockFetch(() => ({ json: {} }));
    await client().read('GET /people', undefined);
    expect(calls[0].url).toBe('https://api.letsdeel.com/rest/v2/people');
    expect(calls[0].headers.Authorization).toBe('Bearer deel-tok');
  });

  it('fills a path param and POSTs a templated write body', async () => {
    const calls = mockFetch(() => ({ json: { id: 'ts1' } }));
    await client().read('GET /people/{id}', 'p1');
    expect(calls[0].url).toBe('https://api.letsdeel.com/rest/v2/people/p1');
    const created = await client().create('POST /timesheets', { hours: 8 });
    expect(created.success).toBe(true);
    expect(calls[1].method).toBe('POST');
    expect(calls[1].body).toEqual({ hours: 8 });
  });

  it('throws a clear error when the token is missing', async () => {
    mockFetch(() => ({ json: {} }));
    await expect(new DeelClient(provider({ accessToken: '' })).read('GET /people', undefined)).rejects.toThrow(/missing apiToken/);
  });

  it('payroll_runs: fans out legal-entities → per-entity payroll-events (payday = cycle date_end)', async () => {
    const calls = mockFetch((c) => {
      if (c.url.includes('/legal-entities/le1/payroll-events')) return { json: { data: [{ id: 'cyc-1', type: 'REGULAR', date_start: '2025-06-01', date_end: '2025-06-30' }] } };
      if (c.url.endsWith('/legal-entities?limit=100')) return { json: { data: [{ id: 'le1', name: 'Acme UK Ltd' }] } };
      return { json: { data: [] } };
    });
    const res = await client().list('payroll_runs');
    // First call lists legal entities, second lists that entity's cycles.
    expect(calls[0].url).toBe('https://api.letsdeel.com/rest/v2/legal-entities?limit=100');
    expect(calls[1].url).toContain('/legal-entities/le1/payroll-events?');
    expect(res.records).toEqual([
      { id: 'cyc-1', data: { run_id: 'cyc-1', legal_entity_id: 'le1', legal_entity_name: 'Acme UK Ltd', type: 'REGULAR', period_start: '2025-06-01', period_end: '2025-06-30', pay_date: '2025-06-30' } },
    ]);
  });
});

describe('FactorialClient', () => {
  it('sends x-api-key against the dated 2026-07-01 base', async () => {
    const calls = mockFetch(() => ({ json: {} }));
    await new FactorialClient(provider({ connectorConfig: { apiKey: 'fac' } })).read('GET /resources/employees/employees', undefined);
    expect(calls[0].url).toBe('https://api.factorialhr.com/api/2026-07-01/resources/employees/employees');
    expect(calls[0].headers['x-api-key']).toBe('fac');
  });

  it('recurring_reimbursements: bridges compensations→employee via contract_versions; cents→decimal; recurring only', async () => {
    mockFetch((c) => {
      if (c.url.includes('/contracts/contract_versions')) return { json: { data: [{ id: 'cv1', employee_id: 'E7' }] } };
      if (c.url.includes('/contracts/compensations')) return { json: { data: [
        { id: 'cmp1', contract_version_id: 'cv1', description: 'Internet stipend', amount: 5000, currency: 'EUR', recurrence: 'monthly' },
        { id: 'cmp2', contract_version_id: 'cv1', description: 'Signing bonus', amount: 100000, recurrence: 'one_time' }, // one_time → dropped
        { id: 'cmp3', contract_version_id: 'cvX', description: 'orphan', amount: 100, recurrence: 'monthly' },           // unknown cv → dropped
      ] } };
      return { json: { data: [] } };
    });
    const res = await new FactorialClient(provider({ connectorConfig: { apiKey: 'fac' } })).list('recurring_reimbursements');
    expect(res.records).toEqual([
      { id: 'cmp1', data: { id: 'cmp1', employee_id: 'E7', description: 'Internet stipend', amount: '50', currency: 'EUR', cadence: 'monthly', compensation_type: undefined } },
    ]);
  });
});

describe('HiBobClient', () => {
  it('uses Basic base64(serviceUserId:token) against the v1 base', async () => {
    const calls = mockFetch(() => ({ json: {} }));
    await new HiBobClient(provider({ connectorConfig: { serviceUserId: 'svc', token: 'sec' } })).read('GET /people', undefined);
    expect(calls[0].url).toBe('https://api.hibob.com/v1/people');
    expect(calls[0].headers.Authorization).toBe(`Basic ${Buffer.from('svc:sec').toString('base64')}`);
  });
});

describe('PersonioClient', () => {
  const client = () => new PersonioClient(provider({ connectorConfig: { clientId: 'cid', clientSecret: 'sec' } }));

  it('mints a bearer at /v1/auth then calls the /v1 API', async () => {
    const calls = mockFetch((c) => (c.url.endsWith('/auth') ? { json: { success: true, data: { token: 'minted' } } } : { json: {} }));
    await client().read('GET /company/employees', undefined);
    expect(calls[0].url).toBe('https://api.personio.de/v1/auth');
    expect(calls[0].method).toBe('POST');
    const apiCall = calls.find((c) => c.url.includes('/company/employees'));
    expect(apiCall?.url).toBe('https://api.personio.de/v1/company/employees');
    expect(apiCall?.headers.Authorization).toBe('Bearer minted');
  });
});

describe('DayforceClient', () => {
  it('mints via the identity password grant then calls the per-company base', async () => {
    const calls = mockFetch((c) => (c.url.includes('/connect/token') ? { json: { access_token: 'df' } } : { json: { Data: [] } }));
    await new DayforceClient(provider({ connectorConfig: { companyId: 'acme', username: 'u', password: 'p' } })).read('GET /Employees', undefined);
    expect(calls[0].url).toBe('https://dfid.dayforcehcm.com/connect/token');
    expect(String(calls[0].body)).toContain('grant_type=password');
    const apiCall = calls.find((c) => c.url.includes('/Employees'));
    expect(apiCall?.url).toBe('https://acme.dayforcehcm.com/Api/acme/V1/Employees');
    expect(apiCall?.headers.Authorization).toBe('Bearer df');
  });

  it('earning rates: fans out over employees, takes the latest CompensationSummary row', async () => {
    mockFetch((c) => {
      if (c.url.includes('/connect/token')) return { json: { access_token: 'df' } };
      if (c.url.endsWith('/Employees')) return { json: { Data: [{ XRefCode: 'E1' }, { XRefCode: 'E2' }] } };
      if (c.url.includes('/Employees/E1/CompensationSummary')) return { json: { Data: [
        { EffectiveStart: '2023-01-01', BaseSalary: 80000, BaseRate: 38.46 },
        { EffectiveStart: '2025-01-01', BaseSalary: 95000, BaseRate: 45.67 },
      ] } };
      // E2 is hourly (no salary) → BaseRate drives amount + rateType
      if (c.url.includes('/Employees/E2/CompensationSummary')) return { json: { Data: [
        { EffectiveStart: '2024-06-01', BaseSalary: 0, BaseRate: 22.5 },
      ] } };
      return { json: { Data: [] } };
    });
    const recs = await new DayforceClient(provider({ connectorConfig: { companyId: 'acme', username: 'u', password: 'p' } })).list('dayforce_earning_rates');
    expect(recs.records).toEqual([
      { id: 'E1', data: { rate_id: 'E1', employee_id: 'E1', amount: '95000', rate_type: 'salaried', effective_start: '2025-01-01' } },
      { id: 'E2', data: { rate_id: 'E2', employee_id: 'E2', amount: '22.5', rate_type: 'hourly', effective_start: '2024-06-01' } },
    ]);
  });
});

describe('UkgProClient', () => {
  it('uses Basic + US-API-Key against the service host', async () => {
    const calls = mockFetch(() => ({ json: {} }));
    await new UkgProClient(provider({ connectorConfig: { serviceUrl: 'service5.ultipro.com', customerApiKey: 'ck', username: 'u', userApiKey: 'uk' } })).read('GET /personnel/v1/employees', undefined);
    expect(calls[0].url).toBe('https://service5.ultipro.com/personnel/v1/employees');
    expect(calls[0].headers.Authorization).toBe(`Basic ${Buffer.from('u:uk').toString('base64')}`);
    expect(calls[0].headers['US-API-Key']).toBe('ck');
  });

  it('pay statements: POSTs to /payroll/v1/employees/pay-statements and stamps a synthetic _stmtId', async () => {
    const calls = mockFetch(() => ({ json: { payStatements: [{ PayDate: '2025-06-20', PeriodStartDate: '2025-06-01', PeriodEndDate: '2025-06-15', GrossWagesCurrent: '3653.85', NetPayCurrent: '2710.42' }] } }));
    const rec = await new UkgProClient(provider({ connectorConfig: { serviceUrl: 'service5.ultipro.com', customerApiKey: 'ck', username: 'u', userApiKey: 'uk' } }))
      .read('employee_pay_statements', 'E77');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('https://service5.ultipro.com/payroll/v1/employees/pay-statements');
    expect(calls[0].body).toMatchObject({ employeeIdentifier: { employeeId: 'E77' } });
    expect(rec.data).toEqual({ payStatements: [{ PayDate: '2025-06-20', PeriodStartDate: '2025-06-01', PeriodEndDate: '2025-06-15', GrossWagesCurrent: '3653.85', NetPayCurrent: '2710.42', _stmtId: 'E77:2025-06-20' }] });
  });
});

describe('UkgReadyClient', () => {
  it('logs in for a bearer (Api-Key header) then fills {cid} against the /ta/rest/v2 base', async () => {
    const calls = mockFetch((c) => (c.url.endsWith('/ta/rest/v1/login') ? { json: { token: 'ukr' } } : { json: [] }));
    await new UkgReadyClient(provider({ connectorConfig: { apiHost: 'secure.saashr.com', companyShortName: 'acme', username: 'u', password: 'p', apiKey: 'k' } })).read('GET /companies/{cid}/employees', undefined);
    expect(calls[0].url).toBe('https://secure.saashr.com/ta/rest/v1/login');
    expect(calls[0].headers['Api-Key']).toBe('k');
    const api = calls.find((c) => c.url.includes('/companies/acme/employees'));
    expect(api?.url).toBe('https://secure.saashr.com/ta/rest/v2/companies/acme/employees');
    expect(api?.headers.Authorization).toBe('Bearer ukr');
  });
});

describe('AdpClient (mTLS via node:https)', () => {
  const creds = { connectorConfig: { clientId: 'cid', clientSecret: 'sec', certificatePem: 'CERT', privateKeyPem: 'KEY' } };

  /** Mock https.request: record options, reply per-URL. We spy on the CJS module
   *  object (the same singleton the client's `import https from 'node:https'`
   *  default-import resolves to); the ESM namespace object is frozen. */
  function mockHttps(reply: (opts: { hostname?: string; path?: string }) => unknown) {
    const seen: Array<{ hostname?: string; path?: string; method?: string; headers?: Record<string, string>; agent?: unknown }> = [];
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const https = require('node:https');
    jest.spyOn(https, 'request').mockImplementation(((opts: any, cb: any) => {
      seen.push(opts);
      const res = new EventEmitter() as EventEmitter & { statusCode?: number; setEncoding?: () => void };
      res.statusCode = 200;
      res.setEncoding = () => {};
      const req = new EventEmitter() as EventEmitter & { write?: () => void; end?: () => void };
      req.write = () => {};
      req.end = () => {
        process.nextTick(() => {
          cb(res);
          res.emit('data', JSON.stringify(reply(opts)));
          res.emit('end');
        });
      };
      return req;
    }) as any);
    return seen;
  }

  it('mints a client_credentials token (mTLS agent) then calls api.adp.com', async () => {
    const seen = mockHttps((o) => (o.hostname === 'accounts.adp.com' ? { access_token: 'adp' } : { workers: [] }));
    await new AdpClient(provider(creds), 'adp_run').read('GET /hr/v2/workers', undefined);
    const token = seen.find((s) => s.hostname === 'accounts.adp.com');
    const api = seen.find((s) => s.hostname === 'api.adp.com');
    expect(token?.path).toBe('/auth/oauth/v2/token');
    expect((token?.agent as { options?: { cert?: string } })?.options?.cert).toBe('CERT');
    expect(api?.path).toBe('/hr/v2/workers');
    expect(api?.headers?.Authorization).toBe('Bearer adp');
  });

  it('requires the client certificate/key', async () => {
    await expect(new AdpClient(provider({ connectorConfig: { clientId: 'c', clientSecret: 's' } }), 'adp_run').read('GET /hr/v2/workers', undefined))
      .rejects.toThrow(/certificatePem\/privateKeyPem/);
  });
});

describe('DayforceClient pay-summary aggregation (fixes the $0 NetPay bug)', () => {
  const client = () => new DayforceClient(provider({ connectorConfig: { companyId: 'acme', username: 'u', password: 'p' } }));
  it('aggregates Σ PayAmount per (EmployeeXRefCode, PayDate) into one row per employee per paydate', async () => {
    const calls = mockFetch((c) => {
      if (c.url.includes('/connect/token')) return { json: { access_token: 'tok', expires_in: 3600 } };
      if (c.url.includes('/EmployeePaySummaries')) return { json: { Data: [
        { EmployeeXRefCode: 'E1', PayDate: '2025-06-20', PayAmount: 1000 },
        { EmployeeXRefCode: 'E1', PayDate: '2025-06-20', PayAmount: 500.5 },
        { EmployeeXRefCode: 'E2', PayDate: '2025-06-20', PayAmount: 2000 },
      ] } };
      return { json: {} };
    });
    const res = await client().list('pay_summaries');
    expect(calls.some((c) => c.url.includes('filterTransactionTimeStartUtc') && c.url.includes('filterTransactionTimeEndUtc'))).toBe(true);
    const byId = Object.fromEntries(res.records.map((r) => [r.id, r.data]));
    expect(res.records).toHaveLength(2);
    expect(byId['E1:2025-06-20']).toMatchObject({ EmployeeXRefCode: 'E1', PayDate: '2025-06-20', amount: '1500.50' });
    expect(byId['E2:2025-06-20']).toMatchObject({ amount: '2000.00' });
  });
  it('committed_pay_run is inert without a configured report xRefCode', async () => {
    mockFetch((c) => (c.url.includes('/connect/token') ? { json: { access_token: 'tok', expires_in: 3600 } } : { json: {} }));
    const res = await client().list('committed_pay_run');
    expect(res.records).toEqual([]);
  });
});

describe('UkgProClient payroll runs (paygroup-payperiods → run link key)', () => {
  const client = () => new UkgProClient(provider({ connectorConfig: { serviceUrl: 'service5.ultipro.com', customerApiKey: 'ck', username: 'u', userApiKey: 'uk' } }));
  it('lists pay-group pay periods keyed payGroup:payDate (matches the pay-statement run link)', async () => {
    mockFetch((c) => {
      if (c.url.includes('/paygroup-payperiods')) return { json: [
        { payPeriodId: 991, payGroup: 'PG7', payDate: '2025-06-20T00:00:00', periodStartDate: '2025-06-01', periodEndDate: '2025-06-15', isPeriodClosed: true },
      ] };
      return { json: {} };
    });
    const res = await client().list('ukg_pro_payrolls');
    expect(res.records[0].id).toBe('PG7:2025-06-20');
    expect(res.records[0].data).toMatchObject({ runKey: 'PG7:2025-06-20', payDate: '2025-06-20', status: 'processed' });
  });
});

describe('DeelClient employer charges (Global-Payroll G2N cycle report)', () => {
  const client = () => new DeelClient(provider({ connectorConfig: { apiToken: 'deel-tok' } }));
  it('sums G2N items by category_group per contract (CONTRIBUTIONS→taxes, BENEFITS→benefits, ADDITIONS→gross), linked to cycle', async () => {
    mockFetch((c) => {
      if (c.url.endsWith('/legal-entities?limit=100')) return { json: { data: [{ id: 'le1' }] } };
      if (c.url.includes('/legal-entities/le1/payroll-events')) return { json: { data: [{ id: 'CYC7' }] } };
      if (c.url.includes('/reports/payroll/cycles/CYC7/gross-to-net')) return { json: { data: [
        { contract_oid: 'CTR9', currency: 'EUR', items: [
          { label: 'Base salary', value: 5000, category_group: 'ADDITIONS' },
          { label: 'Employee income tax', value: 900, category_group: 'DEDUCTIONS' },
          { label: 'Employer social security', value: 500, category_group: 'CONTRIBUTIONS' },
          { label: 'Employer unemployment', value: 200, category_group: 'CONTRIBUTIONS' },
          { label: 'Employer health', value: 300, category_group: 'BENEFITS' },
        ] },
      ] } };
      return { json: { data: [] } };
    });
    const res = await client().list('employer_charges');
    expect(res.records).toEqual([
      { id: 'CYC7:CTR9', data: { id: 'CYC7:CTR9', employeeExternalId: 'CTR9', payrollRunExternalId: 'CYC7', grossPay: '5000.00', employerTaxes: '700.00', employerBenefits: '300.00' } },
    ]);
  });
  it('is inert for a cycle with no G2N report (non-GP) — the report fetch errors are swallowed', async () => {
    mockFetch((c) => {
      if (c.url.endsWith('/legal-entities?limit=100')) return { json: { data: [{ id: 'le1' }] } };
      if (c.url.includes('/legal-entities/le1/payroll-events')) return { json: { data: [{ id: 'CYCX' }] } };
      if (c.url.includes('/gross-to-net')) return { status: 404, json: { error: 'no report' } };
      return { json: { data: [] } };
    });
    const res = await client().list('employer_charges');
    expect(res.records).toEqual([]);
  });
});
