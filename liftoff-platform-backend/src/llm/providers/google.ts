// Google (Gemini via Vertex AI) Provider
import {
  FunctionCallingMode,
  VertexAI,
  type Content,
  type FunctionDeclaration,
  type GenerativeModel,
  type ModelParams,
  type Part,
  type Tool,
} from '@google-cloud/vertexai';
import { log } from '../../infrastructure/logging';
import type {
  LLMProviderClient,
  LLMCompletionRequest,
  LLMCompletionResponse,
  LLMModelTier,
  LLMStreamEvent,
  LLMStopReason,
  LLMToolCall,
  LLMToolDefinition,
} from '../types';
import { safeParseJsonObject } from './json-utils';
import { googleInputTokens, googleOutputTokens } from '../google-usage';
import { BYOK_TOKEN_HEADER } from '../../byok-gateway/headers';
import { sanitizeWebContent } from './web-content-sanitizer';

export const DEFAULT_MODEL = 'gemini-3.1-pro-preview';
const DEFAULT_MAX_TOKENS = 4096;

/** Bootstrap tier→model seed. Every id here is servable: Vertex answers 200
 *  on `publishers/google/models/<id>`. The registry overlay below replaces this
 *  from the `models` table, so a tier bump is a registry row rather than a code
 *  edit; the seed is what resolves until the first load lands.
 *
 *  The Cloud console model list and the API disagree about which ids exist.
 *  The API is the authority — a request is served by the API. */
export const TIER_MODELS: Record<LLMModelTier, string> = {
  large:    'gemini-3.1-pro-preview',
  medium:   'gemini-3.5-flash',
  small:    'gemini-3.1-flash-lite',
};

/** The live tier→model map: TIER_MODELS overlaid with the `models` registry
 *  by registry-tier-loader on a 60s refresh. Module-level rather than
 *  per-instance because every instance of this provider routes the same tiers. */
let activeTierModels: Record<LLMModelTier, string> = { ...TIER_MODELS };

/** Resolve the model ID for this provider. Explicit `model` wins over `tier`;
 *  if neither is set, falls back to DEFAULT_MODEL. */
function resolveModel(request: LLMCompletionRequest): string {
  if (request.model) return request.model;
  if (request.tier) return activeTierModels[request.tier];
  return DEFAULT_MODEL;
}

function hasProperties(schema: LLMToolDefinition['input_schema']): boolean {
  const props = (schema as { properties?: Record<string, unknown> } | undefined)?.properties;
  return Boolean(props && Object.keys(props).length > 0);
}

/** Translate our LLMToolDefinition[] into Vertex Tool[]. Gemini wraps all
 *  function declarations under a single Tool object. */
function toGoogleTools(tools: LLMToolDefinition[] | undefined): Tool[] | undefined {
  if (!tools?.length) return undefined;
  return [{
    functionDeclarations: tools.map(t => ({
      name: t.name,
      description: t.description,
      // A declaration with nothing to pass carries no `parameters`: Gemini
      // rejects an OBJECT schema whose `properties` is empty.
      ...(hasProperties(t.input_schema) ? { parameters: t.input_schema as unknown as FunctionDeclaration['parameters'] } : {}),
    })),
  }];
}

/** Build Gemini Content[] from our LLMMessage[] shape.
 *
 *  Handles both per-message tool data (LLMMessage.toolCalls on assistant
 *  turns, LLMMessage.toolResults on user turns — for multi-round tool use
 *  in the insights chat) and the legacy request-level `toolResults`
 *  shortcut (kept for Phase 4 tests).
 *
 *  Gemini correlates tool results to calls by FUNCTION NAME (no opaque ids).
 *  We synthesize ids as `${name}-${index}` on the way out; on the way back
 *  in, `extractFunctionNameFromCallId` recovers the name.
 */
/** Every system message, joined, in order.
 *
 *  All of them for the same reason the Anthropic provider takes all of them:
 *  Gemini carries `systemInstruction` as its own field and the loop below skips
 *  every system-role entry, so one this function does not read reaches no
 *  model. Callers that send a prompt plus a preamble (the caller's identity and
 *  the conversation's rolling summary) had the second dropped.
 *
 *  Joined rather than kept as blocks: `systemInstruction` is one instruction on
 *  this provider, and Gemini's implicit caching keys on the request prefix
 *  rather than on per-block markers, so there is nothing a split would buy. */
function joinSystemInstruction(request: LLMCompletionRequest): string | undefined {
  const parts = request.messages
    .filter(m => m.role === 'system' && m.content)
    .map(m => m.content);
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

function buildGoogleContents(request: LLMCompletionRequest): {
  systemInstruction: string | undefined;
  contents: Content[];
} {
  const systemInstruction = joinSystemInstruction(request);

  const contents: Content[] = [];

  for (const m of request.messages) {
    if (m.role === 'system') continue;

    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      // Gemini assistant turn with text + functionCall parts.
      const parts: Part[] = [];
      if (m.content) parts.push({ text: m.content });
      for (const tc of m.toolCalls) {
        parts.push({
          functionCall: {
            name: tc.name,
            args: tc.input,
          },
        });
      }
      contents.push({ role: 'model', parts });
      continue;
    }

    if (m.role === 'user' && m.toolResults && m.toolResults.length > 0) {
      // Tool results become a user turn with functionResponse parts.
      // A tool whose answer is a picture carries it here: this vendor takes
      // binary parts inside the function response itself, so the frame needs
      // no turn of its own.
      const parts: Part[] = m.toolResults.map(tr => ({
        functionResponse: {
          name: extractFunctionNameFromCallId(tr.toolCallId),
          response: { content: safeParseJsonObject(sanitizeWebContent(tr.content)) },
          ...(tr.images && tr.images.length > 0
            ? { parts: tr.images.map(img => ({ inlineData: { mimeType: img.mimeType, data: img.dataBase64 } })) }
            : {}),
        },
      }));
      if (m.content) parts.push({ text: m.content });
      contents.push({ role: 'user', parts });
      continue;
    }

    if (m.role === 'user' && m.images && m.images.length > 0) {
      // Gemini's inlineData part. It is a generic blob — `{ mimeType, data }`
      // with no image-specific shape — which is why this is the one provider
      // that carries VIDEO as well as stills, and why the modality gate treats
      // 'google' as the only engine that can express one. Media leads and text
      // follows, for the same reason the other two vendors want it that way.
      contents.push({
        role: 'user',
        parts: [
          ...m.images.map((img) => ({
            inlineData: { mimeType: img.mimeType, data: img.dataBase64 },
          })),
          ...(m.content ? [{ text: m.content }] : []),
        ],
      });
      continue;
    }

    contents.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    });
  }

  // Legacy: request-level `toolResults` shortcut (Phase 4 tests).
  if (request.toolResults?.length) {
    contents.push({
      role: 'user',
      parts: request.toolResults.map(r => ({
        functionResponse: {
          name: extractFunctionNameFromCallId(r.toolCallId),
          response: { content: safeParseJsonObject(sanitizeWebContent(r.content)) },
        },
      })),
    });
  }

  return { systemInstruction, contents };
}

/** Translate our toolChoice into Gemini's FunctionCallingConfig. */
function toGoogleFunctionCallingConfig(
  toolChoice: 'auto' | 'required' | 'none' | { name: string } | undefined,
): { mode: FunctionCallingMode; allowedFunctionNames?: string[] } {
  if (!toolChoice || toolChoice === 'auto') {
    return { mode: FunctionCallingMode.AUTO };
  }
  if (toolChoice === 'required') {
    return { mode: FunctionCallingMode.ANY };
  }
  if (toolChoice === 'none') {
    return { mode: FunctionCallingMode.NONE };
  }
  return { mode: FunctionCallingMode.ANY, allowedFunctionNames: [toolChoice.name] };
}

/** Recover the function name from a synthesized `${name}-${index}` id. */
function extractFunctionNameFromCallId(callId: string): string {
  const lastDash = callId.lastIndexOf('-');
  if (lastDash === -1) return callId;
  // Verify the suffix is a non-negative integer; otherwise treat as raw id.
  const suffix = callId.slice(lastDash + 1);
  if (!/^\d+$/.test(suffix)) return callId;
  return callId.slice(0, lastDash);
}

/** Gemini candidate-level finishReason values that indicate the safety stack
 *  blocked or curtailed the response. All normalise to our 'refusal'. */
const GOOGLE_SAFETY_FINISH_REASONS = new Set([
  'SAFETY',
  'PROHIBITED_CONTENT',
  'RECITATION',
  'BLOCKLIST',
  'SPII',
  'IMAGE_SAFETY',
]);

/** Map Gemini's finishReason to our LLMStopReason. Gemini doesn't have a
 *  distinct "tool use" finish reason — we infer it from whether the response
 *  contained any functionCall parts.
 *
 *  Two safety shapes normalise to 'refusal':
 *   a. Candidate-level: a `finishReason` in GOOGLE_SAFETY_FINISH_REASONS.
 *   b. Prompt-level block: Gemini returns NO candidates (reason undefined) and
 *      sets `response.promptFeedback.blockReason`. Threaded in via
 *      `promptBlockReason` so the empty response isn't mistaken for success. */
function mapGoogleFinishReason(
  reason: string | undefined,
  hasToolCalls: boolean,
  promptBlockReason?: string,
): LLMStopReason {
  if (hasToolCalls) return 'tool_use';
  if (reason === 'MAX_TOKENS') return 'max_tokens';
  if (reason && GOOGLE_SAFETY_FINISH_REASONS.has(reason)) return 'refusal';
  if (!reason && promptBlockReason) return 'refusal';
  return 'end_turn'; // STOP, FINISH_REASON_UNSPECIFIED, OTHER, etc.
}

/** Read a Gemini prompt-level block reason (`promptFeedback.blockReason`) off a
 *  response defensively — the SDK's response type does not always expose it. */
function extractGooglePromptBlockReason(response: unknown): string | undefined {
  if (!response || typeof response !== 'object') return undefined;
  const pf = (response as { promptFeedback?: { blockReason?: unknown } }).promptFeedback;
  const reason = pf?.blockReason;
  return typeof reason === 'string' && reason ? reason : undefined;
}

/** Coerce Gemini's proto-like args object into plain JSON. The SDK returns a
 *  Struct that JSON.stringify handles correctly, but we round-trip to be safe
 *  against any non-enumerable proto fields that might leak through. */
function coerceProtoArgs(args: unknown): Record<string, unknown> {
  try {
    const round = JSON.parse(JSON.stringify(args ?? {}));
    return round && typeof round === 'object' && !Array.isArray(round)
      ? (round as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Augment the Gemini tools array with the grounding tool when the caller
 *  requested web search via serverTools. The grounding tool is separate
 *  from function-declaration tools in Gemini — on 2.0+ models the shape
 *  is `{ googleSearch: {} }`. The SDK's Tool union doesn't include this
 *  variant (it's Vertex-API level), so we cast defensively.
 *
 *  There is deliberately no guard that drops grounding whenever function tools
 *  are present (mixing the two was once not universally supported). Such a
 *  guard fires on EVERY call the platform assistants make (each of them always
 *  carries its own function tools), so web search would never be reachable on
 *  this provider — it would log a warning and return.
 *
 *  Removed against evidence rather than documentation, because the two differ
 *  for Vertex and the docs have been wrong here before. Sending
 *  functionDeclarations + googleSearch + urlContext in one Vertex
 *  generateContent call returns 200 on all three models the tier ladder uses
 *  (gemini-3.1-pro-preview, gemini-3.5-flash, gemini-3.1-flash-lite). Gemini
 *  3.x combines built-in tools with function calling. If a
 *  future model regresses, the symptom is a 400 naming the tool combination,
 *  not a silent loss. */
function maybeAddGrounding(
  tools: Tool[] | undefined,
  wantsWebSearch: boolean,
): Tool[] | undefined {
  if (!wantsWebSearch) return tools;
  const groundingTool = { googleSearch: {} } as any;
  return [...(tools ?? []), groundingTool as Tool];
}

/** Augment the Gemini tools array with the urlContext tool when the caller
 *  requested web fetch via serverTools. Unlike grounding, urlContext can
 *  coexist with function tools — no conflict warning needed. */
function maybeAddUrlContext(
  tools: Tool[] | undefined,
  wantsUrlContext: boolean,
): Tool[] | undefined {
  if (!wantsUrlContext) return tools;
  const urlContextTool = { urlContext: {} } as any;
  return [...(tools ?? []), urlContextTool as Tool];
}

/** Count urlContext-resolved URLs on a Gemini response candidate. */
function extractGoogleUrlContextRequests(candidate: unknown): number {
  if (!candidate || typeof candidate !== 'object') return 0;
  const meta = (candidate as any).urlContextMetadata;
  if (!meta || !Array.isArray(meta.urlMetadata)) return 0;
  return meta.urlMetadata.length;
}

// Google's billable token arithmetic lives in `llm/google-usage.ts`, imported
// above. It is shared with the BYOK gateway's Vertex parser, which reads the same
// vendor's response off the wire: two implementations of one vendor's arithmetic is
// how one of them stays wrong, and it did — the gateway read three of the four
// counts and under-billed every tool-using turn.

/** Count grounded web-search requests on a Gemini response candidate.
 *  Gemini reports one `webSearchQueries` entry per grounded query issued.
 *  Each counts as one billable request at $35 / 1,000 (Vertex pricing). */
function extractGoogleWebSearchRequests(candidate: unknown): number {
  if (!candidate || typeof candidate !== 'object') return 0;
   
  const gm = (candidate as any).groundingMetadata;
  if (!gm || !Array.isArray(gm.webSearchQueries)) return 0;
  return gm.webSearchQueries.length;
}

export class GoogleProvider implements LLMProviderClient {
  /** The model this request would run against, without running it. See the
   *  note on LLMProviderClient.resolveModelId. */
  resolveModelId(request: LLMCompletionRequest): string {
    return resolveModel(request);
  }

  /** Overlay registry-sourced tier→model ids onto the static TIER_MODELS
   *  seed. Called by registry-tier-loader; a tier absent from the registry
   *  keeps its seed value. */
  applyRegistryTierModels(overrides: Partial<Record<LLMModelTier, string>>): void {
    activeTierModels = { ...TIER_MODELS, ...overrides };
  }

  readonly provider = 'google' as const;
  private vertexAI: VertexAI;
  private projectId: string;

  /** Extra headers on every request this instance makes. Empty for the managed
   *  instance; carries the per-run gateway token for a BYOK one. */
  private customHeaders?: Record<string, string>;

  private constructor(
    vertexAI: VertexAI,
    projectId: string,
    customHeaders?: Record<string, string>,
  ) {
    this.vertexAI = vertexAI;
    this.projectId = projectId;
    this.customHeaders = customHeaders;
  }

  /**
   * Build a generative model, carrying this instance's extra headers if it has
   * any.
   *
   * The managed instance calls through with ONE argument, exactly as it did
   * before BYOK existed. Passing an explicit `undefined` second argument would
   * behave identically and read identically, but it is not the same call — and
   * the difference is the kind that shows up as a puzzling diff in a mock
   * assertion rather than as a behaviour change.
   */
  private generativeModel(params: ModelParams): GenerativeModel {
    if (!this.customHeaders) return this.vertexAI.getGenerativeModel(params);
    return this.vertexAI.getGenerativeModel(params, {
      customHeaders: new Headers(this.customHeaders),
    });
  }

  /**
   * An instance that talks to the BYOK gateway instead of Liftoff's own Vertex.
   *
   * `project` and `location` are the CUSTOMER's — Vertex names both in every
   * request path, so the client has to build the path for their account even
   * though the credential that opens it never leaves the control plane.
   *
   * `apiEndpoint` carries a path as well as a host: the SDK interpolates it as
   * `https://{apiEndpoint}/{apiVersion}/{resource}`, so the gateway's mount
   * point rides along and the request arrives where it can be authenticated.
   *
   * The run token travels in a header of its own rather than in `Authorization`.
   * The SDK fills that one in with an ADC token before the request leaves, and
   * the gateway replaces it with a token minted from the customer's service
   * account — so the two credentials never contend for the same header.
   *
   * Per call rather than pooled, because the credential is per (tenant, run).
   */
  static createForGateway(
    gatewayUrl: string,
    project: string,
    location: string,
    token: string,
  ): GoogleProvider {
    const endpoint = gatewayUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const vertexAI = new VertexAI({
      project,
      location,
      apiEndpoint: endpoint,
    });
    return new GoogleProvider(vertexAI, project, { [BYOK_TOKEN_HEADER]: token });
  }

  static async create(): Promise<GoogleProvider | null> {
    const projectId = process.env.GCP_PROJECT_ID;
    if (!projectId) {
      log.info('GCP_PROJECT_ID not set, Google provider unavailable');
      return null;
    }

    try {
      const vertexAI = new VertexAI({
        project: projectId,
        location: 'us-west1',
      });
      log.info('Google (Vertex AI) provider initialized');
      return new GoogleProvider(vertexAI, projectId);
    } catch (error) {
      log.warn({ error }, 'Failed to initialize Google provider');
      return null;
    }
  }

  async complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse> {
    const modelName = resolveModel(request);
    const maxTokens = request.maxTokens || DEFAULT_MAX_TOKENS;

    // Build contents from messages
    const systemInstruction = joinSystemInstruction(request);
    const conversationMessages = request.messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

    // ── Existing responseSchema shortcut path (forced single function call) ──
    if (request.responseSchema) {
      const functionDeclaration: FunctionDeclaration = {
        name: request.responseSchema.name,
        description: request.responseSchema.description || `Generate structured output for ${request.responseSchema.name}`,
        parameters: request.responseSchema.schema as unknown as FunctionDeclaration['parameters'],
      };

      const tools: Tool[] = [{
        functionDeclarations: [functionDeclaration],
      }];

      const model = this.generativeModel({
        model: modelName,
        generationConfig: {
          maxOutputTokens: maxTokens,
          temperature: request.temperature,
        },
        tools,
        toolConfig: {
          functionCallingConfig: {
            mode: FunctionCallingMode.ANY,
            allowedFunctionNames: [request.responseSchema.name],
          },
        },
      });

      const chat = model.startChat({
        systemInstruction: systemInstruction || undefined,
        history: conversationMessages.slice(0, -1),
      });

      const lastMessage = conversationMessages[conversationMessages.length - 1];
      const result = await chat.sendMessage(lastMessage.parts[0].text);
      const response = result.response;

      // Extract the function call
      const functionCall = response.candidates?.[0]?.content?.parts?.[0]?.functionCall;
      if (!functionCall) {
        throw new Error('Expected function call response but got none');
      }

      return {
        content: JSON.stringify(functionCall.args),
        model: modelName,
        provider: this.provider,
        usage: response.usageMetadata ? {
          // Google bills thoughtsTokenCount as OUTPUT and toolUsePromptTokenCount
          // as INPUT, and neither sits inside the count beside it — the SDK states
          // the arithmetic on `totalTokenCount`: prompt + candidates +
          // toolUsePrompt + thoughts. Reading the two narrow counts charges for
          // the visible answer and nothing for the thinking that produced it,
          // which on a Gemini 3 model is most of the call.
          inputTokens: googleInputTokens(response.usageMetadata),
          outputTokens: googleOutputTokens(response.usageMetadata),
          webSearchRequests: 0,
          webFetchRequests: 0,
          cacheReadTokens: (response.usageMetadata as any).cachedContentTokenCount ?? 0,
          // `promptTokenCount` is the whole prompt, cached part included.
          contextTokens: response.usageMetadata.promptTokenCount || 0,
        } : undefined,
      };
    }

    // ── General-tools path (Phase 4) ──────────────────────────────────────
    const { systemInstruction: sysFromBuilder, contents } = buildGoogleContents(request);
    const wantsWebSearch = request.serverTools?.some(t => t.name === 'web_search') ?? false;
    const wantsUrlContext = request.serverTools?.some(t => t.name === 'web_fetch') ?? false;
    const tools = maybeAddUrlContext(
      maybeAddGrounding(toGoogleTools(request.tools), wantsWebSearch),
      wantsUrlContext,
    );

    const model = this.generativeModel({
      model: modelName,
      generationConfig: {
        maxOutputTokens: maxTokens,
        temperature: request.temperature,
      },
      ...(tools ? {
        tools,
        toolConfig: {
          functionCallingConfig: toGoogleFunctionCallingConfig(request.toolChoice),
        },
      } : {}),
    });

    const result = await model.generateContent({
      contents,
      systemInstruction: sysFromBuilder
        ? { role: 'user', parts: [{ text: sysFromBuilder }] }
        : undefined,
    });
    const response = result.response;
    const candidate = response.candidates?.[0];

    let content = '';
    const toolCalls: LLMToolCall[] = [];
    candidate?.content?.parts?.forEach((part: Part, idx: number) => {
      if ('text' in part && part.text) {
        content += part.text;
      } else if ('functionCall' in part && part.functionCall) {
        toolCalls.push({
          id: `${part.functionCall.name}-${idx}`,
          name: part.functionCall.name,
          input: coerceProtoArgs(part.functionCall.args),
        });
      }
    });

    const promptBlockReason = extractGooglePromptBlockReason(response);
    const stopReason = mapGoogleFinishReason(
      candidate?.finishReason,
      toolCalls.length > 0,
      promptBlockReason,
    );
    const refusalCategory =
      stopReason === 'refusal'
        ? (candidate?.finishReason ?? (promptBlockReason ? `prompt_block:${promptBlockReason}` : undefined))
        : undefined;

    return {
      content,
      model: modelName,
      provider: this.provider,
      stopReason,
      refusalCategory,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      usage: response.usageMetadata ? {
        // Thinking and the tool-result prompt, as above.
        inputTokens: googleInputTokens(response.usageMetadata),
        outputTokens: googleOutputTokens(response.usageMetadata),
        webSearchRequests: extractGoogleWebSearchRequests(candidate),
        webFetchRequests: extractGoogleUrlContextRequests(candidate),
        cacheReadTokens: (response.usageMetadata as any).cachedContentTokenCount ?? 0,
        // `promptTokenCount` is the whole prompt, cached part included.
        contextTokens: response.usageMetadata.promptTokenCount || 0,
      } : undefined,
    };
  }

  /** Stream a completion as a sequence of normalized events.
   *
   *  Gemini's `generateContentStream()` returns `{ stream, response }` where
   *  `stream` is an async iterable of `GenerateContentResponse` chunks. Each
   *  chunk's `candidates[0].content.parts` may contain text or functionCall
   *  parts. Function calls aren't fragmented (Gemini delivers them complete
   *  in a single chunk), so we emit them as soon as we see them. */
  async *completeStream(request: LLMCompletionRequest): AsyncIterable<LLMStreamEvent> {
    const modelName = resolveModel(request);
    const maxTokens = request.maxTokens || DEFAULT_MAX_TOKENS;
    const { systemInstruction, contents } = buildGoogleContents(request);
    const wantsWebSearch = request.serverTools?.some(t => t.name === 'web_search') ?? false;
    const wantsUrlContext = request.serverTools?.some(t => t.name === 'web_fetch') ?? false;
    const tools = maybeAddUrlContext(
      maybeAddGrounding(toGoogleTools(request.tools), wantsWebSearch),
      wantsUrlContext,
    );

    let inputTokens = 0;
    let outputTokens = 0;
    let webSearchRequests = 0;
    let webFetchRequests = 0;
    let cacheReadTokens = 0;
    let hasToolCalls = false;
    let finishReason: string | undefined;
    let promptBlockReason: string | undefined;
    let toolCallIndex = 0;

    try {
      const model = this.generativeModel({
        model: modelName,
        generationConfig: {
          maxOutputTokens: maxTokens,
          temperature: request.temperature,
        },
        ...(tools ? {
          tools,
          toolConfig: {
            functionCallingConfig: toGoogleFunctionCallingConfig(request.toolChoice),
          },
        } : {}),
      });

      const streamingResult = await model.generateContentStream({
        contents,
        systemInstruction: systemInstruction
          ? { role: 'user', parts: [{ text: systemInstruction }] }
          : undefined,
      });

      for await (const item of streamingResult.stream) {
        const candidate = item.candidates?.[0];

        if (candidate?.content?.parts) {
          for (const part of candidate.content.parts as Part[]) {
            if ('text' in part && part.text) {
              yield { type: 'text_delta', text: part.text };
            } else if ('functionCall' in part && part.functionCall) {
              hasToolCalls = true;
              yield {
                type: 'tool_use',
                toolCall: {
                  id: `${part.functionCall.name}-${toolCallIndex++}`,
                  name: part.functionCall.name,
                  input: coerceProtoArgs(part.functionCall.args),
                },
              };
            }
          }
        }

        if (candidate?.finishReason) finishReason = candidate.finishReason;

        // Prompt-level blocks (no candidates) surface via promptFeedback on the
        // chunk. Capture the latest we observe.
        const pbr = extractGooglePromptBlockReason(item);
        if (pbr) promptBlockReason = pbr;

        if (item.usageMetadata) {
          // Thinking and the tool-result prompt, as above.
          inputTokens = googleInputTokens(item.usageMetadata) || inputTokens;
          outputTokens = googleOutputTokens(item.usageMetadata) || outputTokens;
          cacheReadTokens = (item.usageMetadata as any).cachedContentTokenCount ?? cacheReadTokens;
        }

        // groundingMetadata can arrive on any chunk during streaming; take
        // the latest non-zero count we observe.
        const chunkWsr = extractGoogleWebSearchRequests(candidate);
        if (chunkWsr > 0) webSearchRequests = chunkWsr;
        const chunkWfr = extractGoogleUrlContextRequests(candidate);
        if (chunkWfr > 0) webFetchRequests = chunkWfr;
      }
    } catch (err) {
      yield { type: 'error', message: (err as Error).message };
      return;
    }

    const stopReason = mapGoogleFinishReason(finishReason, hasToolCalls, promptBlockReason);
    const refusalCategory =
      stopReason === 'refusal'
        ? (finishReason && GOOGLE_SAFETY_FINISH_REASONS.has(finishReason)
            ? finishReason
            : (promptBlockReason ? `prompt_block:${promptBlockReason}` : undefined))
        : undefined;

    yield {
      type: 'message_complete',
      // The model this call was actually served by, so the usage row names it.
      // Streaming had no way to report this and recorded 'default' for every
      // tier-based caller, which prices the row against no model at all.
      model: modelName,
      stopReason,
      refusalCategory,
      usage: {
        inputTokens, outputTokens, webSearchRequests, webFetchRequests, cacheReadTokens,
        // `promptTokenCount` is the whole prompt, cached part included.
        contextTokens: inputTokens,
      },
    };
  }
}

/** Test seam. The request builder is a pure function of the request, but it is
 *  private to the provider, and instantiating the provider needs credentials
 *  this assertion has nothing to do with. */
export const __internalBuildGoogleContents = buildGoogleContents;
