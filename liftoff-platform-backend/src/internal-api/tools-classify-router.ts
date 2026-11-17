// POST /api/internal/tools/classify — connector onboarding's classification
// step, served by the one classifier this service runs (mcp/tool-classifier.ts:
// Jev, then the generation prompt, then the keyword heuristics).
//
// connector-service's scripts/classify-connector-tools.ts used to reach the
// LLM relay with its own copy of the classification prompt; it now calls this
// and keeps its evidence-first `decideClass` for the effect. Only a tool with
// no evidence at all uses the effect class returned here.
//
// Auth: verifyServiceAuth({ tokenEnvVar: 'CONNECTOR_SERVICE_TOKEN' }) from the
// shared service client — the existing caller's x-service-auth header works
// unchanged, and the LLM relay's own multi-token middleware is not reused.
// Mounted BEFORE authMiddleware in index.ts, beside /api/internal/llm.
//
// The attribution is discriminated. A tenant-triggered classification carries
// its tenant and attributes as today. The global connector inventory (the
// onboarding script, which has no tenant) is accepted ONLY because
// tool_classification is platform overhead: its usage rows are written with
// tenant_id NULL, which the ingester skips by design, so they are platform
// spend and are never claimed as a tenant's cost-attribution event.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { verifyServiceAuth } from '@liftoffos/service-client';
import { toolClassifier } from '../mcp/tool-classifier';
import { log } from '../infrastructure/logging';

export const toolsClassifyRouter = Router();

const bodySchema = z.object({
  tools: z.array(z.object({
    name: z.string().min(1).max(200),
    description: z.string().max(4000),
  })).min(1).max(500),
  attribution: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('tenant'), tenantId: z.string().uuid() }),
    z.object({ kind: z.literal('global_inventory') }),
  ]),
  /** Where to CACHE what was decided. Absent, this route classifies and caches
   *  nothing — the onboarding script's behaviour, which emits a seed migration
   *  instead. Present, each answer is stored under (tool name, this namespace,
   *  this tenant), with the effect class and the classification version beside
   *  the categories, and a re-classification of an unchanged description is
   *  served from it rather than paid for again.
   *
   *  The namespace is PER INSTANCE for a custom API connection
   *  (`custom_api_connector:<connectorId>`). Two workspaces may both connect a
   *  provider whose operations have the same names, and the connector UUID is
   *  what keeps their answers apart — a row also carries the tenant, so the
   *  global (`tenant_id IS NULL`) fallback in getCachedClassification cannot
   *  match another workspace's row either. */
  cache: z.object({ integrationType: z.string().min(1).max(200) }).optional(),
});

export type ToolsClassifyBody = z.infer<typeof bodySchema>;

toolsClassifyRouter.post(
  '/',
  verifyServiceAuth({ tokenEnvVar: 'CONNECTOR_SERVICE_TOKEN' }),
  async (req: Request, res: Response) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues.slice(0, 10) });
    }
    const { tools, attribution, cache } = parsed.data;
    const tenantId = attribution.kind === 'tenant' ? attribution.tenantId : undefined;
    // A namespace without a tenant would write a GLOBAL row, which every other
    // workspace reads through the `tenant_id IS NULL` fallback. Refused rather
    // than silently ignored: a caller that asked for a cache and got none would
    // pay for the whole set on every registration and never know.
    if (cache && !tenantId) {
      return res.status(400).json({ error: 'cache_requires_tenant_attribution' });
    }
    try {
      const results: Array<{ name: string; categories: string[]; effectClass: string | null }> = [];
      for (const tool of tools) {
        if (cache && tenantId) {
          // classifyAndCache is the one place the cache lookup, the
          // description-hash comparison and the write live; going through it
          // means the effect class and the classification version are stored
          // exactly as they are for every other cached classification.
          const categories = await toolClassifier.classifyAndCache(
            tool,
            cache.integrationType,
            undefined,
            { tenantId },
          );
          const cached = await toolClassifier.getCachedClassification(tool.name, cache.integrationType, tenantId);
          results.push({ name: tool.name, categories, effectClass: cached?.effectClass ?? null });
          continue;
        }
        const classified = await toolClassifier.classifyTool(tool, {
          purpose: 'tool_classification',
          ...(tenantId ? { tenantId } : {}),
        });
        results.push({ name: tool.name, categories: classified.categories, effectClass: classified.effectClass ?? null });
      }
      return res.json({ results });
    } catch (err) {
      log.error({ err: (err as Error).message, attribution: attribution.kind, tenantId }, 'tools/classify failed');
      return res.status(500).json({ error: 'classification_failed' });
    }
  },
);
