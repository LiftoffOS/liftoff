// The classification step of connector onboarding, over platform-backend's
// POST /api/internal/tools/classify.
//
// The classify script (scripts/classify-connector-tools.ts) used to reach the
// LLM relay with its own copy of the classification prompt. The prompt now
// lives in one place, behind the one classifier platform-backend runs, and
// this client sends what that route takes: tool NAMES and DESCRIPTIONS only.
// The script keeps its evidence-first `decideClass` for the effect; the
// route's effect class is read only where the script already used the model,
// which is a tool with no evidence at all.
//
// Nothing about a tool's effect is ever sent here. The body carries no
// annotations, no HTTP method, no scope proof, no registry categories — the
// unit test beside this pins that shape.

export interface ClassifyRouteTool {
  name: string;
  description: string;
}

export interface ClassifyRouteResult {
  name: string;
  categories: string[];
  /** `read | write | destructive | outbound`, or null when the classifier
   *  answered nothing confident. */
  effectClass: string | null;
}

export type ClassifyRouteAttribution =
  | { kind: 'tenant'; tenantId: string }
  /** The onboarding script, which has no tenant: platform overhead. */
  | { kind: 'global_inventory' };

/** Where the route should cache what it decided.
 *
 *  Absent, the route classifies and caches nothing — the onboarding script's
 *  behaviour, which emits a seed migration instead. Present, each answer is
 *  cached under (tool name, this namespace, this tenant), so a re-registration
 *  of the same connection does not pay for the whole set again and the effect
 *  class and classification version are stored beside the categories.
 *
 *  The namespace is PER INSTANCE for a custom API connection
 *  (`custom_api_connector:<connectorId>`): two workspaces may both connect a
 *  provider whose operations have the same names, and the connector UUID is
 *  what keeps their answers apart. */
export interface ClassifyRouteCache {
  integrationType: string;
}

/** What one request to the route carries. */
export function buildClassifyRequestBody(
  tools: ReadonlyArray<ClassifyRouteTool>,
  attribution: ClassifyRouteAttribution,
  cache?: ClassifyRouteCache,
): { tools: ClassifyRouteTool[]; attribution: ClassifyRouteAttribution; cache?: ClassifyRouteCache } {
  return {
    tools: tools.map((t) => ({ name: t.name, description: t.description })),
    attribution,
    ...(cache ? { cache } : {}),
  };
}

/** The route's per-request bound. */
export const CLASSIFY_ROUTE_MAX_TOOLS = 500;

export class ClassifyRouteRateLimited extends Error {
  constructor() { super('RATE_LIMIT'); this.name = 'ClassifyRouteRateLimited'; }
}

export async function classifyToolsViaRoute(
  pbUrl: string,
  serviceToken: string,
  tools: ReadonlyArray<ClassifyRouteTool>,
  attribution: ClassifyRouteAttribution,
  fetchImpl: typeof fetch = fetch,
  cache?: ClassifyRouteCache,
): Promise<ClassifyRouteResult[]> {
  if (tools.length === 0) return [];
  if (tools.length > CLASSIFY_ROUTE_MAX_TOOLS) {
    throw new Error(`classify route takes at most ${CLASSIFY_ROUTE_MAX_TOOLS} tools per request`);
  }
  const resp = await fetchImpl(`${pbUrl}/api/internal/tools/classify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-service-auth': serviceToken },
    body: JSON.stringify(buildClassifyRequestBody(tools, attribution, cache)),
  });
  if (resp.status === 429) throw new ClassifyRouteRateLimited();
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`classify route error ${resp.status}: ${text}`);
  }
  const data = (await resp.json()) as { results?: ClassifyRouteResult[] };
  return data.results ?? [];
}
