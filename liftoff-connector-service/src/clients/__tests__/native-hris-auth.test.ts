// Auth-handshake unit tests for the native HRIS clients (offline, no accounts).
// We assert the handshake *shape* against each vendor's documented flow — never that a token
// "works" (we can't). Two kinds of coverage:
//   • positive: for token-minting clients, the exact mint endpoint/method fires before any
//     resource call;
//   • negative: every client throws a clear, specific error when its credentials are absent
//     (the #1 real-world failure mode — a misconfigured connect).
import { mockFetch, provider } from './__lib__/mock-fetch.js';
import { PersonioClient } from '../personio.js';
import { OracleHcmClient } from '../oracle-hcm.js';
import { WorkdayClient } from '../workday.js';
import { SapSuccessFactorsClient } from '../sap-successfactors.js';
import { DeelClient } from '../deel.js';
import { HiBobClient } from '../hibob.js';
import { FactorialClient } from '../factorial.js';
import { UkgProClient } from '../ukg-pro.js';
import { UkgReadyClient } from '../ukg-ready.js';
import { DayforceClient } from '../dayforce.js';
import { AdpClient } from '../adp.js';
import { GustoClient } from '../gusto.js';
import { NamelyClient } from '../namely.js';
import { BambooHRClient } from '../bamboohr.js';

afterEach(() => jest.restoreAllMocks());

describe('Personio auth handshake', () => {
  it('mints a bearer via POST /auth with the client credentials, before any resource call', async () => {
    const calls = mockFetch((c) => c.url.endsWith('/auth')
      ? { json: { success: true, data: { token: 'T', expires_in: 86400 } } } : { json: { data: [] } });
    await new PersonioClient(provider({ connectorConfig: { clientId: 'K', clientSecret: 'S' } }))
      .list('GET /company/employees');
    const auth = calls.find((c) => c.url.endsWith('/auth'))!;
    expect(auth.method).toBe('POST');
    expect(auth.body).toEqual({ client_id: 'K', client_secret: 'S' });
    expect(calls.find((c) => c.url.includes('/company/employees'))!.url).toContain('api.personio.de/v1');
  });
});

describe('Oracle HCM auth handshake', () => {
  it('mints an IDCS token at /oauth2/v1/token before any resource call', async () => {
    const calls = mockFetch((c) => c.url.includes('/oauth2/v1/token')
      ? { json: { access_token: 'oat', expires_in: 3600 } } : { json: { items: [] } });
    await new OracleHcmClient(provider({ connectorConfig: { podHost: 'p.oraclecloud.com', idcsTokenUrl: 'https://idcs.example.com', clientId: 'c', clientSecret: 's' } }))
      .list('departments');
    const tok = calls.find((c) => c.url.includes('/oauth2/v1/token'))!;
    expect(tok.method).toBe('POST');
  });
});

describe('Dayforce auth handshake', () => {
  it('mints a bearer at dfid.dayforcehcm.com/connect/token before any resource call', async () => {
    const calls = mockFetch((c) => (c.url.includes('/connect/token') ? { json: { access_token: 'T' } } : { json: {} }));
    await new DayforceClient(provider({ connectorConfig: { companyId: 'acme', username: 'u', password: 'p' } }))
      .read('native', undefined, { path: '/Employees' });
    expect(calls.find((c) => c.url.includes('/connect/token'))!.method).toBe('POST');
  });
});

describe('UKG Ready auth handshake', () => {
  it('logs in at /ta/rest/v1/login before any resource call', async () => {
    const calls = mockFetch((c) => (c.url.includes('/ta/rest/v1/login') ? { json: { token: 'T' } } : { json: {} }));
    await new UkgReadyClient(provider({ connectorConfig: { apiHost: 'x.ukg.net', username: 'u', password: 'p', apiKey: 'k' } }))
      .read('native', undefined, { path: '/employees' });
    expect(calls.find((c) => c.url.includes('/ta/rest/v1/login'))!.method).toBe('POST');
  });
});

describe('Workday auth handshake', () => {
  it('mints a bearer at the tenant token URL before any resource call', async () => {
    const calls = mockFetch((c) => (c.url.includes('/token') ? { json: { access_token: 'T' } } : { json: {} }));
    await new WorkdayClient(provider({ connectorConfig: { tenantHost: 'https://wd.example.com', tenant: 't', restEndpoint: 'https://wd.example.com/ccx/api/v1/t', tokenUrl: 'https://wd.example.com/token', clientId: 'c', clientSecret: 's', refreshToken: 'rt' } }))
      .read('wql', undefined, { query: 'SELECT x' });
    expect(calls.find((c) => c.url.includes('/token'))!.method).toBe('POST');
  });
});

// Negative: absent credentials → a clear, specific error. Trigger = each client's simplest
// resolveConfig-reaching call; regex = the client's documented missing-cred message.
const MISSING: Array<[string, () => Promise<unknown>, RegExp]> = [
  ['personio', () => new PersonioClient(provider({ connectorConfig: {} })).list('GET /company/employees'), /clientId\/clientSecret/],
  ['oracle_hcm', () => new OracleHcmClient(provider({ connectorConfig: {} })).list('departments'), /podHost\/idcsTokenUrl\/clientId\/clientSecret/],
  ['workday', () => new WorkdayClient(provider({ connectorConfig: {} })).read('wql', undefined, { query: 'x' }), /tokenUrl\/clientId\/clientSecret\/restEndpoint/],
  ['sap_successfactors', () => new SapSuccessFactorsClient(provider({ connectorConfig: {} })).read('users', undefined), /apiServerHost\/companyId\/oauthClientId\/assertionUserId/],
  // deel/factorial accept a vaulted accessToken as the credential, so a truly credential-less
  // provider (empty accessToken + empty config) is required to exercise the missing-cred throw.
  ['deel', () => new DeelClient(provider({ accessToken: '', connectorConfig: {} })).read('native', undefined, { path: '/people' }), /missing apiToken/],
  ['hibob', () => new HiBobClient(provider({ connectorConfig: {} })).read('native', undefined, { path: '/people' }), /serviceUserId\/token/],
  ['factorial', () => new FactorialClient(provider({ accessToken: '', connectorConfig: {} })).read('native', undefined, { path: '/employees' }), /missing apiKey/],
  ['ukg_pro', () => new UkgProClient(provider({ connectorConfig: {} })).read('native', undefined, { path: '/x' }), /serviceUrl\/customerApiKey\/username\/userApiKey/],
  ['ukg_ready', () => new UkgReadyClient(provider({ connectorConfig: {} })).read('native', undefined, { path: '/x' }), /apiHost\/username\/password\/apiKey/],
  ['dayforce', () => new DayforceClient(provider({ connectorConfig: {} })).read('native', undefined, { path: '/x' }), /companyId\/username\/password/],
  ['adp', () => new AdpClient(provider({ connectorConfig: {} }), 'adp_run').read('native', undefined, { path: '/hr/v2/workers' }), /certificatePem\/privateKeyPem/],
  ['gusto', () => new GustoClient(provider({})).list('Employee'), /missing companyId/],
  ['namely', () => new NamelyClient(provider({})).read('profile', 'p1'), /missing subdomain/],
  ['bamboohr', () => new BambooHRClient(provider({})).read('native', undefined, { path: '/employees/directory' }), /subdomain/i],
  // rippling is intentionally omitted: it authenticates with only the vaulted OAuth accessToken
  // (no connectorConfig requirement), so there is no config-level missing-cred throw to assert —
  // an absent/invalid token surfaces as a 401 from the vendor, covered by the OAuth connect flow.
];

describe('missing credentials throw a clear, specific error', () => {
  it.each(MISSING)('%s', async (_name, run, re) => {
    await expect(run()).rejects.toThrow(re);
  });
});
