// Internal LLM Relay Router
//
// Allows internal services to route LLM calls through PB's unified llmClient
// rather than calling Anthropic directly. This enables central API key
// management, provider routing, usage tracking, and tier-based model selection.
//
// Auth: any registered internal service token via X-Service-Auth header (timing-safe).
// Accepted tokens: WORKFORCE_SERVICE_TOKEN, CONNECTOR_SERVICE_TOKEN, GOVERNANCE_EVAL_SERVICE_TOKEN, HARVEST_SERVICE_TOKEN.
// Mounted BEFORE authMiddleware in index.ts.

import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { llmClient } from '../llm/client';
import { sendableModalities } from '../llm/vision';
import { log } from '../infrastructure/logging';
import { checkExecutionAllowed } from '../billing/execution-guard';
import { isPlatformAbsorbedPurpose } from '../cost-attribution/event-classification';
import { validateLLMWireRequest } from '@liftoffos/shared-types';
import { normalizeTier, type LLMCompletionRequest, type LLMModelTier } from '../llm/types';

declare global {
  namespace Express {
    interface Locals {
      matchedTokenVar?: 'WORKFORCE_SERVICE_TOKEN' | 'CONNECTOR_SERVICE_TOKEN' | 'GOVERNANCE_EVAL_SERVICE_TOKEN' | 'HARVEST_SERVICE_TOKEN';
    }
  }
}

export const internalLLMRouter = Router();

const INTERNAL_SERVICE_TOKEN_VARS = [
  'WORKFORCE_SERVICE_TOKEN',
  'CONNECTOR_SERVICE_TOKEN',
  'GOVERNANCE_EVAL_SERVICE_TOKEN',
  'HARVEST_SERVICE_TOKEN',
] as const;

type ServiceTokenVar = typeof INTERNAL_SERVICE_TOKEN_VARS[number];

function serviceAuth(req: Request, res: Response, next: () => void): void {
  const serviceToken = req.headers['x-service-auth'] as string | undefined;

  if (!serviceToken) {
    res.status(401).json({ error: 'Missing service authentication' });
    return;
  }

  const tokenVarPairs = INTERNAL_SERVICE_TOKEN_VARS
    .map(v => ({ varName: v, token: process.env[v] }))
    .filter((t): t is { varName: ServiceTokenVar; token: string } => Boolean(t.token));

  if (tokenVarPairs.length === 0) {
    res.status(503).json({ error: 'LLM relay not configured' });
    return;
  }

  let matchedVar: ServiceTokenVar | undefined;
  const matched = tokenVarPairs.some(({ varName, token: expected }) => {
    try {
      const ok =
        Buffer.byteLength(serviceToken) === Buffer.byteLength(expected) &&
        crypto.timingSafeEqual(Buffer.from(serviceToken), Buffer.from(expected));
      if (ok) matchedVar = varName;
      return ok;
    } catch {
      return false;
    }
  });

  if (!matched) {
    res.status(401).json({ error: 'Invalid service authentication' });
    return;
  }

  res.locals.matchedTokenVar = matchedVar;
  next();
}


/**
 * Turn a wire request into the in-process one, honouring `systemPrompt`.
 *
 * `LLMWireRequest.systemPrompt` is part of the published contract and is
 * documented as "some callers send this instead of a system-role message". It
 * was never read. `LLMCompletionRequest` has no such field, no provider looks
 * for one, and the relay forwarded the body through unchanged — so a caller
 * that used the documented field had its whole system prompt discarded, with a
 * 200 and a plausible answer coming back.
 *
 * harvest-service used it. Its classifier prompt carries the instruction that
 * the content block is untrusted and that instructions inside it must be
 * ignored, and that instruction reached no model for as long as the service has
 * been on this relay.
 *
 * Prepended rather than merged, and additive rather than exclusive: a caller
 * that sends both gets both, in the order it wrote them. Every provider now
 * carries every system message, so neither is dropped.
 */
function toCompletionRequest(wire: LLMCompletionRequest & { systemPrompt?: string }): LLMCompletionRequest {
  const { systemPrompt, ...rest } = wire;
  if (!systemPrompt) return rest as LLMCompletionRequest;
  return {
    ...(rest as LLMCompletionRequest),
    messages: [{ role: 'system' as const, content: systemPrompt }, ...(rest.messages ?? [])],
  };
}

// POST /complete
// Body: { request: LLMCompletionRequest, usageContext?: Record<string, string> }
// Returns: LLMCompletionResponse
internalLLMRouter.post('/complete', serviceAuth, async (req: Request, res: Response) => {
  try {
    const { request, usageContext } = req.body as {
      request: LLMCompletionRequest & { systemPrompt?: string };
      usageContext?: Record<string, string>;
    };

    // Validate the wire contract HERE rather than letting a malformed body
    // reach the provider. Two reasons, and the second is the one that bit us.
    //
    // Legibility: harvest-service sent `responseSchema` as a bare JSON Schema
    // instead of the {name, description?, schema} wrapper. The provider built
    // `tool_choice: {type:'tool', name: undefined}`, JSON.stringify dropped
    // the key, and Anthropic answered `tool_choice.tool.name: Field required`
    // — an error naming a field the caller never wrote, three services from
    // the mistake.
    //
    // Retry semantics: a malformed body is PERMANENT, and callers classify
    // 4xx as terminal (ack-and-skip) and 5xx as retryable. Returning 500 for
    // it — which is what the catch block below did — turns every such request
    // into an infinite redelivery loop. That is why the failure showed up as
    // a steady hourly rate rather than a burst.
    const invalid = validateLLMWireRequest(request);
    if (invalid) {
      log.warn(
        {
          event: 'internal_llm_invalid_request',
          reason: invalid,
          purpose: usageContext?.purpose ?? 'unknown',
          caller: res.locals.matchedTokenVar,
        },
        'internal LLM relay rejected a malformed request',
      );
      return res.status(400).json({ error: invalid });
    }
    if (request.tier) request.tier = normalizeTier(request.tier);

    // SEC-005: HARVEST_SERVICE_TOKEN is scoped to harvest_classification only.
    if (res.locals.matchedTokenVar === 'HARVEST_SERVICE_TOKEN' &&
        usageContext?.purpose !== 'harvest_classification') {
      return res.status(403).json({ error: 'harvest token restricted to harvest_classification purpose' });
    }

    // BILLING-GATE: this relay is the single chokepoint through which every
    // internal/background service (harvest classification, workforce CAIO &
    // insights, governance eval, connector tooling) incurs tenant-attributed
    // LLM cost. A suspended / not-execution-allowed tenant must not accrue new
    // drain, exactly as scheduled agent execution is blocked at invocation
    // start (billing/execution-guard). Gate here so no internal caller can
    // bypass it.
    //
    // Two kinds of call are NOT gated, for the same reason: neither one can
    // drain the tenant.
    //
    //   1. Platform-level calls with no tenantId. Platform overhead outright.
    //
    //   2. Calls whose PURPOSE the platform absorbs — CAIO workforce planning
    //      and HRBP provisioning today. This comment used to assert that every
    //      call through here drains Operating Units, and for these purposes
    //      that was simply not true: cost-attribution classifies them
    //      'platform_overhead', books them at customer_cost_usd=0, and never
    //      touches billing_controls. So the gate was refusing work that no
    //      customer is billed for, and the only thing the refusal bought was a
    //      Chief AI Officer page that failed on load for anyone who skipped the
    //      plan step in onboarding. Building an agent is free (ADR-050);
    //      planning one with the CAIO, and having HRBP turn that plan into
    //      drafts, is the same thing one step earlier. Running what comes out
    //      is what costs money, and that is still enforced: launching answers
    //      402 at POST/PATCH /api/internal-agents.
    //
    //      Derived from isPlatformAbsorbedPurpose rather than a second list
    //      here, so "the platform absorbs this" is stated once. Add a purpose
    //      to the ledger's absorbed set and the relay stops charging for it in
    //      the same commit; the two cannot drift apart.
    //
    // checkExecutionAllowed fails open on DB error, so a transient
    // control-plane blip degrades to "allow", never a hard outage. The 403
    // reason is a stable machine code, not user-facing copy — callers (e.g.
    // harvest) treat a 4xx as a terminal skip, not a retryable error.
    const tenantId = usageContext?.tenantId;
    if (tenantId && !isPlatformAbsorbedPurpose(usageContext?.purpose)) {
      const guard = await checkExecutionAllowed(tenantId);
      if (!guard.allowed) {
        log.info(
          {
            event: 'internal_llm_blocked_suspended',
            purpose: usageContext?.purpose ?? 'unknown',
            tenantId,
            caller: res.locals.matchedTokenVar,
          },
          'internal LLM relay blocked: tenant not execution-allowed',
        );
        // 402, not 403. This is a payment problem, and 402 is the code every
        // other refusal of this kind answers with (agent chat's admission,
        // launch-time activation) — which is what the dashboard's PlanGate
        // modal keys on to show the guard's own copy instead of a generic
        // error. A 403 here reached the Chief AI Officer page as a failure
        // with no explanation and no way forward.
        //
        // `reason` rides along as `message` for the same reason: the guard
        // distinguishes "needs an active plan" from "credit balance is $0"
        // from "outstanding balance of $X", and the person needs to know
        // which. Callers that treat any 4xx as a terminal skip (harvest, and
        // the background services) are unaffected — 402 is as terminal as 403.
        return res.status(402).json({
          error: 'payment_required',
          skipped: true,
          ...(guard.reason ? { message: guard.reason } : {}),
        });
      }
    }

    const response = await llmClient.complete(toCompletionRequest(request), undefined, usageContext);

    log.info(
      {
        event: 'internal_llm_complete',
        purpose: usageContext?.purpose ?? 'unknown',
        tenantId: usageContext?.tenantId,
        model: response.model,
        inputTokens: response.usage?.inputTokens,
        outputTokens: response.usage?.outputTokens,
      },
      'internal LLM relay completed',
    );

    // The window of the model that served the call, from the registry the
    // in-process loops read. The Chief AI Officer's loop runs in another
    // process and guards on how full the window is, the same way Liftoff and
    // the Insights Manager do; `usage.contextTokens` on the response is the
    // prompt this call carried, and this is what it is measured against. A
    // client older than either field simply does not read it.
    //
    // TWO FIELDS, because they are two different claims. `contextWindow` is
    // the number to measure against and always has one — the conservative
    // fallback when the registry has not sized the model.
    // `contextWindowRecorded` is present ONLY when the registry actually holds
    // the model's window, which is what a caller needs to tell "this model
    // holds 1M" from "we are guessing"; a caller that may ever make a
    // destructive decision on it must read the second, not the first.
    return res.json({
      ...response,
      contextWindow: llmClient.contextWindowFor(response.provider, response.model),
      contextWindowRecorded: llmClient.recordedContextWindowFor(response.provider, response.model),
    });
  } catch (err) {
    log.error({ error: (err as Error).message }, 'internal LLM relay failed');
    return res.status(500).json({ error: 'LLM call failed' });
  }
});

// POST /vision
// Body: { tier?, model?, purpose? }
// Returns: { modelId, visionCapable }
//
// Whether the model a request WOULD resolve to can look at a picture.
//
// The relay's callers do not pick a model — they pick a tier, and this process
// resolves it from the preferred provider, the purpose-keyed pool and that
// provider's tier map. So a caller building a turn with an image attached has
// no way to know, in its own process, whether sending the image is an answer or
// a 400. This answers that one question, using the same resolution the
// completion itself will use and the same capability registry every in-process
// surface reads.
//
// It exists so the Chief AI Officer can make the SAME decision the three
// in-process surfaces make. It is not an optimisation: a model that cannot see
// must be told about the picture in words instead, and that sentence has to be
// composed before the prompt is built.
internalLLMRouter.post('/vision', serviceAuth, async (req: Request, res: Response) => {
  try {
    const { tier: rawTier, model, purpose } = req.body as {
      tier?: LLMModelTier;
      model?: string;
      purpose?: string;
    };
    const tier = normalizeTier(rawTier);
    const modelId = await llmClient.resolvePlannedModel(
      {
        messages: [],
        ...(model ? { model } : {}),
        ...(tier ? { tier } : {}),
      },
      undefined,
      purpose ? { purpose } : undefined,
    );
    // `sendable` is the answer that matters: the model's capability intersected
    // with what the resolved provider's request builder can express. A caller
    // that got only the model's capability would send a video to a provider
    // with no video part and find out at the vendor.
    //
    // `visionCapable` is kept alongside it for the one caller that predates the
    // video modality, so a workforce-service deploy that lags this one keeps
    // working instead of silently losing images.
    const provider = llmClient.resolvePlannedProvider();
    const sendable = await sendableModalities(modelId, provider);
    return res.json({
      modelId: modelId ?? null,
      provider,
      sendable,
      visionCapable: sendable.image,
    });
  } catch (err) {
    log.error({ error: (err as Error).message }, 'internal LLM relay vision lookup failed');
    // A lookup that failed knows nothing, and the caller's safe reading of
    // "nothing" is no media — which costs an honest sentence in the prompt
    // rather than a vendor error on the person's turn.
    return res.json({
      modelId: null,
      provider: null,
      sendable: { image: false, video: false },
      visionCapable: false,
    });
  }
});
