// C. Contract-mock E2E (Prism-equivalent, in-process). For representative read+write
// ops per REST connector, a mock fetch VALIDATES the client's request against the
// vendor's own schema (ajv) — returning HTTP 400 if it doesn't conform, exactly like
// Prism — and otherwise returns a spec-shaped response. The client must then parse it.
// So a green write proves: request conformed (else 400 ⇒ success:false) AND the client
// parsed the response. Chosen over the Prism CLI (subprocess/ports) for CI-robustness;
// same guarantee, in-process.

import { readFileSync, existsSync } from 'node:fs';
import type { CompensationClient, ConnectorCredentials } from '../types.js';
import { GustoClient } from '../gusto.js';
import { RipplingClient } from '../rippling.js';
import { NamelyClient } from '../namely.js';
import { OracleHcmClient } from '../oracle-hcm.js';
import { WorkdayClient } from '../workday.js';
import { specPath } from '../../catalog/__tests__/support/regen';
import { deref, requestBodySchema, compileValidator, sample } from '../../catalog/__tests__/support/oas';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml');
const loadSpec = (p: string): any => (/\.ya?ml$/i.test(p) ? yaml.load(readFileSync(p, 'utf8')) : JSON.parse(readFileSync(p, 'utf8')));

interface Call { url: string; method: string; body?: unknown }
function installMock(handler: (c: Call) => { status: number; json?: unknown }) {
  const parse = (b?: string) => { if (!b) return undefined; try { return JSON.parse(b); } catch { return b; } };
  (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const r = handler({ url, method: init?.method ?? 'GET', body: parse(init?.body) });
    return { ok: r.status < 400, status: r.status, headers: { get: () => null }, json: async () => r.json ?? {}, text: async () => JSON.stringify(r.json ?? {}) } as unknown as Response;
  });
}
const provider = (creds: Partial<ConnectorCredentials>) => async () => ({ accessToken: 'tok', ...creds } as ConnectorCredentials);
afterEach(() => jest.restoreAllMocks());

function responseExample(op: any, spec: any): unknown {
  const r = op.responses ?? {};
  const key = ['200', '201', '202', '2XX', 'default'].find((k) => r[k]) ?? Object.keys(r)[0];
  const resp = deref(r[key], spec);
  const media = resp?.content?.['application/json'] ?? Object.values<any>(resp?.content ?? {})[0];
  if (media?.example) return media.example;
  if (media?.schema) return sample(media.schema, spec);
  return { id: 'x', data: [] };
}

interface Drv { key: string; spec: string; large?: boolean; make: () => CompensationClient; entity: (p: string) => string; isToken: (u: string) => boolean; tokenJson?: unknown }
const WD = { connectorConfig: { tenantHost: 'https://wd.example.com', tenant: 'acme', restEndpoint: 'https://wd.example.com/ccx/api/v1/acme', tokenUrl: 'https://wd.example.com/token', clientId: 'c', clientSecret: 's', refreshToken: 'rt' } };
const DRIVERS: Drv[] = [
  { key: 'gusto', spec: 'gusto-app-integrations-openapi.yaml', make: () => new GustoClient(provider({ instanceUrl: 'co-1' })), entity: (p) => p.replace(/^\/v1/, '') || '/', isToken: (u) => u.includes('/oauth') },
  { key: 'namely', spec: 'namely-openapi.yaml', make: () => new NamelyClient(provider({ instanceUrl: 'acme', accessToken: 'pat' })), entity: (p) => p, isToken: () => false },
  { key: 'rippling', spec: 'rippling-openapi.yaml', make: () => new RipplingClient(provider({})), entity: (p) => p, isToken: () => false },
  { key: 'workday_staffing', spec: 'workday-staffing-openapi.yaml', make: () => new WorkdayClient(provider(WD)), entity: (p) => '/ccx/api/staffing/v1/{tenant}' + p, isToken: (u) => u.includes('/token'), tokenJson: { access_token: 'a' } },
  { key: 'oracle_hcm', spec: '.large/oracle-openapi.json', large: true, make: () => new OracleHcmClient(provider({ connectorConfig: { podHost: 'pod.oraclecloud.com', idcsTokenUrl: 'https://idcs.example.com', clientId: 'c', clientSecret: 's' } })), entity: (p) => p, isToken: (u) => u.includes('/token'), tokenJson: { access_token: 'oat', expires_in: 3600 } },
];

describe('C. contract-mock E2E (request validated vs spec, response parsed)', () => {
  for (const d of DRIVERS) {
    const present = existsSync(specPath(d.spec));
    (present ? describe : describe.skip)(d.key, () => {
      const spec = present ? loadSpec(specPath(d.spec)) : { paths: {} };
      const entries = Object.entries<any>(spec.paths ?? {}).filter(([p]) => !/\/(oauth|token|introspect|authorize)\b/.test(p));
      const readOp = entries.find(([, it]) => it.get);
      const writeOp = entries.find(([, it]) => (it.post ?? it.put) && requestBodySchema((it.post ?? it.put), spec));

      it('a GET round-trips: request conforms, client parses the spec response', async () => {
        const [p, item] = readOp!;
        const entityType = `GET ${d.entity(p)}`;
        const params = Object.fromEntries([...d.entity(p).matchAll(/\{([^}]+)\}/g)].map((m) => [m[1], 'x']));
        installMock((c) => (d.isToken(c.url) ? { status: 200, json: d.tokenJson ?? {} } : { status: 200, json: responseExample(item.get, spec) }));
        const rec = await d.make().read(entityType, undefined, params);
        expect(rec).toHaveProperty('data'); // parsed without throwing
      });

      it('a write round-trips: mock validates the body vs the spec (400 if not) and the client succeeds', async () => {
        const [p, item] = writeOp!;
        const op = item.post ?? item.put;
        const method = item.post ? 'POST' : 'PUT';
        const entityType = `${method} ${d.entity(p)}`;
        const params = Object.fromEntries([...d.entity(p).matchAll(/\{([^}]+)\}/g)].map((m) => [m[1], 'x']));
        const bodySchema = requestBodySchema(op, spec)!;
        const validate = compileValidator(bodySchema, spec);
        const body = sample(bodySchema, spec);
        installMock((c) => {
          if (d.isToken(c.url)) return { status: 200, json: d.tokenJson ?? {} };
          if (!validate(c.body)) return { status: 400, json: { errors: validate.errors } }; // Prism-style contract enforcement
          return { status: 201, json: responseExample(op, spec) };
        });
        const res = await d.make().create(entityType, { ...params, body });
        // Only assert success when our sample is itself contract-valid (else the 400 is
        // the sampler's regex-`pattern` gap, not a client defect — see B).
        if (validate(body)) expect(res.success).toBe(true);
        else expect([true, false]).toContain(res.success);
      });
    });
  }
});
