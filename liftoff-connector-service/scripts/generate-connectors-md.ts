// Generates docs/CONNECTORS.md from the CONNECTORS registry.
//
// Run `npm run gen:connector-docs`. The output is deterministic — rerunning
// without a registry change produces byte-identical output. Safe to commit.

import { writeFileSync } from 'fs';
import { resolve } from 'path';
import type { ConnectorDef } from '@liftoffos/connector-types';
import { CONNECTORS, CATEGORY_DISPLAY_LABELS, computeCatalogVersion, type LocalConnectorDef } from '../src/catalog/connectors';

interface Section {
  category: string;
  label: string;
  entries: ConnectorDef[];
}

function authSummary(auth: LocalConnectorDef['auth']): string {
  switch (auth.kind) {
    case 'static_oauth':
      return `static_oauth (${auth.scopes.length} scopes${auth.requiresPkce ? ', PKCE' : ''})`;
    case 'dcr_oauth':
      return `dcr_oauth (discovery: ${new URL(auth.discoveryBaseUrl).hostname})`;
    case 'api_key':
      return 'api_key';
    case 'keypair':
      return 'keypair';
    case 'iam_grant':
      return 'iam_grant (keyless per-tenant SA)';
    case 'none':
      return 'none';
    default:
      return (auth as { kind: string }).kind;
  }
}

function mcpSummary(mcp: ConnectorDef['mcp']): string {
  if (!mcp) return '—';
  if (mcp.kind === 'vendor_hosted') {
    const resolver = mcp.urlResolverKey ? ` (resolver: \`${mcp.urlResolverKey}\`)` : '';
    return `vendor_hosted · ${mcp.transport}${resolver}`;
  }
  if (mcp.kind === 'composio_managed') {
    return `composio_managed · \`${mcp.toolkitSlug}\``;
  }
  return `sidecar · \`${mcp.sidecarPath}\``;
}

function capabilitiesSummary(caps: ConnectorDef['capabilities']): string {
  if (!caps || caps.length === 0) return '—';
  return caps.map((c) => c.capability).join(', ');
}

function statusBadge(def: ConnectorDef): string {
  if (def.status === 'available') return '✅ available';
  if (def.status === 'coming_soon') return `⏳ coming_soon${def.statusReason ? ` — ${def.statusReason}` : ''}`;
  if (def.status === 'beta') return '🧪 beta';
  return '⚠️  deprecated';
}

function groupByCategory(): Section[] {
  const buckets = new Map<string, ConnectorDef[]>();
  for (const def of Object.values(CONNECTORS)) {
    const bucket = buckets.get(def.category) ?? [];
    bucket.push(def);
    buckets.set(def.category, bucket);
  }
  // Sort categories by their display label for stable output.
  const entries = [...buckets.entries()]
    .map(([category, defs]) => ({
      category,
      label:
        (CATEGORY_DISPLAY_LABELS as Record<string, string>)[category] ?? category,
      entries: defs.sort((a, b) => a.type.localeCompare(b.type)),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return entries;
}

function render(): string {
  const all = Object.values(CONNECTORS);
  const available = all.filter((c) => c.status === 'available');
  const comingSoon = all.filter((c) => c.status === 'coming_soon');

  const authCounts = new Map<string, number>();
  for (const c of all) {
    authCounts.set(c.auth.kind, (authCounts.get(c.auth.kind) ?? 0) + 1);
  }

  const mcpCounts = new Map<string, number>();
  let withoutMcp = 0;
  for (const c of all) {
    if (!c.mcp) {
      withoutMcp++;
      continue;
    }
    mcpCounts.set(c.mcp.kind, (mcpCounts.get(c.mcp.kind) ?? 0) + 1);
  }

  const sections = groupByCategory();

  const lines: string[] = [];
  lines.push('# Connector Catalog');
  lines.push('');
  lines.push('> Auto-generated from [`src/catalog/connectors.ts`](../src/catalog/connectors.ts).');
  lines.push('> Do not edit by hand — regenerate with `npm run gen:connector-docs`.');
  lines.push('');
  lines.push(`**Catalog version**: \`${computeCatalogVersion()}\``);
  lines.push('');
  lines.push(`**Totals**: ${all.length} connectors · ${available.length} available · ${comingSoon.length} coming soon`);
  lines.push('');

  // DERIVED from the kinds actually present, not a hand-written list.
  //
  // The list was hand-written and had gone stale: `custom_mcp` had been in the
  // catalog for months and appeared in no row, so the table under-reported the
  // catalog it documents and nobody could tell by reading it. A note is still
  // authored per kind — that is prose nothing can derive — but a kind with no
  // note is now listed with an empty one rather than omitted, which is the
  // difference between a summary and a table you cannot trust.
  const AUTH_KIND_NOTES: Record<string, string> = {
    static_oauth: 'Provider-registered OAuth app (client id/secret from Secret Manager).',
    dcr_oauth: 'RFC 7591 dynamic client registration via `.well-known` discovery.',
    api_key: 'User-supplied API key stored in Secret Manager.',
    keypair: 'Asymmetric keypair auth (e.g. Snowflake RSA).',
    iam_grant: 'Keyless per-tenant SA impersonation + customer IAM grant (e.g. BigQuery).',
    custom_mcp: 'Tenant-registered MCP server; credentials stored per instance.',
    custom_api: 'An API a workspace described and connected from a conversation; the key is entered on a hosted capture page and the operations come from the provider\'s own OpenAPI specification.',
    none: 'No auth (instant-connect capabilities like web search).',
  };
  lines.push('## Auth kinds');
  lines.push('');
  lines.push('| Auth kind | Count | Notes |');
  lines.push('|---|---:|---|');
  // The authored order first, so the table reads the same as it always has,
  // then anything the catalog carries that nobody has written a note for.
  const authKinds = [
    ...Object.keys(AUTH_KIND_NOTES).filter((k) => authCounts.has(k)),
    ...[...authCounts.keys()].filter((k) => !(k in AUTH_KIND_NOTES)).sort(),
  ];
  for (const kind of authKinds) {
    lines.push(`| ${kind} | ${authCounts.get(kind) ?? 0} | ${AUTH_KIND_NOTES[kind] ?? ''} |`);
  }
  lines.push('');

  lines.push('## MCP kinds');
  lines.push('');
  lines.push('| MCP kind | Count | Notes |');
  lines.push('|---|---:|---|');
  lines.push(`| vendor_hosted | ${mcpCounts.get('vendor_hosted') ?? 0} | Vendor operates the MCP server; we connect over SSE or Streamable HTTP. |`);
  lines.push(`| sidecar | ${mcpCounts.get('sidecar') ?? 0} | We operate an in-repo MCP sidecar fronting the vendor REST API. |`);
  lines.push(`| composio_managed | ${mcpCounts.get('composio_managed') ?? 0} | Composio hosts the MCP server; tenant-runtime dispatches directly. |`);
  lines.push(`| (none) | ${withoutMcp} | Pure REST connector with no MCP surface. |`);
  lines.push('');

  for (const section of sections) {
    lines.push(`## ${section.label}`);
    lines.push('');
    lines.push('| Type | Display name | Status | Auth | MCP | Capabilities |');
    lines.push('|---|---|---|---|---|---|');
    for (const def of section.entries) {
      const row = [
        `\`${def.type}\``,
        def.displayName,
        statusBadge(def),
        authSummary(def.auth),
        mcpSummary(def.mcp),
        capabilitiesSummary(def.capabilities),
      ];
      lines.push(`| ${row.join(' | ')} |`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('See also:');
  lines.push('- [`src/catalog/connectors.ts`](../src/catalog/connectors.ts) — the registry');
  lines.push('- [`src/catalog/projections.ts`](../src/catalog/projections.ts) — derived views');
  lines.push('- [`src/catalog/mcp-server-registry.ts`](../src/catalog/mcp-server-registry.ts) — MCP URLs, transports');
  lines.push('- [`src/catalog/connector-capabilities.ts`](../src/catalog/connector-capabilities.ts) — capability → scope maps');
  lines.push('');

  return lines.join('\n');
}

function main(): void {
  const out = render();
  const target = resolve(__dirname, '..', 'docs', 'CONNECTORS.md');
  writeFileSync(target, out);
  process.stdout.write(`wrote ${target} (${out.length} bytes)\n`);
}

export { render };

if (require.main === module) {
  main();
}
