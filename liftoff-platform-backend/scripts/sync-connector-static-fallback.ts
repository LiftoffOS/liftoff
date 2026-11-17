// Regenerate src/connectors/connector-service-cache.static.ts from the
// live connector-service catalog.
//
// Usage:
//   CONNECTOR_SERVICE_URL=https://connectors.example.com \
//   CONNECTOR_SERVICE_TOKEN=<token> \
//   npm run sync:connectors
//
// CI usage (catches drift):
//   npm run sync:connectors
//   git diff --exit-code src/connectors/connector-service-cache.static.ts
//     || { echo "Static fallback is stale. Run 'npm run sync:connectors'."; exit 1; }
//
// The hand-maintained version of this file was the last piece of Phase 1
// drift risk — every connector status change used to require a parallel
// edit here. This script eliminates that by deriving both
// STATIC_FUNCTIONAL_CONNECTOR_TYPES and STATIC_CONNECTOR_CAPABILITIES
// from the live catalog. The only things hand-written are the entries
// for capabilities whose connectors haven't been ported to the registry
// yet (greenhouse/lever/pagerduty) — see STATIC_ONLY_CAPABILITIES below.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { buildOidcAuthHeader } from '@liftoffos/service-client';

export interface ConnectorCapabilityBinding {
  capability: string;
  requiredScopes: string[];
}

export interface ConnectorDef {
  type: string;
  status: 'available' | 'coming_soon' | 'beta' | 'deprecated';
  capabilities?: ConnectorCapabilityBinding[];
}

export interface CatalogResponse {
  connectors: ConnectorDef[];
  version: string;
  categoryLabels: Record<string, string>;
}

interface CapabilityOption {
  connectorType: string;
  requiredScopes: string[];
}

// Capabilities whose connectors are NOT yet in the unified CONNECTORS
// registry. These are hand-maintained until each connector's client code
// lands. They get merged on top of the derived capabilities.
//
// quickbooks and pagerduty used to live here but now ship via Composio
// managed (`status: 'available'`) in the live catalog under `accounting`
// and `incident_management` respectively — leaving the overrides in
// place would emit duplicate rows for the same connectorType.
export const STATIC_ONLY_CAPABILITIES: Record<string, CapabilityOption[]> = {
  accounting: [
    { connectorType: 'xero', requiredScopes: ['accounting.transactions', 'accounting.contacts.read'] },
  ],
  ats: [
    {
      connectorType: 'greenhouse',
      requiredScopes: ['candidates:read', 'candidates:write', 'jobs:read', 'interviews:write'],
    },
    { connectorType: 'lever', requiredScopes: ['read', 'write'] },
  ],
  hris: [
    { connectorType: 'gusto', requiredScopes: ['employees:read', 'employees:write'] },
    { connectorType: 'rippling', requiredScopes: ['employees:read', 'employees:write'] },
  ],
  support_ticketing: [
    { connectorType: 'zendesk', requiredScopes: ['tickets:read', 'tickets:write'] },
  ],
};

const DEFAULT_CATALOG_URL =
  'https://connectors.example.com/api/connectors/catalog';

const OUTPUT_PATH = path.resolve(
  __dirname,
  '..',
  'src',
  'connectors',
  'connector-service-cache.static.ts',
);

async function fetchCatalog(): Promise<CatalogResponse> {
  const baseUrl = (process.env.CONNECTOR_SERVICE_URL ?? '').replace(/\/$/, '');
  const url = baseUrl ? `${baseUrl}/api/connectors/catalog` : DEFAULT_CATALOG_URL;
  const token = process.env.CONNECTOR_SERVICE_TOKEN;
  if (!token) {
    throw new Error(
      'CONNECTOR_SERVICE_TOKEN must be set. In CI it comes from Secret Manager; locally, fetch it with `gcloud secrets versions access latest --secret=connector-service-token --project=YOUR_CONTROL_PROJECT_STAGING`.',
    );
  }

  // Cloud Run internal IAM requires `Authorization: Bearer <id-token>` from
  // an identity with `roles/run.invoker`. Three supported paths:
  //   1. CI: Cloud Build fetches an ID token from the metadata server via
  //      curl and exports it as CONNECTOR_SERVICE_ID_TOKEN (see the
  //      `fetch-catalog-auth` step in cloudbuild.yaml). `gcloud auth
  //      print-identity-token` doesn't work in Cloud Build — the runner's
  //      SA creds only live on the metadata server, not in an ADC file.
  //   2. Local dev with ADC: `gcloud auth application-default login
  //      --impersonate-service-account=cloud-build-dev@...` — ADC
  //      picks up the impersonation and buildOidcAuthHeader works.
  //   3. Escape hatch: set CONNECTOR_SERVICE_ID_TOKEN to an ID token you
  //      minted manually (`gcloud auth print-identity-token
  //      --impersonate-service-account=... --audiences=<connector-svc-url>`).
  //      Useful when you don't want to touch your ADC login.
  const baseForAudience = url.replace(/\/api\/connectors\/catalog$/, '');
  const headers: Record<string, string> = { 'X-Service-Auth': token };
  const manualIdToken = process.env.CONNECTOR_SERVICE_ID_TOKEN;
  if (manualIdToken) {
    headers.Authorization = `Bearer ${manualIdToken}`;
  } else {
    try {
      const oidc = await buildOidcAuthHeader(baseForAudience);
      for (const [k, v] of Object.entries(oidc)) {
        headers[k] = v;
      }
    } catch {
      // Metadata server absent — fall through; fetch surfaces the 403.
    }
  }

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Catalog fetch failed: HTTP ${res.status} ${res.statusText}\n${body}`);
  }
  return (await res.json()) as CatalogResponse;
}

export function deriveFunctionalTypes(catalog: CatalogResponse): string[] {
  return catalog.connectors
    .filter((c) => c.status === 'available')
    .map((c) => c.type)
    .sort();
}

export function deriveCapabilities(catalog: CatalogResponse): Record<string, CapabilityOption[]> {
  const result: Record<string, CapabilityOption[]> = {};

  for (const connector of catalog.connectors) {
    if (connector.status !== 'available') continue;
    if (!connector.capabilities) continue;
    for (const binding of connector.capabilities) {
      const bucket = (result[binding.capability] ??= []);
      bucket.push({
        connectorType: connector.type,
        requiredScopes: binding.requiredScopes,
      });
    }
  }

  // Merge static-only entries. These belong to capabilities whose
  // connectors haven't been ported to the registry yet.
  for (const [cap, options] of Object.entries(STATIC_ONLY_CAPABILITIES)) {
    result[cap] = [...(result[cap] ?? []), ...options];
  }

  // Deterministic ordering so `git diff` doesn't flap.
  const ordered: Record<string, CapabilityOption[]> = {};
  for (const key of Object.keys(result).sort()) {
    ordered[key] = [...result[key]!].sort((a, b) => a.connectorType.localeCompare(b.connectorType));
  }

  return ordered;
}

export function renderFile(
  functional: string[],
  capabilities: Record<string, CapabilityOption[]>,
  version: string,
): string {
  const stringifiedCaps = Object.entries(capabilities)
    .map(([cap, options]) => {
      const lines = options
        .map(
          (o) =>
            `    { connectorType: ${JSON.stringify(o.connectorType)}, requiredScopes: ${JSON.stringify(o.requiredScopes)} },`,
        )
        .join('\n');
      return `  ${JSON.stringify(cap)}: [\n${lines}\n  ],`;
    })
    .join('\n');

  const stringifiedFunctional = functional
    .map((t) => `  ${JSON.stringify(t)},`)
    .join('\n');

  return `// AUTO-GENERATED by scripts/sync-connector-static-fallback.ts.
// DO NOT EDIT BY HAND. Run \`npm run sync:connectors\` to regenerate.
//
// Source: GET /api/connectors/catalog on liftoff-connector-service.
// Catalog version at generation: ${version}
//
// This file is the fail-closed fallback for the connector-service RPC
// cache: used (a) when CONNECTOR_SERVICE_ENABLED=off, and (b) when the
// live RPC is unreachable at startup. Because it's regenerated from the
// same registry the live RPC serves, drift is impossible — if the
// registry changes, CI fails until someone re-runs this script.

export interface CapabilityOption {
  connectorType: string;
  requiredScopes: string[];
}

export const STATIC_CONNECTOR_CAPABILITIES: Record<string, CapabilityOption[]> = {
${stringifiedCaps}
};

export const STATIC_FUNCTIONAL_CONNECTOR_TYPES: Set<string> = new Set([
${stringifiedFunctional}
]);
`;
}

async function main(): Promise<void> {
  const catalog = await fetchCatalog();
  const functional = deriveFunctionalTypes(catalog);
  const capabilities = deriveCapabilities(catalog);
  const output = renderFile(functional, capabilities, catalog.version);
  await fs.writeFile(OUTPUT_PATH, output, 'utf8');
  // Summary for human operators + CI log lines.

  console.log(
    `sync: wrote ${OUTPUT_PATH}\n  catalog version: ${catalog.version}\n  functional types: ${functional.length}\n  capabilities: ${Object.keys(capabilities).length}`,
  );
}

// Only run when invoked directly as a CLI. Without this guard Jest would
// execute main() every time the module is imported for testing, and the
// tests fail on the missing CONNECTOR_SERVICE_TOKEN env var.
if (require.main === module) {
  main().catch((err) => {
    // Intentional: this is a CLI, not a library.

    console.error('sync-connector-static-fallback failed:', (err as Error).message);
    process.exit(1);
  });
}
