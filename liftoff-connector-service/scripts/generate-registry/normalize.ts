// Registry generation — deterministic normalization.
//
// Turns raw OpenAPI operations into ConnectorFunction entries: snake_case
// name, one-line EN description, read/write categories from the HTTP method.
// This stage is pluggable by design: an LLM pass can later rewrite the
// descriptions in registry voice and refine category tags, but its absence
// must never block generation — the deterministic output below is correct,
// just plainer. Hand-fixes belong in overrides.ts, NEVER in generated files.

import type { OpenApiOperation } from './openapi-adapter';

/** The registry's JsonSchemaProperty dialect is deliberately narrow: type,
 *  description, items, properties, enum, requiredFields — nothing else. Raw
 *  OpenAPI schemas carry format/minimum/anyOf/… which the dialect rejects, so
 *  every generated property is projected down to the allowed fields. Numeric
 *  bounds and formats are folded into the description rather than lost. */
export function sanitizeProperty(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { type: 'string' };
  }
  const src = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  let type = src.type;
  if (Array.isArray(type)) type = type.filter((t) => t !== 'null')[0] ?? 'string';
  if (typeof type !== 'string') {
    // anyOf/oneOf and typeless schemas degrade to string with a hint.
    type = src.properties ? 'object' : src.items ? 'array' : 'string';
  }
  out.type = type;

  const extras: string[] = [];
  if (typeof src.format === 'string') extras.push(`format ${src.format}`);
  if (typeof src.minimum === 'number') extras.push(`minimum ${src.minimum}`);
  if (typeof src.maximum === 'number') extras.push(`maximum ${src.maximum}`);
  if (typeof src.default !== 'undefined') extras.push(`default ${JSON.stringify(src.default)}`);
  const desc = [
    typeof src.description === 'string' ? src.description : '',
    extras.length > 0 ? `(${extras.join(', ')})` : '',
  ]
    .filter(Boolean)
    .join(' ')
    .slice(0, 300);
  if (desc) out.description = desc;

  if (Array.isArray(src.enum)) {
    out.enum = src.enum.filter(
      (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v),
    );
  }
  if (type === 'array') {
    out.items = src.items ? sanitizeProperty(src.items) : {};
  }
  if (type === 'object' && src.properties && typeof src.properties === 'object') {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src.properties as Record<string, unknown>)) {
      props[k] = sanitizeProperty(v);
    }
    out.properties = props;
    if (Array.isArray(src.required)) out.requiredFields = src.required;
  }
  return out;
}

export interface GeneratedFunction {
  name: string;
  description: string;
  inputSchema: OpenApiOperation['inputSchema'];
  categories: ('read' | 'write' | 'destructive' | 'outbound' | 'sensitive')[];
}

/** EN half of a bilingual "中文 / English" summary; the whole string when it
 *  is not bilingual. */
export function englishHalf(text: string): string {
  const hasCjk = /[一-鿿]/.test(text);
  if (!hasCjk) return text.trim();
  const parts = text.split('/');
  for (let i = parts.length - 1; i >= 0; i--) {
    const candidate = parts.slice(i).join('/').trim();
    if (candidate && !/[一-鿿]/.test(candidate)) return candidate;
  }
  return text.replace(/[一-鿿]/g, '').replace(/\s+/g, ' ').trim();
}

export function snakeCase(s: string): string {
  return s
    .replace(/[{}]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_')
    .toLowerCase();
}

export interface NormalizeOptions {
  /** Prefix every function name (e.g. the platform segment for tikhub). */
  namePrefix?: string;
  /** Derive the name from the LAST N path segments when no operationId is
   *  used. */
  nameFromPathSegments?: number;
  /** Ignore operationId even when present — FastAPI's defaults echo the whole
   *  path and make unusable names. */
  ignoreOperationId?: boolean;
  /** Drop this many leading path segments before joining the rest into the
   *  name (e.g. 3 drops api/v1/<platform>; family + version segments that
   *  remain disambiguate same-named operations across API families). */
  dropLeadingSegments?: number;
  /** Append the vendor's own per-call price to the description when known —
   *  the model choosing between tools deserves to see the cost. */
  includePrice?: boolean;
}

export function normalizeOperation(
  op: OpenApiOperation,
  opts: NormalizeOptions = {},
): GeneratedFunction {
  const segments = op.path.split('/').filter(Boolean);
  const fromPath = (
    opts.dropLeadingSegments != null
      ? segments.slice(opts.dropLeadingSegments)
      : segments.slice(-(opts.nameFromPathSegments ?? 2))
  )
    .map(snakeCase)
    .filter(Boolean)
    .join('_');
  const base =
    op.operationId && !opts.ignoreOperationId ? snakeCase(op.operationId) : fromPath;
  const name = [opts.namePrefix, base].filter(Boolean).join('_').slice(0, 80);

  let description =
    englishHalf(op.summary) || englishHalf(op.description).split('.')[0] || name;
  description = description.replace(/\s+/g, ' ').trim().slice(0, 300);
  if (opts.includePrice && typeof op.priceUsd === 'number') {
    description = `${description} (about $${op.priceUsd} per call)`;
  }

  // Method is the honest default for side-effect classification: a GET
  // retrieves, everything else changes remote state. Vendor configs and the
  // overrides file escalate specific operations (outbound, destructive,
  // sensitive) where the method alone under-states the blast radius.
  const categories: GeneratedFunction['categories'] =
    op.method === 'get' ? ['read'] : ['write'];

  const properties: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(op.inputSchema.properties)) {
    properties[k] = sanitizeProperty(v);
  }
  const inputSchema = {
    type: 'object' as const,
    properties,
    ...(op.inputSchema.required ? { required: op.inputSchema.required } : {}),
  };

  return { name, description, inputSchema, categories };
}
