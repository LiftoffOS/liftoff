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
 */
export interface LLMTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
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
