// The OPENAI-WIRE adapter: one run loop for every endpoint that speaks the
// OpenAI wire format — OpenAI itself, OpenRouter, and xAI.
//
// It knows about none of them. Which endpoint a run goes to, what that endpoint
// calls its models, and which hosted tools it offers are all the TARGET's
// answers (see wire-target.ts); this file owns the loop they share. That split
// is what lets one fix here repair three vendors at once — and it is why the
// directory is named for the WIRE rather than for OpenAI, which for a long time
// made a defect in this shared loop read as an OpenAI problem.
//
// Wraps @openai/agents@^0.8.5 (re-exports from
// @openai/agents-core). API surface verified against the installed
// agent.d.ts / run.d.ts / mcp.d.ts / result.d.ts. Hook strategies:
//   - HITL gate         → InputGuardrail at agent level (agents-core/guardrail.d.ts)
//   - Recovery LLM      → drained between run() invocations; corrections appended
//                         to the conversation accumulator for the next turn
//   - Tool catalog      → native mcpServers (mcp.d.ts), no bridge
//   - Pause / resume    → abort + RunResult.state serialize + re-invoke

import {
  run,
  Agent,
  tool,
  webSearchTool,
  protocol,
  type AgentInputItem,
  type RunItem,
  type StreamedRunResult,
} from '@openai/agents';
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
  PlatformMessage,
  PlatformContent,
  ToolResultObserver,
} from '../types';
import { AGENT_INVOCATION_GATE_NAME } from '../types';
import type { McpToolCatalog } from '../catalog-types';
import { needsExplicitCacheBreakpoints } from '../../../llm/providers/qwen';
import { roundIsTerminal, logTurnClosed } from '../../terminal-tools';
import { mcpToOpenAiFunctionTools, type BridgeContext } from '../mcp-bridge';
import { toolResultFailure } from '../../../tool-gateway/mcp-result';
import { getMcpClientPool } from '../mcp-client-pool';
import { ArgumentDeltaCorrelator } from './argument-deltas';
import { logger } from '../../../infrastructure/logging';
import {
  forcingDirectiveForRequest,
  openAiToolChoiceSettings,
  openAiWireToolChoice,
} from '../grounding-forcing';
import type { WireTarget } from './wire-target';
import { extractProviderFailure } from '../provider-failure';

/**
 * One hosted web-search invocation, as this wire reports it.
 *
 * Shared rather than per-vendor: every endpoint on this wire that runs a hosted
 * search reports it the same way, and every one of them bills per CALL. The
 * count is the whole input to that bill, so an undercount is money not charged
 * — and it fails silently, because zero searches is an ordinary run.
 *
 * The shape is the SDK's, not the vendor's: `openaiResponsesModel` maps a
 * `web_search_call` output item to a `hosted_tool_call` protocol item carrying
 * the original type as its NAME, surfaced as a `tool_call_item`. Matching on
 * the run-item type alone is not enough — every function tool the agent
 * dispatches is a `tool_call_item` too.
 *
 * `tool_search_call_item` is also accepted: it is the SDK's newer dedicated
 * item type, and which arrives depends on the SDK version rather than on us.
 */
function isWebSearchCallItem(it: unknown): boolean {
  const item = it as { type?: string; rawItem?: { type?: string; name?: string } };
  if (item?.type === 'tool_search_call_item') return true;
  return item?.rawItem?.type === 'hosted_tool_call'
    && item?.rawItem?.name === 'web_search_call';
}

export class OpenAiWireAdapter implements VendorSdkAdapter {
  /** Which endpoint served the run, for provenance and logs. Read off the
   *  TARGET rather than declared, so it cannot disagree with where the call
   *  actually went — and so a new endpoint needs no subclass to be named. */
  get kind(): string { return this.target.name; }
  /** The engine this target is, by the id the rest of the runtime uses. Three
   *  targets share the adapter; a line labelled by the adapter alone read a
   *  Grok run as an OpenRouter one. */
  private get engineId(): 'openai-agents' | 'xai-openai-wire' | 'openrouter-openai-wire' {
    return this.target.name === 'openai' ? 'openai-agents' : this.target.name === 'xai' ? 'xai-openai-wire' : 'openrouter-openai-wire';
  }
  private catalog: McpToolCatalog | null = null;
  private hitlGate: HitlGate | null = null;
  private anomalyHandler: AnomalyHandler | null = null;
  private toolBatchHandler: ToolBatchHandler | null = null;
  private toolResultObserver: ToolResultObserver | null = null;
  /** The calls the bridge handed to the observer, waited for, and had
   *  confirmed remembered — marked on their finished events. */
  private recordedCalls = new Set<string>();
  /** Part 6 — set by registerTrajectoryRecorder; null when sink is disabled. */
  private recorder: import('../types').TrajectoryRecorder | null = null;
  private currentInvocation: InvocationInput | null = null;
  private injected: UserMessage[] = [];
  private paused = false;
  /** Which endpoint this instance is pointed at, and what that endpoint calls
   *  its models. Required: this class serves several endpoints and defaults to
   *  none of them, so a caller has to say which one it means. */
  protected readonly target: WireTarget;

  constructor(opts: { target: WireTarget }) {
    this.target = opts.target;
  }

  /**
   * What this run spent, from whatever the SDK managed to complete.
   *
   * Emitted on EVERY exit — the clean one, each pause, an abort, a max-turns
   * ceiling, and any other error. It used to be emitted only after a clean
   * loop, so a run that threw recorded NOTHING: ten turns of tokens, billed to
   * nobody, and invisible, because a failed run with no cost row looks exactly
   * like a run that never started. Found on a Grok turn that searched the web
   * for 38 seconds, hit the turn ceiling, and reported `ok:true` with no usage.
   *
   * A throw does not refund what was already spent, so the only question is
   * whether we recorded it. An undefined result means the run never began —
   * the one case where there is genuinely nothing to bill.
   *
   * Hosted web_search is billed per CALL rather than per token, so its count
   * rides along here: this is the only place that knows how many ran.
   */
  private *usageEventsFor(
    result: { rawResponses?: unknown[]; newItems?: unknown[] } | undefined,
  ): Generator<InvocationEvent> {
    if (!result) return;
    let inputTokens = 0, outputTokens = 0, cachedTokens = 0;
    // Both spellings, for the same reason cachedTokens below already reads
    // both: this file serves OpenAI, OpenRouter and xAI over one wire, and they
    // do not agree on the casing. The SDK normalises to camelCase for its own
    // vendor; a third-party base URL returns what its API returns, which is
    // snake_case, and the responses API and chat-completions disagree again on
    // input_tokens versus prompt_tokens.
    //
    // Read one spelling and the totals are zero, the guard below suppresses the
    // event, and the engine reports NO USAGE AT ALL — which is not the same as
    // zero and cannot be told apart from it downstream. xai-openai-wire has
    // been in that state, so its cache ratio was never measurable and its cost
    // never attributed.
    const responses = (result.rawResponses ?? []) as Array<{ usage?: Record<string, unknown> }>;
    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    // What the gateway charged, summed over the turn's requests. OpenRouter
    // returns it on `usage.cost` when the request asks for accounting; the SDK
    // hands the raw response through untouched, which is why it is reachable
    // here at all. Left undefined when no response carried one, because the
    // direct-API vendors on this same wire report no charge and a zero here
    // would un-bill the call.
    let vendorCostUsd: number | undefined;
    for (const r of responses) {
      const u = r.usage ?? {};
      const c = num(u.cost);
      if (c > 0) vendorCostUsd = (vendorCostUsd ?? 0) + c;
      inputTokens += num(u.inputTokens) || num(u.input_tokens) || num(u.prompt_tokens);
      outputTokens += num(u.outputTokens) || num(u.output_tokens) || num(u.completion_tokens);
      const details = (u.inputTokensDetails ?? u.input_tokens_details ?? u.prompt_tokens_details) as
        Array<Record<string, number>> | Record<string, number> | undefined;
      // The responses API sends an array of detail objects; chat-completions
      // sends one object. Both carry the cached count under either casing.
      for (const d of Array.isArray(details) ? details : details ? [details] : []) {
        cachedTokens += num(d.cached_tokens) || num(d.cachedTokens);
      }
    }
    const webSearchRequests = (result.newItems ?? []).filter(isWebSearchCallItem).length;
    if (inputTokens || outputTokens || cachedTokens || webSearchRequests || vendorCostUsd) {
      yield {
        type: 'usage',
        usage: {
          inputTokens,
          outputTokens,
          cachedTokens,
          // The prompt total already includes the cached part on this wire, so
          // the context is that figure unchanged.
          contextTokens: inputTokens,
          webSearchRequests: webSearchRequests || undefined,
          vendorCostUsd,
        },
      };
    }
  }

  async *invoke(input: InvocationInput, signal: AbortSignal): AsyncIterable<InvocationEvent> {
    if (!this.catalog) throw new Error('Tool catalog not registered');
    this.currentInvocation = input;
    this.paused = false;
    this.injected = [];

    // Vendor-hosted MCP servers are NOT registered natively here. They are
    // enumerated into catalog.tools (service.ts buildToolGatewayAndCatalog →
    // vendor-mcp-enumerate) and dispatched through the bridge alongside
    // in-process tools, so tool-error recovery + the per-tool HITL gate apply to
    // them. `mcpServers: []` below; the bridge's mcp-client-pool owns the remote
    // transport and releaseAll() in finally tears the clients down.

    // Internal abort controller — composed with the caller-provided
    // signal. The bridge calls `bridgeContext.abort()` on a HITL gate hit
    // to tear down the OpenAI run loop immediately, so the model can't
    // emit further tool calls (potentially non-gated, actually executed)
    // within the same run after the gate fired. Without this abort,
    // `run()` with `toolUseBehavior: 'run_llm_again'` would feed the
    // error-shaped tool result back to the LLM and keep going; a second
    // gated tool in the same run would overwrite pendingHitlGate and the
    // first approval would be lost.
    // §2d gap-fix.
    const internalAbort = new AbortController();
    const onOuterAbort = () => internalAbort.abort();
    if (signal.aborted) internalAbort.abort();
    else signal.addEventListener('abort', onOuterAbort, { once: true });

    // In-process tool-gateway servers exposed as native OpenAI function
    // tools via the bridge. dispatchFunctionCall acquires an in-memory
    // MCP client paired with the live McpServer instance, so the same
    // tool names work identically across Anthropic (native MCP) and
    // OpenAI (function-tool bridge).
    this.recordedCalls = new Set();
    const bridgeContext: BridgeContext = {
      tenantId: input.tenantId,
      invocationId: input.invocationId,
      hitlGate: this.hitlGate,
      anomalyHandler: this.anomalyHandler,
      pendingHitlGate: null,
      abort: () => internalAbort.abort(),
      onRecoveryInject: (text) => { this.injected.push({ text, source: 'system' }); },
      toolResultObserver: this.toolResultObserver,
      recordedCalls: this.recordedCalls,
    };
    const functionTools = mcpToOpenAiFunctionTools(this.catalog, bridgeContext)
      .map((ft) => tool({
        name: ft.name,
        description: ft.description,
        // strict:false lets us pass the raw JSON Schema MCP tools emit
        // (which includes additionalProperties, optional fields, etc.) —
        // the OpenAI SDK's strict mode requires a sealed schema we'd have
        // to canonicalise per tool.
        parameters: ft.parameters as Parameters<typeof tool>[0]['parameters'],
        strict: false,
        // The SDK hands the call's own id in `details.toolCall.callId`; it
        // rides on the dispatch so a rejection is folded into its batch.
        execute: ((args: Record<string, unknown>, _ctx: unknown, details?: { toolCall?: { callId?: string } }) =>
          ft.execute(args, { callId: details?.toolCall?.callId })) as Parameters<typeof tool>[0]['execute'],
      } as Parameters<typeof tool>[0]));

    let conversation: AgentInputItem[] = this.translatePlatformMessages(input.messages);

    // The endpoint's own hosted web search, when it has one. Which tools those
    // are is the TARGET's answer: OpenAI serves web_search on its Responses-API
    // families, xAI serves it on every Grok model, OpenRouter serves none. Where
    // there is none, the platform's bridged web tools still cover web.
    const nativeTools = this.target.nativeWebTools(input);
    if (nativeTools.length === 0) {
      // Observable (not silent): native web_search isn't attached for this model.
      logger.debug(
        { model: input.model, invocationId: input.invocationId },
        'openai-adapter: native web_search skipped (model is not a Responses-API web_search family); web_fetch_advanced still covers fetch',
      );
    }

    // Where this call goes, and what the endpoint there calls the model. Both
    // answers belong to the target: this class serves several OpenAI-wire
    // endpoints and knowing which one it is talking to is the only difference
    // between them.
    const sdkProvider = await this.target.sdkProvider(input);
    const agentModel = await this.target.modelId(input, sdkProvider);

    const terminal = new Set(input.terminalToolNames ?? []);
    /** Whether this turn has produced assistant text yet. Read through a closure
     *  because the run object does not exist until after the agent is built. */
    let spokenChars = 0;
    const hasSpoken = (): boolean => spokenChars > 0;

    const agent = new Agent({
      name: 'agent',
      instructions: input.systemPrompt,
      model: agentModel,
      mcpServers: [],
      inputGuardrails: this.makeInputGuardrails(input),
      handoffs: [],
      tools: [...functionTools, ...nativeTools],
      handoffDescription: '',
      modelSettings: {},
      outputGuardrails: [],
      outputType: 'text',
      // End the turn when a round did nothing but finish the work.
      //
      // The FUNCTION form, not `stopAtToolNames`, and the difference decides
      // whether this is safe. `stopAtToolNames` stops at the FIRST listed tool
      // called, whatever else the round was doing, and makes that tool's raw
      // output the run's final output — so a round that posted the review AND
      // read the next pull request would be truncated mid-plan, and the written
      // summary would be replaced by tool JSON in the transcript. The function
      // receives the whole round, which is the only place "did this round do
      // nothing but finish" can be asked.
      //
      // Falls through to `run_llm_again` for an agent with no graph: nothing
      // knows when a conversational run is done, so nothing should end it early.
      toolUseBehavior: terminal.size === 0
        ? 'run_llm_again'
        : (_ctx, toolResults) => {
            const names = toolResults.map((r) => r.tool?.name ?? '');
            if (!roundIsTerminal(names, terminal)) {
              return { isFinalOutput: false, isInterrupted: undefined };
            }
            // Only when the turn has ALREADY SPOKEN.
            //
            // Ending here skips the model call that would have written the
            // closing sentence, so a turn that has said nothing yet would end
            // with an empty reply — a blank bubble in an interactive thread,
            // which this estate has shipped before and is worse than the call
            // this saves. With text already streamed the sentence is redundant;
            // without it, it is the only thing the person would read.
            if (!hasSpoken()) return { isFinalOutput: false, isInterrupted: undefined };
            // The delivery already happened in the tool that just ran; this is
            // the sentence the extra model call would have written.
            logTurnClosed(this.engineId, names, input.invocationId);
            return {
              isFinalOutput: true,
              isInterrupted: undefined,
              finalOutput: '',
            };
          },
      resetToolChoice: true,
    });

    // Prompt-cache routing, where the endpoint has such a thing.
    //
    // It goes through `providerData` because the Agents SDK has no field for
    // it: `providerData` is spread into the request body verbatim, which is
    // how a wire parameter the SDK does not model reaches the endpoint.
    //
    // What it does NOT do is make a cache hit — the prefix still has to match
    // byte for byte. It decides WHICH cache is consulted, so two runs of the
    // same agent, which do share a prefix, stop landing on different shards and
    // missing each other. Retention is deliberately left alone: OpenAI
    // deprecated `prompt_cache_retention` in favour of `prompt_cache_options`,
    // non-ZDR organisations already default to the 24h policy, and the only ttl
    // the SDK types accept is '30m' — shorter than the default we would be
    // overriding.
    // Native forcing, where this endpoint has it. An OPTIMISATION over the
    // grounding floor, never the mechanism: the host has already prefetched and
    // appended the read, so an engine that cannot force is not degraded — it is
    // grounded on the same bytes. Forcing only lets the model author the query.
    const forcing = input.groundingToolName
      ? forcingDirectiveForRequest(
        this.engineId,
        input.groundingToolName,
        input.invocationId,
      )
      : null;
    if (input.groundingToolName) {
      agent.modelSettings = {
        ...agent.modelSettings,
        ...openAiToolChoiceSettings(forcing),
        ...(Object.keys(openAiWireToolChoice(forcing)).length > 0
          ? { providerData: { ...(agent.modelSettings?.providerData ?? {}), ...openAiWireToolChoice(forcing) } }
          : {}),
      };
    }

    const cacheKey = this.target.promptCacheKey?.(input);
    if (cacheKey) {
      agent.modelSettings = {
        ...agent.modelSettings,
        providerData: { ...(agent.modelSettings?.providerData ?? {}), prompt_cache_key: cacheKey },
      };
    }

    // Sticky routing, for an endpoint that fans out across providers.
    //
    // A different question from the cache key above: that one names a cache,
    // this one names a CONVERSATION so every turn lands on the provider already
    // holding the prefix. On a fan-out endpoint the cache is per provider, so
    // without this the first turns scatter and the cache hit that would start
    // stickiness never happens.
    //
    // Sent as a body field rather than the `x-session-id` header because the
    // body wins when both are present, and this is the only place either is set.
    const sessionId = this.target.stickySessionId?.(input);
    if (sessionId) {
      agent.modelSettings = {
        ...agent.modelSettings,
        providerData: { ...(agent.modelSettings?.providerData ?? {}), session_id: sessionId },
      };
    }

    // Explicit cache breakpoints, for the one family that needs them.
    //
    // Every other model reachable through this endpoint caches automatically —
    // DeepSeek, Grok, Kimi, Moonshot and Z.AI are all documented as needing no
    // configuration. Alibaba is the exception: it caches only what a
    // `cache_control: { type: 'ephemeral' }` breakpoint marks (openrouter.ai
    // prompt-caching guide, read 2026-09-11).
    //
    // Without this a Qwen run caches nothing while its siblings cache fine —
    // same engine, same adapter, same prompt, only the model id different, which
    // is not a difference anyone would think to look for. It shows up as a bill.
    //
    // Matched on the MODEL ID, not the resolved provider: a Qwen model reached
    // through the `openrouter` provider needs the breakpoint just as much. The
    // requirement is Alibaba's, not ours.
    //
    // The system prompt is sent as ONE block because it is one stable prefix —
    // `prompt-tiers.ts` has already ordered it so everything cacheable comes
    // first, and a breakpoint at its end is a breakpoint at the end of the
    // cacheable part.
    if (needsExplicitCacheBreakpoints(input.model)) {
      agent.modelSettings = {
        ...agent.modelSettings,
        providerData: {
          ...(agent.modelSettings?.providerData ?? {}),
          system: [
            {
              type: 'text',
              text: input.systemPrompt,
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      };
    }

    try {
      while (true) {
        if (signal.aborted) {
          yield { type: 'completion', outcome: 'error', reason: 'aborted' };
          return;
        }

        // run() may throw AbortError when the bridge aborts internalAbort
        // on a HITL gate hit. Catch it locally so the post-loop
        // pendingHitlGate emit fires — propagating would skip the pause
        // event entirely and the outer hybrid loop would see a generic
        // completion error.
        let runResult: StreamedRunResult<unknown, typeof agent>;
        // Declared OUTSIDE the try so the catch below can still bill for what
        // the run managed to spend before it failed. A throw does not refund
        // the tokens already burned.
        let streamed: StreamedRunResult<unknown, typeof agent> | undefined;
        // Tool calls are translated AS THEY HAPPEN, off the stream, not from
        // `newItems` once the run is over. Everything that listens on the
        // event stream — the ledger, the provenance recorder, the persisted
        // call, the chat frames — used to hear about a run's tool calls after
        // its last one: the write at the end of a run was judged against a
        // store its own reads had not reached, and a paused run lost its tool
        // events entirely. The stream's items are the same objects `newItems`
        // holds, so the pass at the end skips them.
        const yieldedLive = new Set<unknown>();
        try {
          // Streaming run: forward token-level text deltas as assistant_delta;
          // newItems (incl. the terminal message_output) are read after the
          // stream completes, so tool calls + the final assistant_message and
          // history/interruptions are processed exactly as the non-streaming
          // path did below.
          // No modelProvider here, and none is possible: it is a field of
          // RunConfig, which only a Runner carries. Which client serves the
          // call is decided when `target.modelId` binds the model to
          // `sdkProvider` above — see bindModel in wire-target.ts.
          streamed = await run(agent, conversation, {
            signal: internalAbort.signal,
            stream: true,
            // The run's own turn budget (the tenant's maxToolCalls, role-
            // clamped by the engine), forwarded so it reaches this engine.
            // Without it the Agents SDK's own default of ten model turns
            // applied to every wire vendor, and the tenant's setting was a
            // no-op on all of them. Undefined leaves the SDK's default.
            ...(typeof input.maxTurns === 'number' ? { maxTurns: input.maxTurns } : {}),
          });
          // The batch boundary for this engine is read off the stream: the
          // calls one model response made are `tool_called` items, and the next
          // `response_started` is the SDK about to make the next request, so
          // every one of them has resolved. The Agents SDK has no request-start
          // hook. Because the close names the ids it collected, a stream consumed
          // late still closes only its own batch.
          let batchCallIds: string[] = [];
          const closeBatch = async () => {
            if (batchCallIds.length === 0) return;
            const ids = batchCallIds;
            batchCallIds = [];
            if (this.toolBatchHandler) await this.toolBatchHandler(ids);
          };
          // Tool-argument fragments come through the SDK's raw `model` events,
          // named by index; this binds each index to the call announced at it
          // and emits `tool_call_partial` the way the Claude adapter does.
          const argumentDeltas = new ArgumentDeltaCorrelator();
          for await (const sev of streamed) {
            if (sev.type === 'run_item_stream_event' && sev.name === 'tool_called') {
              const callId = (sev.item as { rawItem?: { callId?: string } }).rawItem?.callId;
              if (callId) batchCallIds.push(callId);
              yieldedLive.add(sev.item);
              for (const ev of this.translateRunItem(sev.item as RunItem)) yield ev;
              continue;
            }
            if (sev.type === 'run_item_stream_event' && sev.name === 'tool_output') {
              yieldedLive.add(sev.item);
              for (const ev of this.translateRunItem(sev.item as RunItem)) yield ev;
              continue;
            }
            if (sev.type === 'raw_model_stream_event'
                && (sev.data as { type?: string }).type === 'response_started') {
              await closeBatch();
              argumentDeltas.reset();
              continue;
            }
            if (sev.type === 'raw_model_stream_event'
                && (sev.data as { type?: string }).type === 'model') {
              for (const ev of argumentDeltas.onRawEvent((sev.data as { event?: unknown }).event)) yield ev;
              continue;
            }
            if (sev.type === 'raw_model_stream_event'
                && (sev.data as { type?: string }).type === 'output_text_delta') {
              const delta = (sev.data as { delta?: string }).delta;
              if (delta) {
                // Counted so turn-closing can tell a turn that has spoken from
                // one that has not. Ending a silent turn early would leave a
                // blank bubble where the closing sentence would have been.
                spokenChars += delta.length;
                yield { type: 'assistant_delta', text: delta };
              }
            }
          }
          await streamed.completed;
          await closeBatch();
          runResult = streamed;
        } catch (e) {
          // What the run produced BEFORE it was torn down goes into the record
          // first, whatever the reason. The items are recorded off `newItems`
          // once the run resolves, and a pause aborts the run mid-flight: the
          // gate fires inside a tool's execute, the bridge aborts, run()
          // rejects, and the turn that proposed the gated call — its text,
          // its reasoning, the call itself — never reached the recorder. The
          // pause's checkpoint then held only the user turn, and its resume
          // could not find the call it was meant to complete. The SDK keeps
          // the items generated so far on the result, so they are read from
          // there.
          this.recordRunItems(input, streamed?.newItems ?? []);
          // Bridge-initiated abort with a pending gate → fall through to
          // the post-loop emit below.
          if (bridgeContext.pendingDelegationPause) {
            const token = await this.pause('delegation');
            const delegationContext = bridgeContext.pendingDelegationPause;
            bridgeContext.pendingDelegationPause = null;
            yield* this.usageEventsFor(streamed);
            yield { type: 'pause_requested', reason: 'delegation', token, delegationContext };
            return;
          }
          if (bridgeContext.pendingWakePause) {
            const wakeToken = await this.pause('self_wake');
            const wakeContext = bridgeContext.pendingWakePause;
            bridgeContext.pendingWakePause = null;
            yield* this.usageEventsFor(streamed);
            yield { type: 'pause_requested', reason: 'self_wake', token: wakeToken, wakeContext };
            return;
          }
          if (bridgeContext.pendingHitlGate) {
            const token = await this.pause('hitl_gate');
            const gateContext = bridgeContext.pendingHitlGate;
            bridgeContext.pendingHitlGate = null;
            yield* this.usageEventsFor(streamed);
            yield { type: 'pause_requested', reason: 'hitl_gate', token, gateContext };
            return;
          }
          // Bridge-initiated abort because recovery declined another attempt.
          // Checked before the generic branches so the completion names the
          // tool that could not be made to work, rather than reporting the
          // abort machinery.
          if (bridgeContext.recoveryAbortReason) {
            const reason = bridgeContext.recoveryAbortReason;
            bridgeContext.recoveryAbortReason = null;
            yield* this.usageEventsFor(streamed);
            yield { type: 'completion', outcome: 'error', reason };
            return;
          }
          // Outer-signal abort (caller wants to stop) → completion.
          if (signal.aborted) {
            yield* this.usageEventsFor(streamed);
            yield { type: 'completion', outcome: 'error', reason: 'aborted' };
            return;
          }
          // The Agents SDK raises MaxTurnsExceeded for its own ceiling. That is
          // a run cut off while working, not a fault, and routing it through
          // the recovery LLM would spend another model call rediscovering that
          // there was no room left.
          if (e instanceof Error && /max turns/i.test(e.message)) {
            yield* this.usageEventsFor(streamed);
            yield { type: 'completion', outcome: 'limit_reached', reason: e.message };
            return;
          }
          // Anything else → surface as a completion error so the outer
          // hybrid loop can route through the recovery LLM.
          yield* this.usageEventsFor(streamed);
          yield { type: 'completion', outcome: 'error', reason: (e as Error).message, failure: extractProviderFailure(e) };
          return;
        }

        // Translate the newItems into platform events.
        const newItems = runResult.newItems ?? [];
        // Part 6 §D2 — feed the recorder the raw RunItems (which carry
        // reasoning_text + encrypted_content + function_call payloads
        // verbatim) before translateRunItem reduces them to the lossy
        // platform-event shape.
        this.recordRunItems(input, newItems);
        for (const item of newItems) {
          if (yieldedLive.has(item)) continue;
          for (const ev of this.translateRunItem(item)) yield ev;
        }

        yield* this.usageEventsFor(runResult);

        // Oversight HITL signal — the bridge's dispatchFunctionCall set
        // pendingHitlGate on BridgeContext AND called bridgeContext.abort()
        // when the registered hitlGate returned `{ allow: false, hitlPause }`.
        // The catch block above handles the abort-during-run() case; this
        // branch handles the rare case where the gate fired on the last
        // tool of the run (no further tool calls to abort through), so
        // run() resolved normally before pendingHitlGate was set.
        if (bridgeContext.pendingHitlGate) {
          const token = await this.pause('hitl_gate');
          const gateContext = bridgeContext.pendingHitlGate;
          bridgeContext.pendingHitlGate = null;
          yield { type: 'pause_requested', reason: 'hitl_gate', token, gateContext };
          return;
        }

        // Async spawn_task_graph pause — same last-tool-of-run edge case as the
        // HITL branch above: the bridge set pendingDelegationPause + aborted, but
        // run() may have resolved before the abort landed, so the catch didn't
        // fire. Emit the delegation pause here too.
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

        if (this.paused) {
          const token = await this.pause('ask_user');
          yield { type: 'pause_requested', reason: 'ask_user', token };
          return;
        }

        if (runResult.interruptions && runResult.interruptions.length > 0) {
          const token = await this.pause('hitl_gate');
          yield { type: 'pause_requested', reason: 'hitl_gate', token };
          return;
        }

        const drained = this.injected.splice(0, this.injected.length);
        if (drained.length === 0) {
          yield { type: 'completion', outcome: 'success' };
          return;
        }
        conversation = [
          ...runResult.history,
          ...drained.map((m) => this.userMessageToAgentInputItem(m)),
        ];
      }
    } finally {
      signal.removeEventListener('abort', onOuterAbort);
      // Release the bridge's MCP clients for this invocation. Vendor MCP now
      // flows through the bridge pool (in-memory for the gateway, HTTP for
      // remote vendor servers), not native mcpServers — so there are no
      // per-invoke server.connect()/close() to undo; releaseAll closes both.
      await getMcpClientPool().releaseAll(input.invocationId).catch(() => undefined);
    }
  }

  async injectMessage(message: UserMessage): Promise<void> {
    this.injected.push(message);
  }

  async pause(reason: PauseReason): Promise<ResumeToken> {
    this.paused = true;
    const serialized = JSON.stringify({ reason, input: this.currentInvocation });
    // The ENDPOINT, not the loop. This class serves three of them, and a token
    // that always said `openai` described an OpenRouter or Grok pause as an
    // OpenAI one. Nothing routes on this field today — which is exactly why it
    // could stay wrong — but it is what a paused run says about itself.
    return { adapterKind: this.kind, serialized };
  }

  async *resume(
    token: ResumeToken,
    response: UserResponse,
    signal: AbortSignal,
  ): AsyncIterable<InvocationEvent> {
    const data = JSON.parse(token.serialized) as { input: InvocationInput };
    const messages: PlatformMessage[] = [
      ...data.input.messages,
      { role: 'user', content: [{ type: 'text', text: response.text }] },
    ];
    yield* this.invoke({ ...data.input, messages }, signal);
  }

  registerToolCatalog(catalog: McpToolCatalog): void { this.catalog = catalog; }
  registerHitlGate(gate: HitlGate): void { this.hitlGate = gate; }
  registerAnomalyHandler(handler: AnomalyHandler): void { this.anomalyHandler = handler; }
  registerToolBatchHandler(handler: ToolBatchHandler): void { this.toolBatchHandler = handler; }
  registerToolResultObserver(observer: ToolResultObserver): void { this.toolResultObserver = observer; }
  registerTrajectoryRecorder(recorder: import('../types').TrajectoryRecorder): void { this.recorder = recorder; }

  private makeInputGuardrails(input: InvocationInput) {
    if (!this.hitlGate) return [];
    const gate = this.hitlGate;
    return [{
      name: 'hitl-gate',
      execute: async (args: { input: unknown; context: unknown }) => {
        const result = await gate({
          toolName: AGENT_INVOCATION_GATE_NAME,
          args: args.input,
          tenantId: input.tenantId,
          invocationId: input.invocationId,
        });
        return {
          outputInfo: { reason: result.reason ?? '' },
          tripwireTriggered: !result.allow,
        };
      },
    }] as unknown as ConstructorParameters<typeof Agent>[0]['inputGuardrails'];
  }

  /** Platform history → the SDK's input items.
   *
   *  A USER item takes a bare string; an ASSISTANT item does NOT. The SDK's
   *  `AssistantMessageItem` (agents-core protocol.d.ts) requires
   *  `status: 'in_progress' | 'completed' | 'incomplete'` and a `content`
   *  ARRAY of output parts, and the SDK maps over that array — so a string
   *  there throws `item.content.map is not a function` deep inside the run,
   *  as a TypeError with no provider involved.
   *
   *  This is reachable only through cross-engine rebuild: otherwise
   *  `input.messages` on this path holds only the current USER turn, and a
   *  string is valid there. Replaying a conversation rebuilt from the canonical
   *  record is the one thing that hands this adapter assistant history, so a
   *  string here fails on the first real one. Neither the inverse-mapper unit tests nor
   *  the 7x7 matrix could see it: both assert on what `canonicalToEngine`
   *  emits and stop before anything consumes it. */
  private translatePlatformMessages(msgs: PlatformMessage[]): AgentInputItem[] {
    const out: AgentInputItem[] = [];
    // A replayed result carries the call's id and nothing else; the SDK's
    // function_call_result item requires the NAME too, and the only place it
    // exists is the tool_use it answers.
    const nameByCallId = new Map<string, string>();
    for (const m of msgs) {
      for (const c of m.content) if (c.type === 'tool_use') nameByCallId.set(c.callId, c.toolName);
    }
    for (const m of msgs) {
      if (m.role === 'system') continue;
      const text = m.content
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map((c) => c.text)
        .join('\n');
      // The tool exchanges, as the SDK's own items rather than as text or
      // nothing. A `function_call` on the assistant side, a
      // `function_call_result` on the user side, paired by callId — the shape
      // the Responses API replays natively, so a resumed run continues from
      // the call it made and the result it got, not from prose about them.
      // Arguments are the string the model emitted when the history was
      // rebuilt from the canonical record (canonicalToOpenAI preserves it) and
      // are re-serialized when the run's own history carries an object.
      const calls = m.content
        .filter((c): c is Extract<PlatformContent, { type: 'tool_use' }> => c.type === 'tool_use')
        .map((c) => ({
          type: 'function_call',
          callId: c.callId,
          name: c.toolName,
          status: 'completed',
          arguments: typeof c.args === 'string' ? c.args : JSON.stringify(c.args ?? {}),
        } as unknown as AgentInputItem));
      const results = m.content
        .filter((c): c is Extract<PlatformContent, { type: 'tool_result' }> => c.type === 'tool_result')
        .map((c) => ({
          type: 'function_call_result',
          callId: c.callId,
          name: nameByCallId.get(c.callId) ?? 'tool',
          status: 'completed',
          output: { type: 'text', text: typeof c.result === 'string' ? c.result : JSON.stringify(c.result ?? '') },
        } as unknown as AgentInputItem));
      // Images ride the USER turn only, as `input_image` parts with a data URL
      // — the Responses API's own shape, and the only one the Agents SDK will
      // accept. An assistant turn has no image form here, so one is never
      // built: an image on an assistant message is history being replayed and
      // the text beside it already carries what the turn said.
      // Images only: the Responses API has an input_image part and no video
      // one. The gate never routes video to this engine; anything non-image
      // arriving here is described in the text rather than dropped.
      const media = m.role === 'user'
        ? m.content.filter((c): c is Extract<PlatformContent, { type: 'media' }> => c.type === 'media')
        : [];
      const images = media.filter((c) => c.mimeType.startsWith('image/'));
      const unsupportedNote = media
        .filter((c) => !c.mimeType.startsWith('image/'))
        .map((c) => `[The person attached a ${c.mimeType}. This engine cannot receive it.]`)
        .join('\n');
      const textWithNote = [unsupportedNote, text].filter(Boolean).join('\n');
      // The result items go first on a user turn: a turn that answers calls
      // and then speaks answers before it speaks, which is the order the
      // model produced it in.
      out.push(...results);
      if (textWithNote || images.length > 0) {
        if (m.role === 'assistant') {
          out.push({
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text }],
          } as unknown as AgentInputItem);
        } else if (images.length > 0) {
          out.push({
            role: 'user',
            content: [
              ...images.map((img) => ({
                type: 'input_image',
                image: `data:${img.mimeType};base64,${img.dataBase64}`,
              })),
              ...(text ? [{ type: 'input_text', text }] : []),
            ],
          } as unknown as AgentInputItem);
        } else {
          out.push({ role: 'user', content: textWithNote } as unknown as AgentInputItem);
        }
      }
      // The calls an assistant turn made come after its text, as the model
      // emitted them.
      out.push(...calls);
    }
    return out;
  }

  /** Validate a rebuilt history against the SDK's OWN protocol schema.
   *
   *  `protocol.AssistantMessageItem` / `UserMessageItem` are exported by
   *  @openai/agents-core as runtime zod objects, so this checks the vendor's
   *  contract rather than our reading of it — and it moves when the vendor
   *  moves. Verified to discriminate: the pre-fix shape
   *  `{ role: 'assistant', content: <string> }` fails with
   *  `status: Invalid option: expected one of "in_progress"|"completed"|"incomplete"`,
   *  which is the defect stated in the vendor's own words. */
  assertCanReplayHistory(messages: PlatformMessage[]): void {
    const items = this.translatePlatformMessages(messages) as unknown as Array<{ role?: string; type?: string }>;
    items.forEach((item, index) => {
      // The tool exchange items are validated against the SDK's own
      // FunctionCallItem / FunctionCallResultItem, the message items against
      // its message items — every shape this translator emits, checked by the
      // vendor's contract rather than our reading of it.
      const [schema, label] = item.type === 'function_call'
        ? [protocol.FunctionCallItem, 'FunctionCallItem']
        : item.type === 'function_call_result'
          ? [protocol.FunctionCallResultItem, 'FunctionCallResultItem']
          : item.role === 'assistant'
            ? [protocol.AssistantMessageItem, 'AssistantMessageItem']
            : [protocol.UserMessageItem, 'UserMessageItem'];
      const parsed = schema.safeParse(item);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new Error(
          `replayed history item ${index} (${item.type ?? `role=${item.role}`}) is not a valid ${label}: `
          + `${issue.path.join('.') || '<root>'}: ${issue.message}`,
        );
      }
    });
  }

  private userMessageToAgentInputItem(m: UserMessage): AgentInputItem {
    return { role: 'user', content: m.text } as unknown as AgentInputItem;
  }

  /** Feed the recorder the raw RunItems a run produced. Once per run: the
   *  normal exit records the completed run's items, the abort exit records
   *  whatever had been generated by then, and the two never both fire for
   *  the same run. */
  private recordRunItems(input: InvocationInput, items: RunItem[]): void {
    if (!this.recorder) return;
    for (const item of items) {
      this.recorder.recordRaw({
        invocationId: input.invocationId,
        // The provider the ROUTING CHAIN resolved, which the input already
        // carries. The target used to declare it as a constant, and a constant
        // cannot answer for the OpenRouter target: one engine serves four
        // families there, so it recorded all four as the gateway.
        provider: input.provider,
        model: input.model,
        rawKind: 'openai_run_item',
        raw: item,
      });
    }
  }

  // Translate one @openai/agents RunItem into platform events. RunItem class
  // instances expose `_item`-suffixed `type` discriminators ('message_output_item',
  // 'tool_call_item', 'tool_call_output_item', 'tool_search_call_item', …) and the
  // protocol payload lives on `item.rawItem` — NOT on the item's top level. The
  // earlier matcher checked bare 'message_output'/'tool_call'/'tool_output' and
  // read `i.content`/`i.tool_name`, so OpenAI runs emitted only the
  // terminal completion — no assistant_message, no tool_call_started/finished.
  private translateRunItem(item: RunItem): InvocationEvent[] {
    switch (item.type) {
      case 'message_output_item': {
        const raw = item.rawItem;
        const text = (raw.content ?? [])
          .filter((c): c is { type: 'output_text'; text: string } =>
            (c as { type?: string }).type === 'output_text')
          .map((c) => c.text)
          .join('');
        if (!text) return [];
        return [{ type: 'assistant_message', content: [{ type: 'text', text }] }];
      }
      case 'tool_call_item': {
        // The protocol spells it `callId`. Read as `call_id ?? id`, a started
        // call was keyed by the ITEM id and its finished counterpart — whose
        // result item has none — by ''; the two never met, every stream seam
        // saw `toolName: ''`, and persistence grew an overlay to recover the
        // name from the trajectory recorder instead.
        const raw = item.rawItem as { type?: string; name?: string; arguments?: unknown; callId?: string; call_id?: string; id?: string };
        if (raw.type !== 'function_call' || typeof raw.arguments !== 'string') return [];
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(raw.arguments) as Record<string, unknown>;
        } catch {
          return [{
            type: 'anomaly_detected',
            kind: 'malformed_output',
            context: { toolName: raw.name, error: 'tool arguments not JSON', rawData: raw.arguments },
          }];
        }
        return [{
          type: 'tool_call_started',
          toolName: raw.name ?? '',
          args: parsed,
          callId: raw.callId ?? raw.call_id ?? raw.id ?? '',
        }];
      }
      case 'tool_call_output_item': {
        const raw = item.rawItem as { callId?: string; call_id?: string; id?: string; output?: unknown };
        const callId = raw.callId ?? raw.call_id ?? raw.id ?? '';
        // The MODEL-FACING output, on purpose: this event is persisted and
        // replayed into later model contexts, and the untrusted frame on a
        // vendor result is the boundary there. The raw data went to the
        // observer at dispatch. Whether the CALL failed is inside the output —
        // a gate's `{ error }` answered without dispatch, or an `isError`
        // envelope from a tool that ran — read here, once, so the ledger, the
        // persisted call and the surfaces agree.
        const result = raw.output;
        const failure = toolResultFailure(result);
        const recordedAtDispatch = this.recordedCalls.delete(callId);
        return [{
          type: 'tool_call_finished',
          callId,
          result,
          ...(failure ? { error: failure } : {}),
          ...(recordedAtDispatch ? { recordedAtDispatch } : {}),
        }];
      }
      case 'tool_search_call_item': {
        // Hosted web_search (gpt-5 / gpt-4.1 via nativeOpenAiWebTools).
        const raw = item.rawItem as { call_id?: string; callId?: string; arguments?: unknown };
        return [{
          type: 'tool_call_started',
          toolName: 'web_search',
          args: (raw.arguments ?? {}) as Record<string, unknown>,
          callId: raw.call_id ?? raw.callId ?? '',
        }];
      }
      case 'tool_search_output_item': {
        const raw = item.rawItem as { call_id?: string; callId?: string; output?: unknown };
        return [{
          type: 'tool_call_finished',
          callId: raw.call_id ?? raw.callId ?? '',
          result: raw.output,
        }];
      }
      // reasoning is captured by future trajectory work, not here; handoffs /
      // approvals aren't used by the outer Liftoff agent.
      case 'reasoning_item':
      case 'handoff_call_item':
      case 'handoff_output_item':
      case 'tool_approval_item':
      default:
        return [];
    }
  }
}
