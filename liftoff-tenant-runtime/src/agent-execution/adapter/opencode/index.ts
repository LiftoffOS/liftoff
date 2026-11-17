// opencode VendorSdkAdapter (@opencode-ai/sdk) for the open-weights families
// (GLM / Qwen / DeepSeek / Kimi / MiniMax, reached through OpenRouter) and for
// Grok (reached on api.x.ai). opencode is a model-agnostic agentic runtime that
// owns the loop AND self-manages context (session summarize + auto-compaction),
// so — like the other vendor SDKs — no Liftoff-side context handling ("B") is
// needed.
//
// TWO TRANSPORTS, ONE ADAPTER, the same shape as the opencode coding runner
// (tools/code-session/runners/opencode.ts). opencode ships both providers
// natively, so each needs only a key and the model registration: the
// open-weights families go under opencode's `openrouter` provider on Liftoff's
// OpenRouter key, Grok under its `xai` provider on Liftoff's xAI key or — when
// the customer funds the run — the per-run gateway token. The provider id is
// the TRANSPORT; the family the model belongs to is what the registry files
// its metadata under, and the two are passed separately for that reason.
//
// opencode runs as a REST server; `./server.ts` spawns it with an environment
// of our choosing and binds the SDK's client to it. Liftoff's governed tool
// seam is reached as a REMOTE MCP server
// (Config.mcp.liftoff = {type:'remote', url}) served on localhost by
// exposeCatalogOverHttp — every tool call routes through dispatchFunctionCall
// (registered hitlGate + framing + OU-metering + single-result bound). HITL is
// therefore the SAME pendingHitlGate mechanism as Codex: a gated call sets
// bridgeContext.pendingHitlGate (shared, in-process), which this adapter observes
// to abort the session and pause.
//
// opencode's OWN built-in tools are DENIED, in config and again at the
// permission prompt. They are the one thing the governed proxy above cannot
// see: a built-in never reaches dispatchFunctionCall, so the HITL gate, the
// oversight policy, framing, metering and the single-result bound do not apply
// to it. This adapter used to auto-approve those prompts "since the Liftoff gate
// already ran in the proxy" — the gate had not run, which is why the prompt
// existed. See the config block and the permission handler below.
//
// Installed SDK reconciliation (@opencode-ai/sdk@1.18.x, generated OpenAPI
// client): createOpencodeClient({baseUrl}); client.session.create / prompt /
// abort / summarize; (await client.event.subscribe()).stream yields the Event
// union; permission reply via client.postSessionIdPermissionsPermissionId. The
// SDK's own createOpencode() is not used: its ServerOptions has no `env`, and
// the server's environment decides which API opencode reaches a provider over
// (`./server.ts`), so the spawn is ours and builds that environment from the
// allow-list like every other engine (adapter/child-process-env.ts).
//
// Denying the built-in tools above is the other half of that: with no bash and
// no file tools, whatever the server's environment holds has no reader inside
// the session. It is defence by removing the capability as well as by
// withholding the secret — but the server still runs under the runtime's
// identity, so the durable answer remains isolation
// (execution-environments/cloud-run-sandbox-provider.ts), the way the sandbox
// tool path already runs.
//
// BYO PROVIDER KEYS: honoured for Grok, and only Grok, because that is a
// property of the providers rather than of this engine. An OpenRouter invoice
// is Liftoff's — the keys card offers no OpenRouter field because a customer
// cannot hold one for our account — so the open-weights families always run on
// Liftoff's OpenRouter credential, whatever the workspace pasted. Grok bills on
// an xAI account, which a customer CAN hold: a customer-funded Grok run reaches
// xAI through Liftoff's gateway, which holds the real key, and the token opencode
// is given is the per-run credential for that gateway, never the customer's own.
//
// IMAGES ARE CARRIED, NOT DESCRIBED. opencode's prompt takes file parts beside
// the text, and a file part whose URL is a data URL reaches the model as the
// vendor's own image block (the server resolves `data:` URLs in place and its
// message mapping sends an `image/*` file part as media). So every picture in
// the conversation rides the first turn — the one that carries the replayed
// transcript, which names each by its attachment number
// (conversation-preamble.ts). A resumed session already holds its pictures, and
// a follow-up turn is text. Video stays described: no model behind either
// transport takes one.

import type { OpencodeClient } from '@opencode-ai/sdk';
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
import { longestDispatchTimeoutMs } from '../dispatch-timeout';
import { rememberedEventFields } from '../remembered-stamp';
import { exposeCatalogOverHttp, type ToolGatewayHttpMcp } from '../tool-gateway-http-mcp';
import { getMcpClientPool } from '../mcp-client-pool';
import { attachedImages, firstTurnPrompt, type MediaContent } from '../conversation-preamble';
import { LIFTOFF_MCP_SERVER_NAME, opencodeCatalogToolName } from '../mcp-tool-names';

/** Consecutive failed status probes (one per 5s quiet tick) before the server is
 *  called gone. Three rides out a dropped request without spending the turn's
 *  whole budget on a process that has already exited. */
const UNREACHABLE_PROBES_BEFORE_FAILING = 3;

/** How long to keep draining after the blocking prompt returns, so parts already
 *  on the wire still reach the caller. The turn is already over; this is only
 *  about not truncating its tail. */
const PROMPT_DRAIN_GRACE_MS = 2_000;

/** How long cleanup waits for a blocking prompt to come back after the session
 *  has been aborted, before giving up on it. */
const PROMPT_SETTLE_GRACE_MS = 2_000;

/** How long one shutdown step (closing the event stream, closing the local MCP
 *  server) may take before the adapter stops waiting on it. Each is a local
 *  teardown that normally finishes in milliseconds; waiting past this only
 *  holds the run's close open. */
export const SHUTDOWN_STEP_GRACE_MS = 5_000;

/**
 * Await one shutdown step, but no longer than SHUTDOWN_STEP_GRACE_MS.
 *
 * Shutdown used to await these unbounded, and on the first opencode run on a
 * fresh instance closing after an approval pause took ~300s: a localhost
 * connection held open until Node's own 300s timer. Cleanup must not inherit a
 * hang it exists to clean up after. A step that overruns is logged and left to
 * finish on its own; a step that fails is ignored, as before.
 */
export async function settleShutdownStep(
  step: string,
  work: () => Promise<unknown> | undefined,
  context: { invocationId?: string },
  graceMs: number = SHUTDOWN_STEP_GRACE_MS,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const startedAt = Date.now();
  const overran = await Promise.race([
    Promise.resolve()
      .then(work)
      .then(() => false, () => false),
    new Promise<true>((resolve) => { timer = setTimeout(() => resolve(true), graceMs); timer.unref?.(); }),
  ]);
  clearTimeout(timer);
  if (overran) {
    logger.warn(
      { step, graceMs, elapsedMs: Date.now() - startedAt, invocationId: context.invocationId },
      'opencode shutdown step overran its bound; no longer waiting on it',
    );
  }
}
import { logger } from '../../../infrastructure/logging';
import { opencodeModelEntry } from './model-config';
import { startOpencode, type OpencodeServerHandle } from './server';
import { getOpenRouterApiKey, getXaiApiKey } from '../../../infrastructure/secrets';
import { extractProviderFailure } from '../provider-failure';
import { XAI_BASE_URL, xaiNativeModelId } from '../../../llm/providers/xai';

/** opencode's provider id for each host this adapter uses. Both are providers
 *  opencode ships natively, so neither needs an npm/baseURL definition — only
 *  a key and the model registration. The same two ids the coding runner uses. */
const OPENROUTER_PROVIDER_ID = process.env.OPENCODE_PROVIDER_ID || 'openrouter';
const XAI_PROVIDER_ID = process.env.OPENCODE_XAI_PROVIDER_ID || 'xai';

/** How long opencode waits on one call to the `liftoff` MCP server, in ms.
 *
 *  opencode 1.18.7 calls MCP tools with `{ timeout: mcp.<server>.timeout,
 *  resetTimeoutOnProgress: true }` (src/mcp/catalog.ts). A per-server value,
 *  so it must cover the longest call the bridge behind the server will wait
 *  for: code_session at its default 600s budget plus the bridge's 60s margin,
 *  660s today (longestDispatchTimeoutMs). Another 30s on top so the BRIDGE's
 *  ceiling fires first when a tool does hang: it answers the model with a tool
 *  error the run can act on, where opencode's own timeout is a bare -32001.
 *  690_000 ms with the defaults. It also bounds connect and tools/list, which
 *  on a loopback server answer in milliseconds either way. */
export function liftoffMcpServerTimeoutMs(): number {
  return longestDispatchTimeoutMs() + 30_000;
}

/** How long a turn may produce NOTHING before it is abandoned.
 *
 *  Silence is the failure a bound can actually detect. A turn still streaming
 *  is working, however long it has been. */
export function turnIdleTimeoutMs(): number {
  return Number(process.env.OPENCODE_TURN_IDLE_TIMEOUT_MS) || 180_000;
}

/** The ceiling a turn may never pass, whatever it is doing.
 *
 *  Derived from the longest `tools/call` the turn can legally contain, because
 *  a turn shorter than a call it is permitted to make cannot finish one. It
 *  used to be a flat 180_000 — a quarter of the 690_000 we advertise per call. */
export function turnDeadlineMs(): number {
  return Number(process.env.OPENCODE_TURN_TIMEOUT_MS)
    || liftoffMcpServerTimeoutMs() + turnIdleTimeoutMs();
}

/** One text part, or one file part per picture, in the shape opencode's prompt
 *  endpoint takes. Named here so the first turn (text + pictures) and every
 *  later one (text) build the same list. */
/** What one turn's snapshot events have already said, so each thing is said
 *  once: the text each part carries so far, the parts closed as messages, the
 *  calls already announced. */
interface OpencodeTurnState {
  text: Map<string, string>;
  closed: Set<string>;
  started: Set<string>;
  /** Message ids the server has announced as the USER's. Their text parts
   *  are the prompt coming back, not the model speaking. */
  userMessages: Set<string>;
}

function newTurnState(): OpencodeTurnState {
  return { text: new Map(), closed: new Set(), started: new Set(), userMessages: new Set() };
}

/** Whether a stream event is a part of the PROMPT — the server echoes the
 *  user's message through the same `message.part.updated` event as the
 *  model's parts, and the message announced its role first. The event stream
 *  skips it, and so does the trajectory record: the loop recorded the prompt
 *  as the user's turn before the run started, and a second copy would stand
 *  in the record as the assistant's words. */
function isPromptPart(e: { type: string; properties?: Record<string, unknown> }, turn: OpencodeTurnState): boolean {
  if (e.type !== 'message.part.updated') return false;
  const part = (e.properties as { part?: { messageID?: unknown } } | undefined)?.part;
  return typeof part?.messageID === 'string' && turn.userMessages.has(part.messageID);
}

type PromptPart =
  | { type: 'text'; text: string }
  | { type: 'file'; mime: string; url: string; filename?: string };

/** The file parts for the conversation's images: a data URL each, so nothing
 *  is written to disk and the bytes reach the server in the request that
 *  names them. Named in attachment order, the way the transcript numbers them. */
function imageParts(images: readonly MediaContent[]): PromptPart[] {
  return images.map((image, i) => ({
    type: 'file',
    mime: image.mimeType,
    url: `data:${image.mimeType};base64,${image.dataBase64}`,
    filename: `attachment-${i + 1}.${image.mimeType.slice('image/'.length).replace(/[^a-z0-9]/gi, '') || 'img'}`,
  }));
}

/** Where a run's model is served from, and on whose credential.
 *
 *  Decided ONCE per run and threaded through, because three things have to
 *  agree about it: the provider block opencode is configured with, the
 *  provider the prompt names the model under, and the id that model is
 *  registered as. Grok is xAI's whoever pays — the resolved provider says so,
 *  and so does a customer's xAI credential on the run — and its id is xAI's own
 *  (`grok-4.6`), never OpenRouter's slug, which api.x.ai 404s. */
interface OpencodeTransport {
  /** opencode's provider id — the TRANSPORT the model is reached through. */
  providerId: string;
  /** The id opencode registers and prompts the model under. */
  modelId: string;
  apiKey: string | null;
  /** Set when the host is not the provider's own default: the gateway on any run
   *  that opened a session — a customer-funded Grok run, or a managed run routed
   *  through it so its reasoning tokens are counted — or an operator-moved xAI
   *  host. */
  baseURL?: string;
  /** What the opencode server's environment must carry for this provider,
   *  beyond the config. opencode registers its provider-specific model loader
   *  only for a provider that exists when its loaders run, and a key given in
   *  the config alone does not create one: for xAI that loader is what selects
   *  the Responses API over the bundled SDK's chat completions model (see
   *  `./server.ts`). The catalog names the variable, `XAI_API_KEY`; the same
   *  credential as the config's, which stays the one actually used. OpenRouter
   *  is left on the config-only path it has always run on. */
  env: Record<string, string>;
}

async function resolveTransport(input: InvocationInput): Promise<OpencodeTransport> {
  const byokXai = input.byok?.vendor === 'xai' ? input.byok : undefined;
  const xai = input.provider === 'xai' || !!byokXai;
  if (!xai) {
    // THE OPEN-WEIGHTS FAMILIES REACH OPENROUTER THROUGH THE GATEWAY WHEN THERE
    // IS ONE, and it is not about who pays — nobody but Liftoff ever pays for
    // these, the invoice is ours, and the keys card offers no OpenRouter field.
    //
    // It is about what this engine can SEE. Its `step-finish` tokens split
    // reasoning out of the completion figure the vendor bills, and the vendor's
    // own count is on the HTTP response in
    // `completion_tokens_details.reasoning_tokens` — which the gateway reads and
    // nothing on this side of the process can.
    //
    // `/v1` is the OpenAI-wire convention both the gateway and openrouter.ai
    // serve, and the trailing slash is stripped first exactly as the xAI branch
    // below does it: the control plane builds the base as
    // `<backend>/byok/<vendor>`, and a double slash reaches the router as an
    // empty path segment.
    const byokOpenRouter = input.byok?.vendor === 'openrouter' ? input.byok : undefined;
    const apiKey = byokOpenRouter ? byokOpenRouter.token : await getOpenRouterApiKey();
    return {
      providerId: OPENROUTER_PROVIDER_ID,
      modelId: input.model,
      apiKey,
      ...(byokOpenRouter
        ? { baseURL: `${byokOpenRouter.baseUrl.replace(/\/+$/, '')}/v1` }
        : {}),
      // OpenRouter stays on the config-only path it has always run on: opencode
      // registers its OpenRouter models from the config alone, and adding an
      // environment copy would be a second credential for the same request.
      env: {},
    };
  }
  // A customer-funded Grok run reaches xAI through Liftoff's gateway, which
  // holds the real key; the token here is the per-run credential for that
  // gateway, never the customer's own. `/v1` is the OpenAI-wire convention
  // both the gateway and api.x.ai serve.
  const apiKey = byokXai ? byokXai.token : await getXaiApiKey();
  return {
    providerId: XAI_PROVIDER_ID,
    modelId: xaiNativeModelId(input.model),
    apiKey,
    baseURL: byokXai
      ? `${byokXai.baseUrl.replace(/\/+$/, '')}/v1`
      : `${(process.env.XAI_BASE_URL ?? XAI_BASE_URL).replace(/\/+$/, '')}/v1`,
    env: apiKey ? { XAI_API_KEY: apiKey } : {},
  };
}

/**
 * opencode's built-in tools, all switched off.
 *
 * Enumerated rather than expressed as "deny everything" because the config is a
 * per-name map with no wildcard: a tool this list does not name stays ON. The
 * permission block beside it is the backstop for exactly that — a built-in
 * introduced by a future opencode release lands in `permission`'s categories
 * (bash / edit / webfetch / external_directory) even when this list has not
 * heard of it, and the handler denies anything that reaches neither.
 *
 * Every capability this agent legitimately needs arrives through the governed
 * `liftoff` MCP server, so there is nothing to lose by removing all of them.
 */
/** opencode's own built-in tools, every one of them refused.
 *
 *  Kept against the published list at https://opencode.ai/docs/tools/. It had
 *  drifted, and `question` is what the drift cost: that tool asks the person a
 *  question and WAITS for the answer, so on a headless runtime the turn does not
 *  fail, it stops — the server stays up and answers REST, calls the session
 *  busy, and every deadline above it expires against a turn that was never going
 *  to move. A `read` we forgot to deny is a governance hole; a `question` we
 *  forgot to deny is a deadlock.
 *
 *  Names no longer in the published list are kept rather than pruned: an entry
 *  for a tool that does not exist costs nothing, and removing one that a version
 *  still serves reopens it. */
const OPENCODE_BUILTIN_TOOLS_DENIED: Record<string, boolean> = {
  bash: false,
  edit: false,
  write: false,
  patch: false,
  apply_patch: false,
  read: false,
  grep: false,
  glob: false,
  list: false,
  lsp: false,
  skill: false,
  webfetch: false,
  websearch: false,
  question: false,
  task: false,
  todowrite: false,
  todoread: false,
};

/** The catalog's name for a tool opencode reported — with the server prefix
 *  removed. The stream seams resolve names against the catalog the run
 *  started with, and a prefixed name such as `liftoff_call_github_<id>_tool`
 *  matches nothing there: our own bookkeeping tools would be observed as if
 *  they were a vendor's, and a vendor call only remembered by its stamp. */
const catalogToolName = opencodeCatalogToolName;

export class OpencodeAdapter implements VendorSdkAdapter {
  readonly kind = 'opencode';
  /** Session-based: the opencode session holds the history upstream and we
   *  send only the next turn's text. */
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
    // The replayed transcript, with the conversation's pictures attached to
    // the same turn it names them from.
    const firstTurn: PromptPart[] = [
      { type: 'text', text: firstTurnPrompt(input.messages, { carriesImages: true }) },
      ...imageParts(attachedImages(input.messages)),
    ];
    yield* this.run(input, firstTurn, undefined, input.systemPrompt, signal);
  }

  async *resume(token: ResumeToken, response: UserResponse, signal: AbortSignal): AsyncIterable<InvocationEvent> {
    if (!this.catalog) throw new Error('Tool catalog not registered');
    const data = JSON.parse(token.serialized) as { input: InvocationInput; sessionId?: string };
    this.currentInvocation = data.input;
    this.paused = false;
    this.injected = [];
    // Text only: the session holds its pictures upstream, and a person's
    // answer to a pause carries none.
    yield* this.run(data.input, [{ type: 'text', text: response.text }], data.sessionId, undefined, signal);
  }

  /** Shared invoke/resume driver. `sessionId` set → resume that session (no
   *  system prompt re-sent); undefined → create a fresh session. */
  private async *run(
    input: InvocationInput,
    firstTurn: PromptPart[],
    resumeSessionId: string | undefined,
    systemPrompt: string | undefined,
    signal: AbortSignal,
  ): AsyncIterable<InvocationEvent> {
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

    let httpMcp: ToolGatewayHttpMcp | null = null;
    let opencode: { client: OpencodeClient; server: OpencodeServerHandle } | null = null;
    try {
      httpMcp = await exposeCatalogOverHttp(this.catalog!, bridgeContext);
      // Configure the transport's provider with its API key AND explicitly
      // register the requested model. opencode validates the model against a
      // static bundled catalog (a models.dev snapshot) that lags the vendors,
      // so a new slug like `z-ai/glm-4.6` fails with
      // "Model not found: openrouter/z-ai/glm-4.6" even with the key set.
      // Registering it under provider.<id>.models bypasses the catalog check;
      // the transport passes the id straight to the host, which resolves any
      // valid model. An API key in the environment alone is also not reliably
      // picked up by the spawned server, so pass it inline.
      const transport = await resolveTransport(input);
      // Bind explicitly: loopback, ephemeral port.
      //
      // The server exited 1 before any turn ran, with `ServeError` — a BIND
      // failure, not the hang it looked like from outside. The container already
      // serves its own port and leaving the SDK to choose put the two in each
      // other's way. Loopback also means this server, which executes tool calls,
      // is not reachable from outside the container.
      //
      // It starts UNSECURED, and deliberately. The server reads
      // OPENCODE_SERVER_PASSWORD and warns when it is unset, but the client is
      // built with `{ baseUrl }` and nothing else — so setting the password
      // locks the SDK's own client out, and `session.create` comes back 401
      // with no session id. Loopback on an ephemeral port inside the container
      // is the boundary here; the password is not available to be one until
      // the SDK gives its client a credential.
      opencode = await startOpencode({
        hostname: '127.0.0.1',
        port: 0,
        env: transport.env,
        // The opencode server (a Bun process) can take longer than the SDK's 5s
        // default to become ready on a cold Cloud Run container — a too-tight
        // timeout fails the whole engine ("Timeout waiting for server to start")
        // before the server is even up. Give it a generous, env-overridable
        // window. (The opencode-ai CLI version is pinned in the Dockerfile so the
        // startup cost is reproducible; this is the safety margin on top.)
        timeout: Number(process.env.OPENCODE_SERVER_START_TIMEOUT_MS) || 30_000,
        // The prompt request is open for the whole turn, so the transport must
        // outlive the turn's own ceiling — with a margin, so the TURN bound is
        // what ends a long turn and reports why, rather than the socket giving
        // up first and reporting `fetch failed`.
        requestTimeoutMs: turnDeadlineMs() + 60_000,
        config: {
          ...(transport.apiKey
            ? {
                provider: {
                  [transport.providerId]: {
                    options: {
                      apiKey: transport.apiKey,
                      ...(transport.baseURL ? { baseURL: transport.baseURL } : {}),
                    },
                    // The registry files a model under its FAMILY
                    // (`input.provider`); `transport.providerId` is the
                    // transport opencode reaches it through. They were the same
                    // string while the gateway families all resolved to
                    // 'openrouter', and stopped being the same the day a family
                    // became its own provider — so looking the window up by
                    // transport silently missed and the session lost its
                    // compaction limit.
                    models: { [transport.modelId]: opencodeModelEntry(input.provider, transport.modelId) },
                  },
                },
              }
            : {}),
          mcp: {
            [LIFTOFF_MCP_SERVER_NAME]: {
              type: 'remote',
              url: httpMcp.url,
              headers: { Authorization: `Bearer ${httpMcp.bearerToken}` },
              // opencode passes this to EVERY `tools/call` on the server (and
              // bounds connect and tools/list with it). Unset, the MCP SDK's
              // 60s default applied and our server sends no progress, so any
              // tool past a minute (code_session above all) failed as -32001
              // while the bridge was still serving it. See
              // liftoffMcpServerTimeoutMs.
              timeout: liftoffMcpServerTimeoutMs(),
            },
          },
          // The run's turn budget (the tenant's maxToolCalls, role-clamped by
          // the engine), as the primary agent's step cap: "the maximum number
          // of agentic iterations before forcing a text-only response", after
          // which opencode itself asks the model for a summary of its work and
          // what remains. A prompt that names no agent runs under `build`, the
          // default primary agent, so the cap goes on it. `maxSteps` is the
          // name the pinned SDK types; `steps` is its newer spelling, set
          // beside it so a server on either side of the rename reads one.
          ...(typeof input.maxTurns === 'number' && input.maxTurns > 0
            ? { agent: { build: { maxSteps: input.maxTurns, steps: input.maxTurns } } }
            : {}),
          // opencode's OWN built-in tools, denied.
          //
          // Every tool this agent is allowed reaches it through the `liftoff`
          // MCP server above, where dispatchFunctionCall applies the HITL gate,
          // the oversight policy, untrusted framing, OU metering and the
          // single-result bound. opencode's built-ins bypass all of it — they
          // never touch that proxy, which is precisely why the server raises a
          // permission prompt for them instead.
          //
          // They are also unconfined: this server is a child of the runtime,
          // cwd /app, running as root with the runtime's service account. `bash`
          // is an ungoverned shell there, and `read` alone reaches /proc and the
          // application source without needing one.
          //
          // Denying them puts this engine on the same footing as the Anthropic
          // one, whose outer agent gets `allowedTools: [...ANTHROPIC_NATIVE_WEB_TOOLS]`
          // and nothing else, with code work going through the `code_session`
          // tool. `permission` and `tools` are belt and braces: `tools` removes
          // them from the model's menu, `permission` refuses them if a future
          // version reintroduces one under another name.
          permission: {
            ...Object.fromEntries(Object.keys(OPENCODE_BUILTIN_TOOLS_DENIED).map((t) => [t, 'deny'])),
            external_directory: 'deny',
          },
          tools: OPENCODE_BUILTIN_TOOLS_DENIED,
        },
      });
      const client = opencode.client;
      await this.warnOnUndeniedBuiltins(client, input.invocationId);

      const sessionId = resumeSessionId ?? (await this.createSession(client));
      yield { type: 'session_started', sessionId };

      let nextParts = firstTurn;
      while (true) {
        if (signal.aborted) { yield { type: 'completion', outcome: 'error', reason: 'aborted' }; return; }

        const result = yield* this.runTurn(client, opencode.server, sessionId, nextParts, systemPrompt, transport, input, bridgeContext, internalAbort, signal);
        systemPrompt = undefined; // only the first turn carries the system prompt
        if (result === 'paused' || result === 'aborted') return;

        if (this.paused) {
          const token = this.pauseToken('ask_user', sessionId);
          yield { type: 'pause_requested', reason: 'ask_user', token };
          return;
        }
        const drained = this.injected.splice(0, this.injected.length);
        if (drained.length === 0) { yield { type: 'completion', outcome: 'success' }; return; }
        nextParts = [{ type: 'text', text: drained.map((m) => m.text).join('\n') }];
      }
    } catch (e) {
      if (signal.aborted) { yield { type: 'completion', outcome: 'error', reason: 'aborted' }; return; }
      logger.warn({ err: (e as Error).message, invocationId: input.invocationId }, 'opencode invoke failed');
      yield { type: 'completion', outcome: 'error', reason: (e as Error).message, failure: extractProviderFailure(e) };
    } finally {
      signal.removeEventListener('abort', onOuterAbort);
      try { opencode?.server.close(); } catch { /* noop */ }
      const mcp = httpMcp;
      if (mcp) await settleShutdownStep('local MCP server close', () => mcp.close(), input);
      await getMcpClientPool().releaseAll(input.invocationId).catch(() => undefined);
    }
  }

  private async createSession(client: OpencodeClient): Promise<string> {
    const res = await client.session.create({ body: {} });
    const id = (res.data as { id?: string } | undefined)?.id;
    if (!id) {
      // Carry the server's own reason. Reported as a bare "returned no id" it
      // reads as an empty success, and the 401 that actually caused it — the
      // client cannot authenticate to a secured server — costs a round trip to
      // find.
      const err = (res as { error?: unknown }).error;
      const detail = err ? `: ${typeof err === 'string' ? err : JSON.stringify(err)}` : '';
      throw new Error(`opencode session.create returned no id${detail}`);
    }
    return id;
  }

  /** Fire one prompt turn and consume the global event stream (filtered to this
   *  session) until session.idle. Returns 'paused'/'aborted' or undefined. */
  private async *runTurn(
    client: OpencodeClient,
    /** The server behind `client`, so a failed request can say whether the
     *  process is still there. See the prompt-failure branch below. */
    server: OpencodeServerHandle,
    sessionId: string,
    parts: PromptPart[],
    systemPrompt: string | undefined,
    transport: OpencodeTransport,
    input: InvocationInput,
    bridgeContext: BridgeContext,
    internalAbort: AbortController,
    signal: AbortSignal,
  ): AsyncGenerator<InvocationEvent, 'paused' | 'aborted' | undefined, undefined> {
    const events = await client.event.subscribe();

    // The SYNCHRONOUS prompt endpoint, and that is the point.
    //
    // `promptAsync` is documented to answer 204 immediately: it reports that the
    // message was accepted and nothing about the turn. So this promise settled
    // at once, the rejection capture below could only ever see a transport
    // error, and termination rested entirely on an event arriving. When the
    // event stream went quiet the turn had no other way to end and burned its
    // whole deadline — with the server answering REST the whole time and calling
    // the session busy.
    //
    // `POST /session/{id}/message` blocks until the turn finishes and returns
    // the assistant message, so its resolution IS the terminal signal, owed to
    // nothing on the wire. The stream stays what it is good at: incremental
    // parts. session.idle and an idle session.status remain as earlier exits.
    let promptError: Error | null = null;
    let promptSettled = false;
    const promptDone = client.session
      .prompt({
        path: { id: sessionId },
        body: {
          model: { providerID: transport.providerId, modelID: transport.modelId },
          ...(systemPrompt ? { system: systemPrompt } : {}),
          parts,
        },
      })
      .then(
        (res) => {
          const err = (res as { error?: unknown }).error;
          if (err) promptError = new Error(`opencode prompt failed: ${JSON.stringify(err)}`);
        },
        (err: unknown) => { promptError = err as Error; },
      )
      .finally(() => { promptSettled = true; });

    // TWO BOUNDS, BECAUSE "HUNG" AND "SLOW" ARE DIFFERENT THINGS.
    //
    // There was one: a flat three minutes of wall clock, whatever the turn was
    // doing. A sweep reading eight pages died at 183 seconds with
    // `message.part.delta` as its last event — the model was mid-sentence, and
    // the run was recorded `error` for taking too long to say something it was
    // in the middle of saying. Locally this engine has no turn ceiling at all;
    // this one is ours, and it was the shortest number in the stack.
    //
    // It was also incoherent with the calls it contains. We tell opencode a
    // single `tools/call` may take `liftoffMcpServerTimeoutMs()` — 690s with
    // the defaults — inside a turn we destroyed at 180. One call was allowed
    // to outlive its own turn by a factor of four.
    //
    // So: IDLE is the hang detector, and it is the one that fires in practice.
    // Nothing arriving for this long means nothing is coming. The ABSOLUTE
    // ceiling stays, because a turn must not run forever, and is now derived
    // from the longest call it can legally contain rather than set beside it.
    const idleMs = turnIdleTimeoutMs();
    const deadlineMs = turnDeadlineMs();
    const deadline = Date.now() + deadlineMs;
    // Kept so a timeout can say what it was waiting for. See the warn below.
    let eventsSeen = 0;
    let lastEventType: string | undefined;
    let lastEventAt: number | undefined;
    let unreachable = 0;
    let quietStateLogged = false;
    /** Set when the blocking prompt returns. The turn is over at that moment;
     *  this short window only lets parts already in flight finish arriving so a
     *  streamed answer keeps its tail. */
    let graceDeadline: number | undefined;
    const turn = newTurnState();
    const it = events.stream[Symbol.asyncIterator]();
    try {
      while (true) {
        if (signal.aborted) { yield { type: 'completion', outcome: 'error', reason: 'aborted' }; return 'aborted'; }
        // The bridge ended the turn: recovery declined another attempt at a
        // call (mcp-bridge fireRecovery sets the reason and aborts the
        // internal controller). This loop read only the OUTER signal, so a
        // bridge abort changed nothing here: the session ran on with its tool
        // parts stranded `running` until the deadline — three minutes per
        // interrupted step, reported as "opencode stopped after N events",
        // and the bridge's own reason never reached the completion. Same
        // branch the openai-wire engine has, checked before the poll so it
        // is seen within one tick even on a quiet stream.
        if (internalAbort.signal.aborted) {
          await client.session.abort({ path: { id: sessionId } }).catch(() => undefined);
          const reason = bridgeContext.recoveryAbortReason ?? 'aborted';
          bridgeContext.recoveryAbortReason = null;
          yield { type: 'completion', outcome: 'error', reason };
          return 'aborted';
        }
        if (promptError) {
          await client.session.abort({ path: { id: sessionId } }).catch(() => undefined);
          // SAY WHETHER THE SERVER IS STILL THERE.
          //
          // `fetch failed` is Node's word for a broken socket and says nothing
          // about why. A run failed that way at 302 s with the engine perfectly
          // healthy — it was the request's own timeout — and telling that apart
          // from a crashed process took reading undici's source. The process's
          // own exit code and last words are what separate the two, so they go
          // on the completion rather than being left to an investigation.
          const engine = server.diagnostics();
          if (engine && !engine.alive) {
            logger.warn({
              invocationId: input.invocationId,
              exitCode: engine.exitCode,
              signal: engine.signal,
              recentOutput: engine.recentOutput,
            }, 'opencode prompt failed and the server is gone');
          }
          yield {
            type: 'completion',
            outcome: 'error',
            reason: engine && !engine.alive
              ? `opencode prompt failed: ${(promptError as Error).message}`
                + ` (server exited code=${engine.exitCode} signal=${engine.signal})`
              : `opencode prompt failed: ${(promptError as Error).message}`,
            failure: extractProviderFailure(promptError),
          };
          return 'aborted';
        }
        // The turn is complete the moment the blocking prompt returns.
        if (promptSettled && graceDeadline === undefined) {
          graceDeadline = Date.now() + PROMPT_DRAIN_GRACE_MS;
        }
        if (graceDeadline !== undefined && Date.now() >= graceDeadline) {
          for (const out of this.closeOpenText(turn)) yield out;
          return undefined;
        }

        const remaining = Math.min(
          deadline - Date.now(),
          graceDeadline !== undefined ? graceDeadline - Date.now() : Number.MAX_SAFE_INTEGER,
        );
        // Idle first: a stream that has stopped producing is the failure this
        // is for. A stream still producing gets to finish.
        const idleFor = lastEventAt === undefined ? 0 : Date.now() - lastEventAt;
        const idleExpired = lastEventAt !== undefined && idleFor >= idleMs;
        if (deadline - Date.now() <= 0 || idleExpired) {
          await client.session.abort({ path: { id: sessionId } }).catch(() => undefined);
          // Say what it was waiting for, not just that it waited.
          //
          // "no terminal event" is true of every timeout and distinguishes
          // none of them: a stream that produced nothing at all, one that
          // produced work and never closed, and one blocked on a permission
          // prompt look identical in the log. The benchmark recorded opencode
          // failing to finish a three-turn conversation twice and there was
          // nothing to read afterwards saying which of those it was.
          logger.warn(
            {
              invocationId: input.invocationId,
              sessionId,
              deadlineMs,
              idleMs,
              bound: idleExpired ? 'idle' : 'absolute',
              eventsSeen,
              lastEventType: lastEventType ?? '(none — the stream produced nothing)',
              msSinceLastEvent: lastEventAt ? Date.now() - lastEventAt : null,
            },
            'opencode turn timed out',
          );
          yield {
            type: 'completion',
            outcome: 'error',
            reason: eventsSeen === 0
              ? `opencode produced no events in ${deadlineMs}ms`
              : idleExpired
                ? `opencode went quiet for ${idleFor}ms after ${eventsSeen} event(s), last was ${lastEventType}`
                : `opencode stopped after ${eventsSeen} event(s), last was ${lastEventType}`,
          };
          return 'aborted';
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const poll = new Promise<{ __poll: true }>((resolve) => {
          timer = setTimeout(() => resolve({ __poll: true }), Math.min(remaining, 5_000));
        });
        const res = await Promise.race([it.next(), poll]);
        if (timer) clearTimeout(timer);
        if ('__poll' in res) {
          // Stream quiet. Before waiting out the rest of the deadline, ASK the
          // server whether it is still working.
          //
          // The event stream is the primary signal and this is the backstop for
          // it dying. Two live turns ended with it dead: 161 events then a text
          // part, 130 events then a heartbeat, and in both cases nothing further
          // arrived for ~170 of the 180 second budget. No `session.idle`, no
          // `session.status`, no error — the connection simply stopped
          // producing, which is indistinguishable from a thinking model unless
          // something asks over a different channel.
          if (eventsSeen > 0) {
            const state = await this.sessionState(client, sessionId);
            if (state.kind === 'idle') return undefined;
            // The server itself is gone. Distinguished from "busy" because the
            // two need opposite responses: a busy session deserves the rest of
            // its deadline, an unreachable server will never produce another
            // event and waiting for it burns the full budget on a process that
            // has already left. Confirmed over consecutive probes so a single
            // dropped request does not end a live turn.
            if (state.kind === 'unreachable') {
              unreachable += 1;
              if (unreachable >= UNREACHABLE_PROBES_BEFORE_FAILING) {
                logger.warn(
                  { invocationId: input.invocationId, sessionId, eventsSeen, lastEventType, detail: state.detail },
                  'opencode server unreachable',
                );
                yield {
                  type: 'completion',
                  outcome: 'error',
                  reason: `opencode server stopped responding after ${eventsSeen} event(s) `
                    + `(last ${lastEventType}); ${state.detail}`,
                };
                return 'aborted';
              }
            } else {
              unreachable = 0;
            }
            if (!quietStateLogged) {
              quietStateLogged = true;
              // Logged ONCE per turn, on the first quiet tick.
              //
              // The state alone answered the first question — the server is
              // alive and calls the session BUSY, so it is neither gone nor
              // finished — and raised the next one it cannot answer: busy doing
              // WHAT. The message shape says: a tool part still `running` means
              // it is waiting on a tool, which for this adapter means the MCP
              // proxy it was pointed at.
              //
              // SHAPE ONLY — part types, tool names, statuses. No text, no
              // arguments, no results: this is a diagnostic about control flow,
              // and it must not become a second copy of the conversation in the
              // logs.
              logger.info(
                {
                  invocationId: input.invocationId,
                  sessionId,
                  eventsSeen,
                  lastEventType,
                  state: state.kind,
                  detail: state.detail,
                  lastParts: await this.sessionShape(client, sessionId),
                },
                'opencode stream quiet',
              );
            }
          }
          continue;
        }
        if (res.done) {
          for (const out of this.closeOpenText(turn)) yield out;
          break;
        }

        const e = res.value as { type: string; properties?: Record<string, unknown> };
        eventsSeen += 1;
        lastEventType = e.type;
        lastEventAt = Date.now();
        if (this.eventSessionId(e) !== sessionId) continue;
        this.noteMessageRole(e, turn);
        if (this.recorder && !isPromptPart(e, turn)) {
          this.recorder.recordRaw({
            invocationId: input.invocationId, provider: input.provider, model: input.model,
            rawKind: 'opencode_part', raw: e,
          });
        }

        for (const out of this.translateEvent(e, turn)) yield out;

        // opencode's own permission prompt — REFUSED, and refused loudly.
        //
        // This used to auto-approve, on the reasoning that "the Liftoff gate
        // already ran in the httpMcp proxy". That reasoning was backwards. The
        // proxy carries the Liftoff catalog, where dispatchFunctionCall applies
        // the gate; opencode raises a prompt only for its OWN built-ins, which
        // by definition never went through the proxy. So the gate had not run,
        // and approving here waved through an ungoverned shell running as root
        // in this container with the runtime's service account.
        //
        // Denying is the fail-closed default the config above already expresses.
        // Reaching this branch at all means a built-in escaped both the `tools`
        // map and the `permission` categories, which is worth a WARN rather than
        // a silent refusal: it is the signal that an opencode release added a
        // capability this adapter has not classified.
        if (e.type === 'permission.updated') {
          const p = e.properties as
            { id?: string; type?: string; title?: string } | undefined;
          if (p?.id) {
            logger.warn(
              {
                invocationId: input.invocationId,
                permissionType: p.type,
                permissionTitle: p.title,
              },
              'opencode_builtin_tool_denied: a built-in tool asked for permission and was refused; '
              + 'every governed capability reaches this agent through the liftoff MCP server',
            );
            await client
              .postSessionIdPermissionsPermissionId({ path: { id: sessionId, permissionID: p.id }, body: { response: 'reject' } })
              .catch(() => undefined);
          }
        }

        // Liftoff HITL / delegation — set in-process by the httpMcp proxy's dispatchFunctionCall.
        if (bridgeContext.pendingDelegationPause) {
          const token = this.pauseToken('delegation', sessionId);
          const delegationContext = bridgeContext.pendingDelegationPause;
          bridgeContext.pendingDelegationPause = null;
          internalAbort.abort();
          await client.session.abort({ path: { id: sessionId } }).catch(() => undefined);
          yield { type: 'pause_requested', reason: 'delegation', token, delegationContext };
          return 'paused';
        }
        if (bridgeContext.pendingWakePause) {
          const wakeToken = this.pauseToken('self_wake', sessionId);
          const wakeContext = bridgeContext.pendingWakePause;
          bridgeContext.pendingWakePause = null;
          internalAbort.abort();
          await client.session.abort({ path: { id: sessionId } }).catch(() => undefined);
          yield { type: 'pause_requested', reason: 'self_wake', token: wakeToken, wakeContext };
          return 'paused';
        }
        if (bridgeContext.pendingHitlGate) {
          const token = this.pauseToken('hitl_gate', sessionId);
          const gateContext = bridgeContext.pendingHitlGate;
          bridgeContext.pendingHitlGate = null;
          internalAbort.abort();
          await client.session.abort({ path: { id: sessionId } }).catch(() => undefined);
          yield { type: 'pause_requested', reason: 'hitl_gate', token, gateContext };
          return 'paused';
        }

        if (e.type === 'session.error') {
          yield { type: 'completion', outcome: 'error', reason: JSON.stringify(e.properties ?? {}) };
          return 'aborted';
        }
        // Turn complete. BOTH spellings, because the SDK declares both and
        // either genuinely means the turn is over: `session.idle`, and
        // `session.status` carrying `{type:'idle'}` (its other members are
        // `busy` and `retry`, so idle is the only terminal one).
        //
        // Waiting on `session.idle` alone hung every turn. A live run streamed
        // 161 events, ended on `message.part.updated`, then sat silent for 174
        // of its 180 second budget — the turn had finished at about five
        // seconds and nothing here recognised it. A terminal signal read from
        // one of two declared spellings is a stall that looks exactly like a
        // slow model.
        if (e.type === 'session.idle') {
          for (const out of this.closeOpenText(turn)) yield out;
          return undefined;
        }
        if (e.type === 'session.status') {
          const status = (e.properties as { status?: { type?: string } } | undefined)?.status;
          if (status?.type === 'idle') {
            for (const out of this.closeOpenText(turn)) yield out;
            return undefined;
          }
        }
      }
    } finally {
      // BOUNDED. With the async endpoint this settled instantly and awaiting it
      // was free. The blocking one returns when the turn ends — so on an aborted
      // or genuinely hung turn it may never return, and cleanup must not inherit
      // the hang it exists to clean up after.
      await Promise.race([
        promptDone,
        new Promise<void>((resolve) => { setTimeout(resolve, PROMPT_SETTLE_GRACE_MS).unref?.(); }),
      ]).catch(() => undefined);
      await settleShutdownStep('event stream close', () => it.return?.(undefined), input);
    }
    return undefined;
  }

  /** The prompt is a message too, and its parts stream through the same
   *  event as the model's. The message announces its role first; a message
   *  the server calls the user's is remembered so its parts are skipped. */
  private noteMessageRole(e: { type: string; properties?: Record<string, unknown> }, turn: OpencodeTurnState): void {
    if (e.type !== 'message.updated') return;
    const info = (e.properties as { info?: { id?: string; role?: string } } | undefined)?.info;
    if (info?.role === 'user' && typeof info.id === 'string') turn.userMessages.add(info.id);
  }

  /**
   * opencode's part events are SNAPSHOTS, so the translation keeps state.
   *
   * A text part arrives on every update carrying the whole text so far (with
   * the increment beside it as `delta` where the server sends one), and a tool
   * part arrives once per state — pending, running, completed — under the same
   * call id. Read naively, that is the text repeated on every update, two
   * `tool_call_started` for every call (the pending one with empty arguments),
   * and no message boundary at all: nothing said "that message ended", so the
   * run's reply was never recorded as a message, only streamed as tokens.
   */
  private translateEvent(
    e: { type: string; properties?: Record<string, unknown> },
    turn: OpencodeTurnState = newTurnState(),
  ): InvocationEvent[] {
    if (e.type === 'message.updated') {
      this.noteMessageRole(e, turn);
      return [];
    }
    if (e.type !== 'message.part.updated') return [];
    if (isPromptPart(e, turn)) return [];
    const props = e.properties as { part?: Record<string, unknown>; delta?: unknown } | undefined;
    const part = props?.part;
    if (!part) return [];
    const ptype = part.type as string;
    if (ptype === 'text' && typeof part.text === 'string') {
      const partId = (part.id as string) ?? '';
      const seen = turn.text.get(partId) ?? '';
      const full = part.text;
      // The increment: the server's own `delta` where it sends one, else the
      // suffix beyond what this part already carried; a rewrite that is not a
      // continuation is re-sent whole.
      const delta = typeof props?.delta === 'string'
        ? props.delta
        : full.startsWith(seen) ? full.slice(seen.length) : full;
      turn.text.set(partId, full);
      const out: InvocationEvent[] = delta ? [{ type: 'assistant_delta', text: delta }] : [];
      const ended = (part.time as { end?: number } | undefined)?.end !== undefined;
      if (ended && full && !turn.closed.has(partId)) {
        turn.closed.add(partId);
        out.push({ type: 'assistant_message', content: [{ type: 'text', text: full }] });
      }
      return out;
    }
    if (ptype === 'tool') {
      const state = part.state as { status?: string; input?: unknown; output?: unknown; error?: string } | undefined;
      const callId = (part.callID as string) ?? (part.id as string) ?? '';
      const toolName = catalogToolName((part.tool as string) ?? '');
      const started = (): InvocationEvent => {
        turn.started.add(callId);
        return { type: 'tool_call_started', toolName, args: (state?.input ?? {}) as Record<string, unknown>, callId };
      };
      // Once per call, on the first state that carries the arguments: the
      // pending state has none, and a started event with `{}` for arguments
      // is a call nobody made.
      if (state?.status === 'running') {
        return turn.started.has(callId) ? [] : [started()];
      }
      if (state?.status === 'completed' || state?.status === 'error') {
        // The proxy's stamp arrives on the completed state's `metadata`,
        // flat: opencode's session wrapper spreads the result's top-level
        // `metadata` there (and drops `_meta`). See remembered-stamp.ts.
        const meta = (state as { metadata?: unknown }).metadata;
        const finished: InvocationEvent = { type: 'tool_call_finished', callId, result: state?.output, error: state?.error, ...rememberedEventFields(meta) };
        return turn.started.has(callId) ? [finished] : [started(), finished];
      }
    }
    if (ptype === 'step-finish') {
      const tokens = part.tokens as
        { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } } | undefined;
      // What the gateway charged for this step. `cost` is a REQUIRED field on
      // opencode's step-finish part, and for a gateway-served model it is the
      // only figure that can be right: one model is served by many endpoints at
      // different prices and no price list says which one took the request.
      const reportedCost = typeof part.cost === 'number' && Number.isFinite(part.cost) && part.cost > 0
        ? part.cost
        : undefined;
      if (tokens || reportedCost !== undefined) {
        // opencode reports `input` EXCLUSIVE of `cache.read` (Anthropic's
        // convention), while every non-Anthropic row on both planes is priced
        // under OpenAI's — `prompt_tokens` inclusive of the cached portion,
        // fresh = input − cached (`freshInputTokensFor`). Reported as-is, a
        // cached turn's fresh tokens priced to zero: input 61 with 24,832
        // cached read as no fresh input at all. Normalised here, at the one
        // seam that knows which convention the number arrived in.
        const cached = tokens?.cache?.read ?? 0;
        // REASONING TOKENS ARE COMPLETION TOKENS, and opencode reports them in
        // their own field. Every vendor bills them at the completion rate and
        // folds them into its own completion count; opencode splits the two, so
        // reading `output` alone charges for the visible answer and nothing for
        // the thinking that produced it. On a reasoning model that is nearly the
        // whole call: a one-word reply on qwen3.7-plus billed 6,015 completion
        // tokens against the 3 `output` carried, so the run was priced at 58% of
        // what the gateway charged.
        const completion = (tokens?.output ?? 0) + (tokens?.reasoning ?? 0);
        // `inputTokens` is already input + cached here (the normalisation
        // above), so the context is that same figure. Stated explicitly rather
        // than left to the guard's fallback: the fallback reads `inputTokens`,
        // which happens to be right for this adapter, and a silent agreement
        // is not a contract.
        const inclusive = (tokens?.input ?? 0) + cached;
        return [{
          type: 'usage',
          usage: {
            inputTokens: inclusive,
            outputTokens: completion,
            cachedTokens: cached,
            contextTokens: inclusive,
            // Billed where the model charges for one; opencode reports it and
            // this is the count the rate table prices.
            cacheWriteTokens: tokens?.cache?.write ?? 0,
            // Undefined unless the gateway reported a charge, never zero — a
            // zero booked as a charge is an unbilled call. Where it IS present
            // it supersedes every count above, which is what makes a
            // gateway-served model billable at all.
            vendorCostUsd: reportedCost,
          },
        }];
      }
    }
    return [];
  }

  /** The message boundaries the turn's end implies: every text part still
   *  open when the session goes idle is a message that ended with the turn. */
  private closeOpenText(turn: OpencodeTurnState): InvocationEvent[] {
    const out: InvocationEvent[] = [];
    for (const [partId, text] of turn.text) {
      if (turn.closed.has(partId) || !text) continue;
      turn.closed.add(partId);
      out.push({ type: 'assistant_message', content: [{ type: 'text', text }] });
    }
    return out;
  }

  /** Report any built-in this version serves that the deny list does not name.
   *
   *  The list above is maintained by hand against published docs, which is how
   *  it fell behind. Asking the server closes the loop without depending on it:
   *  an experimental endpoint is not something to gate a turn on, but it is
   *  exactly right for saying "this build serves a tool nobody decided about"
   *  while the decision is still cheap. Warn only — a drift detector that could
   *  stop a run would be a worse bargain than the drift. */
  private async warnOnUndeniedBuiltins(client: OpencodeClient, invocationId: string): Promise<void> {
    try {
      const res = await client.tool.ids({});
      const ids = res.data as string[] | undefined;
      if (!Array.isArray(ids)) return;
      // MCP tools carry their server's name; only the server's OWN tools are
      // the deny list's business.
      const undenied = ids.filter(
        (id) => !id.includes('liftoff') && !(id in OPENCODE_BUILTIN_TOOLS_DENIED),
      );
      if (undenied.length > 0) {
        logger.warn(
          { invocationId, undenied },
          'opencode serves built-in tools this runtime has not denied',
        );
      }
    } catch {
      // Experimental endpoint. Its absence says nothing about the turn.
    }
  }

  /** The SHAPE of the last message in a session: part types, tool names and
   *  tool statuses, never content.
   *
   *  Read when the stream has gone quiet while the server still calls the
   *  session busy — the one state the event stream cannot explain. A tool part
   *  left `running` says the turn is blocked on a tool rather than thinking. */
  private async sessionShape(client: OpencodeClient, sessionId: string): Promise<string[]> {
    try {
      const res = await client.session.messages({ path: { id: sessionId }, query: { limit: 2 } });
      const messages = res.data as Array<{ parts?: Array<Record<string, unknown>> }> | undefined;
      const parts = messages?.flatMap((m) => m.parts ?? []) ?? [];
      return parts.slice(-12).map((part) => {
        const type = String(part.type ?? '?');
        if (type !== 'tool') return type;
        const state = part.state as { status?: string } | undefined;
        return `tool:${String(part.tool ?? '?')}:${state?.status ?? '?'}`;
      });
    } catch (e) {
      return [`unreadable: ${(e as Error).message}`];
    }
  }

  /** What the server says about this session when its event stream has gone
   *  quiet: finished, still working, or not answering at all.
   *
   *  Three states rather than a boolean, because "not answering" and "still
   *  working" call for opposite responses and a boolean collapses them into
   *  the same wait. An absent entry counts as busy, not idle: this cannot tell
   *  "the server dropped it" from "the server never listed it", and ending a
   *  live turn is worse than waiting for the deadline that already bounds it. */
  private async sessionState(
    client: OpencodeClient,
    sessionId: string,
  ): Promise<{ kind: 'idle' | 'busy' | 'unreachable'; detail?: string }> {
    try {
      const res = await client.session.status({});
      const statuses = res.data as Record<string, { type?: string }> | undefined;
      if (statuses?.[sessionId]?.type === 'idle') return { kind: 'idle' };
      const err = (res as { error?: unknown }).error;
      if (!statuses && err) return { kind: 'unreachable', detail: `status: ${JSON.stringify(err)}` };
      return { kind: 'busy', detail: statuses?.[sessionId]?.type ?? 'not listed' };
    } catch (e) {
      return { kind: 'unreachable', detail: (e as Error).message };
    }
  }

  private eventSessionId(e: { type: string; properties?: Record<string, unknown> }): string | undefined {
    const p = e.properties;
    if (!p) return undefined;
    if (typeof p.sessionID === 'string') return p.sessionID;
    const part = p.part as { sessionID?: string } | undefined;
    if (part && typeof part.sessionID === 'string') return part.sessionID;
    const info = p.info as { sessionID?: string } | undefined;
    if (info && typeof info.sessionID === 'string') return info.sessionID;
    return undefined;
  }


  private pauseToken(reason: PauseReason, sessionId: string): ResumeToken {
    this.paused = true;
    return { adapterKind: 'opencode', serialized: JSON.stringify({ reason, input: this.currentInvocation, sessionId }) };
  }

  async injectMessage(message: UserMessage): Promise<void> {
    this.injected.push(message);
  }

  async pause(reason: PauseReason): Promise<ResumeToken> {
    return this.pauseToken(reason, this.currentInvocation?.resumeSessionId ?? '');
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
