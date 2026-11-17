// OpenAI Codex VendorSdkAdapter (@openai/codex-sdk) for provider 'openai'.
//
// Codex spawns the Codex CLI as a subprocess that owns the loop AND self-compacts
// context — so, like Anthropic's Claude Agent SDK, no Liftoff-side context
// handling ("B") is needed. Codex cannot use an in-process MCP transport; it
// reaches Liftoff's governed tool seam as a REMOTE (StreamableHttp) MCP server
// served on localhost by exposeCatalogOverHttp (which routes every tool call
// through dispatchFunctionCall → the registered hitlGate + framing + OU-metering +
// single-result bound). The proxy and this adapter share one BridgeContext, so a
// HITL-gated call sets bridgeContext.pendingHitlGate, which this adapter observes
// to abort the turn and emit pause_requested; resume re-enters via resumeThread.
//
// Codex is a coding agent; for a general Liftoff agent we run it read-only with
// networking disabled (sandboxMode:'read-only', networkAccessEnabled:false) and
// prepend the platform systemPrompt to the first turn (Codex has no system slot).
//
// WEB SEARCH IS OPENAI'S OWN, LIVE, AND COUNTED. The rule every engine follows
// is the model vendor's hosted search where the vendor has one, counted per
// call and billed at that vendor's rate (grounding-cost.ts); Codex runs on the
// Responses API and its `web_search` IS that search. `live` is pinned rather
// than left to the CLI, whose default under a read-only sandbox is `cached` —
// an OpenAI-maintained index without external web access, a different product
// from the live search the wire engine offers and one whose billing is not
// the rate we hold. Each `web_search` item the thread reports is counted onto
// the turn's usage event as `webSearchRequests`, the same field the wire fills
// from `web_search_call` items, so `computeGroundingCost('openai')` bills it.
// Uncounted, a search is $0 on our side and a charge on OpenAI's.
//
// IMAGES ARE CARRIED, NOT DESCRIBED. The SDK's turn input takes
// `{ type: 'local_image', path }` members beside the text and hands each to
// the CLI as `--image <path>`, so every picture in the conversation is written
// to a per-run temporary directory and attached to the first turn — the one
// that carries the replayed transcript, which names each by its attachment
// number (conversation-preamble.ts). The directory is removed when the run
// ends, success or not. A resumed thread already holds its pictures upstream,
// and a follow-up turn is text, so only the first turn attaches any. Video has
// no input form here and stays described in the text.

import type { CodexOptions, Input, Thread, ThreadEvent, ThreadItem, ThreadOptions } from '@openai/codex-sdk';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { esmImport } from '../esm-import';
import { childProcessEnv } from '../child-process-env';
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
  TrajectoryRecorder,
  ToolResultObserver,
} from '../types';
import type { McpToolCatalog } from '../catalog-types';
import type { BridgeContext } from '../mcp-bridge';
import { rememberedEventFields } from '../remembered-stamp';
import { exposeCatalogOverHttp } from '../tool-gateway-http-mcp';
import { getMcpClientPool } from '../mcp-client-pool';
import { attachedImages, firstTurnPrompt, type MediaContent } from '../conversation-preamble';
import { logger } from '../../../infrastructure/logging';
import { extractProviderFailure } from '../provider-failure';
import { getManagedSecret } from '../../../infrastructure/secret-store';

/**
 * How the Codex CLI is told about the governed tool seam.
 *
 * `http_headers`, not `bearer_token`: the installed CLI rejects the latter for
 * streamable_http ("bearer_token is not supported for streamable_http"), and
 * the proxy authenticates on `Authorization: Bearer <token>`.
 *
 * `default_tools_approval_mode: 'approve'`, because Codex has an MCP
 * tool-approval prompt of its own. Under `approvalPolicy: 'never'` it still
 * asks for any tool whose annotations do not mark it read-only unless the
 * sandbox has full disk write access — ours is read-only — and an SDK thread
 * has nobody to answer, so the prompt resolves to Abort and every call came
 * back "user cancelled MCP tool call". Every call through this server is
 * judged by our own gate before it dispatches (HITL, provenance, admission);
 * Codex's prompt would be a second, unanswerable question in front of the
 * same call.
 */
type CodexMcpServerConfig = NonNullable<NonNullable<CodexOptions['config']>['mcp_servers']>;
function liftoffMcpServerConfig(httpMcp: { url: string; bearerToken: string }): CodexMcpServerConfig {
  return {
    url: httpMcp.url,
    http_headers: { Authorization: `Bearer ${httpMcp.bearerToken}` },
    default_tools_approval_mode: 'approve',
  };
}

/** The file extension the CLI reads a picture's type from, taken from the
 *  MIME subtype: `image/png` → `.png`, `image/jpeg` → `.jpeg`. Every type the
 *  control plane's gate admits has a subtype that is also a usable extension. */
function imageExtension(mimeType: string): string {
  return mimeType.slice('image/'.length).replace(/[^a-z0-9]/gi, '') || 'img';
}

/** Write the conversation's images to a directory of their own for this run,
 *  named in attachment order so the file list reads the way the transcript
 *  numbers them. Returns nothing when there is nothing to write, so a run
 *  without pictures creates no directory and has none to remove. */
async function writeImagesForTurn(
  images: readonly MediaContent[],
  invocationId: string,
): Promise<{ dir: string; paths: string[] } | null> {
  if (images.length === 0) return null;
  const dir = await mkdtemp(join(tmpdir(), `codex-${invocationId.replace(/[^a-zA-Z0-9_-]/g, '')}-`));
  const paths: string[] = [];
  for (const [i, image] of images.entries()) {
    const path = join(dir, `attachment-${i + 1}.${imageExtension(image.mimeType)}`);
    await writeFile(path, Buffer.from(image.dataBase64, 'base64'));
    paths.push(path);
  }
  return { dir, paths };
}

/** The first turn's input: the text, plus one `local_image` member per picture
 *  written for this run. A plain string when there is nothing to attach, which
 *  is the shape every later turn takes. */
function firstTurnInput(text: string, imagePaths: readonly string[]): Input {
  if (imagePaths.length === 0) return text;
  return [
    { type: 'text', text },
    ...imagePaths.map((path) => ({ type: 'local_image' as const, path })),
  ];
}

/** How every thread is run, fresh or resumed: read-only, no sandbox network,
 *  no approval prompt (the governed server carries its own approval mode),
 *  and OpenAI's live web search. One object, so a resumed thread cannot
 *  quietly run under different terms from the one it continues. */
const CODEX_THREAD_OPTIONS = {
  sandboxMode: 'read-only',
  networkAccessEnabled: false,
  approvalPolicy: 'never',
  skipGitRepoCheck: true,
  webSearchMode: 'live',
} as const satisfies ThreadOptions;

export class CodexAdapter implements VendorSdkAdapter {
  readonly kind = 'codex';
  /** Thread-based: after the first turn the Codex thread holds the history
   *  upstream and we send only the next input, so our accumulated history is
   *  not what the model sees. */
  readonly managesOwnContext = true;
  private catalog: McpToolCatalog | null = null;
  private hitlGate: HitlGate | null = null;
  private toolResultObserver: ToolResultObserver | null = null;
  private anomalyHandler: AnomalyHandler | null = null;
  private recorder: TrajectoryRecorder | null = null;
  private currentInvocation: InvocationInput | null = null;
  private injected: UserMessage[] = [];
  private paused = false;

  async *invoke(input: InvocationInput, signal: AbortSignal): AsyncIterable<InvocationEvent> {
    if (!this.catalog) throw new Error('Tool catalog not registered');
    this.currentInvocation = input;
    this.paused = false;
    this.injected = [];

    const internalAbort = new AbortController();
    const onOuterAbort = () => internalAbort.abort();
    if (signal.aborted) internalAbort.abort();
    else signal.addEventListener('abort', onOuterAbort, { once: true });

    const bridgeContext: BridgeContext = {
      tenantId: input.tenantId,
      invocationId: input.invocationId,
      hitlGate: this.hitlGate,
      anomalyHandler: this.anomalyHandler,
      toolResultObserver: this.toolResultObserver,
      // Marked by the bridge under the proxy's own id and consumed by the
      // proxy on the way back, as the result's `_meta` stamp.
      recordedCalls: new Set<string>(),
      pendingHitlGate: null,
      pendingDelegationPause: null,
      abort: () => internalAbort.abort(),
      onRecoveryInject: (text) => { this.injected.push({ text, source: 'system' }); },
    };

    const httpMcp = await exposeCatalogOverHttp(this.catalog, bridgeContext);
    let images: { dir: string; paths: string[] } | null = null;
    // Outside the try: the catch below emits a pause against the thread.
    let threadId: string | null = null;
    try {
      const { Codex } = await esmImport<typeof import('@openai/codex-sdk')>('@openai/codex-sdk');
      const codex = new Codex({
        // npm ci doesn't install the aliased platform optional dep in the image,
        // so point the SDK at the globally-installed CLI (Dockerfile: npm i -g).
        codexPathOverride: process.env.CODEX_CLI_PATH || '/usr/local/bin/codex',
        // Allow-listed, not inherited: `env` replaces the child's environment
        // rather than extending it, which is what is wanted for a process that
        // runs the agent's own tools. See child-process-env.ts.
        env: childProcessEnv(
          input.byok?.vendor === 'openai'
            ? {}
            : { OPENAI_API_KEY: getManagedSecret('OPENAI_API_KEY') },
        ),
        // BYO provider keys: the customer's own account funds this run, so the
        // SDK is pointed at the Liftoff gateway with a short-lived per-run token
        // instead of at OpenAI with ours. The token is never a customer key —
        // the real one is attached on the far side, out of reach of the Codex
        // subprocess that runs this agent's tools. `/v1` is the CLI's own
        // convention for an OpenAI-wire base URL.
        ...(input.byok?.vendor === 'openai'
          ? {
              apiKey: input.byok.token,
              baseUrl: `${input.byok.baseUrl.replace(/\/+$/, '')}/v1`,
            }
          : { apiKey: getManagedSecret('OPENAI_API_KEY') }),
        config: {
          mcp_servers: {
            liftoff: liftoffMcpServerConfig(httpMcp),
          },
        },
      });
      // NO TURN BUDGET REACHES THIS ENGINE. The run's `input.maxTurns` (the
      // tenant's maxToolCalls) has nowhere to go: neither `codex exec`'s flags
      // (the exec CLI struct: --json, --output-schema, --sandbox, --profile,
      // --skip-git-repo-check, --ephemeral, --image, ...) nor the CLI's
      // config.toml keys (model, sandbox_mode, approval_policy, web_search,
      // tools, agents, mcp_servers, ...) carry a cap on turns, steps or tool
      // calls, and ThreadOptions / TurnOptions of @openai/codex-sdk expose
      // none. The Codex CLI's own loop decides when to stop. The runtime's
      // wall clock and the per-call gate still bound the run.
      const thread: Thread = codex.startThread({ model: input.model, ...CODEX_THREAD_OPTIONS });

      // Codex has no system slot — prepend the platform instructions + history
      // preamble (multi-turn / HITL-resume replay) to the first turn. The
      // conversation's pictures ride the same turn as local files.
      images = await writeImagesForTurn(attachedImages(input.messages), input.invocationId);
      let nextInput: Input = firstTurnInput(
        `${input.systemPrompt}\n\n${firstTurnPrompt(input.messages, { carriesImages: true })}`,
        images?.paths ?? [],
      );
      while (true) {
        if (signal.aborted) { yield { type: 'completion', outcome: 'error', reason: 'aborted' }; return; }
        const paused = yield* this.runTurn(thread, nextInput, input, bridgeContext, internalAbort, signal, (id) => {
          if (id && !threadId) threadId = id;
        });
        if (paused === 'paused') { return; }
        if (paused === 'aborted') { return; }

        if (this.paused) {
          const token = await this.pauseWithThread('ask_user', threadId);
          yield { type: 'pause_requested', reason: 'ask_user', token };
          return;
        }
        const drained = this.injected.splice(0, this.injected.length);
        if (drained.length === 0) {
          yield { type: 'completion', outcome: 'success' };
          return;
        }
        nextInput = drained.map((m) => m.text).join('\n');
      }
    } catch (e) {
      if (signal.aborted) { yield { type: 'completion', outcome: 'error', reason: 'aborted' }; return; }
      // The bridge aborts the run the moment a call is gated, delegated or
      // put to sleep, and the SDK reports that abort by throwing before the
      // next event arrives — so the per-event check in runTurn never saw the
      // stash, and the pause reached the loop as "codex invoke failed: The
      // operation was aborted": a failed turn, no approval row, nothing on the
      // review page. The stash is read here, as the openai-wire engine reads
      // it in its own catch.
      if (yield* this.pendingPause(bridgeContext, threadId)) return;
      logger.warn({ err: (e as Error).message, invocationId: input.invocationId }, 'codex invoke failed');
      yield { type: 'completion', outcome: 'error', reason: (e as Error).message, failure: extractProviderFailure(e) };
    } finally {
      signal.removeEventListener('abort', onOuterAbort);
      if (images) await rm(images.dir, { recursive: true, force: true }).catch(() => undefined);
      await httpMcp.close().catch(() => undefined);
      await getMcpClientPool().releaseAll(input.invocationId).catch(() => undefined);
    }
  }

  /** The pause the bridge stashed on the shared context, if any, emitted as
   *  the event the loop consumes: delegation, then wake, then the gate, the
   *  order runTurn checks them in. True when one was emitted. */
  private async *pendingPause(
    bridgeContext: BridgeContext,
    threadId: string | null,
  ): AsyncGenerator<InvocationEvent, boolean, undefined> {
    if (bridgeContext.pendingDelegationPause) {
      const token = await this.pauseWithThread('delegation', threadId);
      const delegationContext = bridgeContext.pendingDelegationPause;
      bridgeContext.pendingDelegationPause = null;
      yield { type: 'pause_requested', reason: 'delegation', token, delegationContext };
      return true;
    }
    if (bridgeContext.pendingWakePause) {
      const token = await this.pauseWithThread('self_wake', threadId);
      const wakeContext = bridgeContext.pendingWakePause;
      bridgeContext.pendingWakePause = null;
      yield { type: 'pause_requested', reason: 'self_wake', token, wakeContext };
      return true;
    }
    if (bridgeContext.pendingHitlGate) {
      const token = await this.pauseWithThread('hitl_gate', threadId);
      const gateContext = bridgeContext.pendingHitlGate;
      bridgeContext.pendingHitlGate = null;
      yield { type: 'pause_requested', reason: 'hitl_gate', token, gateContext };
      return true;
    }
    return false;
  }

  /** Run one Codex turn, streaming events → InvocationEvents. Returns 'paused'
   *  when a HITL/delegation pause was emitted, 'aborted' on outer abort, or
   *  undefined when the turn completed normally. */
  private async *runTurn(
    thread: Thread,
    turnInput: Input,
    input: InvocationInput,
    bridgeContext: BridgeContext,
    internalAbort: AbortController,
    signal: AbortSignal,
    onThreadId: (_id: string | null) => void,
  ): AsyncGenerator<InvocationEvent, 'paused' | 'aborted' | undefined, undefined> {
    const streamed = await thread.runStreamed(turnInput, { signal: internalAbort.signal });
    // Hosted searches this turn made. Per TURN, because that is the unit the
    // usage event reports on; summed across turns by the loop, like tokens.
    let webSearchRequests = 0;
    for await (const event of streamed.events as AsyncGenerator<ThreadEvent>) {
      if (signal.aborted) { yield { type: 'completion', outcome: 'error', reason: 'aborted' }; return 'aborted'; }
      if (this.recorder) {
        this.recorder.recordRaw({
          invocationId: input.invocationId,
          provider: 'openai',
          model: input.model,
          rawKind: 'codex_thread_item',
          raw: event,
        });
      }
      if (event.type === 'thread.started') {
        onThreadId(event.thread_id);
        yield { type: 'session_started', sessionId: event.thread_id };
      } else if (event.type === 'item.started' || event.type === 'item.completed') {
        if (event.type === 'item.completed' && event.item.type === 'web_search') webSearchRequests += 1;
        for (const ev of this.translateItem(event.item, event.type)) yield ev;
      } else if (event.type === 'turn.completed') {
        const u = event.usage;
        yield {
          type: 'usage',
          usage: {
            inputTokens: u.input_tokens,
            // OpenAI's `input_tokens` is the prompt TOTAL, cached part
            // included, so the context is that figure unchanged. Adding
            // `cached_input_tokens` to it would count the cached part twice.
            contextTokens: u.input_tokens,
            // Reasoning tokens are OUTPUT tokens and are billed as such. The
            // SDK reports them separately, and reading only output_tokens
            // under-reports the cost of every reasoning turn — which on a
            // codex model is most of them.
            outputTokens: u.output_tokens + (u.reasoning_output_tokens ?? 0),
            cachedTokens: u.cached_input_tokens,
            // OpenAI's hosted searches, billed per CALL and so carried beside
            // the tokens rather than derived from them. Undefined rather than
            // zero when there were none, the way every other adapter says it.
            webSearchRequests: webSearchRequests || undefined,
            // Cache WRITES, kept because they are the only thing that
            // distinguishes "this engine does not cache" from "it cached and
            // read nothing back". The benchmark reported codex at 0% and those
            // two readings are opposite conclusions from the same number.
            raw: {
              cacheWriteInputTokens: u.cache_write_input_tokens,
              reasoningOutputTokens: u.reasoning_output_tokens,
            },
          },
        };
      } else if (event.type === 'turn.failed') {
        // The SDK may report the bridge's own abort as a failed turn.
        if (yield* this.pendingPause(bridgeContext, thread.id)) return 'paused';
        yield { type: 'anomaly_detected', kind: 'unexpected_stop', context: { error: event.error?.message } };
        yield {
          type: 'completion',
          outcome: 'error',
          reason: event.error?.message ?? 'codex turn failed',
          failure: extractProviderFailure(event.error),
        };
        return 'aborted';
      } else if (event.type === 'error') {
        if (yield* this.pendingPause(bridgeContext, thread.id)) return 'paused';
        yield {
          type: 'completion',
          outcome: 'error',
          reason: event.message,
          failure: extractProviderFailure(event),
        };
        return 'aborted';
      }

      // HITL / delegation — set by exposeCatalogOverHttp's dispatchFunctionCall in-process.
      // thread.id is populated after the first turn starts and round-trips for resume.
      if (bridgeContext.pendingDelegationPause) {
        const token = await this.pauseWithThread('delegation', thread.id);
        const delegationContext = bridgeContext.pendingDelegationPause;
        bridgeContext.pendingDelegationPause = null;
        internalAbort.abort();
        yield { type: 'pause_requested', reason: 'delegation', token, delegationContext };
        return 'paused';
      }
      if (bridgeContext.pendingWakePause) {
        const wakeToken = await this.pauseWithThread('self_wake', thread.id);
        const wakeContext = bridgeContext.pendingWakePause;
        bridgeContext.pendingWakePause = null;
        internalAbort.abort();
        yield { type: 'pause_requested', reason: 'self_wake', token: wakeToken, wakeContext };
        return 'paused';
      }
      if (bridgeContext.pendingHitlGate) {
        const token = await this.pauseWithThread('hitl_gate', thread.id);
        const gateContext = bridgeContext.pendingHitlGate;
        bridgeContext.pendingHitlGate = null;
        internalAbort.abort();
        yield { type: 'pause_requested', reason: 'hitl_gate', token, gateContext };
        return 'paused';
      }
    }
    return undefined;
  }

  private translateItem(item: ThreadItem, phase: 'item.started' | 'item.completed'): InvocationEvent[] {
    if (item.type === 'agent_message') {
      return phase === 'item.completed' && item.text
        ? [{ type: 'assistant_message', content: [{ type: 'text', text: item.text }] }]
        : [];
    }
    if (item.type === 'mcp_tool_call') {
      if (phase === 'item.started') {
        return [{ type: 'tool_call_started', toolName: item.tool, args: (item.arguments ?? {}) as Record<string, unknown>, callId: item.id }];
      }
      // The bridge waited for the observer on the HTTP MCP path under an id
      // of its own, and the proxy handed that id and the outcome back on the
      // result's `_meta` (remembered-stamp.ts). Read off the item, so a call
      // whose record landed is marked and the stream skips it, and a call
      // whose record did not is re-recorded under the bridge's id — the same
      // row, not a second one.
      const meta = (item.result as { _meta?: unknown } | undefined)?._meta;
      return [{
        type: 'tool_call_finished',
        callId: item.id,
        result: item.result ?? item.error,
        error: item.error?.message,
        ...rememberedEventFields(meta),
      }];
    }
    if (item.type === 'web_search') {
      // OpenAI's hosted search, surfaced the way the wire surfaces its
      // `web_search_call`: a started/finished pair named `web_search`, so the
      // loop, the trajectory and the person see the search the model made.
      // The item carries the query and no results — the results reach the
      // model inside the response — so the finished event carries the query.
      return phase === 'item.started'
        ? [{ type: 'tool_call_started', toolName: 'web_search', args: { query: item.query }, callId: item.id }]
        : [{ type: 'tool_call_finished', callId: item.id, result: { query: item.query } }];
    }
    if (item.type === 'error' && phase === 'item.completed') {
      return [{ type: 'anomaly_detected', kind: 'unknown', context: { error: item.message } }];
    }
    return [];
  }


  async injectMessage(message: UserMessage): Promise<void> {
    this.injected.push(message);
  }

  async pause(reason: PauseReason): Promise<ResumeToken> {
    return this.pauseWithThread(reason, null);
  }

  private async pauseWithThread(reason: PauseReason, threadId: string | null): Promise<ResumeToken> {
    this.paused = true;
    return { adapterKind: 'codex', serialized: JSON.stringify({ reason, input: this.currentInvocation, threadId }) };
  }

  async *resume(token: ResumeToken, response: UserResponse, signal: AbortSignal): AsyncIterable<InvocationEvent> {
    const data = JSON.parse(token.serialized) as { input: InvocationInput; threadId: string | null };
    if (!this.catalog) throw new Error('Tool catalog not registered');
    this.currentInvocation = data.input;
    this.paused = false;
    this.injected = [];

    const internalAbort = new AbortController();
    const onOuterAbort = () => internalAbort.abort();
    if (signal.aborted) internalAbort.abort();
    else signal.addEventListener('abort', onOuterAbort, { once: true });

    const bridgeContext: BridgeContext = {
      tenantId: data.input.tenantId,
      invocationId: data.input.invocationId,
      hitlGate: this.hitlGate,
      anomalyHandler: this.anomalyHandler,
      toolResultObserver: this.toolResultObserver,
      // Marked by the bridge under the proxy's own id and consumed by the
      // proxy on the way back, as the result's `_meta` stamp.
      recordedCalls: new Set<string>(),
      pendingHitlGate: null,
      pendingDelegationPause: null,
      abort: () => internalAbort.abort(),
      onRecoveryInject: (text) => { this.injected.push({ text, source: 'system' }); },
    };
    const httpMcp = await exposeCatalogOverHttp(this.catalog, bridgeContext);
    let threadId: string | null = data.threadId;
    try {
      const { Codex } = await esmImport<typeof import('@openai/codex-sdk')>('@openai/codex-sdk');
      const codex = new Codex({
        // npm ci doesn't install the aliased platform optional dep in the image,
        // so point the SDK at the globally-installed CLI (Dockerfile: npm i -g).
        codexPathOverride: process.env.CODEX_CLI_PATH || '/usr/local/bin/codex',
        env: childProcessEnv(
          data.input.byok?.vendor === 'openai'
            ? {}
            : { OPENAI_API_KEY: getManagedSecret('OPENAI_API_KEY') },
        ),
        // Same substitution as invoke() above — a resumed thread is the same
        // run and is funded by the same account.
        ...(data.input.byok?.vendor === 'openai'
          ? {
              apiKey: data.input.byok.token,
              baseUrl: `${data.input.byok.baseUrl.replace(/\/+$/, '')}/v1`,
            }
          : { apiKey: getManagedSecret('OPENAI_API_KEY') }),
        config: { mcp_servers: { liftoff: liftoffMcpServerConfig(httpMcp) } },
      });
      const thread: Thread = data.threadId
        ? codex.resumeThread(data.threadId, CODEX_THREAD_OPTIONS)
        : codex.startThread({ model: data.input.model, ...CODEX_THREAD_OPTIONS });

      // Text only: the thread holds its pictures upstream, and a person's
      // answer to a pause carries none.
      let nextInput: Input = response.text;
      while (true) {
        if (signal.aborted) { yield { type: 'completion', outcome: 'error', reason: 'aborted' }; return; }
        const result = yield* this.runTurn(thread, nextInput, data.input, bridgeContext, internalAbort, signal, (id) => { if (id) threadId = id; });
        if (result === 'paused' || result === 'aborted') return;
        if (this.paused) {
          const t = await this.pauseWithThread('ask_user', threadId);
          yield { type: 'pause_requested', reason: 'ask_user', token: t };
          return;
        }
        const drained = this.injected.splice(0, this.injected.length);
        if (drained.length === 0) { yield { type: 'completion', outcome: 'success' }; return; }
        nextInput = drained.map((m) => m.text).join('\n');
      }
    } catch (e) {
      if (signal.aborted) { yield { type: 'completion', outcome: 'error', reason: 'aborted' }; return; }
      // Same as invoke: a gate hit on the resumed turn aborts the stream
      // before its pause is observed.
      if (yield* this.pendingPause(bridgeContext, threadId)) return;
      logger.warn({ err: (e as Error).message, invocationId: data.input.invocationId }, 'codex resume failed');
      yield { type: 'completion', outcome: 'error', reason: (e as Error).message, failure: extractProviderFailure(e) };
    } finally {
      signal.removeEventListener('abort', onOuterAbort);
      await httpMcp.close().catch(() => undefined);
      await getMcpClientPool().releaseAll(data.input.invocationId).catch(() => undefined);
    }
  }

  registerToolCatalog(catalog: McpToolCatalog): void { this.catalog = catalog; }
  registerHitlGate(gate: HitlGate): void { this.hitlGate = gate; }
  registerToolResultObserver(observer: ToolResultObserver): void { this.toolResultObserver = observer; }
  registerAnomalyHandler(handler: AnomalyHandler): void { this.anomalyHandler = handler; }
  // No registerToolBatchHandler: this engine dispatches over HTTP MCP, where a
  // tools/call carries no model call id, so its rejections cannot be folded
  // into the batch that produced them. The platform accounts per call here.
  registerTrajectoryRecorder(recorder: TrajectoryRecorder): void { this.recorder = recorder; }
}
