// Generic MCP types shared by every MCP consumer (external_agents,
// custom_mcp_servers, future consumers).
//
// Extracted from src/external-agents/types.ts to eliminate the "wrong
// coupling" the Phase 0 plan flagged. Anything tagged to a specific
// consumer (e.g., ExternalAgent, CollaborationMode) stays in that
// consumer's types file and re-exports MCP-generic shapes from here.

import type { SensitivityCategory } from './tool-classifier';

// ── Auth + transport ────────────────────────────────────────────────────

export type AuthType = 'none' | 'api_key' | 'bearer_token' | 'custom_headers';

export type TransportType = 'streamable-http' | 'sse';

export interface CustomHeader {
  key: string;
  value: string;
}

// ── Tool & resource definitions (wire shape) ──────────────────────────

// JSON Schema property shape used inside MCPToolDefinition.inputSchema.
// Recursive so that array `items`/`prefixItems` and nested object `properties`
// are expressible. The MCP 2026-07-28 spec loosened tool schemas to accept any
// JSON Schema 2020-12 keyword (`prefixItems`, `$defs`, `$ref`, composition
// keywords), so this type carries the full dialect through persistence
// unchanged — the `[key: string]: unknown` index signature admits any keyword
// a well-behaved server emits without stripping it on the way into the
// consumer's raw_mcp_tools JSONB column.
//
// Note: whether a schema is USABLE is a separate question from whether it is
// PERSISTABLE. The downstream LLM tool API (Anthropic rejects top-level
// oneOf/anyOf; Vertex rejects $ref/oneOf/patternProperties) is the real
// acceptance gate; the tool-validator classifies non-conforming tools as
// `degraded` (excluded from the LLM-facing set) rather than rejecting the
// whole server. See src/mcp/tool-validator.ts.
export interface JsonSchemaProperty {
  type?: string | string[];
  description?: string;
  items?: JsonSchemaProperty | JsonSchemaProperty[] | Record<string, never>;
  prefixItems?: JsonSchemaProperty[];
  properties?: Record<string, JsonSchemaProperty>;
  additionalProperties?: boolean | JsonSchemaProperty;
  patternProperties?: Record<string, JsonSchemaProperty>;
  enum?: (string | number | boolean | null)[];
  required?: string[];
  requiredFields?: string[];
  default?: unknown;
  anyOf?: JsonSchemaProperty[];
  oneOf?: JsonSchemaProperty[];
  allOf?: JsonSchemaProperty[];
  $ref?: string;
  $defs?: Record<string, JsonSchemaProperty>;
  $schema?: string;
  // Any other JSON Schema 2020-12 keyword passes through unchanged.
  [key: string]: unknown;
}

export interface MCPToolDefinition {
  name: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, JsonSchemaProperty>;
    required?: string[];
    $defs?: Record<string, JsonSchemaProperty>;
    $schema?: string;
    additionalProperties?: boolean | JsonSchemaProperty;
    // Carry any other 2020-12 keyword through persistence unchanged.
    [key: string]: unknown;
  };
  /** Discovery-pipeline annotation (NOT a wire field): set true when this
   *  tool's schema is not LLM-tool-API-acceptable. Persisted in raw_mcp_tools
   *  so the runtime (Tenant-Runtime) can exclude it from the LLM-facing tool
   *  set without re-running the validator. All tools are still persisted. */
  degraded?: boolean;
  degradeReasons?: string[];
}

export interface MCPResourceDefinition {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

// ── Distilled capability outputs (post-LLM analysis) ──────────────────

export interface DetectedCapability {
  id: string;
  name: string;
  description: string;
  rawToolName: string;
}

export interface DetectedResource {
  id: string;
  name: string;
  description: string;
  rawUri: string;
}

// ── Discovery pipeline I/O ────────────────────────────────────────────

export type DiscoverStage =
  | 'connected'
  | 'validating'
  | 'discovering'
  | 'analyzing'
  | 'classifying'
  | 'finalizing';

export interface DiscoverInput {
  endpointUrl: string;
  name: string;
  description?: string;
  authType: AuthType;
  apiKey?: string;
  bearerToken?: string;
  customHeaders?: CustomHeader[];
  tenantId?: string;
  agentId?: string;
  correlationId?: string;
}

/**
 * A prompt-injection finding on a discovered tool's free-text metadata
 * (description / name). This is a FLAG, not a validation violation: a hit does
 * NOT fail discovery, so a legitimate MCP server is never silently hard-dropped.
 * The discovery pipeline surfaces these as operator-visible flags on the result.
 */
export interface ToolDefinitionInjectionFinding {
  toolName: string;
  field: 'description' | 'name';
  /** Representative detector rule code (audit-safe). */
  code: string;
  score: number;
  /** PII-safe hash of the scanned text. */
  hash: string;
}

/**
 * A tool whose input schema the downstream LLM tool API cannot consume (e.g.
 * a top-level oneOf, or an array missing both `items` and `prefixItems`). This
 * is NOT a whole-server rejection: the tool is persisted like any other but
 * excluded from the LLM-facing set, and the reasons are surfaced to the
 * operator — mirroring the flag-not-reject stance of injection findings, so a
 * legitimate server is never hard-dropped over one odd tool.
 */
export interface DegradedTool {
  toolName: string;
  /** Human-readable reasons the tool is excluded from the LLM-facing set. */
  reasons: string[];
}

export interface DiscoverOutput {
  capabilities: DetectedCapability[];
  resources: DetectedResource[];
  toolClassifications: Record<string, SensitivityCategory[]>;
  /** 1b: what one call does, per tool, when the classifier answered
   *  confidently (`read | write | destructive | outbound`). A tool with no
   *  confident answer is absent. Persisted beside the categories and carried
   *  to the runtime, which appends it to the tool's categories as a DECLARED
   *  class. Absent on results from before the effect head existed. */
  toolEffectClasses?: Record<string, 'read' | 'write' | 'destructive' | 'outbound'>;
  /** The classification version (src/typesafe/questions.ts) that produced
   *  each tool's row: the current one for a Jev answer, the cached row's own
   *  for a reused row, absent for the generation and keyword paths so those
   *  rows are re-classified on the next discovery. */
  toolClassificationVersions?: Record<string, number>;
  rawMcpTools: MCPToolDefinition[];
  rawMcpResources: MCPResourceDefinition[];
  transportType: TransportType;
  summary: string;
  collaborationHints: string;
  correlationId?: string;
  /** Operator-visible injection flags on tool metadata. Populated only in
   *  `enforce` mode; empty/absent in shadow (audited only) and off. */
  injectionFindings?: ToolDefinitionInjectionFinding[];
  /** Tools excluded from the LLM-facing set because their schema is not
   *  LLM-tool-API-acceptable. Empty array = every discovered tool is usable.
   *  Never causes discovery to fail (no whole-server hard reject). */
  degradedTools: DegradedTool[];
}
