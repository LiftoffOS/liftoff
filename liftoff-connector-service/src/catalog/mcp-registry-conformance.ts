// MCP Registry Conformance Validator (TE-009, TE-016)
//
// Ported from tenant-runtime/src/connectors/mcp-registry-conformance.ts.
// Adjusted so that the sidecar-exists check is a soft warning when the
// mcp-servers/ directory isn't co-located with this service — the raw
// sidecar code lives in tenant-runtime for Phase 1c.

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  getMCPConnectorTypes,
  getFullRegistryEntry,
} from './mcp-server-registry.js';

const VENDOR_HOSTED_ALLOWED_HOSTNAMES = new Set([
  'mcp.stripe.com',
  'mcp.hubspot.com',
  // GTM / market-intelligence (Change 6 — vendor_hosted + DCR)
  'mcp.zoominfo.com',
  'mcp.commonroom.io',
  'mcp.similarweb.com',
  'api.ahrefs.com',
  'mcp.supermetrics.com',
  'api.outreach.io',
  'api.github.com',
  'api.githubcopilot.com',
  'mcp.github.com',
  'gitlab.com',
  'mcp.notion.com',
  'mcp.intuit.com',
  'mcp.xero.com',
  'mcp.intercom.com',
  'mcp.linear.app',
  'mcp.asana.com',
  'mcp.calendly.com',
  'mcp.paypal.com',
  'mcp.datadoghq.com',
  'api.clay.com',
  'mcp.clay.earth',
  'mcp.granola.ai',
  'mcp.sentry.dev',
  // Marketing connectors (vendor-hosted MCP)
  'mcp.klaviyo.com', 'app.kit.com', 'mcp.omnisend.com', 'mcp.amplitude.com', 'app.pendo.io',
  'mcp.webflow.com', 'mcp.typefully.com', 'install.crustdata.com', 'mcp.tapfiliate.com',
  'mcp.partnerstack.com', 'mcp.crossbeam.com', 'mcp.paddle.com', 'mcp.salesloft.com',
  'mcp.snov.io', 'mcp.sparktoro.com', 'mcp.livestorm.co', 'mcp.coupler.io',
  'mcp.keywordseverywhere.com', 'mcp.tolt.com', 'gateway.demandbase.com',
  // Composio-managed MCP terminator (per-toolkit servers under one host)
  'mcp.composio.dev',
  // Per-workspace connectors' placeholder hostnames
  'placeholder.snowflakecomputing.com',
  'placeholder.azuredatabricks.net',
]);

function getMcpServersRoot(): string | null {
  const candidates = [
    path.resolve(__dirname, '../../mcp-servers'),
    path.resolve(__dirname, '../../../mcp-servers'),
    path.resolve(process.cwd(), 'mcp-servers'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

export interface ConformanceViolation {
  connectorType: string;
  rule: string;
  detail: string;
}

interface InspectableEntry {
  mcpUrl: string;
  isVendorHosted: boolean;
  disabled?: boolean;
  disabledReason?: string;
  hasUrlResolver?: boolean;
}

function getRegistry(): Record<string, InspectableEntry> {
  const types = getMCPConnectorTypes();
  const result: Record<string, InspectableEntry> = {};
  for (const t of types) {
    const entry = getFullRegistryEntry(t);
    if (entry) {
      result[t] = {
        mcpUrl: entry.mcpUrl,
        isVendorHosted: entry.isVendorHosted,
        disabled: entry.disabled,
        disabledReason: entry.disabledReason,
        hasUrlResolver: typeof entry.urlResolver === 'function',
      };
    }
  }
  return result;
}

export function getMCPRegistryConformanceViolations(): ConformanceViolation[] {
  const violations: ConformanceViolation[] = [];
  const registry = getRegistry();
  const mcpServersRoot = getMcpServersRoot();

  for (const [connectorType, entry] of Object.entries(registry)) {
    if (entry.disabled) {
      if (!entry.disabledReason || entry.disabledReason.trim() === '') {
        violations.push({
          connectorType,
          rule: 'disabled_without_reason',
          detail: 'disabled:true requires disabledReason to be set',
        });
      }
      continue;
    }

    if (entry.isVendorHosted) {
      let parsed: URL;
      try {
        parsed = new URL(entry.mcpUrl);
      } catch {
        violations.push({
          connectorType,
          rule: 'vendor_hosted_bad_url',
          detail: `mcpUrl is not a valid URL: ${entry.mcpUrl}`,
        });
        continue;
      }
      if (parsed.protocol !== 'https:') {
        violations.push({
          connectorType,
          rule: 'vendor_hosted_non_https',
          detail: `vendor-hosted mcpUrl must be https, got: ${parsed.protocol}`,
        });
      }
      if (!entry.hasUrlResolver && !VENDOR_HOSTED_ALLOWED_HOSTNAMES.has(parsed.hostname)) {
        violations.push({
          connectorType,
          rule: 'vendor_hosted_hostname_not_on_allowlist',
          detail: `hostname ${parsed.hostname} is not on the allow-list`,
        });
      }
      if (/^\d+\.\d+\.\d+\.\d+$/.test(parsed.hostname)) {
        violations.push({
          connectorType,
          rule: 'vendor_hosted_ip_literal',
          detail: `vendor-hosted mcpUrl must use a hostname, not an IP: ${parsed.hostname}`,
        });
      }
    } else if (mcpServersRoot) {
      const candidates = [
        path.join(mcpServersRoot, connectorType, 'index.ts'),
        path.join(mcpServersRoot, connectorType.replace(/_/g, '-'), 'index.ts'),
        path.join(mcpServersRoot, connectorType.split('_')[0], 'index.ts'),
      ];
      const exists = candidates.some((p) => fs.existsSync(p));
      if (!exists) {
        violations.push({
          connectorType,
          rule: 'sidecar_not_implemented',
          detail: `no sidecar found at mcp-servers/${connectorType}/index.ts`,
        });
      }
    }
  }

  return violations;
}

export function validateMCPRegistryConformance(): void {
  const violations = getMCPRegistryConformanceViolations();
  if (violations.length === 0) return;
  const lines = violations
    .map((v) => `  [${v.rule}] ${v.connectorType}: ${v.detail}`)
    .join('\n');
  throw new Error(
    `MCP registry conformance check failed — ${violations.length} violation(s):\n${lines}`,
  );
}
