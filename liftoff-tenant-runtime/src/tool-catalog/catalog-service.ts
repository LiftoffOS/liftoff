/**
 * Tool Catalog Service
 *
 * Exposes the per-tenant, per-manifest tool catalog — the same aliased tool
 * names the executor will see at runtime. Used by the Phase 2 HTTP endpoint
 * and, via the platform-backend TenantRuntimeClient, by the distill service
 * to feed real tool names into the LLM during agent/workflow classification.
 *
 * Tool sources:
 *   - Self-hosted connectors (Google, Microsoft, Slack, Salesforce, Dropbox, Box):
 *     static registry via getConnectorFunctions() — always available, permanent cache.
 *   - Vendor-hosted MCP connectors (Stripe, HubSpot, GitHub):
 *     live discovery via discoverMCPTools() with 5-min TTL cache.
 *
 * Tool names follow the buildToolsSchema() sanitization convention:
 *   ${sanitizedAlias}__${funcName}
 * where sanitizedAlias = manifest.alias.replace(/[^a-zA-Z0-9_-]/g, '_').
 */

import { getToolSchemas as getConnectorFunctions } from '../connectors/tool-schema-cache';
import { connectorManifestRepository } from '../connectors/manifest-repository';
import { logger } from '../infrastructure/logging';
import { sanitizeToolNameSegment } from '../agent-execution/tool-name-sanitizer';

export interface CatalogTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  categories?: string[];
  entityType?: string;
  // W1.4 — work_inbox/ack metadata. Platform-backend distill reads
  // these to know which tool is the inbox half of a pair and which
  // is the ack, then auto-injects an acknowledgement contract into
  // the agent's system prompt whenever a bound agent's catalog
  // contains both halves. See work_inbox/ack convention plan.
  draftVariant?: string;
  workRole?: 'inbox' | 'ack';
  paired_ack?: string;
  acknowledges?: string;
  workItemKind?: string;
}

export interface ToolCatalogResult {
  connectorType: string;
  alias: string;
  tools: CatalogTool[];
}

export interface ManifestSummaryResult {
  manifestId: string;
  connectorType: string;
  alias: string;
  displayName: string;
}

/**
 * Sanitize a manifest alias for use as a tool-name prefix.
 * Matches the convention in buildToolsSchema() at service.ts:1578.
 */
export function sanitizeAlias(alias: string): string {
  return alias.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Get the full tool catalog for a specific tenant manifest.
 *
 * Returns tools with the exact aliased names the executor will use at
 * runtime, so distill can emit tool names that resolve at execution time.
 *
 * For self-hosted connectors: returns instantly from the in-memory registry.
 * For vendor-hosted MCP connectors: uses the 5-min TTL cache, discovering
 * live only if the cache is stale. On MCP failure, returns an empty array
 * (graceful degradation — distill falls back to 'agent' classification).
 */
export async function getAvailableTools(
  tenantId: string,
  manifestId: string,
): Promise<ToolCatalogResult | null> {
  // Look up the manifest to get connectorType and alias.
  const manifest = await connectorManifestRepository.getById(tenantId, manifestId);
  if (!manifest) {
    return null;
  }

  const sanitized = sanitizeAlias(manifest.alias);
  const tools: CatalogTool[] = [];

  // 1. Self-hosted registry tools (always available, permanent cache).
  const registryFunctions = getConnectorFunctions(manifest.connectorType);
  for (const func of registryFunctions) {
    tools.push({
      // sanitize func.name defensively — connector-service's listTools now
      // emits clean names but a future malformed registry entry would
      // otherwise break the LLM providers' tool-name regex.
      name: `${sanitized}__${sanitizeToolNameSegment(func.name)}`,
      description: func.description,
      input_schema: func.inputSchema as Record<string, unknown>,
      categories: func.categories,
      entityType: func.entityType,
      // W1.4 — pass registry metadata through to the distill consumer.
      draftVariant: func.draftVariant,
      workRole: func.workRole,
      paired_ack: func.paired_ack,
      acknowledges: func.acknowledges,
      workItemKind: func.workItemKind,
    });
  }

  // Phase 2c: vendor-hosted MCP discovery (Stripe, HubSpot, GitHub, etc.) is
  // now served from the same tool-schema cache — the connector-service seeds
  // it with the full vendor tool set so getConnectorFunctions() already
  // covers both self-hosted and vendor-hosted connectors. No live MCP call
  // is made from the tool catalog anymore.
  logger.debug('tool_catalog_sourced_from_cache', {
    tenant_id: tenantId,
    manifest_id: manifestId,
    connector_type: manifest.connectorType,
    tool_count: tools.length,
  });

  return {
    connectorType: manifest.connectorType,
    alias: manifest.alias,
    tools,
  };
}

/**
 * List all connected manifests for a tenant (summary view for distill's
 * integration enumeration).
 */
export async function getTenantManifests(
  tenantId: string,
): Promise<ManifestSummaryResult[]> {
  // Not getManifestsForAgent(tenantId, ['*']): '*' is not a wildcard there —
  // the SQL literally checks `connector_type = ANY($2)`, so that call returns
  // [] for every tenant, and the distill catalog-fetch and the W4 redistill
  // sweep would both silently see an empty manifest list and skip the
  // work-inbox/ack contract injection entirely. The correct method is
  // listManifests(tenantId), which has no type filter and returns every
  // manifest for the tenant.
  const manifests = await connectorManifestRepository.listManifests(tenantId);

  return manifests.map(m => ({
    manifestId: m.id,
    connectorType: m.connectorType,
    alias: m.alias,
    displayName: m.displayName || m.alias,
  }));
}
