// D. Auth structural tests. Proves each vendor's auth handshake is built correctly
// (headers, token grant, SAML signature, WS-Security). This proves STRUCTURE — not
// that the vendor accepts it (that needs a live endpoint), but every account-free
// property of the handshake is asserted, incl. a real cryptographic verification of
// the SAP SAML assertion signature against our own cert.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { SignedXml } from 'xml-crypto';
import { GustoClient } from '../gusto.js';
import { RipplingClient } from '../rippling.js';
import { NamelyClient } from '../namely.js';
import { OracleHcmClient } from '../oracle-hcm.js';
import { WorkdayClient } from '../workday.js';
import { SapSuccessFactorsClient } from '../sap-successfactors.js';
import type { ConnectorCredentials } from '../types.js';

interface Call { url: string; method: string; headers: Record<string, string>; body?: string }

function mockFetch(responder: (c: Call) => { status?: number; json?: unknown }): Call[] {
  const calls: Call[] = [];
  (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const call: Call = { url, method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: init?.body };
    calls.push(call);
    const r = responder(call);
    return {
      ok: (r.status ?? 200) < 400, status: r.status ?? 200,
      headers: { get: () => null },
      json: async () => r.json ?? {}, text: async () => JSON.stringify(r.json ?? {}),
    } as unknown as Response;
  });
  return calls;
}
const provider = (creds: Partial<ConnectorCredentials>) => async () => ({ accessToken: 'tok', ...creds } as ConnectorCredentials);
afterEach(() => jest.restoreAllMocks());

describe('D. auth structural', () => {
  it('Gusto sends Authorization: Bearer on API requests', async () => {
    const calls = mockFetch(() => ({ json: [] }));
    await new GustoClient(provider({ instanceUrl: 'co-1' })).read('GET /companies/{company_id}/employees', undefined, {});
    expect(calls[0].headers.Authorization).toBe('Bearer tok');
  });

  it('Rippling sends Authorization: Bearer', async () => {
    const calls = mockFetch(() => ({ json: { results: [] } }));
    await new RipplingClient(provider({})).list('workers');
    expect(calls[0].headers.Authorization).toBe('Bearer tok');
  });

  it('Namely sends the PAT as Authorization: Bearer to the subdomain host', async () => {
    const calls = mockFetch(() => ({ json: { profiles: [] } }));
    await new NamelyClient(provider({ instanceUrl: 'acme', accessToken: 'pat-xyz' })).read('profiles', undefined);
    expect(calls[0].url).toContain('https://acme.namely.com/');
    expect(calls[0].headers.Authorization).toBe('Bearer pat-xyz');
  });

  it('Oracle mints an IDCS token via client_credentials with HTTP Basic, then Bearer on REST', async () => {
    const creds = { connectorConfig: { podHost: 'pod.fa.oraclecloud.com', idcsTokenUrl: 'https://idcs.example.com', clientId: 'cid', clientSecret: 'secret', scope: 'urn:opc:resource:consumer::all' } };
    const calls = mockFetch((c) => (c.url.includes('/token') ? { json: { access_token: 'oat', expires_in: 3600 } } : { json: { items: [] } }));
    await new OracleHcmClient(provider(creds)).list('departments');
    const tok = calls.find((c) => c.url.includes('/oauth2/v1/token'))!;
    expect(tok.method).toBe('POST');
    expect(tok.headers.Authorization).toBe(`Basic ${Buffer.from('cid:secret').toString('base64')}`);
    expect(tok.body).toContain('grant_type=client_credentials');
    expect(tok.body).toContain('scope=');
    const rest = calls.find((c) => c.url.includes('/hcmRestApi/'))!;
    expect(rest.headers.Authorization).toBe('Bearer oat');
  });

  it('Workday builds a WS-Security UsernameToken (username@tenant, PasswordText, mustUnderstand)', async () => {
    const creds = { connectorConfig: { tenantHost: 'https://wd.example.com', tenant: 'acme', restEndpoint: 'https://wd.example.com/ccx/api/v1/acme', tokenUrl: 'https://wd.example.com/token', clientId: 'c', clientSecret: 's', isuUsername: 'isu', isuPassword: 'pw' } };
    const calls = mockFetch(() => ({ json: {} }));
    await new WorkdayClient(provider(creds)).read('SOAP Human_Resources Get_Workers', undefined, { request: {} });
    const xml = String(calls[0].body);
    expect(calls[0].headers['Content-Type']).toContain('text/xml');
    expect(xml).toContain('<wsse:Security xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" soapenv:mustUnderstand="1">');
    expect(xml).toContain('<wsse:Username>isu@acme</wsse:Username>');
    expect(xml).toContain('#PasswordText">pw</wsse:Password>');
  });

  describe('SAP SuccessFactors SAML bearer assertion', () => {
    let dir: string | undefined;
    let cert = '';
    beforeAll(() => {
      try {
        dir = mkdtempSync(join(tmpdir(), 'saml-'));
        execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '1', '-nodes', '-subj', '/CN=test'], { stdio: 'ignore' });
        process.env.SAP_SF_SAML_PRIVATE_KEY = readFileSync(join(dir, 'k.pem'), 'utf8');
        cert = readFileSync(join(dir, 'c.pem'), 'utf8');
        process.env.SAP_SF_SAML_PUBLIC_CERT = cert;
      } catch { dir = undefined; /* openssl unavailable — tests below self-skip */ }
    });
    afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); delete process.env.SAP_SF_SAML_PRIVATE_KEY; delete process.env.SAP_SF_SAML_PUBLIC_CERT; });

    // Vary companyId per call so the module-level token cache (keyed by
    // companyId::oauthClientId) misses and a fresh assertion is minted each time.
    let n = 0;
    const cfgFor = () => ({ connectorConfig: { apiServerHost: 'api4.successfactors.com', companyId: `ACME-${n++}`, oauthClientId: 'KEY123', assertionUserId: 'sfadmin' } });

    async function capturedAssertion(): Promise<string> {
      const calls = mockFetch((c) => (c.url.includes('/oauth/token') ? { json: { access_token: 'sf', expires_in: 1440 } } : { json: { d: { results: [] } } }));
      await new SapSuccessFactorsClient(provider(cfgFor())).read('users', undefined);
      const tok = calls.find((c) => c.url.includes('/oauth/token'))!;
      const assertion = new URLSearchParams(tok.body).get('assertion')!;
      return Buffer.from(assertion, 'base64').toString('utf8');
    }

    it('posts a SAML2 bearer grant with the correct issuer/subject/audience/recipient', async () => {
      if (!dir) return;
      const xml = await capturedAssertion();
      expect(xml).toContain('<saml2:Issuer>KEY123</saml2:Issuer>');           // issuer = oauth client id
      expect(xml).toContain('>sfadmin</saml2:NameID>');                        // subject = assertion user
      expect(xml).toContain('<saml2:Audience>www.successfactors.com</saml2:Audience>');
      expect(xml).toContain('Recipient="https://api4.successfactors.com/oauth/token"');
    });

    it('the assertion signature cryptographically verifies against our X.509 cert', async () => {
      if (!dir) return;
      const xml = await capturedAssertion();
      const doc = new DOMParser().parseFromString(xml, 'text/xml');
      const sigNode = doc.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'Signature').item(0);
      expect(sigNode).toBeTruthy();
      const sigXml = new XMLSerializer().serializeToString(sigNode!);
      const verifier = new SignedXml();
      verifier.publicCert = cert;
      verifier.loadSignature(sigXml);
      const ok = verifier.checkSignature(xml);
      expect(ok).toBe(true);
    });
  });
});
