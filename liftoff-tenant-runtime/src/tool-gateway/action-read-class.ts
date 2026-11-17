// Resolve the DECLARED read classification of a connector action for the
// governance Authorize decision.
//
// The governance-engine Authorize RPC has no tool definitions, so it infers
// read-vs-write from the action NAME — which gates reviewed reads whose verb it
// does not recognise (pdl `enrich_company`, hunter `email_finder`). This resolves
// the reviewed classification the runtime already holds on its catalog and hands
// it to the engine as `action_read_class`.
//
// It trusts ONLY a catalog-DECLARED classification. An inferred or unknown one
// returns UNSPECIFIED so the engine keeps its own fail-closed name heuristic: the
// catalog's inferred read defaults an unknown verb to read (connector-service's
// deriveCategories), and that guess must never loosen the gate. Write/outbound/
// destructive/sensitive signals win over a read via toolIsReadOnly.

import { ActionReadClass } from '@liftoffos/proto-gen/dist/liftoff/governance/v1/governance_service_pb';
import { getToolSchemas, catalogTypeFor, getCustomMcpToolSchema, CUSTOM_MCP_CATALOG_TYPE, getCustomApiToolSchema, CUSTOM_API_CONNECTOR_TYPE } from '../connectors/tool-schema-cache';
import { toolIsReadOnly } from './tool-effect';

/** The catalog function carries `classificationDeclared` (set by the schema-cache
 *  mapper from connector-service's ClassificationSource, or by the custom-MCP
 *  mapper from the control plane's 1b effect class) alongside `categories`. */
type ClassifiedFunction = { categories?: string[]; classificationDeclared?: boolean };

/**
 * `connector` may be an instance alias (`pdl-1a2b3c4d`); it is normalised to
 * its catalog type before the lookup. When the alias names no registry
 * connector — a customer's own MCP server (`custom-mcp-<8 hex>`) — the lookup
 * is the tenant-scoped custom-MCP cache, keyed by server id, because the
 * alias carries only an eight-character id prefix that can collide across
 * tenants (1b). A custom API connection is the same shape for the same reason:
 * `custom_api_connector` is ONE catalog type whose operations come from one
 * workspace's own specification, so the type-keyed map holds nothing under it
 * and every operation would resolve UNSPECIFIED — with the merged
 * classification that would have judged it sitting one map over. Unknown tool /
 * unbuilt cache ⇒ UNSPECIFIED.
 */
export function resolveActionReadClass(tenantId: string, connector: string, actionType: string): ActionReadClass {
  const catalogType = catalogTypeFor(connector);
  const fn = (catalogType === CUSTOM_MCP_CATALOG_TYPE
    ? getCustomMcpToolSchema(tenantId, connector, actionType)
    : catalogType === CUSTOM_API_CONNECTOR_TYPE
      ? getCustomApiToolSchema(tenantId, connector, actionType)
      : getToolSchemas(catalogType).find((f) => f.name === actionType)) as ClassifiedFunction | null | undefined;
  if (!fn?.classificationDeclared) return ActionReadClass.UNSPECIFIED;
  return toolIsReadOnly({ categories: fn.categories })
    ? ActionReadClass.DECLARED_READ
    : ActionReadClass.DECLARED_NON_READ;
}
