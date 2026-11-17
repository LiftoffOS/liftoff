// OpenAI o3-deep-research vendor client. Implements WebFetchAdvancedClient
// for deepResearch only — fetch() throws because OpenAI exposes no generic
// fetch/extract primitive on this model.
//
// Endpoint shapes verified against https://developers.openai.com/api/docs/guides/deep-research
// (June 2026):
//   - POST /v1/responses with model='o3-deep-research', background=true
//   - GET  /v1/responses/{id} for polling
//   - Tool param: { type: 'web_search_preview' } — NOT 'web_search'
//   - Status enum: queued | in_progress | completed | failed | expired
//   - Usage shape: { input_tokens, output_tokens, cache_read_input_tokens,
//                    cache_creation_input_tokens }
//   - Output: array of { type: 'message' | 'web_search_call' | ... };
//             message items carry content[type='output_text'].text +
//             annotations[].url for citations
//
// Cost model: token-based, computed from sentinel-flag rate table. Missing
// usage on a completed response → OpenAIError(422), matching Perplexity's
// MISSING_COST_STATUS contract. NEVER silently $0.

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

const OPENAI_BASE_URL = 'https://api.openai.com';
const OPENAI_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 4 * 60 * 1000;
const TIMEOUT_STATUS = 408;
const MISSING_USAGE_STATUS = 422;
const MAX_OUTPUT_TOKENS_CEILING = 100_000;  // o3-deep-research published max

interface OpenAIRates {
  input_per_million: number;
  cached_per_million: number;
  output_per_million: number;
  // Per-tool-call fee for web_search_preview, charged on TOP of the token
  // cost (the retrieved-content tokens are billed at the model's regular
  // input rate AND we owe this flat fee per invocation). With our fixed
  // max_tool_calls=100 (D6), worst-case is $1.00 of unrecovered cost per
  // o3-deep-research call if this field is omitted.
  search_per_thousand_calls: number;
}
// Verified against developers.openai.com/api/docs/models/o3-deep-research
// on 2026-06-03 (the MODEL-specific page, not the aggregated pricing index).
// o3-deep-research has its own dedicated pricing distinct from gpt-4o /
// o-series chat models — this rate table applies ONLY to the deep_research
// tool path; the LLMClient that handles agent execution against OpenAI
// chat completions uses src/llm/pricing.ts and is intentionally unaffected.
//   Standard tier: input $10/M, cached $2.50/M, output $40/M
//   Batch tier:    same rates published (no batch discount on this model)
// Web search preview per-call fee from the aggregated pricing page —
// model-specific page says "fee per tool call" without a model-specific
// amount; the general "reasoning models" rate of $10 / 1,000 calls applies.
const RATE_DEFAULTS: OpenAIRates = {
  input_per_million: 10,
  cached_per_million: 2.5,
  output_per_million: 40,
  search_per_thousand_calls: 10,
};
const isOpenAIRates = (v: unknown): v is OpenAIRates =>
  typeof v === 'object' && v !== null
    && typeof (v as Record<string, unknown>).input_per_million === 'number'
    && typeof (v as Record<string, unknown>).cached_per_million === 'number'
    && typeof (v as Record<string, unknown>).output_per_million === 'number'
    && typeof (v as Record<string, unknown>).search_per_thousand_calls === 'number';

// D6: OpenAI o3-deep-research only backs the `high` tier of `reasoning_effort`
// (and as fallback for `highest`). `max_tool_calls` is therefore fixed at the
// "high"-equivalent setting; not exposed as a dial. Higher counts cap at 100
// per OpenAI's published o3-deep-research API.
const OPENAI_MAX_TOOL_CALLS = 100;

// Pre-charge ceiling for the `high` tier. Single value because OpenAI is
// only ever called at this tier (D6). Operator override:
// `web_fetch_openai_precharge_micros_high_value`.
const PRECHARGE_HIGH_USD = 3.0;

export class OpenAIError extends Error {
  constructor(message: string, public readonly statusCode: number, public readonly body?: unknown) {
    super(message); this.name = 'OpenAIError';
  }
}

export interface OpenAIUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}
interface OpenAIAnnotation { url?: string; title?: string; start_index?: number; end_index?: number; }
interface OpenAIOutputTextContent { type: 'output_text'; text: string; annotations?: OpenAIAnnotation[]; }
interface OpenAIOutputItem {
  type: 'message' | 'web_search_call' | 'code_interpreter_call' | 'file_search_call' | string;
  content?: OpenAIOutputTextContent[];
}
export interface OpenAIResponse {
  id: string;
  status: 'queued' | 'in_progress' | 'completed' | 'failed' | 'expired';
  usage?: OpenAIUsage;
  output?: OpenAIOutputItem[];
  error?: { message: string; type?: string; code?: string };
}

/**
 * Compute exact cost in micros from an OpenAI o3-deep-research response.
 * Used by both OpenAIClient (hook path) and the deep_research reconciler
 * (recovery path) so both routes share one source of truth for the rate
 * table + rounding.
 *
 * Cost components (all summed):
 *   1. Token cost: (input − cached) × input_rate + cached × cached_rate
 *      + output × output_rate. All rates per 1M tokens.
 *   2. Per-tool-call fee for web_search_preview: searchCallCount ×
 *      search_per_thousand_calls / 1000. The retrieved-content tokens
 *      that web_search returns are already counted in `usage.input_tokens`
 *      and billed at the model's regular input rate — this flat fee is
 *      OWED ON TOP of that.
 *
 * Throws OpenAIError(422) on missing usage or non-finite/negative cost —
 * matches Perplexity's MISSING_COST_STATUS contract so the reconciler can
 * leave the row unresolved on partial responses instead of recording a
 * fabricated cost.
 */
export async function computeOpenAICostMicros(
  usage: OpenAIUsage | undefined,
  searchCallCount = 0,
): Promise<number> {
  if (!usage) {
    throw new OpenAIError('missing usage on OpenAI response', 422);
  }
  const rates = await readTypedFlag('web_fetch_openai_rates_v1', isOpenAIRates, RATE_DEFAULTS);
  const cached = usage.cache_read_input_tokens ?? 0;
  const uncached = Math.max(0, usage.input_tokens - cached);
  const tokenUsd =
    (uncached * rates.input_per_million +
      cached * rates.cached_per_million +
      usage.output_tokens * rates.output_per_million) / 1_000_000;
  const searchUsd = (searchCallCount * rates.search_per_thousand_calls) / 1_000;
  const usd = tokenUsd + searchUsd;
  if (!Number.isFinite(usd) || usd < 0) {
    throw new OpenAIError(
      `OpenAI computed non-finite/negative cost from usage=${JSON.stringify(usage)} searchCallCount=${searchCallCount}`,
      422,
    );
  }
  return Math.round(usd * 1_000_000);
}

export class OpenAIClient implements WebFetchAdvancedClient {
  readonly vendor = 'openai' as const;
  private apiKey: string | null = null;

  supportsSessions(): boolean { return false; }

  // fetch() is required by WebFetchAdvancedClient but unused — OpenAI never
  // appears in the fetch/extract/research chains. Throw 501 (not 0) so an
  // accidental invocation surfaces non-transient (router won't mark vendor
  // health failed, matches the Exa precedent for 400 on session params).
  async fetch(_req: WebFetchAdvancedRequest): Promise<InternalWebFetchAdvancedResult> {
    void _req;
    throw new OpenAIError('OpenAI client does not implement web_fetch_advanced', 501);
  }

  private async key(): Promise<string> {
    if (this.apiKey) return this.apiKey;
    const k = await getWebToolSecret('openai-api-key');
    if (!k) throw new Error('openai-api-key not configured');
    this.apiKey = k;
    return k;
  }

  async deepResearch(
    req: WebDeepResearchRequest,
    hooks?: DeepResearchHooks,
  ): Promise<InternalWebDeepResearchResult> {
    const startMs = Date.now();
    const deepResearchId = randomUUID();
    // We use the global DEEP_RESEARCH_MAX_WAIT_MS (60 min after D15 bump) as
    // the ceiling; OpenAI typically completes in 5-15 min.
    const maxWaitMs = req.maxWaitMs ?? 60 * 60 * 1000;

    // 1. Submit. D6: max_tool_calls is fixed at 100 — OpenAI o3-deep-research
    // only backs the `high` tier (and `highest` fallback); not a dial.
    const submission = await this.call<{ id: string }>('/v1/responses', {
      model: 'o3-deep-research',
      input: req.question,
      background: true,
      tools: [{ type: 'web_search_preview' }],          // verified API ref
      reasoning: { summary: 'auto' },                    // o3-deep-research uses summary, not effort
      max_tool_calls: OPENAI_MAX_TOOL_CALLS,
      max_output_tokens: MAX_OUTPUT_TOKENS_CEILING,
    });

    // 2. Compute estimate (shared between registry write + pre-charge hook).
    // Vendor-internal reasoning_effort is always 'high' for OpenAI (D6).
    const estimateCostMicros = await this.estimatePrechargeMicros();

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
          vendor:             'openai',
          reasoningEffort:    'high',
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
        vendor: 'openai',
        reasoningEffort: 'high',
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
    let final: OpenAIResponse | null = null;
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

      const status = await this.call<OpenAIResponse>(`/v1/responses/${submission.id}`, undefined, 'GET');
      if (status.status === 'completed' || status.status === 'failed' || status.status === 'expired') {
        final = status;
        break;
      }
    }

    // 6. Timeout — NO completion event (upstream still billing us).
    //    markPolled here pushes last_polled_at forward so the reconciler
    //    waits the full adaptive interval before re-polling OpenAI (we
    //    polled at the very end of the 60min ceiling — unlikely to flip
    //    in the next 60s).
    if (!final) {
      if (req.tenantId) {
        markPolled(deepResearchId).catch((err: Error) => logger.warn({
          err: err.message, deep_research_id: deepResearchId,
        }, 'deep_research_markpolled_failed'));
      }
      throw new OpenAIError(
        `o3-deep-research exceeded ${maxWaitMs}ms (request ${submission.id})`,
        TIMEOUT_STATUS,
      );
    }

    // 7. Failed/expired — refund full estimate, fire onCompletion(FAILED),
    //    finalize the registry row, throw.
    if (final.status !== 'completed') {
      if (hooks?.onCompletion) {
        hooks.onCompletion({
          deepResearchId,
          vendor: 'openai',
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
      const code = final.status === 'expired' ? TIMEOUT_STATUS : 500;
      throw new OpenAIError(
        `o3-deep-research ${final.status}: ${final.error?.message ?? 'unknown'}`,
        code,
      );
    }

    // 7a. Completed but contract break — missing usage. Match Perplexity's
    //     MISSING_COST_STATUS pattern: throw 422 WITHOUT firing onCompletion
    //     and WITHOUT finalizing the registry row. The reconciler will
    //     re-poll and either pick up a later resolved response or hit the
    //     24h abandonment cutoff (refund). Firing a FAILED refund here
    //     would be wrong (OpenAI WILL bill us for the successful call);
    //     pretending it was a normal completion would under-bill the OU
    //     ledger silently. 422 surfaces the contract break for operators.
    if (!final.usage) {
      throw new OpenAIError(
        `o3-deep-research completed without usage on response ${submission.id} (contract break)`,
        MISSING_USAGE_STATUS,
      );
    }

    // 8. Completed — exact cost from tokens, finalize registry idempotently.
    const actualCostMicros = await this.computeCostMicros(final.usage, countSearchCalls(final));
    if (hooks?.onCompletion) {
      hooks.onCompletion({
        deepResearchId,
        vendor: 'openai',
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
      vendor: 'openai',
      costMicros: actualCostMicros,
      deepResearchId,
      usage: {
        prompt_tokens:      final.usage.input_tokens,
        completion_tokens:  final.usage.output_tokens,
        citation_tokens:    0,
        reasoning_tokens:   0,
        num_search_queries: countSearchCalls(final),
      },
      durationMs: Date.now() - startMs,
    };
  }

  private async computeCostMicros(usage: OpenAIUsage, searchCallCount: number): Promise<number> {
    return computeOpenAICostMicros(usage, searchCallCount);
  }

  private async estimatePrechargeMicros(): Promise<number> {
    const flags = await getCachedSentinelFlags();
    const v = flags['web_fetch_openai_precharge_micros_high_value'];
    if (typeof v === 'number' && v > 0) return v;
    return Math.round(PRECHARGE_HIGH_USD * 1_000_000);
  }

  protected async call<T>(path: string, body?: unknown, method: 'GET' | 'POST' = 'POST'): Promise<T> {
    const apiKey = await this.key();
    let res: Response;
    try {
      res = await fetch(`${OPENAI_BASE_URL}${path}`, {
        method,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        ...(method === 'POST' && body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
      });
    } catch (e) {
      throw new OpenAIError(`Network: ${(e as Error).message}`, 0);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new OpenAIError(`OpenAI ${res.status}: ${text.slice(0, 500)}`, res.status, text);
    }
    return res.json() as Promise<T>;
  }
}

function extractText(r: OpenAIResponse): string {
  if (!r.output) return '';
  // Find the LAST `message` item; concatenate its output_text content.
  for (let i = r.output.length - 1; i >= 0; i--) {
    const item = r.output[i];
    if (item.type === 'message' && item.content) {
      return item.content
        .filter((c): c is OpenAIOutputTextContent => c.type === 'output_text')
        .map(c => c.text)
        .join('\n');
    }
  }
  return '';
}

function extractCitations(r: OpenAIResponse): Array<{ url: string; title?: string; date?: string }> {
  if (!r.output) return [];
  const out: Array<{ url: string; title?: string; date?: string }> = [];
  for (const item of r.output) {
    if (item.type !== 'message' || !item.content) continue;
    for (const c of item.content) {
      if (c.type !== 'output_text' || !c.annotations) continue;
      for (const a of c.annotations) {
        if (a.url) out.push({ url: a.url, title: a.title });
      }
    }
  }
  return out;
}

export function countSearchCalls(r: OpenAIResponse): number {
  return (r.output ?? []).filter(i => i.type === 'web_search_call').length;
}
