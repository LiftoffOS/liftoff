// Anthropic VendorSdkAdapter — wraps @anthropic-ai/claude-agent-sdk@0.3.220.
// (Upgraded from 0.2.98, whose bundled CLI predated claude-opus-5 and applied
// the wrong thinking config for it; 0.3.220 recognizes opus-5 natively.)
// API surface verified against the installed sdk.d.ts. Hook strategies:
//   - HITL gate         → canUseTool callback (sdk.d.ts:146-188)
//   - Recovery LLM      → hooks.PostToolUse (sdk.d.ts:661) + streamInput inject
//   - Tool catalog      → mcpServers config (sdk.d.ts:1226), native passthrough
//   - Pause / resume    → streamInput pause + HybridResumeState persistence
//   - Abort             → Query.interrupt() (sdk.d.ts:1697)

import { logger } from '../../../infrastructure/logging';
import { roundIsTerminal, logTurnClosed } from '../../terminal-tools';
import { dispatchNameFor, isOwnGatewayTool } from '../../../hitl-enforcement/tool-name-resolution';
import { observeDirectMcpResultSize } from '../../../tool-gateway/observe-result-size';
import { takeGatewayHitlPause } from '../../../hitl-enforcement/gateway-pause-signal';
import {
  query,
  AbortError,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type CanUseTool,
  type PermissionResult,
} from '@anthropic-ai/claude-agent-sdk';
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
  PauseGateContext,
  PauseDelegationContext,
  PlatformMessage,
  PlatformContent,
  ToolResultObserver,
} from '../types';
import type { McpToolCatalog } from '../catalog-types';
import { buildAnthropicMcpServers } from './mcp-servers';
import { ANTHROPIC_NATIVE_WEB_TOOLS } from './native-web-tools';
import { flattenToolResultText } from '../tool-result-text';
import { envelopeRawToolError } from '../../../tool-gateway/tool-error-envelope';

interface AnthropicMessageContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}
import { observeToolCall } from '../../verify-on-stop';
import {
  contextHintsForToolCall,
  deriveContextReader,
  type ContextFileReader,
} from '../subdirectory-context';
import { extractProviderFailure } from '../provider-failure';
import { childProcessEnv } from '../child-process-env';
import { applyCommentAuthorship } from '../comment-authorship';
import { toolBlockToText } from '../conversation-preamble';
import { getManagedSecret } from '../../../infrastructure/secret-store';

/** The `output_config.effort` this adapter asks for, per model.
 *
 *  A DENY-LIST with a universal default, for the same reason the LLM providers'
 *  surface table is one: an unrecognised model must get the level that every
 *  effort-capable model accepts, never a guess.
 *
 *  Opus 5.5 is the single exception and the reason this function exists. Its
 *  vendor default is `medium` where Opus 5's was `high`, so the large-tier swap
 *  would otherwise buy LESS thinking than the model it replaces — silently, on
 *  the path that spends nearly every token this runtime spends, and invisibly
 *  to the LLM-provider tests, which do not cover the Agent SDK at all.
 *
 *  SONNET 5.5 IS DELIBERATELY NOT AN EXCEPTION, which is worth stating because
 *  its vendor default IS `high` and this function therefore asks for less than
 *  the vendor would. That is the same direction as the failure above, so it is
 *  a decision rather than an oversight: `medium` is the vendor's own
 *  recommendation for well-specified agentic and multistep tool work, which is
 *  what this adapter runs, and it is the level Sonnet 4.6 ran at here before
 *  the medium tier moved — so the swap changes the model without also changing
 *  how hard it is asked to think. Raising it is an effort sweep, measured
 *  against real runs, not a constant edited in passing. */
export function effortForModel(model: string | undefined): 'medium' | 'high' {
  return model === 'claude-opus-5-5' ? 'high' : 'medium';
}

/**
 * AnthropicAdapter — wraps the Claude Agent SDK.
 *
 * ⚠️ tool_result.is_error is delivered EXCLUSIVELY via the PostToolUse hook
 * callback (see makePostToolUseHook), NOT via the message stream. The synthesized
 * SDKUserMessage that carries `tool_use_result` does NOT carry `is_error` — so
 * translateSDKMessage cannot and must not try to read error state from the stream.
 * Any future rewrite of the Anthropic capture path that sources tool errors from
 * the message stream will silently lose all tool-error context. The anomaly
 * handler depends on the PostToolUse hook for this.
 *
 * ⚠️ translateSDKMessage intentionally DROPS non-text/non-tool_use assistant
 * blocks (thinking, redacted_thinking, server_tool_use, web_search_tool_result,
 * web_fetch_tool_result, …). Forwarding `thinking` blocks would leak signed
 * thinking content into the lossy PlatformContent text channel and break
 * Anthropic message-replay correctness. The drop rate is metered via
 * anthropic_translation_dropped_block_total{block_type}.
 */
export class AnthropicAdapter implements VendorSdkAdapter {
  readonly kind = 'anthropic';
  /** The Claude Agent SDK owns the session and compacts it internally; we
   *  neither see nor bound that history, so the B5 guard stays out of its way. */
  readonly managesOwnContext = true;
  private catalog: McpToolCatalog | null = null;
  /** Whether this turn has produced assistant text yet. Turn-closing reads it so
   *  a silent turn is never ended early — see makePostToolBatchHook. */
  private hasStreamedText = false;
  /** The tool-use blocks currently streaming, by content-block index.
   *
   *  The SDK announces a tool use once (`content_block_start`, carrying the
   *  tool id and name at an index) and then streams its arguments as
   *  `input_json_delta` blocks that carry ONLY the index. Correlating the two is
   *  the state this map holds; without it an argument delta names no call and
   *  cannot be emitted. Cleared at `message_start`, entries dropped at
   *  `content_block_stop`. */
  private streamingToolBlocks = new Map<number, { id: string; name: string }>();
  private hitlGate: HitlGate | null = null;
  private toolResultObserver: ToolResultObserver | null = null;
  /** The tool uses the hooks handed to the observer and had confirmed
   *  remembered — marked on their finished events. */
  private recordedCalls = new Set<string>();
  /** Why a tool use failed, by id, for its finished event. The SDK's
   *  synthesised user message carries no `is_error`, so the only surfaces
   *  that know are the PostToolUse and PostToolUseFailure hooks and the gate. */
  private callErrors = new Map<string, string>();
  /** Cache-WRITE tokens summed across this turn's API calls.
   *
   *  Accumulated from the assistant messages rather than read off the `result`
   *  aggregate, because the Agent SDK's result usage reports
   *  `cache_creation_input_tokens` as 0 even on a turn that demonstrably wrote the
   *  cache — runs whose cache READS climb turn over turn, so writes plainly
   *  happened, still see the result aggregate report none.
   *  An assistant message carries the RAW Anthropic usage for one API call, which
   *  is the same shape platform-backend already bills cache writes from. */
  private cacheWriteTokensThisTurn = 0;
  private anomalyHandler: AnomalyHandler | null = null;
  private toolBatchHandler: ToolBatchHandler | null = null;
  /** Part 6 — set by registerTrajectoryRecorder; null when sink is disabled. */
  private recorder: import('../types').TrajectoryRecorder | null = null;
  private currentInvocation: InvocationInput | null = null;
  private streamInputQueue: SDKUserMessage[] = [];
  private streamInputResolvers: Array<(m: SDKUserMessage) => void> = [];
  private paused = false;
  /** Stash for the oversight gate signal. canUseTool sets this when the
   *  registered hitlGate returns `{ allow: false, hitlPause }`; the
   *  invoke() loop checks it after the query yields its terminal event
   *  (the deny+interrupt above ended the SDK query without running the
   *  tool) and emits `pause_requested(reason: 'hitl_gate', gateContext)`
   *  so the outer hybrid loop can create the approval + persist the pause.
   *  Reset to null at the top of each invoke(). */
  private pendingHitlGate: PauseGateContext | null = null;
  /** Set by the PostToolUse hook when async spawn_task_graph returns its pause
   *  marker (Anthropic bypasses mcp-bridge, so this is its detection channel). */
  private pendingDelegationPause: PauseDelegationContext | null = null;
  /** Set by the tool-result handler when a wake tool returns {__wakePending} (Anthropic bypasses
   * mcp-bridge — this is its detection channel). invoke() interrupts + emits the self_wake pause. */
  private pendingWakePause: import('../types').WakeContext | null = null;
  /** Reader for the run's own filesystem, resolved once per invocation.
   *  `undefined` means "not looked up yet"; `null` means "this agent has no
   *  filesystem", which is the common case and must not be re-derived on every
   *  tool call. */
  private contextReader: ContextFileReader | null | undefined = undefined;

  async *invoke(input: InvocationInput, signal: AbortSignal): AsyncIterable<InvocationEvent> {
    // Per TURN, not per adapter. The instance is reused across a resume, and a
    // flag left true from an earlier turn would let turn-closing end a silent
    // one on the strength of text somebody read minutes ago.
    this.hasStreamedText = false;
    this.streamingToolBlocks.clear();
    this.cacheWriteTokensThisTurn = 0;
    if (!this.catalog) throw new Error('Tool catalog not registered');
    this.currentInvocation = input;
    this.streamInputQueue = [];
    this.streamInputResolvers = [];
    this.paused = false;
    this.pendingHitlGate = null;
    this.pendingDelegationPause = null;
    this.pendingWakePause = null;
    this.recordedCalls = new Set();
    this.callErrors = new Map();
    this.contextReader = undefined;

    const mcpServers = buildAnthropicMcpServers(this.catalog);
    const canUseTool: CanUseTool = this.makeCanUseTool(input);

    // Streaming-input mode — async iterable as the prompt unlocks Query.interrupt(),
    // setPermissionMode(), etc. (sdk.d.ts:1687-1741).
    const promptInput = this.makeStreamInput(input.messages);

    const sdkQuery: Query = query({
      prompt: promptInput,
      options: {
        model: input.model,
        // Pass OUR system prompt to the SDK as a custom string — replaces the
        // SDK's default `claude_code` preset. Without this, every prompt the
        // platform builds (chat persona, distilled instruction, browser
        // preamble, baseline skills) is silently dropped on the Anthropic
        // path: the SDK falls back to the preset, which knows nothing about
        // our agents and aggressively pushes WebFetch for any URL ask. That
        // was the root cause of "Navigate to <URL> picks WebFetch instead
        // of run_browser_task" — the carefully tuned prompt never reached
        // the model. OpenAI and Gemini adapters always wired this
        // correctly (instructions / systemInstruction respectively); this
        // brings Anthropic to parity. See sdk.d.ts:1460 — a string value
        // means "custom prompt, no preset".
        ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
        // Resume the prior SDK session when the caller (interactive chat)
        // hands us one. The Claude Agent SDK reloads the conversation history
        // for that sessionId so this turn continues with full context. The
        // SDK still emits a fresh system init at the start of the resumed
        // stream — we capture its session_id in translateSDKMessage and emit
        // a session_started event so the control plane can persist it.
        ...(input.resumeSessionId ? { resume: input.resumeSessionId } : {}),
        // The child's environment is an ALLOW-LIST, always, not an inherited
        // copy. `Options.env` replaces it wholesale (sdk.d.ts:1451), and the
        // SDK's own example spreads `process.env` — which would hand this
        // child the Cloud SQL password, four service tokens and the OAuth
        // client secret along with the provider keys. See child-process-env.ts
        // for what that closes and, more importantly, what it does not.
        //
        // A gateway session rides in on top: a Liftoff base URL and a
        // short-lived per-run token INSTEAD of a provider key, so the real
        // credential is attached by the gateway rather than sitting where the
        // agent can read it. Both credential variables are set because the CLI
        // accepts either and which one it prefers has changed across releases;
        // setting one and leaving the other unset is how a release quietly
        // starts authenticating with nothing.
        //
        // TWO KINDS OF SESSION TAKE THIS BRANCH, and the wiring is identical
        // for both because it was never about the money. 'byok' keeps a
        // customer's key out of the environment of the process that runs the
        // agent's Bash tool. 'managed_gateway' is Liftoff's own key, and it is a
        // SECOND witness to the counts — read off the vendor's response rather
        // than carried here through this process's own enumerations, which is
        // where the cache write is lost when it is lost. Anthropic bills a write
        // at 1.25x input and reports `input_tokens` exclusive of it, so a cold
        // turn owes almost all of its charge to that one count.
        //
        // The else branch is only what it always said it was: no session at all,
        // so Liftoff's key goes into the environment directly.
        env: childProcessEnv(
          input.byok?.vendor === 'anthropic'
            ? {
                ANTHROPIC_BASE_URL: input.byok.baseUrl,
                ANTHROPIC_AUTH_TOKEN: input.byok.token,
                ANTHROPIC_API_KEY: input.byok.token,
              }
            : { ANTHROPIC_API_KEY: getManagedSecret('ANTHROPIC_API_KEY') },
        ),
        // Pin `cwd` for the SDK so the session JSONL lands at a
        // deterministic path under `<HOME>/.claude/projects/<encoded-cwd>/`.
        // Interactive chat externalizes the JSONL through chat_sessions
        // (migration 294) and restores it before this query() so the SDK's
        // `resume` finds the file regardless of which Cloud Run instance
        // handles the turn. See chat-turn-handler.ts for the round-trip.
        ...(input.sessionStateDir ? { cwd: input.sessionStateDir } : {}),
        // VERIFIED sdk.d.ts:1226 mcpServers expects McpServerConfig records
        mcpServers: mcpServers as Parameters<typeof query>[0]['options'] extends infer O
          ? O extends { mcpServers?: infer M } ? M : never : never,
        canUseTool,
        maxTurns: input.maxTurns,
        // Stream partial assistant messages so translateSDKMessage can forward
        // token-level text deltas as `assistant_delta` (the terminal full
        // `assistant` message is still emitted for history/accounting).
        includePartialMessages: true,
        // Outer agent doesn't get the Claude Code preset; the
        // code_session tool handles code work in a bounded inner session.
        // Native web search/fetch are default-on for every agent (see
        // native-web-tools.ts for the SDK semantics). Allow-listing them
        // auto-approves them past canUseTool (allowedTools is otherwise empty
        // for the outer agent — code work goes via the inner code_session tool).
        allowedTools: [...ANTHROPIC_NATIVE_WEB_TOOLS],
        // Force adaptive thinking. The spawned claude-code CLI subprocess
        // defaults to `{ type: 'enabled', budgetTokens: N }` when a settings
        // file resolves with extended-thinking on — which newer models
        // (Opus 4.x / Sonnet 4.x) reject with
        //   "thinking.type.enabled is not supported for this model.
        //    Use thinking.type.adaptive and output_config.effort to control
        //    thinking behavior."
        // Passing adaptive explicitly overrides that default and works
        // across every model the platform routes to.
        //
        // `between_tools` IS NOT AVAILABLE HERE, and that is a property of the
        // Agent SDK rather than a choice. Sonnet 5.5 returns the prose a model
        // writes between tool calls as `thinking` blocks — empty under the
        // default display — and `between_tools` is the setting that returns
        // that text readably. The Agent SDK's ThinkingConfig union is
        // `adaptive | enabled | disabled` (checked against 0.3.220 and the
        // latest 0.3.284), so there is nothing to send. The consequence is
        // recorded with the drop at translateSDKMessage: mid-loop model prose
        // does not reach a person on this path. The platform's own narration
        // channel is unaffected, and so are final answers. `summarized` would
        // return that prose mixed with reasoning, which may never reach a
        // person, so it is not the way out.
        thinking: { type: 'adaptive' },
        // Claude 5+ models (e.g. claude-opus-5) REQUIRE an effort level
        // alongside adaptive thinking: without it the CLI still resolves
        // `thinking.type.enabled`, which those models reject with
        //   "\"thinking.type.enabled\" is not supported for this model.
        //    Use \"thinking.type.adaptive\" and \"output_config.effort\" ...".
        // The SDK's `effort` option maps to the API's `output_config.effort`
        // (sdk.d.ts:1182 — "Works with adaptive thinking to guide thinking
        // depth"). 'medium' is a general level accepted by every effort-capable
        // model (only 'max' is model-gated), so it is the safe universal
        // companion to the universal adaptive setting above — and it stays the
        // default for every model that had it.
        //
        // Opus 5.5 is the exception, because its VENDOR default moved: Opus 5
        // defaulted to `high` and Opus 5.5 defaults to `medium`. Sending
        // 'medium' here would therefore hand the new large model less thinking
        // than the model it replaces, on the path that spends nearly every
        // token this runtime spends. Pinned back to 'high' so the swap changes
        // the price and not the depth.
        effort: effortForModel(input.model),
        // VERIFIED sdk.d.ts:647 — HookCallback receives a discriminated
        // HookInput union. Cast to the SDK's expected callback shape since
        // we only handle the PostToolUse variant inline.
        hooks: {
          PostToolUse: [
            {
              hooks: [this.makePostToolUseHook() as unknown as Parameters<typeof query>[0]['options'] extends infer O
                ? O extends { hooks?: { PostToolUse?: Array<{ hooks: Array<infer H> }> } } ? H : never : never],
            },
          ],
          // PostToolUse's updatedMCPToolOutput rewrite does NOT fire when a tool
          // FAILS via a thrown error (verified: native vendor-MCP tools like
          // GitHub surface a 404 as a thrown McpError, which triggers
          // PostToolUseFailure — NOT PostToolUse). This hook classifies that
          // failure into the uniform TOOL_ERROR contract for the model + recovery.
          PostToolUseFailure: [
            {
              hooks: [this.makePostToolUseFailureHook() as unknown as Parameters<typeof query>[0]['options'] extends infer O
                ? O extends { hooks?: { PostToolUseFailure?: Array<{ hooks: Array<infer H> }> } } ? H : never : never],
            },
          ],
          // Turn-closing. The batch hook sees the WHOLE round, which is where
          // "did this round do nothing but finish the work" can be asked — a
          // per-call hook cannot tell a terminal call from a terminal round.
          //
          // Ends the turn through `continue: false` on the common hook output,
          // NOT through `hookSpecificOutput`: `PostToolBatchHookSpecificOutput`
          // carries only `additionalContext` and cannot stop anything. The hook
          // existing is not the same as the hook being able to do this.
          PostToolBatch: [
            {
              hooks: [this.makePostToolBatchHook(input) as unknown as Parameters<typeof query>[0]['options'] extends infer O
                ? O extends { hooks?: { PostToolBatch?: Array<{ hooks: Array<infer H> }> } } ? H : never : never],
            },
          ],
        },
      },
    });

    // ALWAYS interrupt the SDK query on the way out, including the normal
    // success path. The SDK spawns a cli.js subprocess per query() and
    // attaches process-level exit listeners to wire its cleanup. If we
    // return early (e.g. on completion / pause_requested) without telling
    // the SDK we're done, the subprocess may linger past the gc edge for
    // this invoke, and the exit listeners accumulate. Under sustained
    // load (dozens of chat turns in a row on the same Cloud Run instance)
    // the SDK's per-query state piles up and triggers both
    // MaxListenersExceededWarning AND, more critically, container OOM —
    // which Cloud Run handles by terminating the instance mid-request.
    // The OOM terminates the chat-turn handler without running its
    // finally block, so PB sees a stream that ends without complete or
    // error. Hence a try/finally that always runs sdkQuery.interrupt()
    // so the SDK gets a deterministic cleanup signal regardless of which
    // return path is taken.
    let interrupted = false;
    const interruptOnce = async (): Promise<void> => {
      if (interrupted) return;
      interrupted = true;
      try {
        await sdkQuery.interrupt();
      } catch {
        // Best-effort cleanup — the subprocess may already be gone if
        // the SDK finished naturally. Ignoring the error is correct.
      }
    };
    try {
      for await (const sdkMessage of sdkQuery) {
        if (signal.aborted) {
          await interruptOnce();
          yield { type: 'completion', outcome: 'error', reason: 'aborted' };
          return;
        }
        // A terminal pause stashed by the PostToolUse hook during the PREVIOUS iteration's tool
        // execution takes precedence over whatever the model streamed next: a suspended run must not
        // continue. Emit it + return BEFORE processing this message (the model's post-tool
        // continuation), otherwise a racing `completion` event below short-circuits the pause and the
        // agent narrates a fabricated resume instead of durably suspending. Priority: delegation > wake.
        if (this.pendingDelegationPause) {
          await interruptOnce();
          const delegationContext = this.pendingDelegationPause;
          this.pendingDelegationPause = null;
          const token = await this.pause('delegation');
          yield { type: 'pause_requested', reason: 'delegation', token, delegationContext };
          return;
        }
        if (this.pendingWakePause) {
          await interruptOnce();
          const wakeContext = this.pendingWakePause;
          this.pendingWakePause = null;
          const wakeToken = await this.pause('self_wake');
          yield { type: 'pause_requested', reason: 'self_wake', token: wakeToken, wakeContext };
          return;
        }
        // Part 6 §D2 — feed the recorder the RAW SDK message before
        // translateSDKMessage runs its lossy mapping. Assistant turns carry
        // the full block array including thinking/redacted_thinking/server_tool_use
        // /web_search_tool_result; user-role messages with tool_use_result are
        // captured as synthetic user-role tool_result blocks downstream.
        if (this.recorder) {
          const msgType = (sdkMessage as { type?: string }).type;
          const msgPayload = (sdkMessage as { message?: unknown }).message;
          if (msgType === 'assistant' && msgPayload) {
            this.recorder.recordRaw({
              invocationId: input.invocationId,
              provider: 'anthropic',
              model: input.model,
              rawKind: 'anthropic_sdk_message',
              raw: msgPayload,
            });
          } else if (msgType === 'user' && (sdkMessage as { tool_use_result?: unknown }).tool_use_result !== undefined) {
            this.recorder.recordRaw({
              invocationId: input.invocationId,
              provider: 'anthropic',
              model: input.model,
              rawKind: 'anthropic_sdk_message',
              raw: msgPayload,
            });
          }
        }
        // Hook-independent fallback: detect a pause marker directly from the tool_use_result message in
        // the stream, in case the PostToolUse hook does not fire (or misses the shape) for a given MCP
        // transport. Either path sets the stash; the top-of-loop / completion-guard / post-loop checks
        // then emit the pause. Belt-and-suspenders so a suspend is never dropped.
        if (!this.pendingWakePause && !this.pendingDelegationPause && !this.pendingHitlGate) {
          const tur = (sdkMessage as { tool_use_result?: unknown }).tool_use_result;
          if (tur !== undefined) {
            const m = [flattenToolResultText((tur as { content?: unknown } | null | undefined)?.content), flattenToolResultText(tur)]
              .find((t) => t && (t.includes('__wakePending') || t.includes('__delegationPending'))) ?? '';
            if (m.includes('__wakePending')) {
              try { const w = (JSON.parse(m) as { __wakePending?: import('../types').WakeContext }).__wakePending; if (w?.spec) this.pendingWakePause = w; } catch { /* not the marker */ }
            } else if (m.includes('__delegationPending')) {
              try { const dp = (JSON.parse(m) as { __delegationPending?: { parentTaskId: string; childTaskIds: string[]; deadlineAt: string } }).__delegationPending; if (dp?.parentTaskId) this.pendingDelegationPause = { parentTaskId: dp.parentTaskId, childTaskIds: dp.childTaskIds ?? [], deadlineAt: dp.deadlineAt, parentToolCallId: '' }; } catch { /* not the marker */ }
            }
          }
        }
        const events = this.translateSDKMessage(sdkMessage);
        for (const event of events) {
          // If the PostToolUse hook stashed a terminal pause in THIS same message iteration (the tool
          // ran and the model's completion arrived together), the pause wins: do not yield the
          // completion — break to the pause emit below. Otherwise the completion returns and the
          // suspend is lost. pendingHitlGate is included so an unsuppressed SUCCESS
          // completion (translateSDKMessage only suppresses the error-subtype one)
          // can never outrun a stashed oversight gate and conclude the run before
          // the pause is emitted.
          if (event.type === 'completion' && (this.pendingDelegationPause || this.pendingWakePause || this.pendingHitlGate)) break;
          yield event;
          if (event.type === 'completion' || event.type === 'pause_requested') {
            await interruptOnce();
            return;
          }
        }
        // Async spawn_task_graph ran + returned its marker (stashed by the
        // PostToolUse hook): stop the SDK and emit the delegation pause.
        if (this.pendingDelegationPause) {
          await interruptOnce();
          const token = await this.pause('delegation');
          const delegationContext = this.pendingDelegationPause;
          this.pendingDelegationPause = null;
          yield { type: 'pause_requested', reason: 'delegation', token, delegationContext };
          return;
        }
        if (this.pendingWakePause) {
          await interruptOnce();
          const wakeToken = await this.pause('self_wake');
          const wakeContext = this.pendingWakePause;
          this.pendingWakePause = null;
          yield { type: 'pause_requested', reason: 'self_wake', token: wakeToken, wakeContext };
          return;
        }
        // canUseTool denied with interrupt:true and stashed pendingHitlGate. On this
        // SDK version the query does NOT throw AbortError or end its stream after the
        // deny — it emits a result message (subtype 'error_during_execution', whose
        // completion translateSDKMessage suppresses because the pause is stashed) and
        // then, in streaming-input mode, waits for the next user message forever
        // (makeStreamInput blocks until this.paused, which only pause() sets). The
        // post-loop emit below is therefore unreachable on this path, and the run
        // would hang until the caller's stream cap (PB's 5-minute chat-stream
        // limit) with no approval ever created. Emit the pause HERE, in-loop, exactly like
        // the delegation/wake blocks above — the same in-loop check the bridge
        // engines (gemini/codex/opencode) already do. The post-loop emit stays for
        // the AbortError and natural-stream-end paths.
        if (this.pendingHitlGate) {
          await interruptOnce();
          const token = await this.pause('hitl_gate');
          const gateContext = this.pendingHitlGate;
          this.pendingHitlGate = null;
          yield { type: 'pause_requested', reason: 'hitl_gate', token, gateContext };
          return;
        }
      }
    } catch (err) {
      if (err instanceof AbortError) {
        // AbortError reaches here when canUseTool returned interrupt:true
        // (oversight HITL signal) OR when the outer signal aborted. The
        // pendingHitlGate stash distinguishes the HITL case so the
        // post-loop emit below converts it into a pause_requested.
        if (!this.pendingHitlGate) {
          await interruptOnce();
          yield { type: 'completion', outcome: 'error', reason: 'aborted' };
          return;
        }
        // Fall through to the pendingHitlGate emit below.
      } else {
        await interruptOnce();
        yield {
          type: 'completion',
          outcome: 'error',
          reason: (err as Error).message,
          failure: extractProviderFailure(err),
        };
        return;
      }
    } finally {
      // Outermost cleanup — the natural-stream-end path (for-await
      // completes without us returning early) lands here too. Without
      // this, the SDK's subprocess + cleanup wiring leaks per query.
      await interruptOnce();
    }

    // Post-loop oversight pause emit. canUseTool stashed pendingHitlGate
    // and returned deny+interrupt, which ends the SDK query either by
    // normal stream termination (no AbortError) or via an AbortError
    // caught above. Either path leads here when the gate fired; emit
    // pause_requested so the outer hybrid loop creates the approval +
    // persists the hitl_approval pause.
    if (this.pendingHitlGate) {
      const token = await this.pause('hitl_gate');
      const gateContext = this.pendingHitlGate;
      this.pendingHitlGate = null;
      yield { type: 'pause_requested', reason: 'hitl_gate', token, gateContext };
      return;
    }

    // Second source: a gate raised INSIDE an in-process tool handler rather than at
    // canUseTool. Those handlers signal by throwing HitlGateError, and the SDK converts
    // any handler exception into a tool error result — so the throw reaches the model as
    // "that tool failed" and the run completes normally. Left that way, the call is
    // blocked, no approval is created, nothing reaches /dashboard/review, and the
    // invocation records success.
    //
    // The gateway records the pause on a shared in-process channel before throwing, so
    // it survives that conversion. Draining it here turns the last line of defence from
    // silently swallowed into an actual pause. Fixing this needed no SDK change: the
    // throw was our signalling choice, not the SDK's requirement.
    const gatewayPause = takeGatewayHitlPause(input.invocationId);
    if (gatewayPause) {
      const token = await this.pause('hitl_gate');
      yield {
        type: 'pause_requested',
        reason: 'hitl_gate',
        token,
        gateContext: {
          gateReason: gatewayPause.reason,
          pendingToolCalls: [{
            id: `pending-gateway-${gatewayPause.toolName}`,
            name: gatewayPause.toolName,
            input: gatewayPause.args,
          }],
          ...(gatewayPause.matchedCategory ? { matchedCategory: gatewayPause.matchedCategory } : {}),
          ...(gatewayPause.context ? { context: gatewayPause.context } : {}),
        },
      };
      return;
    }
  }

  async injectMessage(message: UserMessage): Promise<void> {
    const sdkMsg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: message.text },
      parent_tool_use_id: null,
    } as SDKUserMessage;
    const resolver = this.streamInputResolvers.shift();
    if (resolver) {
      resolver(sdkMsg);
    } else {
      this.streamInputQueue.push(sdkMsg);
    }
  }

  async pause(reason: PauseReason): Promise<ResumeToken> {
    this.paused = true;
    const serialized = JSON.stringify({
      reason,
      input: this.currentInvocation,
    });
    return { adapterKind: 'anthropic', serialized };
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

  /**
   * The run's own filesystem, resolved once per invocation.
   *
   * This engine cannot dispatch through the MCP client pool the way the bridge
   * does: the Claude Agent SDK already holds the in-process gateway server, and
   * the MCP protocol throws on a second transport for one server. So the reader
   * comes off the catalog, which the gateway populated at build time.
   */
  private resolveContextReader(): ContextFileReader | null {
    if (this.contextReader === undefined) {
      this.contextReader = this.catalog ? deriveContextReader(this.catalog) : null;
    }
    return this.contextReader;
  }

  registerToolCatalog(catalog: McpToolCatalog): void { this.catalog = catalog; }
  registerHitlGate(gate: HitlGate): void { this.hitlGate = gate; }
  registerToolResultObserver(observer: ToolResultObserver): void { this.toolResultObserver = observer; }
  registerAnomalyHandler(handler: AnomalyHandler): void { this.anomalyHandler = handler; }
  registerToolBatchHandler(handler: ToolBatchHandler): void { this.toolBatchHandler = handler; }
  registerTrajectoryRecorder(recorder: import('../types').TrajectoryRecorder): void { this.recorder = recorder; }

  private makeStreamInput(initialMessages: PlatformMessage[]): AsyncIterable<SDKUserMessage> {
    // Arrow-function generator pattern lets us close over `this` without
    // a manual self alias (which @typescript-eslint/no-this-alias flags).
    const generate = async function* (this: AnthropicAdapter): AsyncGenerator<SDKUserMessage> {
      // Replay platform messages first.
      for (const m of initialMessages) {
        if (m.role === 'system') continue;  // system goes via systemPrompt
        // Text, and the tool exchanges rendered AS text in content order.
        // This input is the SDK's streaming user-message channel: it takes
        // user messages only, so a replayed assistant call cannot be sent as
        // a tool_use block and a replayed result cannot be sent as the
        // tool_result that answers one. Rendering them is the one way they
        // reach the model at all; dropping them left a resumed run reading
        // an approval's outcome from nowhere.
        const text = m.content
          .flatMap((c) => {
            if (c.type === 'text') return [c.text];
            if (c.type === 'tool_use' || c.type === 'tool_result') return [toolBlockToText(c)];
            return [];
          })
          .join('\n');
        // Images become real image blocks, ahead of the text. The SDK's user
        // message takes either a string or a content-block array, and
        // ImageBlockParam is one of the blocks it accepts — so this is the one
        // direction the vendor supports and it needs no encoding beyond the
        // base64 the content already carries.
        //
        // Ordering is not cosmetic: a question that arrives before the picture
        // it is about gets answered from the conversation rather than from the
        // image.
        const media = m.content.filter(
          (c): c is Extract<PlatformContent, { type: 'media' }> => c.type === 'media',
        );
        // Anthropic has an image block and no video one. The control plane's
        // gate never sends video to this engine, so anything non-image here is
        // a gate failure rather than a routine case — it is described in the
        // text instead of dropped, so the model is not left answering about a
        // clip it never received.
        const images = media.filter((c) => c.mimeType.startsWith('image/'));
        const unsupported = media.filter((c) => !c.mimeType.startsWith('image/'));
        const unsupportedNote = unsupported.length > 0
          ? unsupported
              .map((c) => `[The person attached a ${c.mimeType}. This engine cannot receive it.]`)
              .join('\n')
          : '';
        const textWithNote = [unsupportedNote, text].filter(Boolean).join('\n');
        if (!textWithNote && images.length === 0) continue;
        if (images.length > 0) {
          yield {
            type: 'user',
            message: {
              role: 'user',
              content: [
                ...images.map((img) => ({
                  type: 'image' as const,
                  source: {
                    type: 'base64' as const,
                    media_type: img.mimeType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
                    data: img.dataBase64,
                  },
                })),
                ...(textWithNote ? [{ type: 'text' as const, text: textWithNote }] : []),
              ],
            },
            parent_tool_use_id: null,
          } as unknown as SDKUserMessage;
          continue;
        }
        yield {
          type: 'user',
          message: { role: 'user', content: textWithNote },
          parent_tool_use_id: null,
        } as SDKUserMessage;
      }
      // Then pull from dynamic queue until paused.
      while (!this.paused) {
        // drain queue first
        const queued = this.streamInputQueue.shift();
        if (queued) {
          yield queued;
          continue;
        }
        const next = await new Promise<SDKUserMessage>((res) => {
          this.streamInputResolvers.push(res);
        });
        yield next;
      }
    };
    return generate.call(this);
  }

  private makeCanUseTool(input: InvocationInput): CanUseTool {
    return async (toolName, toolInput, { signal, toolUseID }): Promise<PermissionResult> => {
      // The SDK's runtime Zod validator requires `updatedInput` to be
      // present on every allow result, even though the TypeScript type
      // marks it optional (sdk.d.ts). Pass through toolInput unchanged
      // so the tool runs with the LLM's original arguments. Without this
      // every allowed tool call comes back to the LLM as
      //   "Tool permission request failed: ZodError: …expected record,
      //    received undefined… [updatedInput]"
      // and the agent then guesses the cause (we've seen it hallucinate
      // "not authenticated with claude.ai" / "MCP token expired").
      const allowToolInput = (toolInput ?? {}) as Record<string, unknown>;
      if (signal.aborted) {
        return { behavior: 'deny', message: 'aborted', interrupt: true };
      }
      // Name the authoring team on comments written to GitHub / GitLab. This
      // is the ONLY seam that sees them on this engine: the SDK opens its own
      // transport to the vendor MCP, so the arguments never reach our process
      // — but permission is still asked here first, and `updatedInput` is
      // honoured. Deliberately applied to what gets dispatched, NOT to what
      // the gate inspects below: oversight should judge the model's own
      // arguments, not our prefix. No-ops (and touches no database) for every
      // tool that is not a code-host comment.
      const dispatchInput = async (): Promise<Record<string, unknown>> =>
        (await applyCommentAuthorship(toolName, allowToolInput, {
          tenantId: input.tenantId,
          invocationId: input.invocationId,
        })) ?? allowToolInput;
      if (!this.hitlGate) {
        return { behavior: 'allow', updatedInput: await dispatchInput() };
      }
      const result = await this.hitlGate({
        toolName,
        args: toolInput,
        tenantId: input.tenantId,
        invocationId: input.invocationId,
        // The SDK's id for this tool_use: the same id the recorder holds the
        // call under, so a pause can name it.
        ...(toolUseID ? { callId: toolUseID } : {}),
      });
      if (result.allow) {
        // A human reviewer who rewrote this call before approving it approved
        // THEIR version. The model re-proposed its own draft on resume (the
        // edit never reached it), so the substitution has to happen here, on
        // the way out — the same `updatedInput` seam comment authorship uses.
        // Authorship still applies on top: it names who is writing, which is
        // true of the reviewer's wording as much as the agent's.
        if (result.updatedInput) {
          return {
            behavior: 'allow',
            updatedInput:
              (await applyCommentAuthorship(toolName, result.updatedInput, {
                tenantId: input.tenantId,
                invocationId: input.invocationId,
              })) ?? result.updatedInput,
          };
        }
        return { behavior: 'allow', updatedInput: await dispatchInput() };
      }
      // Oversight HITL signal — stash the gate context and stop the SDK
      // query cleanly. The tool handler does NOT run (no outbound side
      // effect). invoke()'s post-loop block emits pause_requested with the
      // stashed gate context so the outer hybrid loop creates the
      // approval + persists the hitl_approval pause.
      if (result.hitlPause) {
        this.pendingHitlGate = result.hitlPause;
        return { behavior: 'deny', message: 'HITL approval required', interrupt: true };
      }
      // Hard deny (admission, kill switch, etc) — no pause, no approval. A
      // terminal outcome, so the observer is told, as the bridge tells it on
      // the other engines; the pause above is not one, and is not.
      const denied = result.reason ?? 'HITL gate denied';
      await this.observeToolOutcome({
        toolName, args: allowToolInput, toolUseID, result: { error: denied, reason: result.reason }, error: denied,
      });
      return { behavior: 'deny', message: denied };
    };
  }

  /** Tell the observer what one tool use produced, wait, and keep what the
   *  finished event will need. Never throws. Shared by the three seams that
   *  know an outcome before the model does: PostToolUse (a result, failed or
   *  not), PostToolUseFailure (a throw) and canUseTool (a hard denial). */
  private async observeToolOutcome(o: {
    toolName: string; args: Record<string, unknown>; toolUseID?: string; result: unknown; error?: string;
  }): Promise<void> {
    if (o.toolUseID && o.error) this.callErrors.set(o.toolUseID, o.error);
    if (!this.toolResultObserver) return;
    try {
      const rememberedNow = await this.toolResultObserver({
        toolName: o.toolName,
        args: o.args,
        ...(o.toolUseID ? { callId: o.toolUseID } : {}),
        result: o.result,
        ...(o.error ? { error: o.error } : {}),
      });
      if (rememberedNow && o.toolUseID) this.recordedCalls.add(o.toolUseID);
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, tool: o.toolName, invocationId: this.currentInvocation?.invocationId },
        'tool_result_observer_failed (non-fatal)',
      );
    }
  }

  private makePostToolUseHook() {
    return async (
      input: {
        tool_name?: string;
        tool_input?: unknown;
        tool_response?: { is_error?: boolean; content?: unknown };
      },
      toolUseID: string | undefined,
    ) => {
      const isError = input.tool_response?.is_error === true;

      // How big are DIRECT MCP results? Nobody knows, and this hook is the one
      // place on this engine that sees them: a vendor-hosted server (GitHub,
      // Notion, Stripe) and a workspace's own custom MCP server dispatch over
      // the SDK's own transport, so they never reach the in-process gateway
      // where every other tool result is measured, parked and bounded.
      //
      // MEASURED ONLY, deliberately. Parking a vendor's envelope means
      // deciding per server what is safe to replace, and that decision is
      // worth taking with a live distribution in hand rather than by analogy
      // with a path that carries different traffic. The tool name is what
      // separates the two populations: the SDK reports every MCP tool as
      // `mcp__<server>__<tool>`, and `isOwnGatewayTool` recognises ours.
      const hookToolName = input.tool_name ?? '';
      if (hookToolName.startsWith('mcp__') && !isOwnGatewayTool(hookToolName)) {
        observeDirectMcpResultSize(hookToolName, input.tool_response, this.currentInvocation?.invocationId);
      }

      // The Anthropic engine's observation seam. The other engines are
      // observed at the MCP bridge, which this path never reaches, so without
      // this the gate would be blind on this engine entirely.
      observeToolCall(
        this.currentInvocation?.invocationId,
        input.tool_name ?? '',
        (input.tool_input ?? undefined) as Record<string, unknown> | undefined,
        input.tool_response,
      );
      // And the engine's REMEMBERING seam, for the same reason: this hook is
      // the one point the SDK waits for after a tool returns and before the
      // model continues, so a record made here exists before the model can act
      // on the result. The tool_response is the raw result, as the bridge's
      // copy is on the other engines.
      await this.observeToolOutcome({
        toolName: input.tool_name ?? '',
        args: (input.tool_input ?? {}) as Record<string, unknown>,
        toolUseID,
        result: input.tool_response,
        ...(isError ? { error: flattenToolResultText(input.tool_response?.content) || 'tool returned an error result' } : {}),
      });

      // Compute the model-facing rewrite BEFORE recording so the trajectory and
      // the model's own context capture the SAME content. Vendor-hosted MCP
      // tools (GitHub/Notion/Stripe/custom MCP) dispatch via the SDK's native
      // transport, bypassing the in-process tool-gateway's buildToolErrorContent;
      // envelopeRawToolError classifies their RAW error into the uniform
      // TOOL_ERROR contract. It is idempotent — in-process tool errors already
      // carry TOOL_ERROR → returns null → left untouched. Flatten first: a
      // JSON.stringify of the MCP block-array would escape the inner
      // `TOOL_ERROR {…}` and break the parser.
      const rawText = isError ? flattenToolResultText(input.tool_response?.content) : '';
      const envelope = isError ? envelopeRawToolError(rawText) : null;

      // Async pause markers (spawn_task_graph delegation / self-wake). The tool ran and returned a
      // SUCCESS result carrying {__delegationPending} or {__wakePending}. Stash it so invoke()
      // interrupts + emits the pause. The marker may live under tool_response.content
      // ({content:[{type,text}]}) OR be tool_response ITSELF (some MCP transports hand back the block
      // array / bare string directly), so check BOTH shapes — reading only `.content` silently missed
      // the marker for tool-gateway MCP tools whose tool_response IS the array (found via dev E2E).
      if (!isError) {
        const tr = input.tool_response;
        const marker = [flattenToolResultText((tr as { content?: unknown } | null | undefined)?.content), flattenToolResultText(tr)]
          .find((t) => t && (t.includes('__wakePending') || t.includes('__delegationPending'))) ?? '';
        if (marker.includes('__delegationPending')) {
          try {
            const dp = (JSON.parse(marker) as { __delegationPending?: { parentTaskId: string; childTaskIds: string[]; deadlineAt: string } }).__delegationPending;
            if (dp?.parentTaskId) this.pendingDelegationPause = { parentTaskId: dp.parentTaskId, childTaskIds: dp.childTaskIds ?? [], deadlineAt: dp.deadlineAt, parentToolCallId: toolUseID ?? '' };
          } catch { /* not the marker */ }
        }
        // Self-wake marker (batch-collision guard: only the first terminal pause-control call wins).
        if (marker.includes('__wakePending')) {
          try {
            const w = (JSON.parse(marker) as { __wakePending?: import('../types').WakeContext }).__wakePending;
            if (w && w.spec && !this.pendingWakePause && !this.pendingDelegationPause && !this.pendingHitlGate) {
              this.pendingWakePause = w;
            }
          } catch { /* not the marker */ }
        }
      }

      // Part 6 §A4 — feed the recorder a synthetic user-role message carrying
      // the tool_result block. The canonical schema requires tool_result
      // blocks on user-role messages (matches Anthropic Messages API input
      // shape; preserves replay correctness). is_error is captured verbatim
      // — this is the ONLY surface where it's available; the message stream
      // never carries it on the synthesized SDKUserMessage tool_use_result.
      // When we produce an envelope, the SDK replaces the model-facing MCP
      // output with it (updatedMCPToolOutput below), so we record the ENVELOPE,
      // not the raw text — otherwise the trajectory would say the model read the
      // raw vendor prose when it actually read the classified contract, breaking
      // replay + training fidelity.
      if (this.recorder && this.currentInvocation && toolUseID) {
        const recordedContent = envelope
          ? [{ type: 'text', text: envelope }]
          : (typeof input.tool_response?.content === 'string'
            ? input.tool_response.content
            : [{ type: 'text', text: JSON.stringify(input.tool_response?.content ?? null) }]);
        this.recorder.recordRaw({
          invocationId: this.currentInvocation.invocationId,
          provider: 'anthropic',
          model: this.currentInvocation.model,
          rawKind: 'anthropic_sdk_message',
          raw: {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: toolUseID,
              content: recordedContent,
              is_error: isError,
            }],
          },
        });
      }

      if (!isError) {
        // This engine's delivery seam. `additionalContext` rides alongside
        // the tool result the model is already reading, which is the whole
        // point: the system prompt stays byte-identical, so the SDK's cached
        // prefix survives a mid-run discovery.
        const hints = await contextHintsForToolCall(
          this.currentInvocation?.invocationId,
          input.tool_name ?? '',
          (input.tool_input ?? undefined) as Record<string, unknown> | undefined,
          this.resolveContextReader(),
        );
        if (hints.length === 0) return {};
        return {
          hookSpecificOutput: {
            hookEventName: 'PostToolUse' as const,
            additionalContext: hints.join('\n\n'),
          },
        };
      }

      // Recovery path — hand the envelope (when we have one) to the anomaly
      // handler so parseToolErrorEnvelope succeeds and the classified fast-trip
      // fires instead of a wasted recovery-LLM turn.
      if (this.anomalyHandler && this.currentInvocation) {
        const handlerResult = await this.anomalyHandler({
          kind: 'tool_call_error',
          context: {
            toolName: input.tool_name,
            error: envelope ?? rawText,
            args: input.tool_input,
            callId: toolUseID,
          },
          invocationId: this.currentInvocation.invocationId,
        });
        if (handlerResult.injectMessage) {
          await this.injectMessage({
            text: handlerResult.injectMessage.content
              .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
              .map((c) => c.text)
              .join('\n'),
          });
        }
      }

      // Model-facing rewrite — replace the raw vendor error the model would
      // otherwise read with the uniform envelope (SDK PostToolUse
      // updatedMCPToolOutput). Only when we produced one; in-process tools are
      // already enveloped and pass through untouched.
      if (envelope) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PostToolUse' as const,
            updatedMCPToolOutput: { content: [{ type: 'text' as const, text: envelope }], isError: true },
          },
        };
      }
      return {};
    };
  }

  /**
   * PostToolUseFailure hook — fires when a tool THROWS (as opposed to returning
   * an isError result). Native vendor-hosted MCP tools (GitHub/Notion/Stripe/
   * custom MCP) surface vendor failures (e.g. a 404) as a thrown McpError, which
   * triggers THIS hook, NOT PostToolUse — so PostToolUse's updatedMCPToolOutput
   * rewrite never runs for them and the model would otherwise read the raw
   * vendor prose. PostToolUseFailure cannot replace the tool output (the SDK only
   * honors additionalContext here), so we classify the raw `error` into the
   * uniform TOOL_ERROR contract and inject it as additionalContext the model
   * reads alongside the failure, AND fire recovery with the envelope (Fix A
   * fast-trip). envelopeRawToolError is idempotent — an already-enveloped error
   * (in-process tools never reach here, but be safe) yields null → no-op.
   */
  /**
   * End the turn when a round did nothing but finish the work.
   *
   * The delivery already happened in the tool that just returned; the model call
   * this skips exists to write a sentence saying so. One request and one
   * round-trip on every completed run.
   *
   * Guarded on the turn having SPOKEN, for the same reason as the other engines:
   * ending a silent turn leaves an empty reply where that sentence would have
   * been, which is a blank bubble in an interactive thread and worse than the
   * call it saves.
   */
  private makePostToolBatchHook(input: InvocationInput) {
    const terminal = new Set(input.terminalToolNames ?? []);
    return async (hookInput: { tool_calls?: Array<{ tool_name?: string; tool_use_id?: string }> }) => {
      // The batch boundary the strike ledger folds on, before anything decides
      // to end the turn. PostToolUse fires per tool and may run concurrently
      // for parallel calls; this fires once, after every call in the batch has
      // resolved, naming them (sdk.d.ts PostToolBatchHookInput). Ordered after
      // the batch's PostToolUse hooks by the SDK's own contract, which is what
      // makes it authoritative where a stream event would not be. Logged on
      // every fire: a hook the SDK stopped invoking would otherwise look like
      // a run with no batches, and a rejection never folded is a strike that
      // never lands.
      const callIds = (hookInput.tool_calls ?? [])
        .map((c) => c.tool_use_id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
      logger.info({
        event: 'tool_batch_completed',
        invocationId: this.currentInvocation?.invocationId,
        callCount: callIds.length,
      });
      if (this.toolBatchHandler) await this.toolBatchHandler(callIds);
      if (terminal.size === 0 || !this.hasStreamedText) return {};
      // The SDK names every MCP tool `mcp__<server>__<tool>` in its hook input,
      // while the graph names the tool as the catalog does; compare the catalog
      // name. `dispatchNameFor` keeps the connector alias the graph keeps.
      const names = (hookInput.tool_calls ?? []).map((c) => dispatchNameFor(c.tool_name ?? ''));
      if (!roundIsTerminal(names, terminal)) return {};
      logTurnClosed('claude-agent-sdk', names, input.invocationId);
      return { continue: false, stopReason: 'work complete: the round called only terminal tools' };
    };
  }

  private makePostToolUseFailureHook() {
    return async (
      input: {
        tool_name?: string;
        tool_input?: unknown;
        tool_use_id?: string;
        error?: string;
        is_interrupt?: boolean;
      },
    ) => {
      // is_interrupt = the tool was aborted (HITL/kill/abort), not a genuine
      // vendor failure. Enveloping that as a tool error would mislead the model.
      if (input.is_interrupt) return {};

      const rawText = typeof input.error === 'string' ? input.error : '';
      // A thrown call is a failed call whether or not it classifies: the
      // observer is told before the envelope decides anything, and before the
      // early return below, which is where a vendor's 404 used to vanish from
      // the ledger — recorded nowhere, and its finished event a success.
      await this.observeToolOutcome({
        toolName: input.tool_name ?? '',
        args: (input.tool_input ?? {}) as Record<string, unknown>,
        toolUseID: input.tool_use_id,
        result: { error: rawText || 'tool call failed' },
        error: rawText || 'tool call failed',
      });
      const envelope = envelopeRawToolError(rawText);
      if (!envelope) return {};

      // Recovery (Fix A) — hand the envelope to the anomaly handler so its
      // parseToolErrorEnvelope + classified fast-trip fire.
      if (this.anomalyHandler && this.currentInvocation) {
        const handlerResult = await this.anomalyHandler({
          kind: 'tool_call_error',
          context: {
            toolName: input.tool_name,
            error: envelope,
            args: input.tool_input,
            callId: input.tool_use_id,
          },
          invocationId: this.currentInvocation.invocationId,
        });
        if (handlerResult.injectMessage) {
          await this.injectMessage({
            text: handlerResult.injectMessage.content
              .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
              .map((c) => c.text)
              .join('\n'),
          });
        }
      }

      // Model-facing (Fix B, thrown-error path) — inject the classified contract
      // as additionalContext so the model reads the uniform TOOL_ERROR envelope
      // even though the SDK won't let us replace the failed tool's output here.
      return {
        hookSpecificOutput: {
          hookEventName: 'PostToolUseFailure' as const,
          additionalContext: envelope,
        },
      };
    };
  }

  private translateSDKMessage(message: SDKMessage): InvocationEvent[] {
    const out: InvocationEvent[] = [];
    // SDK system init carries the session_id assigned to this query (or the
    // resumed one when `resume` was set). Surface it as a session_started
    // event so interactive chat can persist it for next-turn resume. Subtype
    // is 'init' for the open-of-stream system message (sdk.d.ts SDKSystemMessage).
    if (message.type === 'system') {
      const sysMsg = message as { subtype?: string; session_id?: string };
      if (sysMsg.subtype === 'init' && typeof sysMsg.session_id === 'string' && sysMsg.session_id) {
        out.push({ type: 'session_started', sessionId: sysMsg.session_id });
      }
      return out;
    }
    // Partial streaming (includePartialMessages): forward text deltas and
    // tool-argument deltas. The full 'assistant' message is still emitted below
    // when the block completes.
    if (message.type === 'stream_event') {
      const e = message.event as {
        type?: string;
        index?: number;
        content_block?: { type?: string; id?: string; name?: string };
        delta?: { type?: string; text?: string; partial_json?: string };
      };
      if (e.type === 'message_start') {
        this.streamingToolBlocks.clear();
      } else if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use' && typeof e.index === 'number') {
        this.streamingToolBlocks.set(e.index, { id: e.content_block.id ?? '', name: e.content_block.name ?? '' });
      } else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta' && e.delta.text) {
        this.hasStreamedText = true;
        out.push({ type: 'assistant_delta', text: e.delta.text });
      } else if (e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta' && typeof e.index === 'number') {
        // Correlated by index to the block that announced the tool. A delta for
        // an index nothing announced is dropped rather than emitted nameless.
        const block = this.streamingToolBlocks.get(e.index);
        if (block && typeof e.delta.partial_json === 'string') {
          out.push({ type: 'tool_call_partial', callId: block.id, toolName: block.name, partialJson: e.delta.partial_json });
        }
      } else if (e.type === 'content_block_stop' && typeof e.index === 'number') {
        this.streamingToolBlocks.delete(e.index);
      }
      return out;
    }
    if (message.type === 'assistant' && message.message) {
      // One API call's own usage. Summed rather than taken as a total: a turn makes
      // several calls and each writes its own cache increment.
      const callUsage = (message.message as { usage?: { cache_creation_input_tokens?: number | null } }).usage;
      const written = callUsage?.cache_creation_input_tokens;
      if (typeof written === 'number' && written > 0) this.cacheWriteTokensThisTurn += written;
      const blocks = (message.message.content ?? []) as AnthropicMessageContentBlock[];
      const platformBlocks = blocks.map<InvocationEvent | null>((b) => {
        if (b.type === 'text' && typeof b.text === 'string') return null;  // handled below
        if (b.type === 'tool_use' && b.name) {
          return {
            type: 'tool_call_started',
            toolName: b.name,
            args: b.input,
            callId: b.id ?? '',
          };
        }
        return null;
      });
      // Emit one assistant_message containing all text/tool_use translated to PlatformContent.
      // Assistant messages only carry text and tool_use blocks; tool_result lives on
      // synthesized user messages translated separately in the user-message branch below.
      type AssistantBlock =
        | { type: 'text'; text: string }
        | { type: 'tool_use'; toolName: string; args: unknown; callId: string };
      const platformContent = blocks
        .map<AssistantBlock | null>((b) => {
          if (b.type === 'text' && typeof b.text === 'string') return { type: 'text', text: b.text };
          if (b.type === 'tool_use' && b.name) {
            return { type: 'tool_use', toolName: b.name, args: b.input, callId: b.id ?? '' };
          }
          // Intentionally-dropped block type (thinking, redacted_thinking,
          // server_tool_use, web_search_tool_result, web_fetch_tool_result, …) —
          // see the class doc. Meter the drop so a future PR that accidentally
          // starts forwarding these (e.g. leaking signed thinking content) is
          // visible in prod. Emitted as a log-based-metric line.
          logger.info(
            { metric_type: 'counter', metric_name: 'anthropic_translation_dropped_block_total', metric_value: 1, block_type: b.type },
            'metric:anthropic_translation_dropped_block_total',
          );
          return null;
        })
        .filter((b): b is AssistantBlock => b !== null);
      if (platformContent.length > 0) {
        out.push({ type: 'assistant_message', content: platformContent });
      }
      // Emit tool_call_started events
      for (const ev of platformBlocks) {
        if (ev) out.push(ev);
      }
    } else if (message.type === 'user' && message.tool_use_result !== undefined) {
      // Synthesize tool_call_finished from the tool_use_result on user messages.
      // The call id to match against the preceding tool_call_started lives on
      // the `tool_result` block inside message.content[].tool_use_id — NOT on
      // SDKUserMessage.parent_tool_use_id (which is the *nested* parent
      // context for Task-subagent tool calls). Earlier code reached for
      // parent_tool_use_id and the result was an empty callId on the wire,
      // which broke result-population on the PB-side harness assembler.
      const result = typeof message.tool_use_result === 'string'
        ? message.tool_use_result
        : JSON.stringify(message.tool_use_result);
      const content = (message as { message?: { content?: unknown } }).message?.content;
      let callId = '';
      if (Array.isArray(content)) {
        for (const block of content as Array<{ type?: string; tool_use_id?: string }>) {
          if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
            callId = block.tool_use_id;
            break;
          }
        }
      }
      // Fall back to parent_tool_use_id (subagent nesting) if no tool_result
      // block carried the id — better than empty.
      if (!callId && message.parent_tool_use_id) callId = message.parent_tool_use_id;
      const recordedAtDispatch = this.recordedCalls.delete(callId);
      // The synthesised message carries no `is_error`; the hooks did, and kept
      // it. Without this the ledger said "failed" and everything reading the
      // stream — run state, the persisted call, the surfaces — said "success".
      const error = this.callErrors.get(callId);
      this.callErrors.delete(callId);
      out.push({
        type: 'tool_call_finished',
        callId,
        result,
        ...(error ? { error } : {}),
        ...(recordedAtDispatch ? { recordedAtDispatch } : {}),
      });
    } else if (message.type === 'result') {
      const subtype = (message as { subtype?: string }).subtype;
      // THE CACHE WRITE LIVES ON `modelUsage`, IN camelCase.
      //
      // The result's snake_case `usage` reports `cache_creation_input_tokens` as 0
      // even on a turn that wrote the cache, while reporting the READ correctly on
      // the same object — so reading it bills nothing and looks healthy: cache
      // reads climb turn over turn while every write records NULL. `modelUsage` is the SDK's own per-model breakdown and
      // declares `cacheCreationInputTokens`; that is where the figure is.
      //
      // Summed across models because a turn can straddle two (a small-model
      // sub-agent beside the main one) and both write their own prefix.
      const modelUsage = (message as {
        modelUsage?: Record<string, { cacheCreationInputTokens?: number }>;
      }).modelUsage;
      let cacheWriteFromModelUsage = 0;
      for (const m of Object.values(modelUsage ?? {})) {
        const w = m?.cacheCreationInputTokens;
        if (typeof w === 'number' && w > 0) cacheWriteFromModelUsage += w;
      }
      const usage = (message as { usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number | null;
        cache_creation_input_tokens?: number | null;
        server_tool_use?: { web_search_requests?: number; web_fetch_requests?: number } | null;
      } }).usage;
      if (usage) {
        out.push({
          type: 'usage',
          usage: {
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
            // Use cache_read for cached-input accounting; cache_creation is
            // tokens spent populating the cache, billed differently.
            cachedTokens: usage.cache_read_input_tokens ?? 0,
            // And "billed differently" means BILLED: Anthropic charges a cache
            // write at 1.25x the input rate, twelve and a half times what the
            // read beside it costs. If this count reached only `contextTokens`,
            // the platform would absorb every cache write this engine makes.
            // The larger of the two sources. The per-call sum is the one that
            // carries a real figure today; the result aggregate is kept in the
            // comparison so this keeps working if the SDK starts populating it.
            // The largest of the three sources. Only `modelUsage` carries a real
            // figure today; the other two stay in the comparison so this keeps
            // working if the SDK starts populating them, and none can win with a
            // smaller number.
            cacheWriteTokens: Math.max(
              cacheWriteFromModelUsage,
              this.cacheWriteTokensThisTurn,
              usage.cache_creation_input_tokens ?? 0,
            ),
            // The whole prompt the model actually read. Anthropic reports the
            // uncached part as `input_tokens` and the cache reads and cache
            // WRITES as their own counts, so the three together are the
            // context. A guard reading `input + cache_read` alone is short by
            // everything the first call of a cached conversation wrote — which
            // is most of it, on the turn where it matters.
            contextTokens:
              (usage.input_tokens ?? 0)
              + (usage.cache_read_input_tokens ?? 0)
              + (usage.cache_creation_input_tokens ?? 0),
            // Anthropic's own count of its hosted searches, which it bills at
            // $10 per 1,000 — the most expensive web search of any supported
            // vendor. `WebSearch` is attached default-on to EVERY Claude agent
            // (native-web-tools.ts), so every agent can run it, and the count
            // in `usage` is the only record of it. Claude is the estate
            // default, so leaving it unread would be the largest unbilled
            // tool spend on the platform.
            //
            // web_fetch_requests is deliberately not carried: Anthropic bills
            // web fetch at NO additional cost, so a count would imply a charge
            // that does not exist. The tokens it pulls in are already counted
            // above, which is the whole of what it costs.
            webSearchRequests: usage.server_tool_use?.web_search_requests || undefined,
          },
        });
      }
      // The SDK's ceilings are not faults. `error_max_turns` and
      // `error_max_budget_usd` mean the run was cut off while working, which is
      // a different thing from `error_during_execution` — and reporting them
      // identically is what let a run that had finished its actual work be
      // recorded as a crash and counted against the agent.
      const outcome = subtype === 'success'
        ? 'success' as const
        : (subtype === 'error_max_turns' || subtype === 'error_max_budget_usd')
          ? 'limit_reached' as const
          : 'error' as const;
      // Capture WHY on the failure path. SDKResultError carries stop_reason,
      // is_error and num_turns (sdk.d.ts SDKResultError), and we were forwarding
      // only `subtype` — so a failed run surfaced the bare string
      // 'error_during_execution' to the user with the explanation discarded here,
      // at the one point in the system that had it. A run can fail this way
      // with no exception, no stack and no error entry anywhere, because
      // nothing on this path throws and nothing else logs.
      if (outcome === 'error') {
        const r = message as {
          subtype?: string; stop_reason?: string | null;
          is_error?: boolean; num_turns?: number;
        };
        logger.error({
          sdk_result_subtype: r.subtype,
          sdk_stop_reason: r.stop_reason ?? null,
          sdk_is_error: r.is_error,
          sdk_num_turns: r.num_turns,
        }, 'anthropic adapter: SDK query ended in error');
      }
      if (outcome === 'limit_reached') {
        const r = message as { subtype?: string; num_turns?: number; stop_reason?: string | null };
        logger.warn({
          event: 'run_limit_reached',
          sdk_result_subtype: r.subtype,
          sdk_num_turns: r.num_turns,
          sdk_stop_reason: r.stop_reason ?? null,
        }, 'anthropic adapter: run hit its configured ceiling before finishing');
      }
      // The SDK's own account of how the query ended, on every path. The
      // subtype after a hook returned `continue: false` is decided inside the
      // spawned binary and is not documented, so the line that lets a run be
      // read has to exist before the run.
      {
        const r = message as { subtype?: string; num_turns?: number; stop_reason?: string | null };
        logger.info({
          event: 'sdk_query_result',
          invocationId: this.currentInvocation?.invocationId,
          sdk_result_subtype: r.subtype,
          sdk_num_turns: r.num_turns,
          sdk_stop_reason: r.stop_reason ?? null,
          outcome,
        }, 'anthropic adapter: SDK query result');
      }
      // A deliberate HITL interrupt is NOT a failed run. When canUseTool denied with
      // `interrupt: true` it stashed pendingHitlGate, and the SDK then ends the query
      // and reports subtype 'error_during_execution'. Translating that into
      // completion{outcome:'error'} races the pause: this event is yielded from inside
      // the stream loop, while pause_requested is only emitted after the loop, so the
      // consumer concluded the invocation as an error before the pause ever arrived.
      //
      // Left that way, send_message denied at canUseTool records outcome=error /
      // error_during_execution / stop_reason=tool_use with NO approval row and
      // nothing on /dashboard/review — a gate that blocks the work and gives the
      // user nothing to approve.
      //
      // Suppress the completion entirely in that case and let the post-loop
      // pause_requested be the single terminal event. Deliberately narrow: only when a
      // pause is genuinely stashed, and only on the error path, so a real failure
      // (and every success) still completes exactly as before.
      if (outcome === 'error' && this.pendingHitlGate) {
        logger.info({
          sdk_result_subtype: subtype,
        }, 'anthropic adapter: suppressing error completion — run is paused for HITL approval');
        return out;
      }
      out.push({ type: 'completion', outcome, reason: subtype });
    }
    return out;
  }
}
