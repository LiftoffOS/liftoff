// Shared helpers for loading + categorizing connector response fixtures.
//
// Each transport-specific test file (composio / vendor-mcp / sidecar /
// rest-direct) loads its fixture set the same way: read JSON files
// under __fixtures__/<connector_type>/<action>.json, assert basic
// structural invariants, then feed the body to the matching adapter.

import * as fs from 'fs';
import * as path from 'path';

export interface Fixture {
  connectorType: string;
  action: string;
  filePath: string;
  body: unknown;
  /** mtime in ms since epoch — used by fixture-age-test to enforce the
   *  120-day refresh cadence. */
  ageMs: number;
}

const FIXTURE_ROOT = path.resolve(__dirname, '..', '__fixtures__');

export function loadAllFixtures(): Fixture[] {
  const out: Fixture[] = [];
  const connectorDirs = fs.readdirSync(FIXTURE_ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
  for (const connectorType of connectorDirs) {
    const dir = path.join(FIXTURE_ROOT, connectorType);
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const filePath = path.join(dir, file);
      const action = file.replace(/\.json$/, '');
      const body = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const stat = fs.statSync(filePath);
      out.push({
        connectorType,
        action,
        filePath,
        body,
        ageMs: Date.now() - stat.mtimeMs,
      });
    }
  }
  return out;
}

export function loadFixturesFor(connectorType: string): Fixture[] {
  return loadAllFixtures().filter(f => f.connectorType === connectorType);
}

/** Generic shape assertions every fixture must satisfy regardless of
 *  transport — guards against typos / accidental empty files / non-JSON
 *  payloads sneaking in. */
export function assertFixtureShape(fixture: Fixture): void {
  if (fixture.body === null || typeof fixture.body !== 'object') {
    throw new Error(`fixture ${fixture.filePath} is not a JSON object`);
  }
  if (Array.isArray(fixture.body) && (fixture.body as unknown[]).length === 0) {
    throw new Error(`fixture ${fixture.filePath} is an empty array`);
  }
  if (!Array.isArray(fixture.body) && Object.keys(fixture.body as object).length === 0) {
    throw new Error(`fixture ${fixture.filePath} has no top-level keys`);
  }
}

/** Connector types that route via Composio (`definitionSource === 'composio'`). */
export const COMPOSIO_MANAGED_TYPES: ReadonlySet<string> = new Set([
  'slack',
  'gmail',
  'google_calendar',
  'google_drive',
  'google_docs',
  'google_slides',
  'google_sheets',
]);

/** Connector types served by vendor-hosted MCP servers. */
export const VENDOR_MCP_TYPES: ReadonlySet<string> = new Set([
  'notion',
  'stripe',
  'hubspot',
]);

/** Connector types dispatched through a locally-hosted MCP sidecar. */
export const SIDECAR_TYPES: ReadonlySet<string> = new Set([
  'salesforce',
]);

/** Connector types dispatched via direct REST clients. */
export const REST_DIRECT_TYPES: ReadonlySet<string> = new Set([
  'bamboohr',
  'calendly',
  'docusign',
]);

/** Native first-party HRIS connector types (direct REST / OData / SOAP clients). Their fixtures
 *  are contract-gated on the tool's responseSchema (native-hris-actions.test.ts) rather than the
 *  live-recapture 120-day age gate — there is no live tenant to recapture from. */
export const NATIVE_REST_TYPES: ReadonlySet<string> = new Set([
  'workday', 'oracle_hcm', 'namely', 'sap_successfactors', 'deel', 'factorial', 'hibob',
  'personio', 'ukg_pro', 'ukg_ready', 'dayforce', 'adp_run', 'adp_workforce_now', 'gusto',
  'rippling', 'bamboohr',
]);
