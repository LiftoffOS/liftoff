// Registry generation — the mechanical OpenAPI adapter.
//
// Everything in this file is deterministic: OpenAPI parameters and request
// bodies are already JSON Schema modulo dialect trivia, so converting them
// into ConnectorFunction input schemas is transcription, not judgment. The
// judgment stages (which platforms, which operations, what a description
// should say) live in the vendor configs and the normalizer — never here.

export interface OpenApiOperation {
  operationId?: string;
  method: string;
  path: string;
  summary: string;
  description: string;
  tags: string[];
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  outputSchema?: unknown;
  /** Vendor price annotation when the spec carries one (Strale's
   *  x-payment-info); USD per call. */
  priceUsd?: number;
}

interface OpenApiDoc {
  paths?: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, unknown> };
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);
const MAX_REF_DEPTH = 6;

/** Bounded $ref resolution against components.schemas. Cycles and over-deep
 *  chains degrade to an opaque object schema rather than recursing forever —
 *  a generated input schema must never be the thing that hangs a build. */
function resolveRefs(node: unknown, doc: OpenApiDoc, depth: number): unknown {
  if (depth > MAX_REF_DEPTH || node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((n) => resolveRefs(n, doc, depth + 1));
  const obj = node as Record<string, unknown>;
  const ref = obj.$ref;
  if (typeof ref === 'string') {
    const m = ref.match(/^#\/components\/schemas\/(.+)$/);
    const target = m ? doc.components?.schemas?.[m[1]] : undefined;
    if (!target) return { type: 'object' };
    return resolveRefs(target, doc, depth + 1);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = resolveRefs(v, doc, depth + 1);
  return out;
}

interface OpenApiParameter {
  name?: string;
  in?: string;
  required?: boolean;
  description?: string;
  schema?: unknown;
}

function inputSchemaFor(
  op: Record<string, unknown>,
  pathItem: Record<string, unknown>,
  doc: OpenApiDoc,
): OpenApiOperation['inputSchema'] {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  const params = [
    ...((pathItem.parameters as OpenApiParameter[] | undefined) ?? []),
    ...((op.parameters as OpenApiParameter[] | undefined) ?? []),
  ];
  for (const p of params) {
    if (!p?.name || (p.in !== 'query' && p.in !== 'path')) continue;
    const schema = (resolveRefs(p.schema ?? { type: 'string' }, doc, 0) ?? {}) as Record<string, unknown>;
    if (p.description && !schema.description) schema.description = p.description;
    properties[p.name] = schema;
    if (p.required) required.push(p.name);
  }

  const body = (op.requestBody as { content?: Record<string, { schema?: unknown }> } | undefined)
    ?.content?.['application/json']?.schema;
  if (body) {
    const resolved = resolveRefs(body, doc, 0) as Record<string, unknown>;
    if (resolved?.type === 'object' && resolved.properties && typeof resolved.properties === 'object') {
      Object.assign(properties, resolved.properties as Record<string, unknown>);
      for (const r of (resolved.required as string[] | undefined) ?? []) required.push(r);
    } else if (resolved) {
      properties.body = resolved;
      required.push('body');
    }
  }

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required: [...new Set(required)] } : {}),
  };
}

function priceOf(op: Record<string, unknown>): number | undefined {
  const info = op['x-payment-info'] as { price?: { amount?: string | number } } | undefined;
  const amount = info?.price?.amount;
  const n = typeof amount === 'string' ? Number(amount) : amount;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/** Flatten an OpenAPI document into operations. Pure transcription. */
export function extractOperations(doc: OpenApiDoc): OpenApiOperation[] {
  const out: OpenApiOperation[] = [];
  for (const [path, pathItem] of Object.entries(doc.paths ?? {})) {
    for (const [method, op] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method) || op === null || typeof op !== 'object') continue;
      const o = op as Record<string, unknown>;
      const okResponse = (o.responses as Record<string, { content?: Record<string, { schema?: unknown }> }> | undefined)?.['200'];
      out.push({
        operationId: typeof o.operationId === 'string' ? o.operationId : undefined,
        method,
        path,
        summary: typeof o.summary === 'string' ? o.summary : '',
        description: typeof o.description === 'string' ? o.description : '',
        tags: Array.isArray(o.tags) ? (o.tags as string[]) : [],
        inputSchema: inputSchemaFor(o, pathItem as Record<string, unknown>, doc),
        outputSchema: okResponse?.content?.['application/json']?.schema
          ? resolveRefs(okResponse.content['application/json'].schema, doc, 0)
          : undefined,
        priceUsd: priceOf(o),
      });
    }
  }
  return out;
}
