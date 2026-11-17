// Google (Gemini via Vertex AI) Provider
// Per implementation plan Phase 3.2: Gemini via Vertex AI
//
// Built on the official Google Gen AI SDK (`@google/genai`). The legacy
// `@google-cloud/vertexai` SDK is deprecated (removed 2026-06-24) and cannot
// reach the `global` Vertex endpoint, where the Gemini 3 models are served for
// the YOUR_TENANT_PROJECT{dev,prod} projects (us-west1 / us-central1 return 404).
// See also src/agent-execution/adapter/gemini/index.ts, which uses the same SDK.

import { GoogleGenAI, FunctionCallingConfigMode, type Part, type Content, type FunctionDeclaration } from '@google/genai';
import { randomUUID } from 'crypto';
import { logger } from '../../infrastructure/logging';
import { BYOK_TOKEN_HEADER } from '../../byok/headers';
import type {
  LLMProviderClient,
  LLMCompletionRequest,
  LLMCompletionResponse,
  LLMModelTier,
  LLMStopReason,
  LLMToolCall,
} from '../types';
import { LLMStructuredOutputError } from '../types';

// `global` is the only Vertex location serving Gemini 3 for these projects;
// GCP_LOCATION overrides it. Mirrors the agent-execution adapter's default.
const DEFAULT_LOCATION = 'global';
const DEFAULT_MODEL = 'gemini-3.1-pro-preview';
const DEFAULT_MAX_TOKENS = 4096;

// Vertex publisher model IDs. There is no GA `gemini-3.1-pro` or plain
// `gemini-3.1-flash` — the served IDs are `-pro-preview`, `gemini-3.5-flash`,
// and `gemini-3.1-flash-lite` (verified against the live model garden).
export const TIER_MODELS: Record<LLMModelTier, string> = {
  large:    'gemini-3.1-pro-preview',
  medium:   'gemini-3.5-flash',
  small:    'gemini-3.1-flash-lite',
};

/**
 * Map a Gemini candidate `finishReason` to the unified LLMStopReason. Gemini
 * has no dedicated 'tool_use' finish reason — tool use is detected by the
 * caller (functionCall parts present) and passed via `hasToolCalls`. Safety
 * blocks surface two ways: a prompt-level block (`promptFeedback.blockReason`,
 * which yields NO candidates and would otherwise read as an empty success),
 * passed via `promptBlocked`; or a candidate-level finishReason of
 * SAFETY/PROHIBITED_CONTENT/RECITATION/BLOCKLIST/SPII/IMAGE_SAFETY. Both map to
 * 'refusal', never 'other' or a successful completion. Precedence matches the
 * original inline logic: promptBlocked → hasToolCalls → finishReason switch.
 * Exported as a pure function so the mapping is unit-testable without mocking
 * the Vertex client.
 */
export function mapGoogleStopReason(
  finishReason: string | undefined,
  hasToolCalls: boolean,
  promptBlocked: boolean,
): LLMStopReason {
  if (promptBlocked) return 'refusal';
  if (hasToolCalls) return 'tool_use';
  switch (finishReason) {
    case 'STOP':
      return 'end_turn';
    case 'MAX_TOKENS':
      return 'max_tokens';
    case 'SAFETY':
    case 'PROHIBITED_CONTENT':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'SPII':
    case 'IMAGE_SAFETY':
      return 'refusal';
    default:
      return 'other';
  }
}

export class GoogleProvider implements LLMProviderClient {
  readonly provider = 'google' as const;
  private ai: GoogleGenAI;
  private projectId: string;

  private constructor(ai: GoogleGenAI, projectId: string) {
    this.ai = ai;
    this.projectId = projectId;
  }

  /**
   * An instance that talks to the BYOK gateway instead of Liftoff's own Vertex.
   *
   * `project` and `location` are the CUSTOMER's — Vertex names both in every
   * request path, so the client builds the path for their account even though
   * the service account that opens it never leaves the control plane.
   *
   * The run token rides in a header of its own rather than in `Authorization`.
   * `@google/genai` fills that one in with an Application Default Credentials
   * token before the request leaves this process, and the gateway replaces it
   * with a token minted from the customer's service account — so the two
   * credentials never contend for the same header.
   *
   * Per call rather than cached, because the credential is per (tenant, run).
   */
  static createForGateway(
    gatewayUrl: string,
    project: string,
    location: string,
    token: string,
  ): GoogleProvider {
    const ai = new GoogleGenAI({
      vertexai: true,
      project,
      location,
      httpOptions: {
        baseUrl: gatewayUrl.replace(/\/+$/, ''),
        headers: { [BYOK_TOKEN_HEADER]: token },
      },
    });
    return new GoogleProvider(ai, project);
  }

  static async create(): Promise<GoogleProvider | null> {
    const projectId = process.env.GCP_PROJECT_ID;
    if (!projectId) {
      logger.info({ message: 'GCP_PROJECT_ID not set, Google provider unavailable' });
      return null;
    }

    try {
      const ai = new GoogleGenAI({
        vertexai: true,
        project: projectId,
        location: process.env.GCP_LOCATION ?? DEFAULT_LOCATION,
      });
      logger.info({ message: 'Google (Vertex AI) provider initialized' });
      return new GoogleProvider(ai, projectId);
    } catch (error) {
      logger.warn({
        message: 'Failed to initialize Google provider',
        error: (error as Error).message,
      });
      return null;
    }
  }

  async complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse> {
    const modelName =
      request.model
      ?? (request.tier ? TIER_MODELS[request.tier] : undefined)
      ?? DEFAULT_MODEL;
    const maxTokens = request.maxTokens || DEFAULT_MAX_TOKENS;
    // The caller's per-call deadline (see LLMCompletionRequest.timeoutMs),
    // merged by the SDK over the client's own httpOptions so gateway headers
    // survive. There is no retry to bound: this client sets no retryOptions,
    // and the SDK only retries when it has them.
    const perCallHttpOptions = request.timeoutMs !== undefined
      ? { httpOptions: { timeout: request.timeoutMs } }
      : {};

    // Build Gemini function declarations from request.tools. MCP/tool schemas
    // are raw JSON Schema → use `parametersJsonSchema` (NOT `parameters`, which
    // genai treats as an OpenAPI-style Schema with uppercase Type enums).
    const functionDeclarations: FunctionDeclaration[] | undefined = request.tools?.length
      ? request.tools.map(t => {
          // Gemini doesn't support input_examples natively — embed in description.
          const description = t.input_examples
            ? `${t.description}\n\nExamples:\n${t.input_examples.map(ex => JSON.stringify(ex)).join('\n')}`
            : t.description;
          return {
            name: t.name,
            description,
            parametersJsonSchema: t.input_schema,
          };
        })
      : undefined;
    const tools = functionDeclarations ? [{ functionDeclarations }] : undefined;

    // Build contents from messages. System message → systemInstruction (config).
    const systemInstruction = request.messages.find(m => m.role === 'system')?.content;
    const contents: Content[] = request.messages
      .filter(m => m.role !== 'system')
      .map(m => {
        // Tool result messages → functionResponse parts.
        if (m.role === 'tool') {
          return {
            role: 'user' as const,
            parts: [{
              functionResponse: {
                name: m.toolCallId || '',
                response: { result: m.content },
              },
            }],
          };
        }

        // Assistant messages with tool calls → functionCall parts.
        if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
          const msgParts: Part[] = [];
          if (m.content && m.content.trim().length > 0) {
            msgParts.push({ text: m.content });
          }
          for (const tc of m.toolCalls) {
            msgParts.push({ functionCall: { name: tc.name, args: tc.input } });
          }
          return { role: 'model' as const, parts: msgParts };
        }

        // Plain text messages.
        return {
          role: (m.role === 'assistant' ? 'model' : 'user') as 'model' | 'user',
          parts: [{ text: m.content }],
        };
      });

    // If responseSchema is provided, use forced function calling to enforce
    // structured output. Mirrors the Anthropic + OpenAI providers: the schema
    // becomes a single forced call, request.tools is ignored, and `content`
    // carries the JSON string so every caller sees one shape. Previously this
    // provider ignored responseSchema entirely and returned prose, which broke
    // callers that JSON.parse the content.
    //
    // Forced function calling rather than config.responseSchema because the
    // latter takes Gemini's OpenAPI-subset Schema and cannot be combined with
    // tools; parametersJsonSchema accepts our raw JSON Schema directly (same
    // reason the tool mapping above uses it).
    if (request.responseSchema) {
      const schemaName = request.responseSchema.name;
      const structured = await this.ai.models.generateContent({
        model: modelName,
        contents,
        config: {
          systemInstruction: systemInstruction || undefined,
          maxOutputTokens: maxTokens,
          temperature: request.temperature,
          ...perCallHttpOptions,
          tools: [{
            functionDeclarations: [{
              name: schemaName,
              description: request.responseSchema.description
                || `Generate structured output for ${schemaName}`,
              parametersJsonSchema: request.responseSchema.schema,
            }],
          }],
          toolConfig: {
            functionCallingConfig: {
              mode: FunctionCallingConfigMode.ANY,
              allowedFunctionNames: [schemaName],
            },
          },
        },
      });
      const call = (structured.candidates?.[0]?.content?.parts ?? [])
        .find(p => p.functionCall)?.functionCall;
      if (!call) {
        throw new LLMStructuredOutputError(this.provider, schemaName);
      }
      const structuredUsage = structured.usageMetadata;
      return {
        content: JSON.stringify(call.args ?? {}),
        model: modelName,
        provider: this.provider,
        usage: structuredUsage ? {
          inputTokens: structuredUsage.promptTokenCount || 0,
          outputTokens: structuredUsage.candidatesTokenCount || 0,
          cachedTokens: structuredUsage.cachedContentTokenCount || 0,
        } : undefined,
      };
    }

    const response = await this.ai.models.generateContent({
      model: modelName,
      contents,
      config: {
        systemInstruction: systemInstruction || undefined,
        tools,
        maxOutputTokens: maxTokens,
        temperature: request.temperature,
        ...perCallHttpOptions,
      },
    });

    const parts: Part[] = response.candidates?.[0]?.content?.parts ?? [];

    // Extract text content.
    const content = parts
      .filter((p): p is Part & { text: string } => typeof p.text === 'string')
      .map(p => p.text)
      .join('');

    // Extract function calls if any.
    const toolCalls: LLMToolCall[] = parts
      .filter((p): p is Part & { functionCall: NonNullable<Part['functionCall']> } => !!p.functionCall)
      .map(p => ({
        id: randomUUID(),  // Gemini doesn't provide tool call IDs
        name: p.functionCall.name ?? '',
        input: (p.functionCall.args ?? {}) as Record<string, unknown>,
      }));

    // Determine stop reason. Gemini has no dedicated 'tool_use' finish reason —
    // we detect tool use by checking for functionCall parts. Safety blocks
    // surface two ways: a prompt-level block (promptFeedback.blockReason, which
    // yields NO candidates and would otherwise read as an empty success), or a
    // candidate-level finishReason of SAFETY/PROHIBITED_CONTENT/etc. Both map to
    // 'refusal', never 'other' or a successful completion.
    const promptBlockReason = (
      response as { promptFeedback?: { blockReason?: string } }
    ).promptFeedback?.blockReason;
    const stopReason = mapGoogleStopReason(
      response.candidates?.[0]?.finishReason,
      toolCalls.length > 0,
      !!promptBlockReason,
    );

    const usage = response.usageMetadata;
    return {
      content,
      model: modelName,
      provider: this.provider,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      stopReason,
      usage: usage ? {
        inputTokens: usage.promptTokenCount || 0,
        outputTokens: usage.candidatesTokenCount || 0,
        cachedTokens: usage.cachedContentTokenCount || 0,
      } : undefined,
    };
  }

  /** Part 2 — exact API-backed token count via @google/genai's countTokens.
   *  Response: `{ totalTokens?: number; cachedContentTokenCount?: number }`.
   *  Tool declarations are counted by the API. `thinking` is not a parameter
   *  on countTokens for Gemini — when `request.thinking` is supplied (for
   *  Anthropic/OpenAI parity) the Google provider ignores it silently. */
  async countTokens(request: import('../types').LLMTokenCountRequest): Promise<import('../types').LLMTokenCountResult> {
    const functionDeclarations: FunctionDeclaration[] | undefined = request.tools?.length
      ? request.tools.map(t => ({
          name: t.name,
          description: t.input_examples
            ? `${t.description}\n\nExamples:\n${t.input_examples.map(ex => JSON.stringify(ex)).join('\n')}`
            : t.description,
          parametersJsonSchema: t.input_schema,
        }))
      : undefined;
    const tools = functionDeclarations ? [{ functionDeclarations }] : undefined;

    // Build contents preserving tool_use / tool_result structure so the
    // API counts function-call args and function-response payloads — not
    // just plain text. Mirrors the complete() builder above; without it,
    // counts on a conversation that already has tool turns under-report
    // by however many tokens the function declarations carry.
    const contents: Content[] = request.messages
      .filter(m => m.role !== 'system')
      .map(m => {
        if (m.role === 'tool') {
          return {
            role: 'user' as const,
            parts: [{
              functionResponse: {
                name: m.toolCallId || '',
                response: { result: m.content },
              },
            }],
          };
        }
        if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
          const msgParts: Part[] = [];
          if (m.content && m.content.trim().length > 0) {
            msgParts.push({ text: m.content });
          }
          for (const tc of m.toolCalls) {
            msgParts.push({ functionCall: { name: tc.name, args: tc.input } });
          }
          return { role: 'model' as const, parts: msgParts };
        }
        return {
          role: (m.role === 'assistant' ? 'model' : 'user') as 'model' | 'user',
          parts: [{ text: m.content }],
        };
      });

    const result = await this.ai.models.countTokens({
      model: request.model,
      contents,
      config: {
        ...(request.system ? { systemInstruction: request.system } : {}),
        ...(tools ? { tools } : {}),
      },
    });
    return { inputTokens: result.totalTokens ?? 0, estimated: false };
  }
}
