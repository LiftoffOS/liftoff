// Derive a strict, ajv-free request contract per operation directly from a vendor's committed
// spec (OpenAPI JSON/YAML), and validate a client's reconstructed HTTP request against it.
// Reuses the existing spec loader in the codegen test support — no new spec parser.
import { loadSpec, specPath } from '../../catalog/__tests__/support/regen.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface OpContract {
  method: string;
  pathTemplate: string;          // "/companies/{company_id}/employees"
  pathParams: string[];          // {..} in the path
  requiredQuery: string[];       // in=query & required
  bodyRequired: string[];        // requestBody json schema top-level required
}

// Resolve a #/components/... or #/definitions/... $ref one hop.
function deref(node: any, root: any): any {
  const ref = node?.$ref;
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return node;
  return ref.split('/').slice(1).reduce((o: any, k: string) => (o ? o[k] : undefined), root) ?? node;
}

/** One OpContract per generated tool, keyed by entityType "METHOD /path". */
export function contractsFor(specRel: string, stripPrefix?: string, pathPrefix?: string): Map<string, OpContract> {
  const spec = loadSpec(specPath(specRel));
  const out = new Map<string, OpContract>();
  for (const [rawPath, itemRaw] of Object.entries<any>((spec as any).paths ?? {})) {
    const item = deref(itemRaw, spec);
    const stripped = stripPrefix && rawPath.startsWith(stripPrefix) ? (rawPath.slice(stripPrefix.length) || '/') : rawPath;
    const path = (pathPrefix ?? '') + stripped;
    const pathParams = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
    for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head']) {
      const op = item?.[method];
      if (!op) continue;
      const M = method.toUpperCase();
      const params = (op.parameters ?? []).map((p: any) => deref(p, spec));
      const queryParams = params.filter((p: any) => p?.in === 'query');
      const rb = deref(op.requestBody, spec);
      const bodySchema = deref(rb?.content?.['application/json']?.schema ?? rb?.content?.['application/xml']?.schema, spec);
      out.set(`${M} ${path}`, {
        method: M,
        pathTemplate: path,
        pathParams,
        requiredQuery: queryParams.filter((p: any) => p.required).map((p: any) => p.name),
        bodyRequired: Array.isArray(bodySchema?.required) ? bodySchema.required : [],
      });
    }
  }
  return out;
}

export interface ReconstructedRequest { method: string; path: string; query: Record<string, string>; body?: Record<string, unknown> }

/** [] on success; else a list of concrete violations. */
export function validateRequest(c: OpContract, req: ReconstructedRequest): string[] {
  const v: string[] = [];
  if (req.method !== c.method) v.push(`method ${req.method} != spec ${c.method}`);
  if (/\{[^}]+\}/.test(req.path)) v.push(`unsubstituted path param in "${req.path}"`);
  const rx = '^' + c.pathTemplate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{[^}]+\\\}/g, '[^/]+') + '$';
  if (!new RegExp(rx).test(req.path)) v.push(`path "${req.path}" does not match template "${c.pathTemplate}"`);
  for (const q of c.requiredQuery) if (!(q in req.query)) v.push(`missing required query param "${q}"`);
  if (c.method === 'GET' || c.method === 'HEAD') {
    if (req.body !== undefined) v.push('GET/HEAD must not carry a request body');
  } else {
    for (const b of c.bodyRequired) if (!req.body || !(b in req.body)) v.push(`missing required body field "${b}"`);
  }
  return v;
}

/** Turn a captured fetch call {url, method, body(parsed)} into a ReconstructedRequest. */
export function decompose(call: { url: string; method: string; body?: unknown }): ReconstructedRequest {
  const u = new URL(call.url);
  return {
    method: call.method,
    path: u.pathname,
    query: Object.fromEntries(u.searchParams.entries()),
    body: (call.body as Record<string, unknown> | undefined) ?? undefined,
  };
}
