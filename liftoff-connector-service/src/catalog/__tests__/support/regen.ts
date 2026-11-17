// Shared test support: replay the EXACT codegen the CLI ran for each connector,
// so conformance tests can compare a fresh render of the committed spec against the
// committed generated file (no drift) and cross-check invariants.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fromOpenApi, fromODataMetadata, fromWsdl, dedupeNames, GenOp } from '../../spec-codegen';

// support -> __tests__ -> catalog -> src -> repo root
export const ROOT = join(__dirname, '../../../..');
export const specPath = (rel: string): string => join(ROOT, 'specs', rel);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml');

export function loadSpec(p: string): Record<string, unknown> {
  const txt = readFileSync(p, 'utf8');
  return /\.ya?ml$/i.test(p) ? (yaml.load(txt) as Record<string, unknown>) : JSON.parse(txt);
}

/** Load a committed generated tool set (JSON DATA) by connector key. */
export function loadGenerated(key: string): Array<{ name: string; entityType: string; inputSchema: { properties?: Record<string, unknown> }; categories: string[]; responseSchema?: Record<string, unknown> }> {
  return JSON.parse(readFileSync(join(ROOT, 'src', 'catalog', 'generated', `${key}.generated.json`), 'utf8'));
}

export interface ConnectorGen {
  key: string;                 // connector id (matches generated file basename)
  openapi?: string;            // spec path (relative to specs/)
  odata?: string;              // edmx path
  wsdlDir?: string;            // dir of *.wsdl
  stripPrefix?: string;
  pathPrefix?: string;
  namePrefix?: string;
  lean?: boolean;
  large?: boolean;             // source lives under specs/.large (not committed)
}

// One entry per generated file, with the flags used to produce it.
export const CONNECTORS: ConnectorGen[] = [
  { key: 'gusto', openapi: 'gusto-app-integrations-openapi.yaml', stripPrefix: '/v1' },
  { key: 'namely', openapi: 'namely-openapi.yaml' },
  { key: 'rippling', openapi: 'rippling-openapi.yaml' },
  // Batch 2 — public/portal OpenAPI specs. UKG Ready + Dayforce are login-gated
  // and ship curated + passthrough (see plan).
  { key: 'personio', openapi: 'personio-personnel-data-api-oa3.yaml' },
  { key: 'factorial', openapi: 'factorial-openapi.json', stripPrefix: '/api/2026-07-01' },
  { key: 'deel', openapi: 'deel-openapi.json' },
  // No stripPrefix: BambooHR has endpoints across /api/v1, /api/v1_2 and /api/v2, so the
  // client base is the bare host and every entityType carries its own full versioned path.
  { key: 'bamboohr', openapi: 'bamboohr-openapi.yaml' },
  { key: 'workday_person', openapi: 'workday-person-openapi.yaml', pathPrefix: '/ccx/api/person/v1/{tenant}', namePrefix: 'person' },
  { key: 'workday_staffing', openapi: 'workday-staffing-openapi.yaml', pathPrefix: '/ccx/api/staffing/v1/{tenant}', namePrefix: 'staffing' },
  { key: 'workday_performance', openapi: 'workday-performance-enablement-openapi.yaml', pathPrefix: '/ccx/api/performanceEnablement/v5/{tenant}', namePrefix: 'perf' },
  { key: 'sap_successfactors', odata: 'sap-successfactors-user.edmx' },
  { key: 'oracle_hcm', openapi: '.large/oracle-openapi.json', lean: true, large: true },
  { key: 'workday_wws', wsdlDir: '.large/wsdl', large: true },
];

/** True if the connector's source spec is present (committed, or staged under .large). */
export function sourceAvailable(c: ConnectorGen): boolean {
  const rel = c.openapi ?? c.odata ?? c.wsdlDir!;
  return existsSync(specPath(rel));
}

/** Reproduce the CLI's ops for a connector: from* → (lean desc cap) → name-prefix → dedupe. */
export function regen(c: ConnectorGen): GenOp[] {
  let ops: GenOp[];
  if (c.wsdlDir) {
    ops = [];
    const dir = specPath(c.wsdlDir);
    for (const f of readdirSync(dir).filter((n) => /\.wsdl$/i.test(n)).sort()) {
      ops.push(...fromWsdl(readFileSync(join(dir, f), 'utf8'), f.replace(/\.wsdl$/i, '')));
    }
  } else if (c.openapi) {
    ops = fromOpenApi(loadSpec(specPath(c.openapi)), c.stripPrefix, c.pathPrefix, c.lean);
  } else {
    ops = fromODataMetadata(readFileSync(specPath(c.odata!), 'utf8'));
  }
  if (c.lean) for (const o of ops) if (o.description.length > 140) o.description = o.description.slice(0, 137) + '…';
  if (c.namePrefix) for (const o of ops) o.name = `${c.namePrefix}_${o.name}`;
  dedupeNames(ops);
  return ops;
}

/** Count of documented operations in the source spec (for "every op → a tool"). */
export function operationCount(c: ConnectorGen): number {
  if (c.wsdlDir) {
    let n = 0;
    const dir = specPath(c.wsdlDir);
    for (const f of readdirSync(dir).filter((x) => /\.wsdl$/i.test(x))) {
      const xml = readFileSync(join(dir, f), 'utf8');
      n += new Set([...xml.matchAll(/<wsdl:operation\s+name="([^"]+)"/g)].map((m) => m[1])).size;
    }
    return n;
  }
  if (c.openapi) {
    const spec = loadSpec(specPath(c.openapi)) as { paths?: Record<string, Record<string, unknown>> };
    let n = 0;
    for (const item of Object.values(spec.paths ?? {})) for (const m of ['get', 'post', 'put', 'patch', 'delete', 'head']) if (item[m]) n++;
    return n;
  }
  return regen(c).length; // OData: derived (query/get/create/update/delete per set + function imports)
}
