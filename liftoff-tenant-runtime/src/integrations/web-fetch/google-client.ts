// Google Gemini Deep Research (Interactions API). Implements
// WebFetchAdvancedClient for deepResearch only. fetch() throws.
//
// Endpoint shapes verified against https://ai.google.dev/api/interactions-api
// (June 2026):
//   - POST /v1beta/interactions with agent='deep-research-{preview|max}-04-2026', background=true
//   - GET  /v1beta/interactions/{id} for polling
//   - Auth via ?key=<api_key> query param (consumer Gemini API)
//   - Status enum: in_progress | requires_action | completed | failed |
//                  cancelled | incomplete | budget_exceeded
//   - Output: steps[].content[type='text'].text (last ModelOutputStep wins)
//   - Citations: step.content[].annotations[] (UrlCitation has .url + .title)
//   - Usage: total_input_tokens / total_output_tokens / total_cached_tokens
//            / total_thought_tokens / total_tool_use_tokens
//
// Cost model: token-based using Gemini 2.5 Pro published rates (default).
// Override via web_fetch_google_rates_v1 sentinel flag. Search-call cost is
// NOT exposed per-call; monthly GCP-billing reconciliation accepts the
// residual (D9).
//
// Data retention: Google retains all background-mode interactions for 55
// days (paid tier). store=false is incompatible with background=true. See
// ADR-018 per-vendor data-residency note + per-tenant exclusion via
// isVendorExcludedForTenant (D12).

import { randomUUID } from 'node:crypto';
import { logger } from '../../infrastructure/logging';
import { getWebToolSecret } from './web-tool-secrets';
import { getCachedSentinelFlags, readTypedFlag } from './limits-config';
import {
  insertSubmission,
  finalizeSubmission,
  markPolled,
  markHookActive,
} from './deep-research-registry';
import type {
  WebFetchAdvancedClient,
  WebFetchAdvancedRequest, InternalWebFetchAdvancedResult,
  WebDeepResearchRequest, InternalWebDeepResearchResult,
} from './types';
import type { DeepResearchHooks } from './perplexity-client';

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com';
const GEMINI_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 15_000;       // typical 20 min, max 60 min
const HEARTBEAT_INTERVAL_MS = 4 * 60 * 1000;
const TIMEOUT_STATUS = 408;

// Google Gemini Deep Research has two model variants. BOTH are in preview
// (per Google's published API surface — the model IDs literally contain
// "preview"); naming the variants `preview` vs `max` would be misleading.
// Use the user-facing product names instead: "Google Gemini Deep Research"
// (standard) and "Google Gemini Deep Research Max".
export type GoogleModelVariant = 'standard' | 'max';
const AGENT_BY_VARIANT: Record<GoogleModelVariant, string> = {
  standard: 'deep-research-preview-04-2026',
  max:      'deep-research-max-preview-04-2026',
};
const PRECHARGE_USD_BY_VARIANT: Record<GoogleModelVariant, number> = {
  standard: 3.0,
  max:      7.0,
};
const PRECHARGE_FLAG_BY_VARIANT: Record<GoogleModelVariant, string> = {
  // Flag-key suffix kept as `_preview_max_cost_usd` to avoid an operator
  // migration on the cached_feature_flags sentinel row. The `preview` in
  // the key name historically reflected the model variant; semantically
  // it's now the "standard Deep Research" tier.
  standard: 'web_fetch_google_preview_max_cost_usd_value',
  max:      'web_fetch_google_max_max_cost_usd_value',
};
// Vendor-internal effort recorded in the hook payload. Google ignores
// reasoning_effort (model self-determines), but the payload field is
// constrained to 'low' | 'medium' | 'high', so map variant → recorded value
// so operators can correlate cost rows with the model variant used.
const RECORDED_EFFORT_BY_VARIANT: Record<GoogleModelVariant, 'low' | 'medium' | 'high'> = {
  standard: 'medium',
  max:      'high',
};

// Google Gemini Deep Research per-token rates.
//
// The Deep Research model pages (ai.google.dev/gemini-api/docs/interactions/
// deep-research) state explicitly: pricing "follows the underlying Gemini
// models" with per-task estimate ranges of $1-$3 (standard) and $3-$7 (Max).
// No model-specific token rates are published — Deep Research bills at the
// rates of whichever Gemini model the agent loop is configured to use.
//
// The Deep Research model docs also document typical usage profiles:
// 80-160 searches, **250k-900k input tokens** (50-70% caching), 60k-80k
// output tokens. THAT ROUTINELY CROSSES THE 200K CONTEXT-TIER BREAKPOINT,
// so the rate table is tier-aware (under/over 200K input). Skipping the
// tier modeling would under-bill every Max call by 50% on input and ~33%
// on output.
//
// Defaults below are the published Gemini 3.1 Pro Preview rates verified
// against ai.google.dev/gemini-api/docs/pricing on 2026-06-03. This is the
// closest published proxy to Deep Research's "underlying model" — operators
// can swap the table via `web_fetch_google_rates_v1_value` if Deep Research
// ever pins a different specific model.
//
// Thinking tokens: the pricing page output column reads "Output price
// (including thinking tokens)" — billed at the output rate of the active tier.
//
// NOT modeled (residual captured by ADR-021's monthly GCP-billing
// reconciliation):
//   - Per-tool-call fees for google_search / url_context / code_execution.
//     Google's pricing page distinguishes "search grounding (retrieved
//     tokens excluded) versus other tools (retrieved tokens included)" with
//     no separately itemized per-call rate.
//   - Context-cache STORAGE rate ($4.50 / 1M tokens / hour). Negligible
//     against per-call cost given Deep Research's short interaction window.
interface GoogleRateTier {
  input_per_million: number;
  cached_per_million: number;
  output_per_million: number;
  thought_per_million: number;
}
interface GoogleRates {
  under_200k: GoogleRateTier;
  over_200k:  GoogleRateTier;
}
const RATE_DEFAULTS: GoogleRates = {
  under_200k: {
    input_per_million:    2.00,
    cached_per_million:   0.20,
    output_per_million:   12.00,
    thought_per_million:  12.00,
  },
  over_200k: {
    input_per_million:    4.00,
    cached_per_million:   0.40,
    output_per_million:   18.00,
    thought_per_million:  18.00,
  },
};
const isGoogleRateTier = (v: unknown): v is GoogleRateTier =>
  typeof v === 'object' && v !== null
    && typeof (v as Record<string, unknown>).input_per_million === 'number'
    && typeof (v as Record<string, unknown>).cached_per_million === 'number'
    && typeof (v as Record<string, unknown>).output_per_million === 'number'
    && typeof (v as Record<string, unknown>).thought_per_million === 'number';
const isGoogleRates = (v: unknown): v is GoogleRates =>
  typeof v === 'object' && v !== null
    && isGoogleRateTier((v as Record<string, unknown>).under_200k)
    && isGoogleRateTier((v as Record<string, unknown>).over_200k);

const CONTEXT_TIER_BREAKPOINT_TOKENS = 200_000;

export class GoogleError extends Error {
  constructor(message: string, public readonly statusCode: number, public readonly body?: unknown) {
    super(message); this.name = 'GoogleError';
  }
}

/**
 * Compute exact cost in micros from a Gemini Deep Research usage payload.
 * Shared by GoogleClient (hook path) and the deep_research reconciler
 * (recovery path). Throws GoogleError(422) on missing or malformed usage
 * — matches the MISSING_COST_STATUS contract used by Perplexity / OpenAI
 * so the reconciler can leave the row unresolved on a contract break
 * instead of fabricating a cost.
 *
 * Tier selection: Gemini's published pricing has a 200K-input-token
 * breakpoint where input/cached/output rates ~2× to ~1.5×. Deep Research
 * routinely crosses this threshold per Google's documented usage profile
 * (250k-900k input tokens typical). The active tier is picked based on
 * `usage.total_input_tokens`; ALL components (input, cached, output, and
 * thinking) bill at the picked tier — the tier breakpoint is a property
 * of the request as a whole, not per-token-class.
 */
export async function computeGoogleCostMicros(usage: GoogleUsage | undefined): Promise<number> {
  if (!usage) {
    throw new GoogleError('missing usage on completed Interaction', 422);
  }
  const rates = await readTypedFlag('web_fetch_google_rates_v1', isGoogleRates, RATE_DEFAULTS);
  const cached = usage.total_cached_tokens ?? 0;
  const totalIn = usage.total_input_tokens ?? 0;
  const uncached = Math.max(0, totalIn - cached);
  const out = usage.total_output_tokens ?? 0;
  const thought = usage.total_thought_tokens ?? 0;
  const tier = totalIn > CONTEXT_TIER_BREAKPOINT_TOKENS ? rates.over_200k : rates.under_200k;
  const usd =
    (uncached * tier.input_per_million +
      cached * tier.cached_per_million +
      out * tier.output_per_million +
      thought * tier.thought_per_million) / 1_000_000;
  if (!Number.isFinite(usd) || usd < 0) {
    throw new GoogleError(
      `Google computed non-finite/negative cost from usage=${JSON.stringify(usage)} tier=${totalIn > CONTEXT_TIER_BREAKPOINT_TOKENS ? 'over_200k' : 'under_200k'}`,
      422,
    );
  }
  return Math.round(usd * 1_000_000);
}

export interface GoogleAnnotation {
  // Discriminated by `type` in docs (UrlCitation | FileCitation | PlaceCitation)
  // but UrlCitation is the only one we surface; others fall through with undefined url.
  type?: string;
  url?: string;
  title?: string;
  start_index?: number;
  end_index?: number;
}
export interface GoogleContent {
  type: 'text' | string;
  text?: string;
  annotations?: GoogleAnnotation[];
}
export interface GoogleStep {
  type?: string;
  content?: GoogleContent[];
}
export interface GoogleUsage {
  total_input_tokens?: number;
  total_output_tokens?: number;
  total_tokens?: number;
  total_cached_tokens?: number;
  total_thought_tokens?: number;
  total_tool_use_tokens?: number;
}
export interface GoogleInteraction {
  id: string;
  status: 'in_progress' | 'requires_action' | 'completed' | 'failed'
        | 'cancelled' | 'incomplete' | 'budget_exceeded';
  steps?: GoogleStep[];
  usage?: GoogleUsage;
  error?: { code?: string; message: string };
}

const TERMINAL_STATUSES = new Set<GoogleInteraction['status']>([
  'completed', 'failed', 'cancelled', 'incomplete', 'budget_exceeded',
]);

export class GoogleClient implements WebFetchAdvancedClient {
  readonly vendor = 'google' as const;
  private apiKey: string | null = null;

  supportsSessions(): boolean { return false; }

  async fetch(_req: WebFetchAdvancedRequest): Promise<InternalWebFetchAdvancedResult> {
    void _req;
    throw new GoogleError('Google client does not implement web_fetch_advanced', 501);
  }

  private async key(): Promise<string> {
    if (this.apiKey) return this.apiKey;
    const k = await getWebToolSecret('google-api-key');
    if (!k) throw new Error('google-api-key not configured');
    this.apiKey = k;
    return k;
  }

  async deepResearch(
    req: WebDeepResearchRequest & { variant: GoogleModelVariant },
    hooks?: DeepResearchHooks,
  ): Promise<InternalWebDeepResearchResult> {
    const startMs = Date.now();
    const deepResearchId = randomUUID();
    // D22: variant is required and chosen by the router from the agent's
    // reasoning_effort tier (`medium` → preview, `highest` → max). Google
    // ignores reasoning_effort itself — the model self-determines depth.
    const variant = req.variant;
    const agent = AGENT_BY_VARIANT[variant];
    const recordedEffort = RECORDED_EFFORT_BY_VARIANT[variant];
    const maxWaitMs = req.maxWaitMs ?? 60 * 60 * 1000;  // 60 min Google ceiling

    // 1. Submit
    const submission = await this.call<{ id: string }>('/v1beta/interactions', {
      agent,
      input: req.question,
      background: true,
      // Default tools per docs (google_search + url_context + code_execution).
      // Listed explicitly for clarity.
      tools: [
        { type: 'google_search' },
        { type: 'url_context' },
        { type: 'code_execution' },
      ],
    });

    // 2. Compute estimate (shared between registry write + pre-charge hook).
    //    Variant determines the precharge ceiling ($3 standard, $7 max).
    const estimateCostMicros = await this.estimatePrechargeMicros(variant);

    // 3. Write the submissions-registry row BEFORE firing the pre-charge
    //    hook. The reconciler drives off this row to recover from hook
    //    failures (Pub/Sub drop, process crash, 408 ceiling). Failure to
    //    write degrades us to hook-only correctness — log ERROR but continue.
    if (req.tenantId) {
      try {
        await insertSubmission({
          deepResearchId,
          submissionId:       submission.id,
          tenantId:           req.tenantId,
          agentId:            req.agentId ?? null,
          vendor:             'google',
          reasoningEffort:    recordedEffort,
          estimateCostMicros,
        });
      } catch (err) {
        logger.error({
          err: (err as Error).message,
          deep_research_id: deepResearchId,
          submission_id:    submission.id,
        }, 'deep_research_registry_write_lost');
      }
    } else {
      logger.warn({
        deep_research_id: deepResearchId,
        submission_id:    submission.id,
      }, 'deep_research_registry_skipped_no_tenant');
    }

    // 4. Fire pre-charge hook. Fire-and-forget — failures log
    //    deep_research_precharge_lost at ERROR. The registry row above
    //    ensures the reconciler picks this up regardless.
    if (hooks?.onPreCharge) {
      hooks.onPreCharge({
        deepResearchId,
        vendor: 'google',
        reasoningEffort: recordedEffort,
        estimateCostMicros,
        submittedAt: new Date(),
        submissionId: submission.id,
      }).catch(err => logger.error({
        err: (err as Error).message,
        deep_research_id: deepResearchId,
        submission_id: submission.id,
        estimate_cost_micros: estimateCostMicros,
      }, 'deep_research_precharge_lost'));
    }

    // 5. Poll with heartbeat
    let lastHeartbeatMs = startMs;
    let consecutiveHeartbeatFailures = 0;
    let final: GoogleInteraction | null = null;
    while (Date.now() - startMs < maxWaitMs) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

      // Registry hook heartbeat: every poll iteration, push hook_active_until
      // forward by 30s so the reconciler defers to us. Fire-and-forget.
      if (req.tenantId) {
        markHookActive(deepResearchId, 30).catch((err: Error) => logger.warn({
          err: err.message, deep_research_id: deepResearchId,
        }, 'deep_research_hook_heartbeat_failed'));
      }

      if (hooks?.onHeartbeat && Date.now() - lastHeartbeatMs >= HEARTBEAT_INTERVAL_MS) {
        try {
          const { refreshed } = await hooks.onHeartbeat();
          consecutiveHeartbeatFailures = 0;
          lastHeartbeatMs = Date.now();
          if (!refreshed) {
            logger.warn({ deep_research_id: deepResearchId, submission_id: submission.id },
              'deep_research_inflight_row_missing');
          }
        } catch (err) {
          consecutiveHeartbeatFailures++;
          if (consecutiveHeartbeatFailures >= 3) {
            logger.error({ err: (err as Error).message, deep_research_id: deepResearchId,
              consecutive_failures: consecutiveHeartbeatFailures }, 'deep_research_heartbeat_stuck');
          }
        }
      }

      const status = await this.call<GoogleInteraction>(`/v1beta/interactions/${submission.id}`, undefined, 'GET');
      if (TERMINAL_STATUSES.has(status.status)) {
        final = status;
        break;
      }
    }

    // 6. Timeout — NO completion event; markPolled forwards last_polled_at
    //    so the reconciler waits the full adaptive interval before re-poll.
    if (!final) {
      if (req.tenantId) {
        markPolled(deepResearchId).catch((err: Error) => logger.warn({
          err: err.message, deep_research_id: deepResearchId,
        }, 'deep_research_markpolled_failed'));
      }
      throw new GoogleError(
        `Gemini deep-research exceeded ${maxWaitMs}ms (interaction ${submission.id})`,
        TIMEOUT_STATUS,
      );
    }

    // 7. Failed / cancelled / incomplete / budget_exceeded — refund, fire
    //    onCompletion(FAILED), finalize registry, throw.
    if (final.status !== 'completed') {
      if (hooks?.onCompletion) {
        hooks.onCompletion({
          deepResearchId,
          vendor: 'google',
          actualCostMicros: 0,
          estimateCostMicros,
          deltaCostMicros: -estimateCostMicros,
          status: 'FAILED',
          submissionId: submission.id,
        }).catch(err => logger.error({ err: (err as Error).message, deep_research_id: deepResearchId },
          'deep_research_delta_lost'));
      }
      if (req.tenantId) {
        finalizeSubmission({
          deepResearchId,
          finalStatus:     'failed',
          finalCostMicros: 0,
        }).catch((err: Error) => logger.error({
          err: err.message, deep_research_id: deepResearchId,
        }, 'deep_research_registry_finalize_lost'));
      }
      // budget_exceeded → 429 surfaces as terminal (D18); other failures 500.
      const code = final.status === 'budget_exceeded' ? 429 : 500;
      throw new GoogleError(
        `Gemini deep-research ${final.status}: ${final.error?.message ?? 'unknown'}`,
        code,
      );
    }

    // 8. Completed — exact cost from tokens, finalize registry idempotently.
    const actualCostMicros = await this.computeCostMicros(final.usage);
    if (hooks?.onCompletion) {
      hooks.onCompletion({
        deepResearchId,
        vendor: 'google',
        actualCostMicros,
        estimateCostMicros,
        deltaCostMicros: actualCostMicros - estimateCostMicros,
        status: 'COMPLETED',
        submissionId: submission.id,
      }).catch(err => logger.error({ err: (err as Error).message, deep_research_id: deepResearchId },
        'deep_research_delta_lost'));
    }
    if (req.tenantId) {
      finalizeSubmission({
        deepResearchId,
        finalStatus:     'completed',
        finalCostMicros: actualCostMicros,
      }).catch((err: Error) => logger.error({
        err: err.message, deep_research_id: deepResearchId,
      }, 'deep_research_registry_finalize_lost'));
    }

    return {
      report: extractText(final),
      sources: extractCitations(final),
      vendor: 'google',
      costMicros: actualCostMicros,
      deepResearchId,
      usage: {
        prompt_tokens:      final.usage?.total_input_tokens ?? 0,
        completion_tokens:  final.usage?.total_output_tokens ?? 0,
        citation_tokens:    0,
        reasoning_tokens:   final.usage?.total_thought_tokens ?? 0,
        num_search_queries: 0,  // not exposed in usage payload
      },
      durationMs: Date.now() - startMs,
    };
  }

  private async computeCostMicros(usage: GoogleUsage | undefined): Promise<number> {
    return computeGoogleCostMicros(usage);
  }

  private async estimatePrechargeMicros(variant: GoogleModelVariant): Promise<number> {
    const flags = await getCachedSentinelFlags();
    const key = PRECHARGE_FLAG_BY_VARIANT[variant];
    const usd = typeof flags[key] === 'number' ? flags[key] as number : PRECHARGE_USD_BY_VARIANT[variant];
    return Math.round(usd * 1_000_000);
  }

  protected async call<T>(path: string, body?: unknown, method: 'GET' | 'POST' = 'POST'): Promise<T> {
    const apiKey = await this.key();
    let res: Response;
    try {
      res = await fetch(`${GEMINI_BASE_URL}${path}?key=${encodeURIComponent(apiKey)}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(method === 'POST' && body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
      });
    } catch (e) {
      throw new GoogleError(`Network: ${(e as Error).message}`, 0);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GoogleError(`Google ${res.status}: ${text.slice(0, 500)}`, res.status, text);
    }
    return res.json() as Promise<T>;
  }
}

function extractText(r: GoogleInteraction): string {
  if (!r.steps?.length) return '';
  // Walk steps in reverse for the last ModelOutputStep with text content.
  for (let i = r.steps.length - 1; i >= 0; i--) {
    const s = r.steps[i];
    if (!s.content) continue;
    const text = s.content
      .filter(c => c.type === 'text' && typeof c.text === 'string')
      .map(c => c.text!)
      .join('\n');
    if (text) return text;
  }
  return '';
}

function extractCitations(r: GoogleInteraction): Array<{ url: string; title?: string; date?: string }> {
  if (!r.steps?.length) return [];
  const out: Array<{ url: string; title?: string; date?: string }> = [];
  for (const s of r.steps) {
    for (const c of s.content ?? []) {
      for (const a of c.annotations ?? []) {
        if (a.url) out.push({ url: a.url, title: a.title });
      }
    }
  }
  return out;
}
