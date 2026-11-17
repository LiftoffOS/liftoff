// Gemini VendorSdkAdapter — built directly on the official Google Gen AI SDK
// (`@google/genai`) over Vertex AI (ADC). We do NOT use Google ADK: ADK's
// OpenTelemetry-2.x dependency tree conflicts with this repo's pinned OTel-1.x
// observability stack, and ADK only adds loop/session orchestration our
// VendorSdkAdapter contract already provides. @google/genai is light (no OTel),
// already in the dependency tree via @google-cloud/vertexai, and exposes the
// same native web tools (googleSearch / urlContext) plus function calling.
//
// Structurally parallel to the OpenAI adapter:
//   - Tool catalog → genai `functionDeclarations`; execution dispatches through
//     the in-process tool-gateway via mcp-bridge.ts (dispatchFunctionCall),
//     which runs the HITL gate then calls the MCP tool.
//   - Native web   → googleSearch + urlContext built-in tools (default-on).
//   - HITL         → dispatchFunctionCall sets pendingHitlGate on an oversight
//     `hitlPause`; the loop stops and emits pause_requested (mirrors OpenAI).
//   - Pause/resume → serialize the InvocationInput and re-invoke with the
//     response appended (fresh request each time) — no SDK session dependency.
//
// We hand-roll the agentic loop (call model → dispatch tool calls → feed
// functionResponses back → repeat until no calls). Requires Gemini 3.x, where
// built-in tools and custom functionDeclarations coexist. Vertex/ADC env:
// project/location from GCP_PROJECT_ID / GCP_LOCATION (the repo convention the
// deploy sets; GOOGLE_CLOUD_PROJECT / GOOGLE_CLOUD_LOCATION accepted as fallback).
//
// BYO PROVIDER KEYS: not wired here, by scope rather than by obstacle. Google
// BYOK is deliberately limited to the llmClient path, so a workspace's Gemini
// AGENT TURNS run on Liftoff's Vertex project even when the workspace has a
// service account on file, and bill as ordinary customer consumption.
//
// Nothing technical stands in the way if that scope widens. The customer's
// credential is a Vertex service account and Vertex is the same service this
// adapter already speaks, so the change is a base URL and a header on the
// GoogleGenAI construction below — `httpOptions: { baseUrl, headers: {
// [BYOK_TOKEN_HEADER]: token } }` with the customer's project and location —
// plus threading `input.byok` in. The gateway already substitutes Liftoff's own
// credential when a customer's is declined, so no fallback would be needed here.

import { forcingDirectiveForRequest, googleAllowedFunctionNames } from '../grounding-forcing';
import { roundIsTerminal, logTurnClosed } from '../../terminal-tools';
import {
  GoogleGenAI,
  FinishReason,
  type Content,
  type Part,
  type Tool,
  type FunctionCall,
  type FunctionDeclaration,
  type GenerateContentResponse,
  FunctionCallingConfigMode,
} from '@google/genai';
import type {
  VendorSdkAdapter,
  InvocationInput,
  InvocationEvent,
  PlatformMessage,
  PlatformContent,
  UserMessage,
  UserResponse,
  PauseReason,
  ResumeToken,
  HitlGate,
  AnomalyHandler,
  ToolBatchHandler,
  AdapterUsage,
  ToolResultObserver,
} from '../types';
import type { McpToolCatalog } from '../catalog-types';
import { dispatchFunctionCall, type BridgeContext } from '../mcp-bridge';
import { getMcpClientPool } from '../mcp-client-pool';
import { extractProviderFailure, classifyProviderFailure } from '../provider-failure';

// `global` is the Vertex meta-endpoint that routes to wherever the requested
// Gemini model is served. Empirically it is the only location that serves any
// Gemini 3 model for the YOUR_TENANT_PROJECT{dev,prod} projects today (us-west1 /
// us-central1 return 404 for every Gemini 3 model), and newly-enabled Gemini
// models surface there. GCP_LOCATION is not set on the deployment, so this
// default is what actually applies; set GCP_LOCATION to override per-region.
const DEFAULT_LOCATION = 'global';
// Bound the in-adapter tool-call loop (each iteration is one model turn) when
// the run carries no budget of its own. The run's `maxTurns` (the tenant's
// maxToolCalls, role-clamped by the engine) governs when it is given; this is
// the safety stop for a caller that passes none.
const MAX_TOOL_ITERATIONS = 50;

// Finish reasons that are a normal end-of-turn (answer produced, or token cap
// hit with usable output). Anything else — SAFETY / RECITATION / BLOCKLIST /
// PROHIBITED_CONTENT / SPII / MALFORMED_FUNCTION_CALL / etc. — is a blocked or
// abnormal stop that must surface as an anomaly, not a silent success.
const NORMAL_FINISH_REASONS: ReadonlySet<FinishReason> = new Set([
  FinishReason.STOP,
  FinishReason.FINISH_REASON_UNSPECIFIED,
]);

/** MAX_TOKENS is not "normal" and not a fault: the model was cut off with more
 *  to say. Counting it as a clean stop recorded a truncated answer as a
 *  finished one — the same mistake Anthropic's `error_max_turns` produced from
 *  the opposite direction, where a working run was recorded as a crash. */
const LIMIT_FINISH_REASONS: ReadonlySet<FinishReason> = new Set([
  FinishReason.MAX_TOKENS,
]);

export class GeminiAdapter implements VendorSdkAdapter {
  // Matches the resolved provider string ('google') so cross-adapter consumers
  // can assert adapter.kind === resolvedProvider uniformly across all three
  // adapters. AnthropicAdapter uses 'anthropic'; OpenAIAdapter uses 'openai'.
  readonly kind = 'google';
  private catalog: McpToolCatalog | null = null;
  private hitlGate: HitlGate | null = null;
  private anomalyHandler: AnomalyHandler | null = null;
  private toolBatchHandler: ToolBatchHandler | null = null;
  private toolResultObserver: ToolResultObserver | null = null;
  /** The calls the bridge handed to the observer and had confirmed remembered. */
  private recordedCalls = new Set<string>();
  /** Part 6 — set by registerTrajectoryRecorder; null when sink is disabled. */
  private recorder: import('../types').TrajectoryRecorder | null = null;
  private currentInvocation: InvocationInput | null = null;
  private injected: UserMessage[] = [];
  private paused = false;

  async *invoke(input: InvocationInput, signal: AbortSignal): AsyncIterable<InvocationEvent> {
    if (!this.catalog) throw new Error('Tool catalog not registered');
    const catalog = this.catalog;
    this.currentInvocation = input;
    this.paused = false;
    this.injected = [];

    const internalAbort = new AbortController();
    const onOuterAbort = () => internalAbort.abort();
    if (signal.aborted) internalAbort.abort();
    else signal.addEventListener('abort', onOuterAbort, { once: true });

    this.recordedCalls = new Set();
    const bridgeContext: BridgeContext = {
      tenantId: input.tenantId,
      invocationId: input.invocationId,
      hitlGate: this.hitlGate,
      anomalyHandler: this.anomalyHandler,
      toolResultObserver: this.toolResultObserver,
      recordedCalls: this.recordedCalls,
      pendingHitlGate: null,
      abort: () => internalAbort.abort(),
      onRecoveryInject: (text) => { this.injected.push({ text, source: 'system' }); },
    };

    // Vertex AI via ADC. Project/location come from the repo-standard env vars
    // — GCP_PROJECT_ID / GCP_LOCATION are what the Cloud Run deploy actually
    // sets, and what src/llm/providers/google.ts and src/memory/embedding.ts
    // read. We fall back to genai's native GOOGLE_CLOUD_* names (handy for local
    // runs), and finally to genai's own metadata-server resolution when all are
    // undefined. We deliberately do NOT hard-guard — that preserves the Cloud
    // Run path and lets genai raise its own clear error if nothing resolves.
    const project = process.env.GCP_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT;
    const location =
      process.env.GCP_LOCATION ??
      process.env.VERTEX_LOCATION ??
      process.env.GOOGLE_CLOUD_LOCATION ??
      DEFAULT_LOCATION;
    const ai = new GoogleGenAI({ vertexai: true, project, location });

    // MCP tools emit standard JSON Schema → use `parametersJsonSchema` (raw
    // JSON Schema), NOT `parameters` (genai's OpenAPI Schema with uppercase
    // Type enums). The two are mutually exclusive; using `parameters` here
    // would feed Gemini a malformed declaration.
    const functionDeclarations: FunctionDeclaration[] = catalog.tools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      parametersJsonSchema: t.inputSchema,
    }));
    // Native web search/fetch default-on (Gemini 3.x coexists built-ins + fns).
    const tools: Tool[] = [
      ...(functionDeclarations.length > 0 ? [{ functionDeclarations }] : []),
      { googleSearch: {} },
      { urlContext: {} },
    ];

    const contents: Content[] = platformMessagesToContents(input.messages);
    const terminal = new Set(input.terminalToolNames ?? []);

    // The run's own turn budget reaches this engine here; the constant is the
    // fallback for a caller that passes none.
    const maxIterations = typeof input.maxTurns === 'number' && input.maxTurns > 0
      ? input.maxTurns
      : MAX_TOOL_ITERATIONS;

    try {
      for (let iteration = 0; iteration < maxIterations; iteration++) {
        // Stream the model turn: emit `assistant_delta` per text chunk while
        // accumulating the full content. Candidate parts are collected VERBATIM
        // across chunks so Gemini-3 `thoughtSignature` parts (on functionCall /
        // thinking parts) replay correctly — rebuilding them 400s the next
        // request with "missing thought_signature". (Verified live on Vertex.)
        let fullText = '';
        const aggregatedParts: Part[] = [];
        const aggregatedCalls: FunctionCall[] = [];
        let lastUsage: GenerateContentResponse['usageMetadata'];
        let groundingQueries = 0;
        let finishReason: FinishReason | undefined;
        let modelRole = 'model';
        try {
          // ROUND 0 ONLY. `mode: ANY` on every iteration forces a call on
          // every iteration: the model cannot answer, only search again, and a
          // turn can repeat the same search until the vendor returns 429. The Agents SDK reverts its toolChoice after
          // the first call (`resetToolChoice`); this hand-rolled loop has to.
          const forcedFunctionNames = input.groundingToolName && iteration === 0
            ? googleAllowedFunctionNames(
              forcingDirectiveForRequest('google-genai', input.groundingToolName, input.invocationId),
            )
            : null;
          const stream = await ai.models.generateContentStream({
            model: input.model,
            contents,
            config: {
              systemInstruction: input.systemPrompt,
              tools,
              // Native forcing on the round-0 request, when a groundsOn rule
              // matched. An OPTIMISATION over the grounding floor: the host has
              // already prefetched that read and appended it, so this only lets
              // the model author the query itself. We hand-roll this loop, so
              // it is one request field.
              // The adapter owns the vendor mapping: `grounding-forcing` says
              // WHICH function to restrict to, and this file is the layer
              // allowed to know that Google spells that
              // `FunctionCallingConfigMode.ANY`. The enum, not the string
              // 'ANY' — a literal is not what the wire expects, so forcing
              // would silently not happen while the request still succeeded.
              ...(forcedFunctionNames
                ? {
                  toolConfig: {
                    functionCallingConfig: {
                      mode: FunctionCallingConfigMode.ANY,
                      allowedFunctionNames: forcedFunctionNames,
                    },
                  },
                }
                : {}),
              abortSignal: internalAbort.signal,
            },
          });
          for await (const chunk of stream) {
            if (signal.aborted) { yield { type: 'completion', outcome: 'error', reason: 'aborted' }; return; }
            const chunkText = chunk.text;
            if (chunkText) { fullText += chunkText; yield { type: 'assistant_delta', text: chunkText }; }
            const chunkContent = chunk.candidates?.[0]?.content;
            if (chunkContent?.parts?.length) {
              for (const part of chunkContent.parts) {
                // Merge CONSECUTIVE plain-text parts so the replayed model
                // content matches the non-streaming single-text-part shape.
                // functionCall / thoughtSignature (thinking) parts are pushed
                // VERBATIM — never merged — so thoughtSignature survives.
                const last = aggregatedParts[aggregatedParts.length - 1];
                if (isPlainTextPart(part) && last && isPlainTextPart(last)) {
                  aggregatedParts[aggregatedParts.length - 1] = { text: (last.text ?? '') + (part.text ?? '') };
                } else {
                  aggregatedParts.push(part);
                }
              }
            }
            if (chunkContent?.role) modelRole = chunkContent.role;
            if (chunk.functionCalls?.length) aggregatedCalls.push(...chunk.functionCalls);
            if (chunk.usageMetadata) lastUsage = chunk.usageMetadata;
            const gq = chunk.candidates?.[0]?.groundingMetadata?.webSearchQueries?.length ?? 0;
            if (gq > 0) groundingQueries = gq;
            const fr = chunk.candidates?.[0]?.finishReason;
            if (fr) finishReason = fr;
          }
        } catch (e) {
          if (signal.aborted) { yield { type: 'completion', outcome: 'error', reason: 'aborted' }; return; }
          yield { type: 'completion', outcome: 'error', reason: (e as Error).message, failure: extractProviderFailure(e) };
          return;
        }

        // Google Search grounding is billed per query; summed across loop turns.
        const usage = toUsage(lastUsage);
        if (usage || groundingQueries > 0) {
          yield { type: 'usage', usage: { ...usage, webSearchRequests: groundingQueries || undefined } };
        }

        // Part 6 §D2 — feed the recorder the aggregated raw parts. The
        // canonical mapper reads `candidates[0].content.parts` so we wrap
        // the aggregated parts (verbatim, with thoughtSignature) into the
        // same response shape Gemini emits for non-streaming calls.
        if (this.recorder && aggregatedParts.length > 0) {
          this.recorder.recordRaw({
            invocationId: input.invocationId,
            provider: 'google',
            model: input.model,
            rawKind: 'gemini_response',
            raw: { candidates: [{ content: { role: modelRole, parts: aggregatedParts } }] },
          });
        }

        // Terminal full-content message (history/accounting) after the deltas.
        if (fullText) yield { type: 'assistant_message', content: [{ type: 'text', text: fullText }] };

        const calls = aggregatedCalls;

        // Replay the RAW aggregated model content (verbatim parts) so
        // thoughtSignature survives — see the streaming note above.
        const modelContent: Content | undefined =
          aggregatedParts.length > 0 ? { role: modelRole, parts: aggregatedParts } : undefined;
        if (modelContent) contents.push(modelContent);

        if (calls.length === 0) {
          // No tool calls → the turn is ending. A non-normal finish reason
          // (safety/recitation/blocklist/malformed) is a blocked stop, not a
          // clean success — surface it as an anomaly + error completion.
          if (finishReason && LIMIT_FINISH_REASONS.has(finishReason)) {
            yield {
              type: 'completion',
              outcome: 'limit_reached',
              reason: `gemini stopped at its output limit (${finishReason})`,
            };
            return;
          }
          if (finishReason && !NORMAL_FINISH_REASONS.has(finishReason)) {
            yield { type: 'anomaly_detected', kind: 'unexpected_stop', context: { error: `gemini finish_reason: ${finishReason}` } };
            yield {
              type: 'completion',
              outcome: 'error',
              reason: `gemini stopped abnormally: ${finishReason}`,
              // finishReason IS the structured signal here — SAFETY,
              // RECITATION, PROHIBITED_CONTENT. Read as prose it lands in
              // 'unknown' and an operator learns nothing.
              failure: {
                kind: classifyProviderFailure(finishReason, undefined),
                providerErrorType: finishReason,
              },
            };
            return;
          }
          const drained = this.injected.splice(0, this.injected.length);
          if (drained.length === 0) { yield { type: 'completion', outcome: 'success' }; return; }
          contents.push({ role: 'user', parts: drained.map((m) => ({ text: m.text })) });
          continue;
        }

        // Execute the requested tool calls through the bridge (HITL inside).
        const responseParts: Part[] = [];
        const dispatchedCallIds: string[] = [];
        for (const call of calls) {
          const callId = call.id ?? call.name ?? '';
          const args = call.args ?? {};
          yield { type: 'tool_call_started', toolName: call.name ?? '', args, callId };
          const result = await dispatchFunctionCall(catalog, call.name ?? '', args, bridgeContext, { callId });
          dispatchedCallIds.push(callId);
          const recordedAtDispatch = this.recordedCalls.delete(callId);
          yield { type: 'tool_call_finished', callId, result, ...(recordedAtDispatch ? { recordedAtDispatch } : {}) };
          responseParts.push({
            functionResponse: { id: call.id, name: call.name, response: wrapResponse(result) },
          });
          if (bridgeContext.pendingHitlGate) break;
          if (bridgeContext.pendingDelegationPause) { bridgeContext.pendingDelegationPause.parentToolCallId = callId; break; }
        }
        // This loop IS the model turn's batch, so the boundary is exact: every
        // call above has resolved and the next request has not been made.
        if (this.toolBatchHandler) await this.toolBatchHandler(dispatchedCallIds);

        if (bridgeContext.pendingDelegationPause) {
          const token = await this.pause('delegation');
          const delegationContext = bridgeContext.pendingDelegationPause;
          bridgeContext.pendingDelegationPause = null;
          yield { type: 'pause_requested', reason: 'delegation', token, delegationContext };
          return;
        }
        if (bridgeContext.pendingWakePause) {
          const wakeToken = await this.pause('self_wake');
          const wakeContext = bridgeContext.pendingWakePause;
          bridgeContext.pendingWakePause = null;
          yield { type: 'pause_requested', reason: 'self_wake', token: wakeToken, wakeContext };
          return;
        }
        if (bridgeContext.pendingHitlGate) {
          const token = await this.pause('hitl_gate');
          const gateContext = bridgeContext.pendingHitlGate;
          bridgeContext.pendingHitlGate = null;
          yield { type: 'pause_requested', reason: 'hitl_gate', token, gateContext };
          return;
        }
        if (this.paused) {
          const token = await this.pause('ask_user');
          yield { type: 'pause_requested', reason: 'ask_user', token };
          return;
        }

        // The work is done when a round called nothing but terminal tools.
        //
        // We own this loop, so there is no vendor flag to reach for: the next
        // iteration is simply not taken. It costs one model call per completed
        // run otherwise, to write a closing sentence after the delivery already
        // happened in the tool that just returned.
        //
        // Guarded on the turn having SPOKEN. Ending a silent turn here would
        // leave an empty reply where that sentence would have been — a blank
        // bubble in an interactive thread, which is worse than the call it
        // saves.
        if (fullText.length > 0 && roundIsTerminal(calls.map((c) => c.name ?? ''), terminal)) {
          logTurnClosed('google-genai', calls.map((c) => c.name ?? ''), input.invocationId);
          yield { type: 'completion', outcome: 'success' };
          return;
        }

        contents.push({ role: 'user', parts: responseParts });
      }
      // The turn budget is spent: a run cut off while working, not a fault,
      // the same reading the wire adapter gives the Agents SDK's own ceiling.
      // Routing it through the recovery LLM would spend another call
      // rediscovering that there was no room left.
      yield { type: 'completion', outcome: 'limit_reached', reason: `max tool iterations exceeded (${maxIterations})` };
    } finally {
      signal.removeEventListener('abort', onOuterAbort);
      await getMcpClientPool().releaseAll(input.invocationId).catch(() => undefined);
    }
  }

  async injectMessage(message: UserMessage): Promise<void> {
    this.injected.push(message);
  }

  async pause(reason: PauseReason): Promise<ResumeToken> {
    this.paused = true;
    const serialized = JSON.stringify({ reason, input: this.currentInvocation });
    return { adapterKind: 'google', serialized };
  }

  async *resume(token: ResumeToken, response: UserResponse, signal: AbortSignal): AsyncIterable<InvocationEvent> {
    const data = JSON.parse(token.serialized) as { input: InvocationInput };
    const messages: PlatformMessage[] = [
      ...data.input.messages,
      { role: 'user', content: [{ type: 'text', text: response.text }] },
    ];
    yield* this.invoke({ ...data.input, messages }, signal);
  }

  registerToolCatalog(catalog: McpToolCatalog): void { this.catalog = catalog; }
  registerHitlGate(gate: HitlGate): void { this.hitlGate = gate; }
  registerToolResultObserver(observer: ToolResultObserver): void { this.toolResultObserver = observer; }
  registerAnomalyHandler(handler: AnomalyHandler): void { this.anomalyHandler = handler; }
  registerToolBatchHandler(handler: ToolBatchHandler): void { this.toolBatchHandler = handler; }
  registerTrajectoryRecorder(recorder: import('../types').TrajectoryRecorder): void { this.recorder = recorder; }
}

/** Convert platform messages to genai Content[]. system → handled via
 *  systemInstruction (skipped here); assistant → 'model'; user/tool → 'user'. */
function platformMessagesToContents(messages: PlatformMessage[]): Content[] {
  // Correlate tool_result parts back to their tool name — PlatformContent's
  // tool_result carries only the callId, but Gemini matches a functionResponse
  // to its functionCall by id AND name, so a missing name can break
  // resume-with-prior-tool-history. Build callId→name from the tool_use parts.
  const nameByCallId = new Map<string, string>();
  for (const m of messages) {
    for (const c of m.content) {
      if (c.type === 'tool_use') nameByCallId.set(c.callId, c.toolName);
    }
  }
  const out: Content[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    const parts = m.content
      .map((c) => platformContentToPart(c, nameByCallId))
      .filter((p): p is Part => p !== null);
    if (parts.length === 0) continue;
    out.push({ role: m.role === 'assistant' ? 'model' : 'user', parts });
  }
  return out;
}

function platformContentToPart(c: PlatformContent, nameByCallId: Map<string, string>): Part | null {
  if (c.type === 'text') return c.text ? { text: c.text } : null;
  if (c.type === 'tool_use') return { functionCall: { id: c.callId, name: c.toolName, args: (c.args ?? {}) as Record<string, unknown> } };
  if (c.type === 'tool_result') return { functionResponse: { id: c.callId, name: nameByCallId.get(c.callId), response: wrapResponse(c.error ?? c.result) } };
  // The one adapter that carries VIDEO as well as stills. genai's inlineData is
  // a generic blob — `{ mimeType, data }`, with no image-specific shape — so
  // both kinds are the same part and the mime type is the whole of the
  // difference. This is why 'google' is the only engine the modality gate lets
  // video through to.
  if (c.type === 'media') return { inlineData: { mimeType: c.mimeType, data: c.dataBase64 } };
  return null;
}

/** A part carrying only assistant text (no functionCall / thoughtSignature) —
 *  the only kind safe to merge across streamed chunks. */
function isPlainTextPart(p: Part): boolean {
  return typeof p.text === 'string' && !p.thoughtSignature && !p.functionCall;
}

/** genai functionResponse.response must be an object. */
function wrapResponse(result: unknown): Record<string, unknown> {
  return result !== null && typeof result === 'object'
    ? (result as Record<string, unknown>)
    : { result };
}

function toUsage(u?: {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
  toolUsePromptTokenCount?: number;
}): AdapterUsage | null {
  if (!u) return null;
  // Google bills thoughtsTokenCount (extended thinking) as OUTPUT tokens and
  // toolUsePromptTokenCount (function-calling prompt) as INPUT tokens. Folding
  // them in; before this every Gemini-3 run with thinking or function-calling
  // on undercounted. Raw breakdown preserved for audit / reconciliation.
  const inputTokens = (u.promptTokenCount ?? 0) + (u.toolUsePromptTokenCount ?? 0);
  return {
    inputTokens,
    outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
    cachedTokens: u.cachedContentTokenCount,
    // `promptTokenCount` is the prompt TOTAL, cached content included, so the
    // context is that figure unchanged. Adding the cached count to it would
    // count the cached part twice.
    contextTokens: inputTokens,
    raw: {
      promptTokenCount: u.promptTokenCount,
      candidatesTokenCount: u.candidatesTokenCount,
      thoughtsTokenCount: u.thoughtsTokenCount,
      toolUsePromptTokenCount: u.toolUsePromptTokenCount,
      cachedContentTokenCount: u.cachedContentTokenCount,
    },
  };
}
