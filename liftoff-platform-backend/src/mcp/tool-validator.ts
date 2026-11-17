// MCP tool schema validator.
//
// Validates the tools an MCP server returns from `tools/list` BEFORE we
// persist them into external_agents.raw_mcp_tools. The bug class we're
// closing is symmetric to the connector-functions-registry bug on the
// tenant runtime side:
//
//   - The previous MCPToolDefinition type silently stripped `items`,
//     `properties`, and other recursive structure from any property
//     declaration, so even a correctly-built MCP server would have its
//     schema corrupted on the way into the database.
//   - Even with the type fixed, an MCP server returning a malformed
//     schema (e.g., `type: 'array'` without `items`) would have the
//     malformed schema persisted as-is, then later fail at LLM call
//     time with "Invalid schema ... array schema missing items".
//
// The fix is to validate the tools/list response at discovery time, BEFORE
// anything is persisted. If a server returns invalid schemas, the
// discovery fails loudly with the field path so the tenant can fix their
// server. Nothing bad reaches the database.
//
// Validation strategy: TWO LAYERS, same as the tenant runtime validator.
//
//   1. Custom recursive walker that enforces OpenAI's stricter-than-spec
//      rules. Specifically: every `type: 'array'` MUST have `items`.
//      ajv alone does NOT catch this — JSON Schema considers `items`
//      optional, but OpenAI's tool API rejects bare arrays.
//
//   2. ajv compile() as a sanity check for general JSON Schema validity:
//      invalid `type` values, malformed `enum`, broken `required` arrays,
//      etc. Configured non-strict to match OpenAI's actual acceptance.
//
// See:
//   - src/external-agents/types.ts JsonSchemaProperty (the type that
//     ought to be returned from a well-behaved MCP server)
//   - src/external-agents/mcp-client.ts MCPClient.discover() (call site)
//   - src/external-agents/__tests__/mcp-tool-validator.test.ts (this
//     module's unit test)

import Ajv2020 from 'ajv/dist/2020';
import type { ErrorObject } from 'ajv';
import { scanToolDefinition } from '@liftoffos/injection-detector';
import type { MCPToolDefinition, ToolDefinitionInjectionFinding, DegradedTool } from './types';

// JSON Schema 2020-12 validator. The MCP 2026-07-28 spec loosened tool schemas
// to accept any 2020-12 keyword (`prefixItems`, `$defs`, `$ref`, composition
// keywords). Ajv's default export is draft-07 and THROWS on a 2020-12
// meta-schema / `prefixItems`, which used to reject spec-compliant servers
// wholesale; the 2020 build compiles them instead. strict:false matches the
// LLM tool APIs' actual (lenient) acceptance.
const ajv = new Ajv2020({
  strict: false,
  allErrors: true,
  validateFormats: false,
});

interface JsonSchemaNode {
  type?: string | string[];
  items?: JsonSchemaNode | JsonSchemaNode[] | Record<string, never>;
  prefixItems?: JsonSchemaNode[];
  properties?: Record<string, JsonSchemaNode>;
  enum?: unknown[];
  anyOf?: unknown[];
  oneOf?: unknown[];
  allOf?: unknown[];
  [key: string]: unknown;
}

export interface McpToolValidationViolation {
  toolName: string;
  /** Dotted path to the offending field, e.g., "inputSchema.properties.sheets". */
  path: string;
  /** Human-readable error description. */
  error: string;
}

/**
 * Recursively walk a JSON Schema and collect every path where
 * `type: 'array'` is missing `items`. The OpenAI-specific rule.
 */
function findArraysMissingItems(
  schema: JsonSchemaNode | undefined,
  path: string,
  violations: { path: string; error: string }[]
): void {
  if (!schema || typeof schema !== 'object') return;

  // JSON Schema 2020-12 tuple validation uses `prefixItems` instead of `items`,
  // so an array with `prefixItems` is well-formed even without `items`.
  if (schema.type === 'array' && schema.items === undefined && schema.prefixItems === undefined) {
    violations.push({ path, error: 'type:array missing items (and no prefixItems)' });
  }

  // `items` is a single subschema (2020-12) — walk it. A draft-07 tuple `items`
  // array is walked via the prefixItems-style branch below instead.
  if (schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
    findArraysMissingItems(
      schema.items as JsonSchemaNode,
      `${path}.items`,
      violations
    );
  }

  const tupleItems = Array.isArray(schema.items)
    ? (schema.items as JsonSchemaNode[])
    : Array.isArray(schema.prefixItems)
      ? schema.prefixItems
      : null;
  if (tupleItems) {
    tupleItems.forEach((child, i) =>
      findArraysMissingItems(child, `${path}.prefixItems[${i}]`, violations)
    );
  }

  if (schema.properties && typeof schema.properties === 'object') {
    for (const [key, child] of Object.entries(schema.properties)) {
      findArraysMissingItems(
        child as JsonSchemaNode,
        `${path}.${key}`,
        violations
      );
    }
  }
}

/**
 * Validate a single MCPToolDefinition. Returns the list of violations
 * (empty list = valid).
 */
function validateOneTool(tool: MCPToolDefinition): McpToolValidationViolation[] {
  const violations: McpToolValidationViolation[] = [];

  if (!tool.name || typeof tool.name !== 'string') {
    violations.push({
      toolName: tool.name || '(missing name)',
      path: 'name',
      error: 'tool name is missing or not a string',
    });
    return violations;
  }

  if (!tool.inputSchema) {
    violations.push({
      toolName: tool.name,
      path: 'inputSchema',
      error: 'inputSchema is missing',
    });
    return violations;
  }

  // Layer 1: custom OpenAI-strict walker for type:array missing items
  const layer1: { path: string; error: string }[] = [];
  findArraysMissingItems(
    tool.inputSchema as unknown as JsonSchemaNode,
    'inputSchema',
    layer1
  );
  for (const v of layer1) {
    violations.push({ toolName: tool.name, path: v.path, error: v.error });
  }

  // Layer 1b: the Anthropic tool API rejects oneOf/allOf/anyOf at the
  // inputSchema TOP LEVEL (documented live break in src/mcp-server/types.ts).
  // MCP 2020-12 permits these, but the downstream LLM does not — so a tool that
  // uses them is DEGRADED (excluded from the LLM-facing set), not a reason to
  // reject the whole server.
  const rootSchema = tool.inputSchema as unknown as JsonSchemaNode;
  for (const kw of ['oneOf', 'allOf', 'anyOf'] as const) {
    if (Array.isArray(rootSchema[kw])) {
      violations.push({
        toolName: tool.name,
        path: `inputSchema.${kw}`,
        error: `top-level ${kw} is not accepted by the LLM tool API`,
      });
    }
  }

  // Layer 2: ajv as a sanity check for general JSON Schema validity
  try {
    ajv.compile(tool.inputSchema as object);
  } catch (error) {
    const err = error as Error & { errors?: ErrorObject[] };
    if (err.errors && Array.isArray(err.errors) && err.errors.length > 0) {
      for (const e of err.errors) {
        violations.push({
          toolName: tool.name,
          path: `inputSchema${e.instancePath || ''}`,
          error: e.message ?? 'unknown ajv error',
        });
      }
    } else {
      violations.push({
        toolName: tool.name,
        path: 'inputSchema',
        error: err.message || String(error),
      });
    }
  }

  return violations;
}

/**
 * Validate the entire `tools` array returned by an MCP server's
 * `tools/list` response. Returns a flat list of violations across all
 * tools (empty = every tool is LLM-tool-API-acceptable).
 *
 * NOTE: since the MCP 2026-07-28 compat work, violations no longer reject the
 * whole server — `classifyMcpTools` uses this to split tools into usable vs
 * degraded. This function is retained for callers/tests that want the raw
 * violation list.
 */
export function validateMcpTools(
  tools: MCPToolDefinition[]
): McpToolValidationViolation[] {
  const violations: McpToolValidationViolation[] = [];
  for (const tool of tools) {
    violations.push(...validateOneTool(tool));
  }
  return violations;
}

/**
 * Partition a `tools/list` response into the tools that are safe to hand to the
 * LLM tool API (`usableTools`) and the tools whose schema the LLM cannot
 * consume (`degradedTools`, each carrying the human-readable reasons). This is
 * the no-hard-reject entry point: a server with one odd tool still onboards
 * every other tool, and NOTHING here throws. A tool with zero violations is
 * usable; a tool with ≥1 violation is degraded and excluded from the LLM set.
 */
export function classifyMcpTools(
  tools: MCPToolDefinition[]
): { usableTools: MCPToolDefinition[]; degradedTools: DegradedTool[] } {
  const usableTools: MCPToolDefinition[] = [];
  const degradedTools: DegradedTool[] = [];
  for (const tool of tools) {
    const violations = validateOneTool(tool);
    if (violations.length === 0) {
      usableTools.push(tool);
    } else {
      degradedTools.push({
        toolName: tool.name || '(missing name)',
        reasons: violations.map((v) => `${v.path}: ${v.error}`),
      });
    }
  }
  return { usableTools, degradedTools };
}

/**
 * Build a human-readable summary string for thrown errors. Used by the
 * caller in MCPClient.discover() to construct the user-facing error
 * message that appears in the SSE error event during discovery.
 */
export function formatViolations(violations: McpToolValidationViolation[]): string {
  return violations
    .map((v) => `  - ${v.toolName} at ${v.path}: ${v.error}`)
    .join('\n');
}

/**
 * Scan each tool's free-text metadata (description, name) for prompt injection.
 *
 * Returns FLAGS, never schema violations: unlike `validateMcpTools` (whose
 * violations cause `MCPClient.discover` to THROW and reject the whole server),
 * a hit here does NOT fail discovery. A malicious customer-hosted or long-tail
 * MCP server can smuggle instructions into an agent's tool catalog via tool
 * metadata; the discovery pipeline surfaces these findings as operator-visible
 * flags (gated + shadow-first) so a legitimate server is never silently
 * hard-dropped on a false positive.
 */
export function scanToolDefinitionsForInjection(
  tools: MCPToolDefinition[],
): ToolDefinitionInjectionFinding[] {
  const findings: ToolDefinitionInjectionFinding[] = [];
  for (const tool of tools) {
    const fields: Array<['description' | 'name', string | undefined]> = [
      ['description', tool.description],
      ['name', tool.name],
    ];
    for (const [field, text] of fields) {
      if (typeof text !== 'string' || text.length === 0) continue;
      const hit = scanToolDefinition(field, text);
      if (hit) {
        findings.push({
          toolName: tool.name,
          field,
          code: hit.code,
          score: hit.score,
          hash: hit.hash,
        });
      }
    }
  }
  return findings;
}

/**
 * Special error class so MCPClient.discover() callers can distinguish
 * "MCP server returned invalid schema" from "MCP server is unreachable"
 * vs "MCP server speaks the wrong protocol". The discover-service.ts
 * error mapper uses the class to render a helpful UI message.
 */
export class McpToolSchemaValidationError extends Error {
  public readonly violations: McpToolValidationViolation[];

  constructor(violations: McpToolValidationViolation[]) {
    const summary = formatViolations(violations);
    super(
      `MCP server returned ${violations.length} invalid tool schema(s):\n${summary}\n\n` +
        `Each tool's input_schema must be a valid JSON Schema. In particular, ` +
        `every property declared as type:'array' MUST also declare an 'items' field. ` +
        `Fix the MCP server's tools/list response and retry discovery.`
    );
    this.name = 'McpToolSchemaValidationError';
    this.violations = violations;
  }
}
