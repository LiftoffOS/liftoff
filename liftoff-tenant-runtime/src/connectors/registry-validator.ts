// Registry validator — startup-time JSON Schema validation for every tool
// schema the runtime will ever expose to the LLM.
//
// Why this exists
// ────────────────
// The runtime exposes three sources of tool schemas to the LLM provider:
//   1. Built-in connector functions from CONNECTOR_FUNCTION_REGISTRY
//      (Google Sheets, Slack, etc. — schemas live in source code)
//   2. STANDARD_TOOLS (memory_search, send_notification, etc.)
//   3. RESEARCH_TOOLS (research findings, analysis, etc.)
//
// All three are static — they ship with the runtime image and never change
// without a deploy. The bug class we're closing is "a developer adds a
// schema that's syntactically valid TypeScript but semantically invalid
// for the LLM provider's tool API, the bad schema reaches production, and
// an LLM call fails at runtime with a 400 error that's hard to attribute
// back to the source."
//
// This module is the runtime equivalent of the
// function-schema-validation.test.ts unit test. The test catches it in CI
// (preferred path), this module catches it on cold-start in production
// (last-line defense). When this module throws, Cloud Run's deployment
// health check fails, the new revision is marked unhealthy, and Cloud Run
// keeps serving the previous good revision automatically. The bad code
// literally cannot reach customer requests.
//
// Validation strategy: TWO LAYERS
// ───────────────────────────────
// 1. Custom recursive walker that enforces OpenAI's stricter-than-spec
//    rules. Specifically: every `type: 'array'` MUST have `items`. The
//    JSON Schema spec considers `items` optional (a bare array means
//    "array of any"), but OpenAI's tool API rejects bare arrays at
//    request time with "Invalid schema ... array schema missing items".
//    This is the most common failure of this kind, and ajv alone does NOT catch
//    it because ajv is spec-compliant.
//
// 2. ajv compile() as a sanity check. Catches things the custom walker
//    doesn't: invalid `type` values, malformed `enum` shapes, broken
//    nested $ref, and other genuine JSON Schema violations. Configured
//    in non-strict mode to match what OpenAI's tool API actually accepts
//    (e.g., type:'object' without 'properties' is allowed).
//
// What gets caught
// ────────────────
//   ✓ `type: 'array'` without `items`           ← original bug, custom walker
//   ✓ Nested `type: 'array'` without `items`    ← custom walker, recursive
//   ✓ Invalid `type` values                     ← ajv
//   ✓ Malformed `enum` (not an array, etc.)    ← ajv
//   ✓ Malformed `properties` shape              ← ajv
//
// What does NOT get caught (out of scope for this validator)
// ──────────────────────────────────────────────────────────
//   ✗ Schema is valid but parameter name is wrong
//     (e.g., `id` when client expects `query`)
//   ✗ The vendor changed their API and our schema is now stale
//   ✗ A connector function exists in the registry but the corresponding
//     client.ts implementation is missing
// These are different bug classes with different solutions (integration
// tests, runtime error-rate alerting, code review).

import Ajv, { type ErrorObject } from 'ajv';
import { logger } from '../infrastructure/logging';
import {
  getToolSchemas as getConnectorFunctions,
  listConnectorTypes as getRegisteredConnectorTypes,
} from './tool-schema-cache';
import { STANDARD_TOOLS } from '../tools/standard-tools';
import { RESEARCH_TOOLS } from '../tools/research-tools';

// Single shared ajv instance configured to match what OpenAI's tool API
// will actually accept at runtime, NOT the strictest possible spec
// interpretation. See module comment for the reasoning.
const ajv = new Ajv({
  strict: false,
  allErrors: true,
  validateFormats: false,
});

export interface RegistryValidationViolation {
  source: 'connector' | 'standard-tool' | 'research-tool';
  /** Connector type for connector tools, undefined for standard/research tools. */
  connectorType?: string;
  toolName: string;
  /** Human-readable error with the field path included. */
  error: string;
}

interface JsonSchemaNode {
  type?: string | string[];
  items?: JsonSchemaNode | Record<string, never>;
  properties?: Record<string, JsonSchemaNode>;
  enum?: unknown[];
  [key: string]: unknown;
}

/**
 * Recursively walk a JSON Schema and collect every path where
 * `type: 'array'` is missing `items`. This is the OpenAI-specific rule
 * the bug originated from. Returns a list of dotted paths, one per
 * violation, e.g. `inputSchema.properties.sheets`.
 *
 * Walks `properties.<key>` and `items` (which itself can contain nested
 * arrays/objects). Stops at primitive leaves.
 */
function findArraysMissingItems(
  schema: JsonSchemaNode | undefined,
  path: string,
  violations: string[]
): void {
  if (!schema || typeof schema !== 'object') return;

  if (schema.type === 'array' && schema.items === undefined) {
    violations.push(`${path}: type:array missing items`);
  }

  // Recurse into items (it itself can be an object/array schema)
  if (schema.items && typeof schema.items === 'object') {
    findArraysMissingItems(schema.items as JsonSchemaNode, `${path}.items`, violations);
  }

  // Recurse into properties
  if (schema.properties && typeof schema.properties === 'object') {
    for (const [key, child] of Object.entries(schema.properties)) {
      findArraysMissingItems(child as JsonSchemaNode, `${path}.${key}`, violations);
    }
  }
}

/**
 * Validate a single tool schema against both layers (custom walker + ajv).
 * Returns the list of error strings (empty list = valid).
 */
function validateSchema(schema: unknown): string[] {
  const errors: string[] = [];

  // Layer 1: custom OpenAI-strict walker — catches `type: array` without items
  findArraysMissingItems(schema as JsonSchemaNode, 'inputSchema', errors);

  // Layer 2: ajv compile as sanity check for general JSON Schema validity
  try {
    ajv.compile(schema as object);
  } catch (error) {
    const err = error as Error & { errors?: ErrorObject[] };
    if (err.errors && Array.isArray(err.errors) && err.errors.length > 0) {
      for (const e of err.errors) {
        errors.push(`${e.instancePath || '(root)'}: ${e.message ?? 'unknown ajv error'}`);
      }
    } else {
      errors.push(err.message || String(error));
    }
  }

  return errors;
}

/**
 * Walk every tool schema the runtime might ever expose to the LLM and
 * validate each one. Returns the list of violations rather than throwing
 * so callers can decide what to do with the result. The default startup
 * caller (validateRegistryAtStartupOrThrow) treats any violation as fatal.
 */
export function findRegistryViolations(): RegistryValidationViolation[] {
  const violations: RegistryValidationViolation[] = [];

  // Connector functions — every type, every function
  for (const connectorType of getRegisteredConnectorTypes()) {
    for (const fn of getConnectorFunctions(connectorType)) {
      for (const error of validateSchema(fn.inputSchema)) {
        violations.push({
          source: 'connector',
          connectorType,
          toolName: fn.name,
          error,
        });
      }
    }
  }

  // Standard tools (memory_search, send_notification, etc.)
  for (const tool of STANDARD_TOOLS) {
    for (const error of validateSchema(tool.input_schema)) {
      violations.push({
        source: 'standard-tool',
        toolName: tool.name,
        error,
      });
    }
  }

  // Research tools
  for (const tool of RESEARCH_TOOLS) {
    for (const error of validateSchema(tool.input_schema)) {
      violations.push({
        source: 'research-tool',
        toolName: tool.name,
        error,
      });
    }
  }

  return violations;
}

/**
 * Startup gate. Called from src/index.ts before the HTTP server starts
 * accepting traffic. Throws if any tool schema is invalid; the throw
 * propagates to the top-level start().catch() which logs and exits with
 * a non-zero status. Cloud Run treats the exit as a startup failure and
 * keeps the previous revision serving traffic.
 *
 * On success, logs an info line with the count of validated tools so the
 * audit trail shows the validator ran on every cold start.
 */
export function validateRegistryAtStartupOrThrow(): void {
  const violations = findRegistryViolations();

  if (violations.length === 0) {
    const connectorToolCount = getRegisteredConnectorTypes()
      .map((t) => getConnectorFunctions(t).length)
      .reduce((a, b) => a + b, 0);
    logger.info('Tool schema registry validated', {
      connector_types: getRegisteredConnectorTypes().length,
      connector_tools: connectorToolCount,
      standard_tools: STANDARD_TOOLS.length,
      research_tools: RESEARCH_TOOLS.length,
    });
    return;
  }

  // Aggregate all violations into one structured log line so the operator
  // can fix them all in one pass instead of redeploy-fail-redeploy-fail.
  logger.error('Tool schema registry validation FAILED — refusing to start', {
    violation_count: violations.length,
    violations: violations.map((v) => ({
      source: v.source,
      ...(v.connectorType ? { connector_type: v.connectorType } : {}),
      tool: v.toolName,
      error: v.error,
    })),
  });

  // Build a human-readable summary for the thrown error so it shows up
  // clearly in Cloud Run startup logs and any error tracking the operator
  // is using.
  const summary = violations
    .map((v) => {
      const prefix = v.connectorType ? `${v.source}/${v.connectorType}` : v.source;
      return `  - ${prefix}.${v.toolName}: ${v.error}`;
    })
    .join('\n');

  throw new Error(
    `Tool schema registry validation failed with ${violations.length} violation(s):\n${summary}\n\n` +
      `Cold-start validator refuses to start with malformed tool schemas. ` +
      `Fix the schemas in the connector-service (ListTools output) ` +
      `(or src/tools/*.ts for standard/research tools) and redeploy. ` +
      `See src/connectors/registry-validator.ts for what gets validated and why.`
  );
}
