// Gemini CLI VendorSdkAdapter for provider 'google'.
//
// Google's own agent runtime — the coding agent behind `gemini` — driven
// headless: one `gemini --output-format stream-json` process per turn, the
// turn's prompt on its stdin (a pipe rather than `-p`, because an argument is
// capped at 128KB on Linux and a replayed transcript is not), the JSONL it
// prints on stdout translated into InvocationEvents. It owns the
// loop, holds the session's history in its own session file and compacts it,
// so — like Codex and opencode — no Liftoff-side context handling ("B") is
// needed. Its SDK form (`@google/gemini-cli-sdk`, in the CLI's own repository)
// is not published; when it is, this engine moves onto it the way Codex sits
// on `@openai/codex-sdk`, and this file keeps only the event translation.
//
// The CLI cannot use an in-process MCP transport; it reaches Liftoff's governed
// tool seam as a REMOTE (streamable HTTP) MCP server served on localhost by
// exposeCatalogOverHttp, which routes every tool call through
// dispatchFunctionCall → the registered hitlGate + framing + OU-metering +
// single-result bound. The proxy and this adapter share one BridgeContext, so a
// HITL-gated call sets bridgeContext.pendingHitlGate, which this adapter
// observes to stop the process and emit pause_requested; resume re-enters with
// `--resume <session id>`.
//
// EVERYTHING THE CLI READS IS WRITTEN PER RUN, under a home directory of its
// own (`GEMINI_CLI_HOME`): `settings.json` names the proxy as the one MCP
// server, trusted so its tools need no confirmation, and restricts the CLI's
// built-ins to `google_web_search` alone (`tools.core` is an allowlist, and a
// built-in it does not name is never registered); a `system.md` carries the
// platform's system prompt, which `GEMINI_SYSTEM_MD` substitutes for the CLI's
// own coding-agent prompt — a real system slot, which Codex lacks. Nothing in
// the process's inherited environment reaches the child: it gets the
// allow-list (child-process-env.ts) plus the Vertex variables, and
// authenticates through the container's own service account, the same way the
// Gen AI SDK engine does.
//
// WEB SEARCH IS GOOGLE'S OWN, AND COUNTED. `google_web_search` is the one
// built-in left on: one grounded generateContent call per invocation, which is
// Google Search grounding — the same product the Gen AI SDK engine bills per
// query — so each `tool_use` naming it is counted onto the turn's usage as
// `webSearchRequests` and `computeGroundingCost('google')` bills it.
//
// IMAGES ARE CARRIED, NOT DESCRIBED. The CLI's `@path` prompt syntax attaches
// a file, and an image file is attached as an inline image part (the CLI's
// read-many-files path, when the file is named explicitly). Every picture in
// the conversation is written under the run's working directory and referenced
// from the first turn — the one that carries the replayed transcript, which
// names each by its attachment number (conversation-preamble.ts). Video has no
// such path and stays described in the text.
//
// BYO PROVIDER KEYS: honoured, through `input.byok`, and what changed is not the
// funding. Google BYOK stays scoped to the llmClient path — an agent TURN routed
// to Gemini still runs on Liftoff's own Vertex project, exactly as on the Gen AI
// SDK and ADK engines — and the credential this adapter now reads is a MANAGED
// gateway session: Liftoff's own capacity, reached through Liftoff's own gateway.
//
// It is wired because THIS ENGINE CANNOT COUNT ITS OWN TOKENS. The CLI's `stats`
// expose `total`, `input` and `output` and never `thoughts` or `tool`, and the
// residual between them cannot be split between the input and output rates from
// here. The gateway reads `usageMetadata.thoughtsTokenCount` off the vendor's own
// response.
//
// The pair handed to the CLI is `GOOGLE_GEMINI_BASE_URL` + `GEMINI_API_KEY`, the
// same pair the coding runner maps a Google credential to, IN PLACE OF the Vertex
// ADC variables. In place of, not beside: the CLI picks one authentication path,
// and leaving `GOOGLE_GENAI_USE_VERTEXAI` set beside a base URL is how it would
// authenticate against the container's service account while the ledger recorded
// the run as having gone through the gateway.
//
// WHICH OF GOOGLE'S TWO APIS THIS SPEAKS, because the pair decides it and the
// answer is not the obvious one. `GOOGLE_GEMINI_BASE_URL` is read ONLY when the
// SDK is not in Vertex mode (`getBaseUrl` branches on `vertexai`), so this pair
// puts the CLI on the GEMINI DEVELOPER API: `v1beta/models/{model}:{method}`,
// with the credential in `x-goog-api-key`. Vertex's grammar names a project and a
// location and is reached with `GOOGLE_VERTEX_BASE_URL` instead.
//
// This pair is nonetheless the right one, for a reason that is a property of the
// CLI rather than a preference: it offers no way to add a header to a model
// request — custom headers are an MCP-server setting — so a bearer the gateway
// would recognise cannot be sent, while `x-goog-api-key` is a slot the gateway
// already reads. The Vertex variables would instead have the CLI authenticate on
// the container's own identity, which is the one thing that must not happen.
//
// So the GATEWAY absorbs the difference: its google door accepts both grammars and
// translates the Gemini-API one onto Vertex against whichever account is serving
// the request (`byok-gateway/google-path.ts`). The coding runner hands a Google
// credential the same pair, so the door had to learn this either way.
//
// RATES: unchanged only while the gateway's endpoint matches this one. Its
// managed Google substitution resolves the location as
// `GCP_LOCATION ?? VERTEX_LOCATION ?? DEFAULT_VERTEX_LOCATION`; with neither set
// on the control plane that is `global`, which is what `vertexEnv()` below
// defaults to and what this repo's Gemini rate table is written against. Setting
// either variable there moves a turn to a non-global endpoint Google prices about
// 10% higher while this repo keeps pricing it at global. The two repos' tables
// differ on that endpoint DELIBERATELY, which is why it must not move by
// accident.

import { spawn, type ChildProcess } from 'child_process';
import { createInterface } from 'readline';
import { mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
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
import { exposeCatalogOverHttp, type ToolGatewayHttpMcp } from '../tool-gateway-http-mcp';
import { getMcpClientPool } from '../mcp-client-pool';
import { attachedImages, firstTurnPrompt, type MediaContent } from '../conversation-preamble';
import { GEMINI_CLI_TOOL_PREFIX, LIFTOFF_MCP_SERVER_NAME, geminiCliCatalogToolName } from '../mcp-tool-names';
import { logger } from '../../../infrastructure/logging';
import { extractProviderFailure } from '../provider-failure';

/** The CLI binary. Installed globally in the image (Dockerfile: `npm i -g
 *  @google/gemini-cli@<pin>`), so it is found on PATH; the override exists for
 *  a checkout that keeps it elsewhere. */
export const GEMINI_CLI_BINARY = (): string => process.env.GEMINI_CLI_PATH || 'gemini';


/** The CLI's own search tool — the one built-in left on. */
export const GEMINI_CLI_WEB_SEARCH_TOOL = 'google_web_search';

/**
 * The CLI's built-in tools, every one of them but the search switched off.
 *
 * `tools.core` is an ALLOWLIST: a built-in it does not name is never
 * registered, so the list of what is on is one entry long. `tools.exclude`
 * says the same thing from the other side, so a future CLI that changes how
 * one of the two is read still lands on the same answer.
 *
 * Every capability this agent legitimately needs arrives through the governed
 * `liftoff` MCP server, so there is nothing to lose by removing all of them —
 * and everything to lose by leaving one: `run_shell_command` is an ungoverned
 * shell in this container, and `read_file` alone reaches /proc and the
 * application source. Kept against the CLI's own ALL_BUILTIN_TOOL_NAMES at
 * the pinned version; a name no longer served costs nothing to exclude.
 */
export const GEMINI_CLI_BUILTINS_EXCLUDED: readonly string[] = [
  'glob',
  'write_todos',
  'write_file',
  'web_fetch',
  'replace',
  'run_shell_command',
  'grep_search',
  'grep_search_ripgrep',
  'read_many_files',
  'read_file',
  'list_directory',
  'activate_skill',
  'ask_user',
  'tracker_create_task',
  'tracker_update_task',
  'tracker_get_task',
  'tracker_list_tasks',
  'tracker_add_dependency',
  'tracker_visualize',
  'get_internal_docs',
  'enter_plan_mode',
  'exit_plan_mode',
  'update_topic',
  'complete_task',
  'invoke_agent',
  'read_mcp_resource',
  'list_mcp_resources',
  'list_background_processes',
  'read_background_output',
];

/** One JSONL event as the CLI prints it (`--output-format stream-json`). The
 *  shapes are the CLI's `JsonStreamEvent` union at the pinned version. */
export interface GeminiCliStreamEvent {
  type: 'init' | 'message' | 'tool_use' | 'tool_result' | 'error' | 'result';
  timestamp?: string;
  // init
  session_id?: string;
  model?: string;
  // message
  role?: 'user' | 'assistant';
  content?: string;
  delta?: boolean;
  // tool_use
  tool_name?: string;
  tool_id?: string;
  parameters?: Record<string, unknown>;
  // tool_result
  status?: 'success' | 'error';
  output?: string;
  // error / result
  severity?: 'warning' | 'error';
  message?: string;
  error?: { type: string; message: string };
  stats?: {
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    cached?: number;
    input?: number;
    duration_ms?: number;
    tool_calls?: number;
    models?: Record<string, { input_tokens?: number; output_tokens?: number; cached?: number }>;
  };
}

/** The catalog's name for a tool the CLI reported — with the server prefix
 *  removed. The stream seams resolve names against the catalog the run
 *  started with, and `mcp_liftoff_send_message` matches nothing there. A name
 *  the CLI truncated to fit its 63-character limit (`…`) is left as reported:
 *  the proxy still received the catalog's own name, so dispatch is unaffected,
 *  and only this event carries the CLI's spelling. */
const catalogToolName = geminiCliCatalogToolName;

/** Where a run's files live: the CLI's home (settings, session files) and its
 *  working directory (attachments) in one place, under the system temp dir.
 *
 *  Per INVOCATION. The settings name THIS run's proxy and bearer token, and a
 *  later turn of the run is a new process that reads them again — so two runs
 *  of one agent sharing a home would have the second's settings answering the
 *  first's next turn, and its tool calls dispatching through the other run's
 *  gate. A pause and its resume are the same invocation, so the session file a
 *  `--resume` needs is under the same home; the session file is keyed by the
 *  working directory's path, which is why home and cwd are one place. Within
 *  one instance that holds; across instances it does not, which is the same
 *  limit Codex's thread files have, and the hybrid loop's cold-start path
 *  (invoke() with the rebuilt history) is what carries a run across it. */
function runHome(input: InvocationInput): string {
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '');
  return join(tmpdir(), 'gemini-cli', safe(input.tenantId), safe(input.invocationId));
}

/** Write the CLI's settings for this run: the governed proxy as the one MCP
 *  server, trusted; the built-ins restricted to search; and the auth type that
 *  MATCHES the credential the environment carries.
 *
 *  `security.auth.selectedType` is what actually decides which of Google's two
 *  APIs the CLI speaks — `AuthType.USE_GEMINI` ('gemini-api-key') reads
 *  `GEMINI_API_KEY` and `GOOGLE_GEMINI_BASE_URL` and addresses
 *  `v1beta/models/{model}:{method}`, which is the grammar the gateway's google
 *  door translates onto Vertex; `vertex-ai` reads neither and authenticates on the
 *  container's own identity. The environment cannot override this choice, so a
 *  gateway session that left it at `vertex-ai` failed every run. */
async function writeSettings(
  home: string,
  httpMcp: { url: string; bearerToken: string },
  /** The auth type this run's credential requires, decided once by
   *  `googleAuth` — never re-derived here, or the settings and the environment
   *  become two answers to one question. */
  selectedType: GeminiAuthType,
  /** The run's turn budget (the tenant's maxToolCalls, role-clamped by the
   *  engine). The CLI's own cap is `model.maxSessionTurns` (settings.json,
   *  "the maximum number of user/model/tool turns in a session", -1 for
   *  unlimited, the default); in a non-interactive run the CLI exits with an
   *  error when it is reached. It is the one turn cap the CLI exposes, so the
   *  budget is forwarded to it; undefined leaves the CLI's default. */
  maxTurns?: number,
): Promise<void> {
  const dir = join(home, '.gemini');
  await mkdir(dir, { recursive: true });
  const settings = {
    security: { auth: { selectedType } },
    general: { checkForUpdates: false },
    ...(typeof maxTurns === 'number' && maxTurns > 0 ? { model: { maxSessionTurns: maxTurns } } : {}),
    mcpServers: {
      [LIFTOFF_MCP_SERVER_NAME]: {
        httpUrl: httpMcp.url,
        headers: { Authorization: `Bearer ${httpMcp.bearerToken}` },
        // Trusted: the CLI's own approval prompt is a second question in front
        // of a call our gate has already judged, and in a headless run its
        // answer is DENY. Every call through this server dispatches through
        // the governed proxy.
        trust: true,
        timeout: Number(process.env.GEMINI_CLI_MCP_TIMEOUT_MS) || 600_000,
      },
    },
    tools: {
      core: [GEMINI_CLI_WEB_SEARCH_TOOL],
      // The core allowlist is enforced by a policy rule that DENIES every tool
      // it does not name, and that rule outranks the one a trusted MCP server
      // earns (v0.52.0: core allowlist enforcement sits above "MCP Trusted" in
      // the policy order). In a headless run a denied tool is not merely
      // refused — it is withheld from the model's declarations — so without
      // this the model ran with google_web_search alone and never saw the
      // governed catalog. `tools.allowed` sits above the core enforcement, so
      // the trusted server's tools are admitted by name pattern.
      allowed: [`${GEMINI_CLI_TOOL_PREFIX}*`],
      exclude: [...GEMINI_CLI_BUILTINS_EXCLUDED],
    },
  };
  await writeFile(join(dir, 'settings.json'), JSON.stringify(settings, null, 2));
}

/** The system prompt, as the file `GEMINI_SYSTEM_MD` points the CLI at. */
async function writeSystemPrompt(home: string, systemPrompt: string): Promise<string> {
  const path = join(home, 'system.md');
  await writeFile(path, systemPrompt);
  return path;
}

/** The file extension the CLI reads a picture's type from, from the MIME
 *  subtype: `image/png` → `.png`. */
function imageExtension(mimeType: string): string {
  return mimeType.slice('image/'.length).replace(/[^a-z0-9]/gi, '') || 'img';
}

/** Write the conversation's images under the run's working directory, named
 *  in attachment order, and return the `@path` references the first turn
 *  carries. Relative to the working directory: the CLI's `@` processor keeps
 *  a file inside the workspace and refuses one outside it. */
async function writeImagesForTurn(
  images: readonly MediaContent[],
  home: string,
  turnId: string,
): Promise<{ dir: string; references: string[] } | null> {
  if (images.length === 0) return null;
  const rel = join('attachments', turnId);
  const dir = join(home, rel);
  await mkdir(dir, { recursive: true });
  const references: string[] = [];
  for (const [i, image] of images.entries()) {
    const name = `attachment-${i + 1}.${imageExtension(image.mimeType)}`;
    await writeFile(join(dir, name), Buffer.from(image.dataBase64, 'base64'));
    references.push(`@${join(rel, name)}`);
  }
  return { dir, references };
}

/** The Vertex environment the CLI authenticates and routes with. Derived the
 *  way the Gen AI SDK engine derives its client: the repo-standard names the
 *  deploy sets, then genai's own, then the default region. */
function vertexEnv(): Record<string, string | undefined> {
  const project = process.env.GCP_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT;
  const location =
    process.env.GCP_LOCATION ?? process.env.VERTEX_LOCATION ?? process.env.GOOGLE_CLOUD_LOCATION ?? 'global';
  return {
    GOOGLE_GENAI_USE_VERTEXAI: 'true',
    GOOGLE_CLOUD_PROJECT: project,
    GOOGLE_CLOUD_LOCATION: location,
  };
}

/** The CLI's two selectable auth types, as `gemini-cli-core@0.52.0` declares them
 *  (`AuthType.USE_GEMINI` / `AuthType.USE_VERTEX_AI`). `AuthType.GATEWAY` also
 *  exists and is NOT usable: the CLI's own `validateAuthMethod` has no branch for
 *  it and answers "Invalid auth method selected." */
type GeminiAuthType = 'gemini-api-key' | 'vertex-ai';

/**
 * How this run authenticates: BOTH halves, from ONE decision.
 *
 * The auth type and the credential are configured in two different files —
 * `settings.json` and the child's environment — and the environment cannot
 * override the settings. That is not a detail: a gateway session handed the
 * Gemini-API variables while the settings still said `vertex-ai` left the CLI in
 * Vertex mode, reading neither variable (they are read ONLY outside Vertex mode),
 * and it exited 41 before its first request, on every run.
 *
 * So the two are returned together from one condition rather than each deriving
 * its own. Two places deciding one thing is exactly what shipped broken here, and
 * a matched pair cannot be half-applied by a later edit that only remembers one
 * side.
 *
 *   gateway  `gemini-api-key` + GOOGLE_GEMINI_BASE_URL + GEMINI_API_KEY — the
 *            Gemini Developer API's grammar, which the gateway's google door
 *            translates onto Vertex.
 *   direct   `vertex-ai` + the Vertex ADC variables — the container's own
 *            identity, which is what every Gemini engine here has always used and
 *            is still the answer when no session could be opened.
 *
 * EXCLUSIVE, never both. Setting the Gemini-API pair beside
 * `GOOGLE_GENAI_USE_VERTEXAI` leaves the CLI to choose, and the one it chooses is
 * not necessarily the one the gateway is recording — a run whose tokens the ledger
 * believes were counted and were not.
 *
 * REACHING THE GATEWAY ON VERTEX'S GRAMMAR INSTEAD DOES NOT WORK, and fails more
 * quietly: the door translates the Gemini-API grammar onto Vertex and deliberately
 * leaves a Vertex path alone, so a Vertex-shaped request passes through carrying
 * whatever project and location the CLI put in it — empty, without
 * `GOOGLE_CLOUD_PROJECT` — and Vertex answers 400 "Invalid resource field value".
 *
 * The rates are the same on both, which is why this can be switched per run
 * without a pricing consequence: the gateway's managed Google substitution is ADC
 * against Liftoff's own Vertex at `DEFAULT_VERTEX_LOCATION` = `global`, and
 * `vertexEnv()` above defaults to `global`. The runtime REFUSES a managed Gemini
 * session on any other endpoint rather than mispricing it (see `byok/session.ts`),
 * so a control plane that moved its location would cost this engine its capture
 * and say so, not bill the wrong rate silently.
 */
function googleAuth(input: InvocationInput): {
  selectedType: GeminiAuthType;
  env: Record<string, string | undefined>;
} {
  const byok = input.byok?.vendor === 'google' ? input.byok : undefined;
  if (!byok) return { selectedType: 'vertex-ai', env: vertexEnv() };
  return {
    selectedType: 'gemini-api-key',
    env: {
      GOOGLE_GEMINI_BASE_URL: byok.baseUrl.replace(/\/+$/, ''),
      GEMINI_API_KEY: byok.token,
    },
  };
}

export class GeminiCliAdapter implements VendorSdkAdapter {
  readonly kind = 'gemini-cli';
  /** Session-based: the CLI's session file holds the history upstream and we
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
    yield* this.run(input, { fresh: true }, signal);
  }

  async *resume(token: ResumeToken, response: UserResponse, signal: AbortSignal): AsyncIterable<InvocationEvent> {
    if (!this.catalog) throw new Error('Tool catalog not registered');
    const data = JSON.parse(token.serialized) as { input: InvocationInput; sessionId?: string };
    this.currentInvocation = data.input;
    this.paused = false;
    this.injected = [];
    // Text only: the session holds its pictures upstream, and a person's
    // answer to a pause carries none.
    yield* this.run(data.input, { fresh: false, sessionId: data.sessionId, text: response.text }, signal);
  }

  /** Shared invoke/resume driver. A fresh run mints its session id, carries
   *  the system prompt and attaches the conversation's pictures; a resumed one
   *  continues the session by id with the person's text. */
  private async *run(
    input: InvocationInput,
    turn: { fresh: boolean; sessionId?: string; text?: string },
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
    let images: { dir: string; references: string[] } | null = null;
    const home = runHome(input);
    try {
      httpMcp = await exposeCatalogOverHttp(this.catalog!, bridgeContext);
      await mkdir(home, { recursive: true });
      // Both halves of the auth decision come from `googleAuth` — the settings
      // file here, the child's environment in `runTurn`. A pure function of the
      // same input cannot answer differently at the two sites, which is the
      // property the previous shape lacked.
      await writeSettings(home, httpMcp, googleAuth(input).selectedType, input.maxTurns);
      const systemMd = await writeSystemPrompt(home, input.systemPrompt);

      // A fresh run names its own session, so the id is known before the
      // process that will confirm it starts; a resumed one continues the
      // session that paused, or starts over when there is none to continue.
      const sessionId = turn.fresh ? randomUUID() : (turn.sessionId || randomUUID());
      const resuming = !turn.fresh && !!turn.sessionId;

      let nextText: string;
      if (turn.fresh) {
        images = await writeImagesForTurn(attachedImages(input.messages), home, sessionId);
        nextText = firstTurnPrompt(input.messages, { carriesImages: true });
        if (images) nextText = `${nextText}\n\nAttached images: ${images.references.join(' ')}`;
      } else {
        nextText = turn.text ?? '';
      }

      let first = true;
      while (true) {
        if (signal.aborted) { yield { type: 'completion', outcome: 'error', reason: 'aborted' }; return; }
        const result = yield* this.runTurn(
          { home, systemMd, sessionId, resume: resuming || !first, text: nextText },
          input, bridgeContext, internalAbort, signal,
        );
        first = false;
        if (result === 'paused' || result === 'aborted') return;

        if (this.paused) {
          const token = this.pauseToken('ask_user', sessionId);
          yield { type: 'pause_requested', reason: 'ask_user', token };
          return;
        }
        const drained = this.injected.splice(0, this.injected.length);
        if (drained.length === 0) { yield { type: 'completion', outcome: 'success' }; return; }
        nextText = drained.map((m) => m.text).join('\n');
      }
    } catch (e) {
      if (signal.aborted) { yield { type: 'completion', outcome: 'error', reason: 'aborted' }; return; }
      logger.warn({ err: (e as Error).message, invocationId: input.invocationId }, 'gemini-cli invoke failed');
      yield { type: 'completion', outcome: 'error', reason: (e as Error).message, failure: extractProviderFailure(e) };
    } finally {
      signal.removeEventListener('abort', onOuterAbort);
      if (images) await rm(images.dir, { recursive: true, force: true }).catch(() => undefined);
      await httpMcp?.close().catch(() => undefined);
      await getMcpClientPool().releaseAll(input.invocationId).catch(() => undefined);
    }
  }

  /** Run ONE CLI process — one turn — and translate its JSONL into events.
   *  Returns 'paused' when a HITL/delegation pause was emitted, 'aborted' on
   *  outer abort or a failed turn, undefined when the turn completed. */
  private async *runTurn(
    turn: { home: string; systemMd: string; sessionId: string; resume: boolean; text: string },
    input: InvocationInput,
    bridgeContext: BridgeContext,
    internalAbort: AbortController,
    signal: AbortSignal,
  ): AsyncGenerator<InvocationEvent, 'paused' | 'aborted' | undefined, undefined> {
    const args = [
      '--output-format', 'stream-json',
      '-m', input.model,
      // The workspace is a directory of our own; nothing in it is untrusted.
      '--skip-trust',
      // No auto-approval. The one built-in left on is read-only and allowed by
      // the CLI's own default policy; the proxy's tools are allowed because
      // the server is trusted; and in a headless run anything else the policy
      // would have ASKED about is denied rather than waited on.
      '--approval-mode', 'default',
      ...(turn.resume ? ['--resume', turn.sessionId] : ['--session-id', turn.sessionId]),
    ];
    const child: ChildProcess = spawn(GEMINI_CLI_BINARY(), args, {
      cwd: turn.home,
      // Allow-listed, not inherited: this child runs the agent's tools. See
      // child-process-env.ts.
      //
      // How it authenticates is EITHER the gateway or Vertex ADC, never both. A
      // session on the run means a base URL plus a per-run token; no session
      // means the container's own service account, which is what every Gemini
      // engine here has always used and is still the answer when the control
      // plane cannot be reached. Merging the two would leave
      // `GOOGLE_GENAI_USE_VERTEXAI` set beside a base URL, and the CLI would
      // authenticate on the service account while the gateway's row claimed the
      // request — tokens counted against a call that never passed through it.
      env: childProcessEnv({
        ...googleAuth(input).env,
        GEMINI_CLI_HOME: turn.home,
        GEMINI_SYSTEM_MD: turn.systemMd,
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // The prompt, on stdin. The CLI reads a non-TTY stdin as the input when
    // no `-p` is given, and runs `@path` references in it the same way.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(turn.text);

    // A turn on this engine is the CLI's whole loop — every tool call the model
    // makes before it answers — and it begins by discovering the governed
    // catalog over MCP, so it is longer than one model call.
    const deadlineMs = Number(process.env.GEMINI_CLI_TURN_TIMEOUT_MS) || 300_000;
    let timedOut = false;
    const killer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, deadlineMs);
    const onAbort = () => child.kill('SIGTERM');
    internalAbort.signal.addEventListener('abort', onAbort, { once: true });

    const stderrTail: string[] = [];
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail.push(chunk.toString('utf8'));
      while (stderrTail.join('').length > 4_000 && stderrTail.length > 1) stderrTail.shift();
    });

    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on('close', (code, sig) => resolve({ code, signal: sig }));
      child.on('error', () => resolve({ code: null, signal: null }));
    });

    let sawResult = false;
    let webSearchRequests = 0;
    // What the turn produced, for the account a failure owes: the CLI says
    // what went wrong on stderr (an MCP server it could not reach, a tool it
    // refused), and a turn that ends without a result or past its deadline is
    // otherwise indistinguishable from a slow model.
    let eventsSeen = 0;
    const toolsCalled: string[] = [];
    const warnings: string[] = [];
    const account = (): Record<string, unknown> => ({
      invocationId: input.invocationId,
      sessionId: turn.sessionId,
      resume: turn.resume,
      eventsSeen,
      toolsCalled: toolsCalled.slice(0, 40),
      cliWarnings: warnings.slice(0, 10),
      stderrTail: stderrTail.join('').trim().slice(-1_500),
    });
    // The CLI streams the assistant's text as `delta: true` chunks and never
    // says where a message ends (v0.52.0: every assistant `message` event is a
    // delta). The boundary is implied: a tool call, or the turn's result,
    // closes whatever the model had said. Without closing it the run's reply
    // is streamed as tokens and recorded as nothing.
    let pendingText = '';
    const closeMessage = (): InvocationEvent[] => {
      if (!pendingText) return [];
      const text = pendingText;
      pendingText = '';
      return [{ type: 'assistant_message', content: [{ type: 'text', text }] }];
    };
    try {
      const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
      for await (const line of lines) {
        if (signal.aborted) { yield { type: 'completion', outcome: 'error', reason: 'aborted' }; return 'aborted'; }
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        let event: GeminiCliStreamEvent;
        try { event = JSON.parse(trimmed) as GeminiCliStreamEvent; } catch { continue; }

        eventsSeen += 1;
        if (this.recorder) {
          this.recorder.recordRaw({
            invocationId: input.invocationId, provider: input.provider, model: input.model,
            rawKind: 'gemini_cli_event', raw: event,
          });
        }

        switch (event.type) {
          case 'init':
            // The CLI confirms the id we minted (or the one we resumed).
            yield { type: 'session_started', sessionId: event.session_id ?? turn.sessionId };
            break;
          case 'message':
            if (event.role === 'assistant' && typeof event.content === 'string' && event.content) {
              pendingText += event.content;
              yield { type: 'assistant_delta', text: event.content };
            }
            break;
          case 'tool_use': {
            for (const closed of closeMessage()) yield closed;
            const name = event.tool_name ?? '';
            toolsCalled.push(name);
            if (name === GEMINI_CLI_WEB_SEARCH_TOOL) webSearchRequests += 1;
            yield {
              type: 'tool_call_started',
              toolName: name === GEMINI_CLI_WEB_SEARCH_TOOL ? 'web_search' : catalogToolName(name),
              args: (event.parameters ?? {}) as Record<string, unknown>,
              callId: event.tool_id ?? '',
            };
            break;
          }
          case 'tool_result':
            yield {
              type: 'tool_call_finished',
              callId: event.tool_id ?? '',
              result: event.output,
              ...(event.error ? { error: event.error.message } : {}),
            };
            break;
          case 'error':
            // Non-fatal on the CLI's side — a loop cut short, a blocked step.
            // A warning is the CLI's own business; an error is surfaced.
            if (event.message) warnings.push(`${event.severity ?? 'warning'}: ${event.message}`);
            if (event.severity === 'error') {
              yield { type: 'anomaly_detected', kind: 'unknown', context: { error: event.message } };
            }
            break;
          case 'result': {
            sawResult = true;
            for (const closed of closeMessage()) yield closed;
            const stats = event.stats;
            if (stats) {
              yield {
                type: 'usage',
                usage: {
                  inputTokens: stats.input_tokens ?? 0,
                  outputTokens: stats.output_tokens ?? 0,
                  cachedTokens: stats.cached ?? 0,
                  // Google's prompt count is the total, cached content
                  // included, so the context is that figure unchanged.
                  contextTokens: stats.input_tokens ?? 0,
                  // Google Search grounding, billed per query and so carried
                  // beside the tokens rather than derived from them.
                  webSearchRequests: webSearchRequests || undefined,
                  raw: { toolCalls: stats.tool_calls, durationMs: stats.duration_ms, models: stats.models },
                },
              };
            }
            if (event.status === 'error') {
              const reason = event.error?.message ?? 'gemini-cli turn failed';
              logger.warn({ ...account(), reason }, 'gemini-cli turn failed');
              yield { type: 'anomaly_detected', kind: 'unexpected_stop', context: { error: reason } };
              yield {
                type: 'completion',
                outcome: 'error',
                reason,
                failure: extractProviderFailure(event.error ? { ...event.error, message: reason } : new Error(reason)),
              };
              return 'aborted';
            }
            break;
          }
        }

        // Liftoff HITL / delegation — set in-process by the httpMcp proxy's
        // dispatchFunctionCall. Checked after every event, so the pause lands
        // on the tool_result that carried it.
        if (bridgeContext.pendingDelegationPause) {
          const token = this.pauseToken('delegation', turn.sessionId);
          const delegationContext = bridgeContext.pendingDelegationPause;
          bridgeContext.pendingDelegationPause = null;
          internalAbort.abort();
          yield { type: 'pause_requested', reason: 'delegation', token, delegationContext };
          return 'paused';
        }
        if (bridgeContext.pendingWakePause) {
          const wakeToken = this.pauseToken('self_wake', turn.sessionId);
          const wakeContext = bridgeContext.pendingWakePause;
          bridgeContext.pendingWakePause = null;
          internalAbort.abort();
          yield { type: 'pause_requested', reason: 'self_wake', token: wakeToken, wakeContext };
          return 'paused';
        }
        if (bridgeContext.pendingHitlGate) {
          const token = this.pauseToken('hitl_gate', turn.sessionId);
          const gateContext = bridgeContext.pendingHitlGate;
          bridgeContext.pendingHitlGate = null;
          internalAbort.abort();
          yield { type: 'pause_requested', reason: 'hitl_gate', token, gateContext };
          return 'paused';
        }
      }

      const { code, signal: exitSignal } = await exit;
      if (signal.aborted) { yield { type: 'completion', outcome: 'error', reason: 'aborted' }; return 'aborted'; }
      if (timedOut) {
        logger.warn({ ...account(), deadlineMs }, 'gemini-cli turn exceeded its deadline');
        yield { type: 'completion', outcome: 'error', reason: `gemini-cli turn exceeded ${deadlineMs}ms` };
        return 'aborted';
      }
      if (!sawResult) {
        // The process ended without saying how. Its stderr is the only
        // account there is, so it rides the reason.
        const detail = stderrTail.join('').trim().slice(-1_500);
        const reason = `gemini-cli exited (code ${code ?? 'null'}${exitSignal ? `, signal ${exitSignal}` : ''}) `
          + `without a result event${detail ? `: ${detail}` : ''}`;
        logger.warn({ ...account(), code, exitSignal }, 'gemini-cli exited without a result');
        yield { type: 'completion', outcome: 'error', reason, failure: extractProviderFailure(new Error(reason)) };
        return 'aborted';
      }
      if (warnings.length > 0) {
        // The turn completed, and the CLI complained on the way — an MCP
        // server it could not reach is the one that matters: the model then
        // ran with none of the governed tools and said nothing about it.
        logger.warn(account(), 'gemini-cli turn completed with warnings from the CLI');
      }
      return undefined;
    } finally {
      clearTimeout(killer);
      internalAbort.signal.removeEventListener('abort', onAbort);
      if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
    }
  }

  private pauseToken(reason: PauseReason, sessionId: string): ResumeToken {
    this.paused = true;
    return { adapterKind: 'gemini-cli', serialized: JSON.stringify({ reason, input: this.currentInvocation, sessionId }) };
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
