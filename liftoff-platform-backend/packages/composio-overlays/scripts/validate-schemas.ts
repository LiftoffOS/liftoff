/**
 * validate-schemas — static gate mirroring tenant-runtime's cold-start
 * registry-validator (src/connectors/registry-validator.ts) over every
 * Composio tool inputSchema this package ships.
 *
 * Why:    tenant-runtime's tool-gateway refuses to boot if ANY tool schema
 *         is malformed for the LLM provider's tool API. When a schema copied
 *         verbatim from Composio's API is invalid (a Python-flavored regex
 *         `pattern` that won't compile under JS's `u` flag, a `nullable`
 *         property with no `type`, a `type: array` with no `items`), the new
 *         revision fails its health check and the deploy is dead. This gate
 *         catches all three classes at publish time, before the package ships.
 *
 * Two layers, identical to the runtime validator:
 *   1. Custom walker — every `type: 'array'` must have `items` (OpenAI rejects
 *      bare arrays; ajv is spec-compliant and does NOT catch this).
 *   2. ajv.compile() (strict:false, allErrors, validateFormats:false) — the
 *      same config the runtime uses. Catches bad `pattern` regexes, `nullable`
 *      without `type`, invalid `type` values, malformed enums, etc.
 *
 * Deterministic and offline (no Composio API, no secret) → a HARD gate.
 * Exit 1 on any violation.
 */

import Ajv, { type ErrorObject } from 'ajv';
import { COMPOSIO_TOOL_SCHEMAS } from '../src/schemas';

const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });

interface JsonSchemaNode {
  type?: string | string[];
  items?: unknown;
  properties?: Record<string, JsonSchemaNode>;
  [key: string]: unknown;
}

function findArraysMissingItems(schema: JsonSchemaNode | undefined, path: string, out: string[]): void {
  if (!schema || typeof schema !== 'object') return;
  if (schema.type === 'array' && schema.items === undefined) {
    out.push(`${path}: type:array missing items`);
  }
  if (schema.items && typeof schema.items === 'object') {
    findArraysMissingItems(schema.items as JsonSchemaNode, `${path}.items`, out);
  }
  if (schema.properties && typeof schema.properties === 'object') {
    for (const [key, child] of Object.entries(schema.properties)) {
      findArraysMissingItems(child, `${path}.${key}`, out);
    }
  }
}

function validateSchema(schema: unknown): string[] {
  const errors: string[] = [];
  findArraysMissingItems(schema as JsonSchemaNode, 'inputSchema', errors);
  try {
    ajv.compile(schema as object);
  } catch (error) {
    const err = error as Error & { errors?: ErrorObject[] };
    if (err.errors && Array.isArray(err.errors) && err.errors.length > 0) {
      for (const e of err.errors) errors.push(`${e.instancePath || '(root)'}: ${e.message ?? 'unknown ajv error'}`);
    } else {
      errors.push(err.message || String(error));
    }
  }
  return errors;
}

function main(): void {
  let total = 0;
  const toolkits = Object.keys(COMPOSIO_TOOL_SCHEMAS).length;
  for (const [toolkit, schemas] of Object.entries(COMPOSIO_TOOL_SCHEMAS)) {
    for (const tool of schemas) {
      for (const err of validateSchema(tool.inputSchema)) {
        total += 1;
        console.error(`  ${toolkit}/${tool.slug}  ::  ${err}`);
      }
    }
  }
  if (total > 0) {
    console.error(
      `\nFAIL: ${total} malformed tool schema(s) across ${toolkits} toolkits. ` +
        `tenant-runtime's cold-start validator would refuse to boot. Fix the schemas ` +
        `(or re-run scaffold:connector, which sanitizes these classes) before publishing.`
    );
    process.exit(1);
  }
  console.error(`OK: all tool schemas across ${toolkits} toolkits are LLM-tool-API valid.`);
}

main();
