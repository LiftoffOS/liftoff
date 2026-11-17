// Spec-derived request conformance for native HRIS clients (offline, no accounts).
//   A. static  — every generated tool's entityType resolves to a real spec operation, and
//                every spec-required param is present in the tool inputSchema. Runs over EVERY
//                OpenAPI tool (exhaustive).
//   B. dynamic — drive the real client through templated-dispatch with a spec-valid input,
//                capture the outgoing fetch, and validate it against the spec contract.
// SAP (OData) + Workday WWS (SOAP) request shape stays covered by odata-codegen.test.ts and the
// SOAP-envelope assertions in native-hris-clients.test.ts. BambooHR has no spec → excluded
// (covered by rest-direct-actions.test.ts + bamboohr.polling.test.ts).
import { CONNECTORS, sourceAvailable, loadGenerated } from '../../catalog/__tests__/support/regen';
import { contractsFor, validateRequest, decompose } from './spec-request-schema';
import { mockFetch, provider } from '../../clients/__tests__/__lib__/mock-fetch';
import { GustoClient } from '../../clients/gusto.js';
import { PersonioClient } from '../../clients/personio.js';
import { DeelClient } from '../../clients/deel.js';

// OpenAPI connectors with a committed spec (excludes OData/WSDL and the uncommitted .large specs).
const OPENAPI = CONNECTORS.filter((c) => c.openapi && sourceAvailable(c));

describe('A. static: every generated tool resolves to a spec operation', () => {
  for (const c of OPENAPI) {
    const contracts = contractsFor(c.openapi!, c.stripPrefix, c.pathPrefix);
    const tools = loadGenerated(c.key);
    it(`${c.key}: every tool entityType maps to a spec op`, () => {
      const unmatched = tools.filter((t) => !contracts.has(t.entityType)).map((t) => t.entityType);
      expect(unmatched).toEqual([]);
    });
    it(`${c.key}: every spec-required param appears in the tool inputSchema`, () => {
      const gaps: string[] = [];
      for (const t of tools) {
        const k = contracts.get(t.entityType);
        if (!k) continue;
        const props = new Set(Object.keys(t.inputSchema?.properties ?? {}));
        for (const p of [...k.pathParams, ...k.requiredQuery]) {
          if (!props.has(p) && !props.has('query')) gaps.push(`${t.entityType} :: missing "${p}"`);
        }
      }
      expect(gaps).toEqual([]);
    });
  }
});

describe('B. dynamic: the client emits a spec-conformant request', () => {
  it('personio GET lands params in query, no body, at the spec path', async () => {
    const contracts = contractsFor('personio-personnel-data-api-oa3.yaml');
    const calls = mockFetch((c) => (c.url.endsWith('/auth') ? { json: { success: true, data: { token: 'T' } } } : { json: { data: [] } }));
    await new PersonioClient(provider({ connectorConfig: { clientId: 'K', clientSecret: 'S' } }))
      .list('GET /company/employees');
    const req = decompose(calls.find((c) => c.url.includes('/company/employees'))!);
    const contract = contracts.get('GET /company/employees');
    expect(contract).toBeDefined();
    // The /v1 base lives in the OpenAPI server URL (client BASE_URL), not the spec path — strip it
    // to compare against the spec template (same as gusto's stripPrefix handling).
    expect(validateRequest(contract!, { ...req, path: req.path.replace(/^\/v1/, '') })).toEqual([]);
    expect(req.body).toBeUndefined();
  });

  it('gusto templated GET substitutes {company_id} from instanceUrl and routes loose args to query', async () => {
    const contracts = contractsFor('gusto-app-integrations-openapi.yaml', '/v1');
    const calls = mockFetch(() => ({ json: [] }));
    await new GustoClient(provider({ instanceUrl: 'co-1' }))
      .read('GET /companies/{company_id}/employees', undefined, { page: '2' });
    const req = decompose(calls[0]);
    expect(req.path).toBe('/v1/companies/co-1/employees'); // client re-adds the /v1 base
    // The contract key omits /v1 (stripPrefix); assert against the stripped path.
    const contract = contracts.get('GET /companies/{company_id}/employees');
    expect(contract).toBeDefined();
    expect(validateRequest(contract!, { ...req, path: '/companies/co-1/employees' })).toEqual([]);
    expect(req.body).toBeUndefined();
  });

  it('deel templated write routes loose args to the body (not query) at the spec path', async () => {
    const contracts = contractsFor('deel-openapi.json');
    const calls = mockFetch(() => ({ json: { data: {} } }));
    await new DeelClient(provider({ connectorConfig: { apiToken: 'tok' } }))
      .create('POST /adjustments', { amount: 100, note: 'x' });
    const req = decompose(calls[0]);
    expect(req.method).toBe('POST');
    expect(req.path).toBe('/rest/v2/adjustments'); // client BASE_URL is api.letsdeel.com/rest/v2
    expect(req.body).toMatchObject({ amount: 100, note: 'x' });
    expect(Object.keys(req.query)).toEqual([]); // write args go to the body, not the query string
    expect(validateRequest(contracts.get('POST /adjustments')!, { ...req, path: req.path.replace(/^\/rest\/v2/, '') })).toEqual([]);
  });
});

// C. Drift guard-rail — every committed-spec native connector that emits responseSchema (OpenAPI +
// OData; excludes lean/large oracle_hcm and WSDL workday_wws which carry none by design) must keep
// responseSchema on its read tools. Catches a codegen regression that would SILENTLY disable
// Phase 2 drift detection for that connector.
describe('C. read tools carry a responseSchema (drift guard-rail)', () => {
  const withResponse = CONNECTORS.filter((c) => sourceAvailable(c) && !c.lean && !c.large && !c.wsdlDir);
  for (const c of withResponse) {
    it(`${c.key}: at least one read tool has a responseSchema`, () => {
      const reads = loadGenerated(c.key).filter((t) => t.categories.length === 1 && t.categories[0] === 'read');
      const withSchema = reads.filter((t) => t.responseSchema);
      expect(withSchema.length).toBeGreaterThan(0);
    });
  }
});
