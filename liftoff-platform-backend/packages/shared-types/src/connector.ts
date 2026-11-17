/**
 * Canonical ConnectorFunction / LLMTool shape, mirrored from tenant-runtime's
 * src/connectors/types.ts. Platform-backend consumes this via the Phase 2
 * tool catalog endpoint; both sides must agree on the shape.
 *
 * Keep in lockstep with tenant-runtime. The Phase 0 type-drift CI fence
 * asserts neither side has a local duplicate of this type.
 */

/** Minimal JSON Schema shape used by connector function input schemas. */
export interface JsonSchemaObject {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
}

/** Tool category taxonomy used for HITL floor enforcement and gating. */
export type ToolCategory = 'read' | 'write' | 'destructive' | 'outbound' | 'sensitive';

export interface ConnectorFunction {
  /** Canonical, aliased tool name (e.g., "salesforce_prod__read_record") */
  name: string;
  description: string;
  inputSchema: JsonSchemaObject;
  categories: ToolCategory[];
  entityType?: string;
  draftVariant?: string;
}

/**
 * Shape of a tool as passed to an LLM completion request. Matches
 * tenant-runtime's LLMTool output of buildToolsSchema().
 *
 * Optional fields (categories, entityType, draftVariant, workRole +
 * pairs, workItemKind) are populated by tenant-runtime's tool-catalog
 * router (W1.4 work_inbox/ack plan) so platform-backend's distill can
 * see registry metadata without an extra round-trip. They are NOT sent
 * to the LLM completion request itself — the LLM only sees the
 * core { name, description, input_schema } triple.
 */
export interface LLMTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  categories?: string[];
  entityType?: string;
  draftVariant?: string;
  workRole?: 'inbox' | 'ack';
  paired_ack?: string;
  acknowledges?: string;
  workItemKind?: string;
  // C2/Composio cutover-completion: where the tool's definition came from
  // ('native' = hand-authored REST function, 'composio' = sourced from
  // @liftoffos/composio-overlays). Used by the runtime stable-name router
  // to pick the dispatch path. Pass-through on the HTTP /tool-catalog
  // response; distill widens its ToolCatalog to carry it.
  definitionSource?: 'native' | 'composio';
  vendorToolName?: string;
}

/** Response shape of GET /api/v1/tool-catalog/tenant/:tenantId/manifest/:manifestId/tools */
export interface ToolCatalogResponse {
  schemaVersion: 1;
  connectorType: string;
  alias: string;
  tools: LLMTool[];
}

/** Response shape of GET /api/v1/tool-catalog/tenant/:tenantId/manifests */
export interface ManifestSummary {
  manifestId: string;
  connectorType: string;
  alias: string;
  displayName: string;
}

export interface TenantManifestsResponse {
  schemaVersion: 1;
  manifests: ManifestSummary[];
}
