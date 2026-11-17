// Parity test: every Composio-managed catalog entry must inline the same
// authConfigIds + mcpServerIds that composio-resources.json carries.
//
// The bootstrap script (src/scripts/composio-bootstrap-toolkit.ts) writes to
// config/composio-resources.json after provisioning each toolkit. The runtime
// registry, however, reads the inlined values from src/catalog/connectors.ts
// (no JSON I/O at module load — the catalog is built as a static const for
// JSON-serializability across the wire). The two MUST stay in sync. This test
// fails CI if an operator updates one but forgets the other.

import fs from 'node:fs';
import path from 'node:path';
import { CONNECTORS } from '../connectors.js';

interface ResourceRecord {
  toolkitSlug: string;
  toolsCount: number;
  authConfigIds: { dev: string; prod: string };
  mcpServerIds: { dev: string; prod: string };
  managedScopes: string[];
}

interface ResourceFile {
  toolkits: Record<string, ResourceRecord>;
}

const RESOURCE_FILE = path.join(__dirname, '../../../config/composio-resources.json');

function loadResourceFile(): ResourceFile {
  return JSON.parse(fs.readFileSync(RESOURCE_FILE, 'utf8')) as ResourceFile;
}

describe('composio-resources.json ↔ CONNECTORS catalog parity', () => {
  const resources = loadResourceFile();

  // Build the inverse map: toolkitSlug → catalog entry (so we can look up by
  // Composio slug, not Liftoff connector type — slugs differ for cal/cal_com,
  // googleads/google_ads, dynamics365/microsoft_dynamics).
  const catalogBySlug = new Map<string, { type: string; mcp: { kind: string; toolkitSlug?: string; authConfigIds?: { dev: string; prod: string }; mcpServerIds?: { dev: string; prod: string } } }>();
  for (const c of Object.values(CONNECTORS)) {
    if (c.mcp?.kind === 'composio_managed') {
      catalogBySlug.set(c.mcp.toolkitSlug, { type: c.type, mcp: c.mcp });
    }
  }

  it('every composio_managed catalog entry has a matching resources.json record', () => {
    const missing: string[] = [];
    for (const [slug] of catalogBySlug) {
      if (!resources.toolkits[slug]) missing.push(slug);
    }
    expect(missing).toEqual([]);
  });

  it('every resources.json toolkit appears in the catalog as composio_managed', () => {
    const orphan: string[] = [];
    for (const slug of Object.keys(resources.toolkits)) {
      if (!catalogBySlug.has(slug)) orphan.push(slug);
    }
    expect(orphan).toEqual([]);
  });

  it('inlined authConfigIds in the catalog match resources.json (per env)', () => {
    const mismatches: string[] = [];
    for (const [slug, catalogEntry] of catalogBySlug) {
      const record = resources.toolkits[slug];
      if (!record) continue;
      for (const env of ['dev', 'prod'] as const) {
        const catalogValue = catalogEntry.mcp.authConfigIds?.[env];
        const resourceValue = record.authConfigIds[env];
        if (catalogValue !== resourceValue) {
          mismatches.push(
            `${slug}.authConfigIds.${env}: catalog=${catalogValue} resources=${resourceValue}`,
          );
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('inlined mcpServerIds in the catalog match resources.json (per env)', () => {
    const mismatches: string[] = [];
    for (const [slug, catalogEntry] of catalogBySlug) {
      const record = resources.toolkits[slug];
      if (!record) continue;
      for (const env of ['dev', 'prod'] as const) {
        const catalogValue = catalogEntry.mcp.mcpServerIds?.[env];
        const resourceValue = record.mcpServerIds[env];
        if (catalogValue !== resourceValue) {
          mismatches.push(
            `${slug}.mcpServerIds.${env}: catalog=${catalogValue} resources=${resourceValue}`,
          );
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});
