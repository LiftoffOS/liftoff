// LLM client for the workforce service.
//
// Routes all LLM calls through Platform Backend's internal relay endpoint
// (POST /api/internal/llm/complete) rather than calling the Anthropic SDK
// directly. This gives the workforce service access to PB's unified provider
// routing, API key pool, usage tracking, and tier-based model selection.
//
// Callers see the same interface as before — complete() for single-turn
// calls, callPBLlmComplete() for the CAIO tool-use loop.

import type { LLMWireResponseSchema } from '@liftoffos/shared-types';

export type LLMTier = 'flagship' | 'medium' | 'small';

export interface LLMCompleteParams {
  systemPrompt: string;
  userContent: string;
  tier: LLMTier;
  maxTokens: number;
  /** Forces the model to answer through a single tool call matching this JSON
   *  schema, so the response is guaranteed-valid JSON rather than prose the
   *  caller has to parse. Platform-backend's llmClient turns this into the
   *  provider's structured-output path. Use it whenever you are about to
   *  JSON.parse a completion. */
  /** Canonical shape from @liftoffos/shared-types. Hand-written here until
   *  the contract was published: this service's copy happened to be right,
   *  harvest-service's was not (it omitted `name`, which the relay turns
   *  into tool_choice.name — the provider rejected every such call). */
  responseSchema?: LLMWireResponseSchema;
  /** Tenant the call belongs to, for cost attribution on llm_usage_log. */
  tenantId?: string;
  /** Cost-attribution bucket for the resulting llm_usage_log row. Defaults
   *  to 'caio_workforce_planning' so a missed override lands in the correct
   *  workforce-planning category (rather than the legacy 'title_generation'
   *  bucket that pre-dates this service). */
  purpose?: string;
}

// ── PB relay message shapes ────────────────────────────────────────────────

interface PBLLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** Marks this message as a prompt-cache breakpoint: the relay forwards it to
   *  platform-backend's llmClient, whose Anthropic providers cache everything up
   *  to and including the marked block. OpenAI and Google cache the identical
   *  prefix on their own and ignore the field. Set only where the bytes up to
   *  the mark are a prefix of the next call's — a mark on content that is
   *  rewritten between calls buys a cache write every time and never a read. */
  cacheControl?: { type: 'ephemeral' };
  toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  toolResults?: Array<{ toolCallId: string; content: string }>;
  /** Images this user turn carries. The relay hands them to whichever provider
   *  it resolves, which builds the vendor's own image block; this side never
   *  sees a vendor shape. Only ever set when the control plane's registry says
   *  the resolved model can see one. */
  images?: Array<{ mimeType: string; dataBase64: string; alt?: string }>;
}

interface PBLLMResponse {
  content: string;
  model: string;
  provider: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    /** The whole prompt this call carried, as the provider counts it (for
     *  Anthropic the uncached input plus the cache reads and writes; for
     *  OpenAI and Google the prompt count, which already includes the cached
     *  part). Absent from a relay older than the field. */
    contextTokens?: number;
  };
  toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  stopReason?: string;
  /** The context window of the model that served the call, from the
   *  control plane's registry. Absent from a relay older than the field.
   *  ALWAYS a number when present: the control plane substitutes its
   *  conservative fallback for a model the registry has not sized. */
  contextWindow?: number;
  /** The RECORDED window — present only when the registry actually holds one
   *  for the served model, and absent both for an unsized model and for a
   *  relay older than the field. The two are a different claim, and only this
   *  one may ever drive a destructive decision. */
  contextWindowRecorded?: number;
}

// ── CAIO conversation content block shapes (Anthropic-compatible) ──────────

interface TextBlock { type: 'text'; text: string }
interface ToolUseBlock { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
interface ToolResultBlock { type: 'tool_result'; tool_use_id: string; content: string }
/** An image on a user turn. Mirrors LLMImageBlock in ../llm/types.ts, which is
 *  what callers construct; this local copy exists because every other block
 *  shape in this file is local too. */
interface ImageBlock { type: 'image'; mimeType: string; dataBase64: string; alt?: string }
type AnyContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ImageBlock;

/** Shape returned to the CAIO tool-use loop — matches the AnthropicMessage
 *  interface defined locally in chat-service.ts so no changes are needed there. */
export interface AnthropicMessageResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: Array<TextBlock | ToolUseBlock>;
  model: string;
  stop_reason: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    /** The prompt this call carried, whole, as the relay's provider counted
     *  it. Undefined when the relay did not say, and the loop's context guard
     *  then stays inert rather than tripping on zero. */
    context_tokens?: number;
  };
  /** The served model's context window, from the relay. Undefined when the
   *  relay did not say. Carries the control plane's conservative fallback for
   *  a model the registry has not sized. */
  context_window?: number;
  /** The RECORDED window, present only when the registry holds one. The
   *  shared bound policy reads this so it can tell a real window from a
   *  guess; a relay older than the field leaves it undefined, and the policy
   *  then falls back exactly as the control plane would have. */
  context_window_recorded?: number;
}

import { loadConfig } from '../infrastructure/config.js';
import { WEB_SERVER_TOOLS } from '@liftoffos/shared-types';

// ── HTTP helpers ─────────────────────────────────────────────────────────

function getPlatformBackendUrl(): string {
  return loadConfig().PLATFORM_BACKEND_URL.replace(/\/$/, '');
}

function getServiceToken(): string {
  return process.env['WORKFORCE_SERVICE_TOKEN'] ?? '';
}

// Anthropic occasionally returns 529 (Overloaded), 503, 502, 504 under load.
// PB forwards these as-is. A single transient blip would otherwise terminate
// an HRBP run mid-loop and leave the spec un-provisioned — so retry with
// exponential backoff + jitter on these statuses and on network errors.
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504, 529]);
const MAX_RETRIES = 4;
const BASE_DELAY_MS = 500;

function backoffMs(attempt: number): number {
  const base = BASE_DELAY_MS * 2 ** attempt;
  const jitter = Math.random() * base;
  return Math.min(base + jitter, 8_000);
}

/** Backoff sleep that wakes early when the caller aborts, so a stop is not
 *  swallowed by an 8-second wait between retries. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function callPBEndpoint(
  body: {
    request: {
      messages: PBLLMMessage[];
      tier?: LLMTier;
      maxTokens?: number;
      tools?: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
      /** Provider-executed tools (web_search, web_fetch). The relay forwards
       *  the request whole, so these reach PB's llmClient unchanged. */
      serverTools?: ReadonlyArray<{ name: string }>;
      /** Canonical shape from @liftoffos/shared-types. Hand-written here until
   *  the contract was published: this service's copy happened to be right,
   *  harvest-service's was not (it omitted `name`, which the relay turns
   *  into tool_choice.name — the provider rejected every such call). */
  responseSchema?: LLMWireResponseSchema;
    };
    usageContext?: Record<string, string>;
  },
  /** Cancels the call and the retry chain. A user stop (ADR-041) fires this, so
   *  Stop takes effect in seconds rather than waiting out four attempts backing
   *  off to 8s each. */
  signal?: AbortSignal,
): Promise<PBLLMResponse> {
  const url = `${getPlatformBackendUrl()}/api/internal/llm/complete`;
  let lastErr: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal?.aborted) {
      throw new Error('PB LLM relay: aborted');
    }
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Service-Auth': getServiceToken(),
        },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
      if (res.ok) return res.json() as Promise<PBLLMResponse>;

      const text = await res.text().catch(() => '');
      // PB returns the upstream Anthropic status code; the same body usually
      // contains overloaded_error / rate_limit_error for 429/529.
      const isUpstreamOverload = /529|overloaded_error/i.test(text);
      const retryable = RETRYABLE_STATUSES.has(res.status) || isUpstreamOverload;
      lastErr = new Error(`PB LLM relay error ${res.status}: ${text}`);
      if (!retryable || attempt === MAX_RETRIES) throw lastErr;
    } catch (err) {
      // An aborted call is not a transient failure — do not retry it.
      if (signal?.aborted || (err as Error).name === 'AbortError') {
        throw err;
      }
      // Network / fetch-level errors: retry up to MAX_RETRIES.
      if (lastErr && lastErr === err) {
        // already a retryable HTTP error captured above — fall through to sleep
      } else {
        lastErr = err as Error;
        if (attempt === MAX_RETRIES) throw lastErr;
      }
    }
    await sleep(backoffMs(attempt), signal);
  }

  throw lastErr ?? new Error('PB LLM relay: exhausted retries');
}

// ── Conversation format conversion ─────────────────────────────────────────

function convertConversationToPBMessages(
  systemPrompt: string,
  conversation: Array<{ role: 'user' | 'assistant'; content: string | AnyContentBlock[] }>,
): PBLLMMessage[] {
  // The CAIO's system prompt is the longest constant part of a planning turn and
  // is re-sent on every round of the tool-use loop, so it carries a cache
  // breakpoint. The conversation below it is append-only within a turn — each
  // round adds the model's reply and its tool results and rewrites nothing —
  // so the last message carries a second one: the provider looks back from it
  // for the longest prefix it already holds, which is exactly the previous
  // round's mark, and reads that instead of being billed the whole
  // conversation again. Without it every round paid for every earlier round's
  // results in full: a turn of ten rounds over a page of records cost ten
  // times the page.
  const messages: PBLLMMessage[] = [
    { role: 'system', content: systemPrompt, cacheControl: { type: 'ephemeral' } },
  ];

  for (const msg of conversation) {
    if (typeof msg.content === 'string') {
      messages.push({ role: msg.role, content: msg.content });
      continue;
    }

    const blocks = msg.content as AnyContentBlock[];

    if (msg.role === 'assistant') {
      const text = blocks
        .filter((b): b is TextBlock => b.type === 'text')
        .map(b => b.text)
        .join('');
      const toolCalls = blocks
        .filter((b): b is ToolUseBlock => b.type === 'tool_use')
        .map(b => ({ id: b.id, name: b.name, input: b.input }));
      const m: PBLLMMessage = { role: 'assistant', content: text };
      if (toolCalls.length > 0) m.toolCalls = toolCalls;
      messages.push(m);
    } else {
      // user turn — may carry tool_result blocks
      const toolResults = blocks
        .filter((b): b is ToolResultBlock => b.type === 'tool_result')
        .map(b => ({ toolCallId: b.tool_use_id, content: b.content }));
      if (toolResults.length > 0) {
        messages.push({ role: 'user', content: '', toolResults });
      } else {
        const text = blocks
          .filter((b): b is TextBlock => b.type === 'text')
          .map(b => b.text)
          .join('');
        // Images ride the user turn beside its text. Carried explicitly rather
        // than filtered away: a block this function does not recognise
        // disappears, and a disappeared picture lets the model answer about one
        // it never received.
        const images = blocks
          .filter((b): b is ImageBlock => b.type === 'image')
          .map(b => ({ mimeType: b.mimeType, dataBase64: b.dataBase64, ...(b.alt ? { alt: b.alt } : {}) }));
        const m: PBLLMMessage = { role: 'user', content: text };
        if (images.length > 0) m.images = images;
        messages.push(m);
      }
    }
  }

  if (messages.length > 1) {
    messages[messages.length - 1] = { ...messages[messages.length - 1], cacheControl: { type: 'ephemeral' } };
  }
  return messages;
}

// ── Public API ─────────────────────────────────────────────────────────────

/** Single-turn text completion — used by title generation, summarization, etc. */
export async function complete(params: LLMCompleteParams): Promise<string> {
  const messages: PBLLMMessage[] = [
    // Single-turn callers (thread titling) hand over one constant instruction
    // and one turn of content, so the whole instruction is a cacheable prefix.
    { role: 'system', content: params.systemPrompt, cacheControl: { type: 'ephemeral' } },
    { role: 'user', content: params.userContent },
  ];
  const data = await callPBEndpoint({
    request: {
      messages,
      tier: params.tier,
      maxTokens: params.maxTokens,
      ...(params.responseSchema ? { responseSchema: params.responseSchema } : {}),
    },
    usageContext: {
      purpose: params.purpose ?? 'caio_workforce_planning',
      // Without this the call lands in llm_usage_log with no tenant, so its
      // cost never reaches the workspace that incurred it.
      ...(params.tenantId ? { tenantId: params.tenantId } : {}),
    },
  });
  return data.content ?? '';
}


/** Multi-turn CAIO tool-use loop completion.
 *  Accepts the conversation in Anthropic-native format, converts to PB's LLMMessage
 *  format, routes through PB's llmClient, and returns an Anthropic-compatible response. */
export async function callPBLlmComplete(params: {
  systemPrompt: string;
  conversation: Array<{ role: 'user' | 'assistant'; content: string | AnyContentBlock[] }>;
  tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  maxTokens: number;
  tenantId: string;
  tier?: LLMTier;
  purpose?: string;
  /** Cancels the call when somebody stops the turn (ADR-041). */
  signal?: AbortSignal;
}): Promise<AnthropicMessageResponse> {
  const messages = convertConversationToPBMessages(params.systemPrompt, params.conversation);
  const data = await callPBEndpoint(
    {
      request: {
        messages,
        tier: params.tier ?? 'medium',
        maxTokens: params.maxTokens,
        ...(params.tools.length > 0 ? { tools: params.tools } : {}),
        // Provider-executed web tools, so the CAIO can read a page it is asked
        // about instead of answering that it cannot. PB's relay validates the
        // request's SHAPE and forwards it whole, so this reaches llmClient
        // untouched and every provider merges it for itself.
        //
        // The list is @liftoffos/shared-types' — the same value platform-backend
        // gives Liftoff and the Insights Manager, so the three assistants cannot
        // drift apart.
        serverTools: WEB_SERVER_TOOLS,
      },
      usageContext: {
        purpose: params.purpose ?? 'caio_workforce_planning',
        tenantId: params.tenantId,
      },
    },
    params.signal,
  );

  return {
    id: `pb-llm-${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content: [
      ...(data.content ? [{ type: 'text' as const, text: data.content }] : []),
      ...(data.toolCalls ?? []).map(tc => ({
        type: 'tool_use' as const,
        id: tc.id,
        name: tc.name,
        input: tc.input,
      })),
    ],
    model: data.model,
    stop_reason: data.stopReason ?? 'end_turn',
    usage: {
      input_tokens: data.usage?.inputTokens ?? 0,
      output_tokens: data.usage?.outputTokens ?? 0,
      ...(typeof data.usage?.contextTokens === 'number' ? { context_tokens: data.usage.contextTokens } : {}),
    },
    ...(typeof data.contextWindow === 'number' ? { context_window: data.contextWindow } : {}),
    ...(typeof data.contextWindowRecorded === 'number' ? { context_window_recorded: data.contextWindowRecorded } : {}),
  };
}

/** @deprecated No longer needed — kept for backward compatibility during transition.
 *  Direct callers should use callPBLlmComplete() instead. */
export async function getLlmClient(): Promise<never> {
  throw new Error('getLlmClient() is deprecated — use callPBLlmComplete() instead');
}

/** @deprecated Only for test teardown compatibility. */
export function resetLlmClientForTests(): void {
  // no-op
}
