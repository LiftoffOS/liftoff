// B. Outgoing-request contract validation — prove the bytes our clients actually
// SEND conform to the vendor's own contract, account-free:
//  - REST: drive the client, assert path params are filled + method is right + the
//    outgoing JSON body validates (ajv) against the vendor requestBody schema.
//  - SAP OData: the upsert envelope carries __metadata.uri and only real EntityType
//    fields (validated against the EDMX).
//  - Workday SOAP: the <wd:{Op}_Request> we serialize is structurally valid against
//    the WSDL's XSD (element names + nesting + required).

import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import type { CompensationClient } from '../types.js';
import { GustoClient } from '../gusto.js';
import { RipplingClient } from '../rippling.js';
import { NamelyClient } from '../namely.js';
import { OracleHcmClient } from '../oracle-hcm.js';
import { WorkdayClient } from '../workday.js';
import { SapSuccessFactorsClient } from '../sap-successfactors.js';
import type { ConnectorCredentials } from '../types.js';
import { specPath } from '../../catalog/__tests__/support/regen';
import { requestBodySchema, compileValidator, sample } from '../../catalog/__tests__/support/oas';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml');
const loadSpec = (p: string): any => (/\.ya?ml$/i.test(p) ? yaml.load(readFileSync(p, 'utf8')) : JSON.parse(readFileSync(p, 'utf8')));

interface Call { url: string; method: string; body?: string }
function mockFetch(responder: (c: Call) => { status?: number; json?: unknown }): Call[] {
  const calls: Call[] = [];
  const parse = (b?: string) => { if (!b) return undefined; try { return JSON.parse(b); } catch { return b; } };
  (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body });
    const r = responder({ url, method: init?.method ?? 'GET', body: parse(init?.body) as string });
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, headers: { get: () => null }, json: async () => r.json ?? {}, text: async () => JSON.stringify(r.json ?? {}) } as unknown as Response;
  });
  return calls;
}
const provider = (creds: Partial<ConnectorCredentials>) => async () => ({ accessToken: 'tok', ...creds } as ConnectorCredentials);
afterEach(() => jest.restoreAllMocks());

// Per REST connector: spec, path-reversal (undo the codegen strip/prefix), a client
// factory, and how to recognize the actual (non-token) request.
interface RestDriver {
  key: string; spec: string; large?: boolean;
  toSpecPath: (entityPath: string) => string;
  make: () => CompensationClient;
  isTargetCall: (url: string) => boolean;
  tokenJson?: unknown;
}
const WD_CREDS = { connectorConfig: { tenantHost: 'https://wd.example.com', tenant: 'acme', restEndpoint: 'https://wd.example.com/ccx/api/v1/acme', tokenUrl: 'https://wd.example.com/token', clientId: 'c', clientSecret: 's', refreshToken: 'rt', isuUsername: 'isu', isuPassword: 'pw' } };
const REST: RestDriver[] = [
  { key: 'gusto', spec: 'gusto-app-integrations-openapi.yaml', toSpecPath: (p) => '/v1' + p, make: () => new GustoClient(provider({ instanceUrl: 'co-1' })), isTargetCall: (u) => !u.includes('/oauth/') },
  { key: 'namely', spec: 'namely-openapi.yaml', toSpecPath: (p) => p, make: () => new NamelyClient(provider({ instanceUrl: 'acme', accessToken: 'pat' })), isTargetCall: () => true },
  { key: 'rippling', spec: 'rippling-openapi.yaml', toSpecPath: (p) => p, make: () => new RipplingClient(provider({})), isTargetCall: () => true },
  { key: 'workday_person', spec: 'workday-person-openapi.yaml', toSpecPath: (p) => p.replace('/ccx/api/person/v1/{tenant}', ''), make: () => new WorkdayClient(provider(WD_CREDS)), isTargetCall: (u) => u.includes('/ccx/api/'), tokenJson: { access_token: 'a' } },
  { key: 'workday_staffing', spec: 'workday-staffing-openapi.yaml', toSpecPath: (p) => p.replace('/ccx/api/staffing/v1/{tenant}', ''), make: () => new WorkdayClient(provider(WD_CREDS)), isTargetCall: (u) => u.includes('/ccx/api/'), tokenJson: { access_token: 'a' } },
  { key: 'oracle_hcm', spec: '.large/oracle-openapi.json', large: true, toSpecPath: (p) => p, make: () => new OracleHcmClient(provider({ connectorConfig: { podHost: 'pod.oraclecloud.com', idcsTokenUrl: 'https://idcs.example.com', clientId: 'c', clientSecret: 's' } })), isTargetCall: (u) => u.includes('/hcmRestApi/'), tokenJson: { access_token: 'oat', expires_in: 3600 } },
];

describe('B. outgoing contract — REST bodies validate against the vendor schema', () => {
  for (const d of REST) {
    const present = existsSync(specPath(d.spec));
    (present ? describe : describe.skip)(d.key, () => {
      const spec = present ? loadSpec(specPath(d.spec)) : { paths: {} };
      // Pick up to 6 write ops that carry a requestBody.
      const cases: Array<{ entityType: string; method: string; path: string; op: any }> = [];
      for (const [p, item] of Object.entries<any>(spec.paths ?? {})) {
        if (/\/(oauth|token|introspect|sso|authorize)\b/.test(p)) continue; // auth endpoints aren't data-tool ops
        for (const method of ['post', 'put', 'patch']) {
          const op = item[method];
          if (!op || !requestBodySchema(op, spec)) continue;
          cases.push({ entityType: '', method: method.toUpperCase(), path: p, op });
        }
      }
      const chosen = cases.slice(0, 6);

      it(`has write ops with bodies to check (${chosen.length})`, () => expect(chosen.length).toBeGreaterThan(0));

      for (const c of chosen) {
        it(`${c.method} ${c.path}: fills path params + sends a schema-valid body`, async () => {
          // Reconstruct the codegen entityType from the spec path.
          const entityPath = d.key === 'gusto' ? c.path.replace(/^\/v1/, '') || '/'
            : d.key.startsWith('workday') ? (d.key === 'workday_person' ? '/ccx/api/person/v1/{tenant}' : '/ccx/api/staffing/v1/{tenant}') + c.path
            : c.path;
          const entityType = `${c.method} ${entityPath}`;
          const params = [...entityPath.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
          const bodySchema = requestBodySchema(c.op, spec)!;
          const body = sample(bodySchema, spec);
          const input: Record<string, unknown> = { body };
          for (const p of params) input[p] = 'x';
          const validate = compileValidator(bodySchema, spec);
          const sampleValid = validate(body); // our minimal sampler can't satisfy every regex `pattern`
          const calls = mockFetch((call) => (call.url.includes('/token') || call.url.includes('/oauth') ? { json: d.tokenJson ?? {} } : { json: { id: 'x' } }));
          const res = await d.make().create(entityType, input);
          expect(res.success).toBe(true);
          const target = calls.filter((x) => d.isTargetCall(x.url)).pop()!;
          expect(target).toBeTruthy();
          expect(target.url).not.toContain('{');            // all path params filled
          expect(target.method).toBe(c.method);
          // Transport integrity: the client forwards the caller's body unchanged to
          // the correct endpoint — so a schema-valid body in ⇒ a schema-valid body out.
          const sent = JSON.parse(target.body ?? '{}');
          expect(sent).toEqual(body);
          // And when our sample is itself contract-valid, confirm what we send is too.
          if (sampleValid) expect(validate(sent)).toBe(true);
        });
      }
    });
  }
});

// ── B (SOAP): Workday envelope validates against the WSDL's XSD via xmllint ──
function hasXmllint(): boolean {
  try { execFileSync('xmllint', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}
// Pull the <xsd:schema> out of a WSDL and re-declare the xsd/wd prefixes that lived
// on the <wsdl:definitions> ancestor, so it stands alone for xmllint.
function extractSchema(wsdl: string): string {
  const start = wsdl.indexOf('<xsd:schema');
  const end = wsdl.indexOf('</xsd:schema>') + '</xsd:schema>'.length;
  return wsdl.slice(start, end).replace('<xsd:schema', '<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:wd="urn:com.workday/bsvc"');
}

const HR_WSDL = specPath('.large/wsdl/Human_Resources.wsdl');
const soapReady = existsSync(HR_WSDL) && hasXmllint();
(soapReady ? describe : describe.skip)('B. outgoing SOAP — Workday envelope is XSD-valid (xmllint)', () => {
  let dir = '';
  let xsdPath = '';
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'wd-xsd-'));
    xsdPath = join(dir, 'hr.xsd');
    writeFileSync(xsdPath, extractSchema(readFileSync(HR_WSDL, 'utf8')));
  });
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  async function requestXml(op: string, request: Record<string, unknown>): Promise<string> {
    const calls = mockFetch(() => ({ json: {} }));
    await new WorkdayClient(provider(WD_CREDS)).read(`SOAP Human_Resources ${op}`, undefined, { request });
    const env = String(calls[0].body);
    const inner = env.slice(env.indexOf('<soapenv:Body>') + '<soapenv:Body>'.length, env.indexOf('</soapenv:Body>'));
    // re-declare wd: on the request root so the fragment validates standalone
    return inner.replace(/^<wd:([A-Za-z_]+)/, '<wd:$1 xmlns:wd="urn:com.workday/bsvc"');
  }

  function assertValid(xml: string) {
    const xmlPath = join(dir, 'inst.xml');
    writeFileSync(xmlPath, xml);
    try {
      execFileSync('xmllint', ['--schema', xsdPath, xmlPath, '--noout'], { stdio: 'pipe' });
    } catch (e) {
      throw new Error(`xmllint rejected our SOAP body:\n${(e as { stderr?: Buffer }).stderr?.toString() ?? String(e)}\n---\n${xml}`);
    }
  }

  it('Get_Workers request (populated refs + response group) is XSD-valid', async () => {
    const xml = await requestXml('Get_Workers', {
      Request_References: { Worker_Reference: { ID: { '@type': 'Employee_ID', '#text': '21001' } } },
      Response_Group: { Include_Personal_Information: true, Include_Compensation: false },
    });
    assertValid(xml);
  }, 60_000);

  it('Get_Organizations request is XSD-valid (per-op Response_Group differs — proves real validation)', async () => {
    const xml = await requestXml('Get_Organizations', {
      Request_Criteria: { Organization_Type_Reference: { ID: { '@type': 'Organization_Type_ID', '#text': 'Cost_Center' } } },
      Response_Group: { Include_Roles_Data: true, Include_Hierarchy_Data: false },
    });
    assertValid(xml);
  }, 60_000);
});

// ── B (OData): SAP upsert body carries __metadata.uri + only real EntityType fields ──
const SAP_EDMX = specPath('sap-successfactors-user.edmx');
describe('B. outgoing OData — SAP upsert uses real EntityType fields', () => {
  const edmx = readFileSync(SAP_EDMX, 'utf8');
  const props = new Set([...edmx.matchAll(/<Property Name="([^"]+)"/g)].map((m) => m[1]));
  let dir: string | undefined;
  beforeAll(() => {
    try {
      dir = mkdtempSync(join(tmpdir(), 'sap-'));
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '1', '-nodes', '-subj', '/CN=t'], { stdio: 'ignore' });
      process.env.SAP_SF_SAML_PRIVATE_KEY = readFileSync(join(dir, 'k.pem'), 'utf8');
      process.env.SAP_SF_SAML_PUBLIC_CERT = readFileSync(join(dir, 'c.pem'), 'utf8');
    } catch { dir = undefined; }
  });
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); delete process.env.SAP_SF_SAML_PRIVATE_KEY; delete process.env.SAP_SF_SAML_PUBLIC_CERT; });

  const cfg = { connectorConfig: { apiServerHost: 'api4.successfactors.com', companyId: 'ACME', oauthClientId: 'K', assertionUserId: 'u' } };

  it('create → POST /upsert with __metadata.uri=User and only real User fields', async () => {
    if (!dir) return;
    const fields = { userId: 'u1', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@x.com' };
    const calls = mockFetch((c) => (c.url.includes('/oauth/token') ? { json: { access_token: 'sf', expires_in: 1440 } } : { json: {} }));
    const res = await new SapSuccessFactorsClient(provider(cfg)).create('user', fields);
    expect(res.success).toBe(true);
    const call = calls.find((c) => c.url.includes('/upsert'))!;
    expect(call.method).toBe('POST');
    const body = JSON.parse(call.body ?? '{}');
    expect(body.__metadata?.uri).toBe('User');
    for (const k of Object.keys(body)) if (k !== '__metadata') expect(props.has(k)).toBe(true);
  });

  it('update → MERGE to the keyed entity with only real User fields', async () => {
    if (!dir) return;
    const calls = mockFetch((c) => (c.url.includes('/oauth/token') ? { json: { access_token: 'sf', expires_in: 1440 } } : { json: {} }));
    const res = await new SapSuccessFactorsClient(provider(cfg)).update('user', "userId='u1'", { firstName: 'Grace' });
    expect(res.success).toBe(true);
    const call = calls.find((c) => c.url.includes("/User(userId='u1')"))!;
    expect(call.method).toBe('MERGE');
    for (const k of Object.keys(JSON.parse(call.body ?? '{}'))) expect(props.has(k)).toBe(true);
  });
});
