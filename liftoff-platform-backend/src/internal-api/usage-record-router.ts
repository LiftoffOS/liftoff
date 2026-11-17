// POST /api/internal/usage/record — the runtime's per-request usage records.
//
// Two callers, one row shape (INV-PB-013):
//
//   * Stagehand's agent loop on the managed key (tenant runtime,
//     web-fetch/stagehand-agent.ts): each model request the AI SDK makes is
//     recorded at the model-call boundary and posted here before the response
//     is returned to the SDK. `provider` and `model` are validated against the
//     model registry — an approved row for that provider, the same source the
//     registry-drift check reads — rather than fixed to one pair, and the
//     purpose is set server-side to `browser_task`.
//   * Every TypeSafe call the runtime makes (web-fetch/jev-loop, hitl
//     contract-check, ask-check, memory, message-check): `provider:
//     'typesafe'`, the model validated against this side's pinned ids, and
//     the purpose derived from the SET ID the body names. Exactly the runtime
//     set ids are accepted; any other id is a 400.
//
// A purpose is never accepted from the caller. Token counts are bounded
// non-negative integers. The body always carries the runtime-minted `callId`
// and `attempts`; the insert is idempotent on the id (migration 506), so a
// retried POST after an ambiguous response is one row.
//
// Rows are the control plane's: they reach cost_attribution_events by the
// existing ingester and classify by purpose — every purpose here sits in
// CUSTOMER_PURPOSES_WITHOUT_AGENT, so a run's work is customer usage whether
// or not the runtime's agent id translated (the field is omitted on a miss).
//
// Auth: PLATFORM_CALLBACK_TOKEN, the token the runtime's shared service client
// sends to `fetch('platform', ...)`. Mounted BEFORE authMiddleware.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { verifyServiceAuth } from '@liftoffos/service-client';
import { getPool } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { writeUsageEvent } from '../llm/usage-tracker';
import type { LLMUsageEvent, LLMUsageProvider } from '../llm/types';
import { PINNED_TYPESAFE_MODEL_IDS, RUNTIME_SET_IDS, type RuntimeSetId } from '../typesafe/questions';

export const usageRecordRouter = Router();

/** The runtime providers the Stagehand loop can run on, and the `models.provider`
 *  key each one's rows are filed under (the mapping the registry-drift test
 *  states: Vertex routes to the Anthropic rows; Grok's registry key is `grok`). */
const REGISTRY_PROVIDER_FOR: Readonly<Record<string, string>> = {
  anthropic: 'anthropic',
  'anthropic-vertex': 'anthropic',
  google: 'google',
  openai: 'openai',
  xai: 'grok',
  glm: 'glm',
  qwen: 'qwen',
  deepseek: 'deepseek',
  kimi: 'kimi',
  minimax: 'minimax',
  xiaomi: 'xiaomi',
};

const tokenCount = z.number().int().min(0).max(100_000_000);

const bodySchema = z.object({
  callId: z.string().uuid(),
  attempts: z.number().int().min(1).max(10),
  provider: z.string().min(1).max(40),
  model: z.string().min(1).max(200),
  inputTokens: tokenCount,
  outputTokens: tokenCount,
  tenantId: z.string().uuid(),
  invocationId: z.string().max(200).optional(),
  agentId: z.string().uuid().optional(),
  /** For `provider: 'typesafe'` only: the set id the purpose derives from. */
  setId: z.string().max(40).optional(),
  /** Whether the vendor answered. False records a failed attempt with the
   *  counts the caller had (zero on no response). */
  success: z.boolean().optional(),
  error: z.string().max(500).optional(),
  vendorRequestId: z.string().max(200).optional(),
});

export type UsageRecordBody = z.infer<typeof bodySchema>;

/** Test seam: the registry lookup. */
let registryHasApproved: (registryProvider: string, modelId: string) => Promise<boolean> = async (registryProvider, modelId) => {
  const result = await getPool().query(
    `SELECT 1 FROM models WHERE provider = $1 AND model_id = $2 AND status = 'approved' LIMIT 1`,
    [registryProvider, modelId],
  );
  return result.rows.length > 0;
};
export function _setRegistryLookupForTesting(fn: typeof registryHasApproved | null): void {
  registryHasApproved = fn ?? (async (registryProvider, modelId) => {
    const result = await getPool().query(
      `SELECT 1 FROM models WHERE provider = $1 AND model_id = $2 AND status = 'approved' LIMIT 1`,
      [registryProvider, modelId],
    );
    return result.rows.length > 0;
  });
}

/** The purpose a body's provider and set id resolve to, or the 400 reason. */
export function purposeFor(body: Pick<UsageRecordBody, 'provider' | 'setId'>): { purpose: string } | { error: string } {
  if (body.provider === 'typesafe') {
    if (!body.setId || !(RUNTIME_SET_IDS as readonly string[]).includes(body.setId)) {
      return { error: `setId must be one of ${RUNTIME_SET_IDS.join(', ')}` };
    }
    // The set id IS the purpose for every runtime set.
    return { purpose: body.setId as RuntimeSetId };
  }
  return { purpose: 'browser_task' };
}

usageRecordRouter.post(
  '/',
  verifyServiceAuth({ tokenEnvVar: 'PLATFORM_CALLBACK_TOKEN' }),
  async (req: Request, res: Response) => {
    // A supplied purpose is ignored, never honoured: the schema does not
    // name it and zod strips unknown keys.
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues.slice(0, 10) });
    }
    const body = parsed.data;

    const resolved = purposeFor(body);
    if ('error' in resolved) return res.status(400).json({ error: resolved.error });

    if (body.provider === 'typesafe') {
      if (!PINNED_TYPESAFE_MODEL_IDS.includes(body.model)) {
        return res.status(400).json({ error: `model must be one of the pinned ids: ${PINNED_TYPESAFE_MODEL_IDS.join(', ')}` });
      }
    } else {
      const registryProvider = REGISTRY_PROVIDER_FOR[body.provider];
      if (!registryProvider) return res.status(400).json({ error: `unknown provider '${body.provider}'` });
      let approved = false;
      try {
        approved = await registryHasApproved(registryProvider, body.model);
      } catch (err) {
        log.error({ err: (err as Error).message }, 'usage/record registry lookup failed');
        return res.status(503).json({ error: 'registry_unavailable' });
      }
      if (!approved) return res.status(400).json({ error: `no approved registry row for ${body.provider}/${body.model}` });
    }

    const event: LLMUsageEvent = {
      timestamp: new Date(),
      provider: body.provider as LLMUsageProvider,
      model: body.model,
      inputTokens: body.inputTokens,
      outputTokens: body.outputTokens,
      success: body.success ?? true,
      ...(body.error ? { error: body.error } : {}),
      context: {
        tenantId: body.tenantId,
        purpose: resolved.purpose,
        ...(body.agentId ? { agentId: body.agentId } : {}),
        ...(body.invocationId ? { invocationId: body.invocationId } : {}),
      },
      callId: body.callId,
      attempts: body.attempts,
      ...(body.vendorRequestId ? { vendorRequestId: body.vendorRequestId } : {}),
    };
    try {
      await writeUsageEvent(event);
    } catch (err) {
      log.error({ err: (err as Error).message, callId: body.callId, purpose: resolved.purpose }, 'usage/record write failed');
      return res.status(500).json({ error: 'write_failed' });
    }
    return res.status(200).json({ recorded: true, callId: body.callId, purpose: resolved.purpose });
  },
);
