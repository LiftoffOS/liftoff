// Gemini VendorSdkAdapter built on Google's Agent Development Kit (@google/adk).
// The ADK owns the agent loop AND context management (TokenBasedContextCompactor
// auto-summarizes old events at a token threshold), so — like the Claude Agent
// SDK for Anthropic — no Liftoff-side context handling ("B") is needed here.
//
// Governance is preserved by routing every tool through the SAME bridge the
// OpenAI adapter uses: each catalog tool becomes an ADK FunctionTool whose
// `execute` calls dispatchFunctionCall(...), so the HITL gate, untrusted
// framing, OU-metering, and single-result bound all still apply. The ADK only
// owns the loop; Liftoff keeps the tool seam.
//
// Structurally parallel to the OpenAI adapter (adapter/openai/index.ts): outer
// re-run loop draining recovery injections, HITL/delegation pause via the
// BridgeContext stash, pause/resume serialized through HybridResumeState.
//
// Requires Vertex env, resolved exactly as the direct @google/genai Gemini
// adapter resolves it (`adkVertexTarget` below): GCP_PROJECT_ID /
// GOOGLE_CLOUD_PROJECT, and GCP_LOCATION / VERTEX_LOCATION /
// GOOGLE_CLOUD_LOCATION, with GOOGLE_GENAI_USE_VERTEXAI checked at boot.
//
// BYO PROVIDER KEYS: not wired here, by scope rather than by obstacle. Google
// BYOK is deliberately limited to the llmClient path, so a workspace's Gemini
// agent turns run on Liftoff's Vertex project even when the workspace has a
// service account on file, and bill as ordinary customer consumption.
//
// Nothing technical stands in the way if that scope widens. ADK declares
// `getHttpOptions()` protected exactly so a subclass can widen it, which is the
// seam a base URL would go through — the customer's credential is a Vertex
// service account and Vertex is the same service this engine already speaks.

import {
  LlmAgent,
  Runner,
  FunctionTool,
  InMemorySessionService,
  TokenBasedContextCompactor,
  LlmSummarizer,
  Gemini,
  getFunctionCalls,
  getFunctionResponses,
  type Event,
} from '@google/adk';
import type { Content } from '@google/genai';
import { toGenaiParameters } from './schema';
import type {
  VendorSdkAdapter,
  InvocationInput,
  InvocationEvent,
  UserMessage,
  UserResponse,
  PauseReason,
  ResumeToken,
  HitlGate,
  AnomalyHandler,
  ToolBatchHandler,
  AnomalyKind,
  PlatformMessage,
  TrajectoryRecorder,
  ToolResultObserver,
} from '../types';
import type { McpToolCatalog } from '../catalog-types';
import { dispatchFunctionCall, type BridgeContext } from '../mcp-bridge';
import { roundIsTerminal, logTurnClosed } from '../../terminal-tools';
import { getMcpClientPool } from '../mcp-client-pool';
import { firstTurnPrompt } from '../conversation-preamble';
import { logger } from '../../../infrastructure/logging';
import { extractProviderFailure, classifyProviderFailure } from '../provider-failure';

const ADK_APP_NAME = 'agent';

/** The Vertex project and region this engine calls, resolved the way the
 *  other two Google engines resolve theirs: the repo-standard names the
 *  deploy sets first, then genai's own, then the default region.
 *
 *  One resolution for all three, because a cache reading is a property of
 *  the endpoint as much as of the request: three engines that read the same
 *  deploy env into different regions are three endpoints, and a benchmark
 *  that compares them compares regions, not engines. The request shape is
 *  otherwise the same here as on the Gen AI SDK engine (the instruction lands
 *  in the system slot, `cachedContentTokenCount` propagates through ADK's
 *  aggregator unchanged, compaction sits 700k tokens away), so the endpoint
 *  is the one adapter-side variable there is. */
export function adkVertexTarget(env: NodeJS.ProcessEnv = process.env): { project: string | undefined; location: string } {
  return {
    project: env.GCP_PROJECT_ID ?? env.GOOGLE_CLOUD_PROJECT,
    location: env.GCP_LOCATION ?? env.VERTEX_LOCATION ?? env.GOOGLE_CLOUD_LOCATION ?? 'global',
  };
}
// Compaction is calibrated below Gemini 3.x's ~1M input window: summarize once a
// session exceeds ~700k tokens, keeping the most recent events raw. Tunable via
// env so it can be adjusted without a redeploy.
const TOKEN_THRESHOLD = Number(process.env.ADK_COMPACT_TOKEN_THRESHOLD) || 700_000;
const EVENT_RETENTION = Number(process.env.ADK_COMPACT_EVENT_RETENTION) || 20;
const SUMMARIZER_MODEL = process.env.ADK_SUMMARIZER_MODEL || 'gemini-flash-latest';

export class GeminiAdkAdapter implements VendorSdkAdapter {
  readonly kind = 'google-adk';
  /** Session-based: the ADK session service holds the history upstream and we
   *  send only the next turn's text. */
  readonly managesOwnContext = true;
  private catalog: McpToolCatalog | null = null;
  private hitlGate: HitlGate | null = null;
  private anomalyHandler: AnomalyHandler | null = null;
  private toolBatchHandler: ToolBatchHandler | null = null;
  private toolResultObserver: ToolResultObserver | null = null;
  /** The calls the bridge handed to the observer and had confirmed remembered. */
  private recordedCalls = new Set<string>();
  private recorder: TrajectoryRecorder | null = null;
  private currentInvocation: InvocationInput | null = null;
  private injected: UserMessage[] = [];
  private paused = false;
  private readonly sessionService = new InMemorySessionService();

  async *invoke(input: InvocationInput, signal: AbortSignal): AsyncIterable<InvocationEvent> {
    if (!this.catalog) throw new Error('Tool catalog not registered');
    this.currentInvocation = input;
    this.paused = false;
    this.injected = [];

    // Internal abort composed with the caller signal. dispatchFunctionCall calls
    // bridgeContext.abort() on a HITL gate hit; ADK's runAsync doesn't accept an
    // AbortSignal, so the abort is a no-op for the loop itself — we instead break
    // the for-await when pendingHitlGate/pendingDelegationPause is set (below).
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
      pendingDelegationPause: null,
      abort: () => internalAbort.abort(),
      onRecoveryInject: (text) => { this.injected.push({ text, source: 'system' }); },
    };

    // Turn-closing on this engine. ADK owns the model loop, and the break it
    // exposes is `skipSummarization`: a function-response event carrying it is
    // a final response (events/event.js isFinalResponse), so the LlmAgent loop
    // ends without the model call that would have written a closing sentence.
    // The decision is the SHARED one — every call in the round terminal, and
    // the turn already spoken — read here off the round the Runner announced
    // before it ran the tools (the model event carrying the functionCalls
    // arrives first, so `currentRound` is set when execute() runs). Set on
    // every tool of a terminal round, because the merged response event takes
    // the last writer's value and a round is all-or-nothing.
    const terminal = new Set(input.terminalToolNames ?? []);
    const turn = { roundNames: [] as string[], spoken: false };

    // Each catalog tool → an ADK FunctionTool that dispatches back through the
    // governed bridge (parity with mcpToOpenAiFunctionTools). One shared
    // BridgeContext so every tool settles through the same hitlGate + recovery.
    const tools = this.catalog.tools.map((t) => new FunctionTool({
      name: t.name,
      description: t.description ?? '',
      // Vertex requires its own Schema shape (uppercase Type enum, OBJECT
      // top-level, whitelisted fields). Raw JSON-Schema is rejected.
      parameters: toGenaiParameters(t.inputSchema),
      // ADK's tool context names the call (`functionCallId`); it rides on the
      // dispatch so a rejection can be folded into its batch.
      execute: async (
        args: unknown,
        toolContext?: { functionCallId?: string; actions?: { skipSummarization?: boolean } },
      ) => {
        const result = await dispatchFunctionCall(
          this.catalog!, t.name, (args ?? {}) as Record<string, unknown>, bridgeContext,
          { callId: toolContext?.functionCallId },
        );
        // Guarded on the turn having SPOKEN, like every other engine: ending a
        // silent turn leaves an empty reply where the sentence would have been.
        if (toolContext?.actions && turn.spoken && roundIsTerminal(turn.roundNames, terminal)) {
          toolContext.actions.skipSummarization = true;
          logTurnClosed('google-adk', turn.roundNames, input.invocationId);
        }
        return result;
      },
    }));

    const { project, location } = adkVertexTarget();
    const agent = new LlmAgent({
      name: ADK_APP_NAME,
      model: new Gemini({ model: input.model, vertexai: true, project, location }),
      instruction: input.systemPrompt,
      tools,
      contextCompactors: [
        new TokenBasedContextCompactor({
          tokenThreshold: TOKEN_THRESHOLD,
          eventRetentionSize: EVENT_RETENTION,
          summarizer: new LlmSummarizer({
            llm: new Gemini({ model: SUMMARIZER_MODEL, vertexai: true, project, location }),
          }),
        }),
      ],
    });

    const userId = input.tenantId;
    // Session id round-trips as the SDK session (chat-continuity + HITL resume).
    const sessionId = input.resumeSessionId ?? input.invocationId;
    const existing = await this.sessionService.getSession({ appName: ADK_APP_NAME, userId, sessionId });
    if (!existing) await this.sessionService.createSession({ appName: ADK_APP_NAME, userId, sessionId });
    yield { type: 'session_started', sessionId };

    const runner = new Runner({ appName: ADK_APP_NAME, agent, sessionService: this.sessionService });

    try {
      // First turn carries the history preamble (multi-turn / HITL-resume replay);
      // subsequent iterations only carry drained recovery injections.
      let nextText = firstTurnPrompt(input.messages);
      while (true) {
        if (signal.aborted) { yield { type: 'completion', outcome: 'error', reason: 'aborted' }; return; }
        const newMessage: Content = { role: 'user', parts: [{ text: nextText }] };

        // Accumulate this turn's assistant text so a terminal assistant_message is
        // GUARANTEED even if ADK streams the response as partial deltas (harness
        // derives finalText from the last assistant_message). Reset per turn.
        let assistantText = '';
        let sawAssistantMessage = false;
        let gated = false;
        // The batch boundary for this engine is read off the Runner's events:
        // a model event whose parts carry `functionCall`s IS the batch (the
        // Runner executes them before the next model call), so the next such
        // event, or the end of the run, closes the previous one. Naming the ids
        // is what keeps a late-consumed event from closing anything but its own.
        let openBatchCallIds: string[] = [];
        const closeBatch = async () => {
          if (openBatchCallIds.length === 0) return;
          const ids = openBatchCallIds;
          openBatchCallIds = [];
          if (this.toolBatchHandler) await this.toolBatchHandler(ids);
        };
        // The run's turn budget (the tenant's maxToolCalls, role-clamped by
        // the engine) reaches the ADK as `RunConfig.maxLlmCalls`: "a limit on
        // the total number of llm calls for a given run", enforced on every
        // model call and thrown past the loop when exceeded (the catch below
        // reads that as the budget spent). Undefined leaves the ADK's own
        // default (500 via createRunConfig).
        const runConfig = typeof input.maxTurns === 'number' && input.maxTurns > 0
          ? { maxLlmCalls: input.maxTurns }
          : undefined;
        for await (const event of runner.runAsync({ userId, sessionId, newMessage, ...(runConfig ? { runConfig } : {}) })) {
          if (signal.aborted) { yield { type: 'completion', outcome: 'error', reason: 'aborted' }; return; }
          const calledIds = (event.content?.parts ?? [])
            .map((part) => (part as { functionCall?: { id?: string } }).functionCall?.id)
            .filter((id): id is string => typeof id === 'string' && id.length > 0);
          if (calledIds.length > 0) {
            await closeBatch();
            openBatchCallIds = calledIds;
          }
          // The round the Runner is about to execute, by name, for the
          // turn-closing decision the tools read.
          const calledNames = (event.content?.parts ?? [])
            .map((part) => (part as { functionCall?: { name?: string } }).functionCall?.name)
            .filter((n): n is string => typeof n === 'string' && n.length > 0);
          if (calledNames.length > 0) turn.roundNames = calledNames;
          if (this.recorder) {
            this.recorder.recordRaw({
              invocationId: input.invocationId,
              provider: 'google',
              model: input.model,
              rawKind: 'adk_event',
              raw: event,
            });
          }

          // ADK surfaces model/transport failures as an Event carrying
          // errorCode/errorMessage and NO content. Without this the failure is
          // silently swallowed and the turn reports success with empty text
          // (and zero usage → zero billing). Surface it as an anomaly + error.
          if (event.errorCode || event.errorMessage) {
            const detail = event.errorMessage || event.errorCode || 'ADK error';
            logger.warn(
              { errorCode: event.errorCode, invocationId: input.invocationId },
              'gemini-adk error event',
            );
            const kind: AnomalyKind = /invalid_rapt|invalid_grant|unauthenticated|permission|auth/i.test(detail)
              ? 'auth_failed'
              : /quota|rate|resource_exhausted|429|529|overload/i.test(detail)
                ? 'rate_limited'
                : 'unknown';
            yield { type: 'anomaly_detected', kind, context: { error: detail, rawData: event.errorCode } };
            yield {
              type: 'completion',
              outcome: 'error',
              reason: detail,
              // ADK hands us its own error code. Classify from that rather than
              // letting the downstream classifier re-read the prose we just
              // built out of it.
              failure: {
                kind: classifyProviderFailure(event.errorCode, undefined),
                ...(event.errorCode ? { providerErrorType: event.errorCode } : {}),
              },
            };
            return;
          }

          for (const ev of this.translateEvent(event)) {
            if (ev.type === 'assistant_delta') {
              assistantText += ev.text;
            } else if (ev.type === 'assistant_message') {
              const t = ev.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
              if (t) { assistantText = t; sawAssistantMessage = true; }
            }
            if (assistantText.length > 0) turn.spoken = true;
            yield ev;
          }

          // Oversight HITL / delegation — dispatchFunctionCall set these on the
          // shared BridgeContext inside a tool's execute(). Break the loop and pause.
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
            gated = true;
            break;
          }
        }
        // The run's last batch has no following model event to close it.
        await closeBatch();
        if (gated) return;

        if (this.paused) {
          const token = await this.pause('ask_user');
          yield { type: 'pause_requested', reason: 'ask_user', token };
          return;
        }

        // Drain recovery-LLM corrections; if any, re-run the ADK turn with them.
        const drained = this.injected.splice(0, this.injected.length);
        if (drained.length === 0) {
          // Emit the accumulated text as a terminal assistant_message if ADK only
          // streamed partials (no non-partial event carried the full text).
          if (assistantText && !sawAssistantMessage) {
            yield { type: 'assistant_message', content: [{ type: 'text', text: assistantText }] };
          }
          yield { type: 'completion', outcome: 'success' };
          return;
        }
        nextText = drained.map((m) => m.text).join('\n');
      }
    } catch (e) {
      if (signal.aborted) { yield { type: 'completion', outcome: 'error', reason: 'aborted' }; return; }
      // The ADK's own ceiling ("Max number of llm calls limit of N exceeded"):
      // a run cut off while working, not a fault, the same reading the wire
      // adapter gives the Agents SDK's max-turns error.
      if (e instanceof Error && /max number of llm calls/i.test(e.message)) {
        yield { type: 'completion', outcome: 'limit_reached', reason: e.message };
        return;
      }
      logger.warn({ err: (e as Error).message, invocationId: input.invocationId }, 'gemini-adk invoke failed');
      yield { type: 'completion', outcome: 'error', reason: (e as Error).message, failure: extractProviderFailure(e) };
    } finally {
      signal.removeEventListener('abort', onOuterAbort);
      await getMcpClientPool().releaseAll(input.invocationId).catch(() => undefined);
    }
  }

  /** Translate one ADK Event into platform events. */
  private translateEvent(event: Event): InvocationEvent[] {
    const out: InvocationEvent[] = [];
    const text = (event.content?.parts ?? [])
      .map((p) => (typeof p.text === 'string' ? p.text : ''))
      .join('');
    if (text) {
      if (event.partial) out.push({ type: 'assistant_delta', text });
      else out.push({ type: 'assistant_message', content: [{ type: 'text', text }] });
    } else if (event.content?.parts?.length && !event.partial) {
      // Content present but no text extracted — reveals the real part shape so we
      // can map it precisely (e.g. inlineData / thought parts) without guessing.
      logger.warn(
        { partKeys: event.content.parts.map((p) => Object.keys(p)) },
        'gemini-adk: non-partial event has content parts but no text',
      );
    }
    for (const fc of getFunctionCalls(event)) {
      out.push({
        type: 'tool_call_started',
        toolName: fc.name ?? '',
        args: (fc.args ?? {}) as Record<string, unknown>,
        callId: fc.id ?? fc.name ?? '',
      });
    }
    for (const fr of getFunctionResponses(event)) {
      const callId = fr.id ?? fr.name ?? '';
      const recordedAtDispatch = this.recordedCalls.delete(callId);
      out.push({ type: 'tool_call_finished', callId, result: fr.response, ...(recordedAtDispatch ? { recordedAtDispatch } : {}) });
    }
    const um = event.usageMetadata;
    if (um) {
      // Google bills thoughtsTokenCount (extended thinking) as OUTPUT and
      // toolUsePromptTokenCount (the function-calling prompt) as INPUT, and
      // neither is inside the count beside it — the SDK states the arithmetic on
      // `totalTokenCount`, which is prompt + candidates + toolUsePrompt +
      // thoughts. The Gemini adapter folds both in; this one read the two narrow
      // counts, so every ADK run with thinking or function-calling on was
      // under-attributed, which is the platform absorbing the difference.
      const inputTokens = (um.promptTokenCount ?? 0) + (um.toolUsePromptTokenCount ?? 0);
      const outputTokens = (um.candidatesTokenCount ?? 0) + (um.thoughtsTokenCount ?? 0);
      const cachedTokens = um.cachedContentTokenCount ?? 0;
      if (inputTokens || outputTokens || cachedTokens) {
        // `promptTokenCount` is the prompt TOTAL, cached content included, so
        // the context is that figure unchanged.
        out.push({ type: 'usage', usage: { inputTokens, outputTokens, cachedTokens, contextTokens: inputTokens } });
      }
    }
    return out;
  }

  async injectMessage(message: UserMessage): Promise<void> {
    this.injected.push(message);
  }

  async pause(reason: PauseReason): Promise<ResumeToken> {
    this.paused = true;
    const sessionId = this.currentInvocation?.resumeSessionId ?? this.currentInvocation?.invocationId;
    return { adapterKind: 'google-adk', serialized: JSON.stringify({ reason, input: this.currentInvocation, sessionId }) };
  }

  async *resume(token: ResumeToken, response: UserResponse, signal: AbortSignal): AsyncIterable<InvocationEvent> {
    const data = JSON.parse(token.serialized) as { input: InvocationInput; sessionId?: string };
    const messages: PlatformMessage[] = [
      ...data.input.messages,
      { role: 'user', content: [{ type: 'text', text: response.text }] },
    ];
    yield* this.invoke(
      { ...data.input, messages, resumeSessionId: data.sessionId ?? data.input.resumeSessionId },
      signal,
    );
  }

  registerToolCatalog(catalog: McpToolCatalog): void { this.catalog = catalog; }
  registerHitlGate(gate: HitlGate): void { this.hitlGate = gate; }
  registerToolResultObserver(observer: ToolResultObserver): void { this.toolResultObserver = observer; }
  registerAnomalyHandler(handler: AnomalyHandler): void { this.anomalyHandler = handler; }
  registerToolBatchHandler(handler: ToolBatchHandler): void { this.toolBatchHandler = handler; }
  registerTrajectoryRecorder(recorder: TrajectoryRecorder): void { this.recorder = recorder; }
}
