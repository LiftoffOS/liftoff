// Execution Environments Types
// Separate type hierarchy from ConnectorType — execution environments are NOT connectors.
// They provision ephemeral compute instead of calling external APIs.

import type { JsonSchemaProperty, ToolErrorCode } from '@liftoffos/connector-types';

// ─── Executor surface (tool-gateway boundary) ───────────────────────────────

export interface SandboxSession {
  tenantId: string;
  agentId: string;
  invocationId: string;
  sessionId: string;
  /** Frontend SSE thread the runtime should broadcast sandbox events to. */
  threadId?: string;
  /** Compiled-instructions version of the agent. Baked into the per-sandbox
   *  container so the sidecar's callback JWTs carry the right identity (without
   *  it the provider falls back to the sandbox-executor's process.env, which is
   *  shared across all of a tenant's agents → placeholder identity). */
  instructionVersion?: number;
  /** Image this session's sandbox needs, when the default will not do.
   *
   *  A sandbox is cached per `sessionId`, so the template is a property of the
   *  session and not of the call: the first call provisions and every later one
   *  reuses it. `code_session` therefore runs under its OWN sessionId rather
   *  than the agent's, which is also what gives it the fresh, empty workspace
   *  the tool promises and a lifecycle it can end. */
  template?: ExecutionEnvironmentType;
}

export interface SandboxToolCallInput {
  toolName: string;
  input: Record<string, unknown>;
  /**
   * Caller-supplied unique id. Retries with the same id collapse to a
   * single row in sandbox_usage_log and audit_logs via the partial unique
   * indexes. Omit when retry-safety isn't needed; the executor falls back
   * to a fresh uuid per call.
   */
  id?: string;
}

export interface SandboxToolCallResult {
  success: boolean;
  data: Record<string, unknown>;
  error?: string;
  /** Structured contract for a failure the model can act on. Present when the
   *  executor knows something more useful than "it broke" — chiefly a workspace
   *  that is still starting, which is worth waiting for rather than abandoning. */
  errorCode?: ToolErrorCode;
  retryable?: boolean;
  retryAfterMs?: number;
  /** Something the agent must know that is not a failure. Currently only: the
   *  workspace it is writing into is not the one it had before. Delivered on
   *  the first call after a reset, because that is the moment it matters and
   *  the last moment the agent can still act on it. */
  notice?: string;
}

/**
 * Surface tool-gateway consumes via setSandboxExecutor. Both the in-process
 * SandboxExecutor class and the HTTP SandboxExecutorClient implement it.
 */
export interface SandboxExecutorInterface {
  execute(session: SandboxSession, call: SandboxToolCallInput): Promise<SandboxToolCallResult>;
}

// ─── Environment Templates ──────────────────────────────────────────────────

export type ExecutionEnvironmentType =
  | 'general-shell'
  | 'code-development'
  | 'data-analysis'
  | 'sandbox-sidecar'
  | 'aio-sandbox'
  /** The aio-sandbox image plus the pinned vendor coding CLIs. Used ONLY by
   *  `code_session`, which needs `claude`/`codex`/`gemini` on PATH; every other
   *  sandbox stays on the smaller image so it does not pay their size or their
   *  cold start. Selects the image repository — see CloudRunSandboxProvider. */
  | 'aio-sandbox-coding';

// ─── Sandbox Provider Interface ─────────────────────────────────────────────

export interface ExecOpts {
  workDir?: string;
  timeout?: number;
  env?: Record<string, string>;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SandboxConfig {
  template: ExecutionEnvironmentType;
  resourceLimits: ResourceLimits;
  credentials: InjectedCredential[];
  initCommands?: string[][];         // Each command is an args array, NOT a shell string
  timeoutMs: number;
  costCeilingCredits: number;
  /** Per-sandbox identity baked into the container env (TENANT_ID/AGENT_ID/
   *  INSTRUCTION_VERSION) so the sidecar's callback JWTs carry the real agent's
   *  identity. Populated from the session at create time. When absent, the
   *  provider falls back to process.env (shared → placeholder). */
  tenantId?: string;
  agentId?: string;
  instructionVersion?: number;
}

export type SandboxCapability = 'shell' | 'file' | 'browser' | 'vscode';

export interface SandboxConfigV2 extends SandboxConfig {
  capabilities: SandboxCapability[];
  jwtSecret: string;
  enableVnc: boolean;
}

export interface ResourceLimits {
  cpuMillis: number;
  memoryMb: number;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface InjectedCredential {
  connectorId: string;
  credentialType: 'github_pat' | 'api_key';
  scope: 'read' | 'write';
}

export interface SandboxInstance {
  sandboxId: string;
  status: SandboxStatus;
  workDir: string;
  createdAt: Date;
  lastHeartbeatAt: Date;
  /** This session had a workspace before and it is gone; this one is empty.
   *  Set only on the provision that follows a reap, and cleared once the agent
   *  has been told. */
  workspaceReset?: boolean;
}

export type SandboxStatus =
  | 'creating'
  | 'ready'
  | 'running'
  | 'destroying'
  | 'destroyed'
  | 'error';

// ─── Sandbox Provider ───────────────────────────────────────────────────────

/** Summary record returned by listSandboxServices — provider-agnostic so the
 *  orphan-sweep logic in SandboxExecutor does not need to know about Cloud Run. */
export interface SandboxServiceRecord {
  sandboxId: string;
  /** Seconds since the underlying service was created. Used by the orphan sweep
   *  to skip in-flight creates (the DB row may legitimately not exist yet). */
  ageSeconds: number;
}

export interface SandboxProvider {
  /** `sandboxId` is minted by the caller so the provisioning claim can be
   *  recorded before the (minute-long) create starts. Providers generate their
   *  own when it is omitted, which keeps in-process test stubs working. */
  create(config: SandboxConfig, sandboxId?: string): Promise<SandboxInstance>;
  exec(sandboxId: string, args: string[], opts?: ExecOpts): Promise<ExecResult>;
  readFile(sandboxId: string, path: string): Promise<string>;
  writeFile(sandboxId: string, path: string, content: string): Promise<void>;
  destroy(sandboxId: string): Promise<void>;
  /** List every sandbox-named service the provider currently manages. Used by
   *  the executor's orphan sweep to find Cloud Run services that leaked when
   *  provider.create() threw before sandbox_state had a row inserted. Optional
   *  on the interface so providers without a real backing service (in-process
   *  test stubs) need not implement it. */
  listSandboxServices?(): Promise<SandboxServiceRecord[]>;
}

export interface ShellSessionHandle { sessionId: string }
export interface ShellSessionView { content: string; cursor: number }
export interface PtyCreateOpts { command?: string[]; cwd?: string; cols?: number; rows?: number }

export interface BrowserPageHandle { tabId: string }
export interface BrowserActionResult { success: boolean; data?: Record<string, unknown> }

export interface FileWatcherHandle { watcherId: string }
export interface FileWatchEvent { type: 'add' | 'change' | 'unlink'; path: string; ts: number }

export interface SandboxProviderV2 extends SandboxProvider {
  // Shell PTY sessions
  shellSessionCreate(sandboxId: string, opts: PtyCreateOpts): Promise<ShellSessionHandle>;
  shellSessionWrite(sandboxId: string, sessionId: string, data: string): Promise<void>;
  shellSessionView(sandboxId: string, sessionId: string, offset?: number): Promise<ShellSessionView>;
  shellSessionWait(sandboxId: string, sessionId: string, timeoutMs: number): Promise<{ exitCode: number | null }>;
  shellSessionKill(sandboxId: string, sessionId: string): Promise<void>;
  shellSessionResize(sandboxId: string, sessionId: string, cols: number, rows: number): Promise<void>;
  shellSessionList(sandboxId: string): Promise<{ sessions: Array<{ sessionId: string; createdAt: string; status: 'active' | 'exited' }> }>;
  shellSessionStats(sandboxId: string, sessionId: string): Promise<Record<string, unknown>>;
  shellSessionCleanup(sandboxId: string, sessionId: string): Promise<void>;
  shellSessionCleanupAll(sandboxId: string): Promise<void>;

  // File richer ops
  fileStrReplaceEditor(sandboxId: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
  fileGrep(sandboxId: string, opts: { pattern: string; path?: string; glob?: string }): Promise<{ matches: Array<{ path: string; line: number; text: string }> }>;
  fileGlob(sandboxId: string, opts: { pattern: string; root?: string }): Promise<{ paths: string[] }>;
  fileFind(sandboxId: string, opts: { pattern: string; path?: string; type?: 'f' | 'd' }): Promise<{ paths: string[] }>;
  fileWatchCreate(sandboxId: string, paths: string[]): Promise<FileWatcherHandle>;
  fileWatchPoll(sandboxId: string, watcherId: string, sinceTs?: number): Promise<{ events: FileWatchEvent[] }>;
  fileWatchStop(sandboxId: string, watcherId: string): Promise<void>;

  // Bash sessions
  bashSessionCreate(sandboxId: string, opts: { cwd?: string; env?: Record<string, string> }): Promise<{ sessionId: string }>;
  bashSessionExec(sandboxId: string, sessionId: string, args: string[], timeoutMs?: number): Promise<{ stdout: string; stderr: string; exitCode: number; cwdAfter: string }>;
  bashSessionKill(sandboxId: string, sessionId: string): Promise<void>;
  bashSessionList(sandboxId: string): Promise<{ sessions: Array<{ id: string; cwd: string; createdAt: string }> }>;

  // Node.js sessions
  nodejsSessionCreate(sandboxId: string): Promise<{ sessionId: string }>;
  nodejsExecute(sandboxId: string, sessionId: string, code: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  nodejsSessionDelete(sandboxId: string, sessionId: string): Promise<void>;

  // Generic code
  codeExecute(sandboxId: string, opts: { language: 'python' | 'javascript' | 'bash'; code: string; session_id?: string; timeout_ms?: number }): Promise<Record<string, unknown>>;

  // util/convertToMarkdown
  utilConvertToMarkdown(sandboxId: string, opts: { path?: string; content?: string; mime?: string }): Promise<{ markdown: string }>;

  // Browser core verbs
  browserNavigate(sandboxId: string, tabId: string | undefined, url: string): Promise<BrowserActionResult & { tabId: string }>;
  browserClick(sandboxId: string, tabId: string, selector: string): Promise<BrowserActionResult>;
  browserFill(sandboxId: string, tabId: string, selector: string, value: string): Promise<BrowserActionResult>;
  browserType(sandboxId: string, tabId: string, selector: string, value: string): Promise<BrowserActionResult>;
  browserPressKey(sandboxId: string, tabId: string, key: string): Promise<BrowserActionResult>;
  browserHover(sandboxId: string, tabId: string, selector: string): Promise<BrowserActionResult>;
  browserSelectOption(sandboxId: string, tabId: string, selector: string, value: string): Promise<BrowserActionResult>;
  browserCheck(sandboxId: string, tabId: string, selector: string): Promise<BrowserActionResult>;
  browserUncheck(sandboxId: string, tabId: string, selector: string): Promise<BrowserActionResult>;
  browserScroll(sandboxId: string, tabId: string, dx: number, dy: number): Promise<BrowserActionResult>;
  browserWaitFor(sandboxId: string, tabId: string, selector: string, timeoutMs: number): Promise<BrowserActionResult>;
  browserScreenshot(sandboxId: string, tabId: string, selector?: string): Promise<{ pngBase64: string }>;
  browserEvaluate(sandboxId: string, tabId: string, script: string): Promise<{ result: unknown }>;
  browserExtractText(sandboxId: string, tabId: string, selector?: string): Promise<{ text: string }>;
  browserExtractMarkdown(sandboxId: string, tabId: string): Promise<{ markdown: string }>;
  browserExtractHtml(sandboxId: string, tabId: string): Promise<{ html: string }>;
  browserListTabs(sandboxId: string): Promise<{ tabs: Array<{ tabId: string; url: string; title: string }> }>;
  browserNewTab(sandboxId: string): Promise<BrowserPageHandle>;
  browserCloseTab(sandboxId: string, tabId: string): Promise<void>;

  // Browser additional page methods (14.F)
  browserBack(sandboxId: string, tabId: string): Promise<void>;
  browserForward(sandboxId: string, tabId: string): Promise<void>;
  browserReload(sandboxId: string, tabId: string, waitUntil?: 'load' | 'domcontentloaded' | 'networkidle'): Promise<void>;
  browserHotKey(sandboxId: string, tabId: string, keys: string): Promise<void>;
  browserUploadFile(sandboxId: string, tabId: string, selector: string, filePaths: string[]): Promise<void>;
  browserGetElements(sandboxId: string, tabId: string, selector: string): Promise<{ elements: Array<{ tag: string; text: string; attrs: Record<string, string> }> }>;
  browserGetConsole(sandboxId: string, tabId: string, since?: number): Promise<{ messages: Array<{ level: string; text: string; ts: number }> }>;
  browserExportConsole(sandboxId: string, tabId: string): Promise<{ path: string }>;
  browserFindText(sandboxId: string, tabId: string, text: string): Promise<{ found: boolean; selector?: string; bounding_box?: { x: number; y: number; width: number; height: number } }>;
  browserScrollTo(sandboxId: string, tabId: string, x: number, y: number): Promise<void>;
  browserScrollToElement(sandboxId: string, tabId: string, selector: string): Promise<void>;

  // Browser state (14.G)
  browserStateSave(sandboxId: string, tabId: string, stateId?: string): Promise<{ stateId: string; path: string }>;
  browserStateLoad(sandboxId: string, stateId: string): Promise<{ tabId: string }>;
  browserStateList(sandboxId: string): Promise<{ states: Array<{ stateId: string; createdAt: string; size: number }> }>;
  browserStateDelete(sandboxId: string, stateId: string): Promise<void>;

  // Browser network interception (14.H)
  browserRouteAdd(sandboxId: string, tabId: string, urlPattern: string, action: 'block' | 'fulfill' | 'continue', fulfill?: { status: number; body: string; headers: Record<string, string> }): Promise<{ routeId: string }>;
  browserRouteRemove(sandboxId: string, routeId: string): Promise<void>;
  browserRouteList(sandboxId: string): Promise<{ routes: Array<{ routeId: string; tabId: string; urlPattern: string; action: 'block' | 'fulfill' | 'continue' }> }>;
  browserHeadersSet(sandboxId: string, tabId: string, headers: Record<string, string>): Promise<void>;
  browserHeadersScoped(sandboxId: string, tabId: string, urlPattern: string, headers: Record<string, string>): Promise<{ routeId: string }>;
  browserHeadersClear(sandboxId: string, tabId: string): Promise<void>;
  browserRequestsList(sandboxId: string, tabId: string, since?: number): Promise<{ requests: Array<Record<string, unknown>> }>;

  // Browser captcha (14.K)
  browserCaptchaDetect(sandboxId: string, tabId: string): Promise<{ detected: boolean; type?: string; selector?: string }>;
  browserCaptchaWait(sandboxId: string, tabId: string, timeoutMs?: number): Promise<{ solved: boolean; durationMs: number }>;

  // Proxy (14.L)
  proxyMappingAdd(sandboxId: string, matchPattern: string, upstreamUrl: string): Promise<{ mappingId: string }>;
  proxyMappingRemove(sandboxId: string, mappingId: string): Promise<void>;
  proxyMappingList(sandboxId: string): Promise<{ mappings: Array<{ id: string; pattern: string; upstream: string }> }>;
  proxyExcludeAdd(sandboxId: string, pattern: string): Promise<{ excludeId: string }>;
  proxyExcludeRemove(sandboxId: string, excludeId: string): Promise<void>;
  proxyExcludeList(sandboxId: string): Promise<{ excludes: Array<{ id: string; pattern: string }> }>;
  proxyUpstreamSet(sandboxId: string, upstreamUrl: string): Promise<void>;
  proxyUpstreamRemove(sandboxId: string): Promise<void>;
  proxyUpstreamGet(sandboxId: string): Promise<{ upstreamUrl: string | null }>;
  proxyHealth(sandboxId: string): Promise<{ healthy: boolean; requestsServed: number; errors: number }>;
  proxyDiagnose(sandboxId: string, url: string): Promise<{ reachable: boolean; latencyMs: number; statusCode?: number; error?: string }>;

  // Sandbox-meta
  getSandboxContext(sandboxId: string): Promise<Record<string, unknown>>;
  listPythonPackages(sandboxId: string): Promise<{ packages: Array<{ name: string; version: string }> }>;
  listNodejsPackages(sandboxId: string): Promise<{ packages: Array<{ name: string; version: string }> }>;
  restartSandbox(sandboxId: string): Promise<{ success: boolean; restarted_programs: string[] }>;

  // MCP discoverability
  mcpListTools(sandboxId: string): Promise<{ tools: Array<Record<string, unknown>> }>;
  mcpDispatch(sandboxId: string, toolName: string, args: Record<string, unknown>, idempotencyKey?: string): Promise<Record<string, unknown>>;
  mcpAwaitApproval(sandboxId: string, idempotencyKey: string, timeoutMs: number): Promise<Record<string, unknown>>;

  // Info
  getSandboxInfo(sandboxId: string): Promise<{ cdpUrl: string; vscodeUrl: string; vncUrl: string }>;
  issueTicket(sandboxId: string, purpose: 'vscode' | 'vnc' | 'cdp', ttlSec: number): Promise<{ ticket: string; url: string }>;
  setRoutingContext(sandboxId: string, ctx: { threadId?: string; invocationId?: string }): Promise<void>;
}

// ─── Function Registry ──────────────────────────────────────────────────────

export type SandboxToolCategory = 'read' | 'write' | 'destructive' | 'outbound' | 'sensitive';

export interface ExecutionEnvironmentFunction {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, JsonSchemaProperty>;
    required?: string[];
  };
  categories: SandboxToolCategory[];
  /** When true, this function is only callable by code running INSIDE the
   *  sandbox container (via `/v1/mcp/dispatch`) — it MUST NOT appear in the
   *  agent LLM's tool catalog. The `mcp_*` family and `sandbox_*` introspection
   *  helpers are the canonical examples: they exist so the sandbox-side SDK
   *  can broker MCP calls back through the runtime, not for the LLM to invoke
   *  directly. Mis-exposing one of these to the LLM causes a stub-fallback
   *  retry storm: the LLM can choose `mcp_dispatch` to reach Gmail and the
   *  hybrid loop has no standard-tool handler for it.
   *  Defaults to `false` (LLM-exposable). */
  sandboxInternal?: boolean;
}

// ─── Instruction Model Extension ────────────────────────────────────────────

export interface ExecutionEnvironmentConfig {
  enabled: boolean;
  template: ExecutionEnvironmentType;
  resourceLimits: ResourceLimits;
  costCeilingCredits: number;
  initRepos?: Array<{
    url: string;
    branch?: string;
    credentialRef?: string;
  }>;
}

// ─── Sandbox Usage Record ───────────────────────────────────────────────────

/**
 * Billing phases emitted into `sandbox_usage_log`. The sandbox is one Cloud
 * Run instance regardless of how many PTYs / tabs / watchers / bash sessions
 * are open inside it, so there is a single per-second meter — `instance_alive`
 * — plus the three lifecycle phases. Per-resource phases that historically
 * appeared in this union have been removed; the `sandbox_usage_log.phase`
 * CHECK constraint accepts them for read compatibility with older rows but
 * the code never emits them.
 */
export type SandboxPhase =
  | 'provision'
  | 'execute'
  | 'teardown'
  | 'instance_alive';

export interface SandboxUsageRecord {
  tenantId: string;
  invocationId: string;
  agentId: string;
  sandboxId: string;
  phase: SandboxPhase;
  toolName: string | null;
  cpuMillis: number;
  memoryMbSeconds: number;
  egressBytes: number;
  wallClockMs: number;
  creditsConsumed: number;
  template: ExecutionEnvironmentType;
  exitCode: number | null;
  idempotencyKey: string;
}

// ─── Sandbox State (persisted for crash recovery) ───────────────────────────

export interface SandboxStateRecord {
  sandboxId: string;
  sessionId: string;
  tenantId: string;
  agentId: string;
  invocationId: string;
  status: SandboxStatus;
  template: ExecutionEnvironmentType;
  createdAt: Date;
  lastHeartbeat: Date;
  destroyedAt: Date | null;
  capabilities?: SandboxCapability[];
  jwtSecretEncrypted?: Buffer;
  imageTag?: string;
  readyAt?: Date | null;
  mcpDispatchCounter?: number;
}

// ─── Sandbox Command Audit ──────────────────────────────────────────────────

export interface SandboxCommandAudit {
  tenantId: string;
  agentId: string;
  invocationId: string;
  sandboxId: string;
  toolName: string;
  commandArgs: string[] | null;
  workDir: string | null;
  exitCode: number | null;
  stdoutPreview: string | null;
  stderrPreview: string | null;
  wallClockMs: number;
  component?: 'shell' | 'file' | 'browser' | 'vscode';
}

// ─── Rate Limits ────────────────────────────────────────────────────────────

export interface SandboxRateLimits {
  maxConcurrentPerAgent: number;
  maxConcurrentPerTenant: number;
  maxExecPerMinutePerSandbox: number;
  maxCreationsPerHourPerTenant: number;
}

export const DEFAULT_SANDBOX_RATE_LIMITS: SandboxRateLimits = {
  maxConcurrentPerAgent: 50,
  maxConcurrentPerTenant: 200,
  maxExecPerMinutePerSandbox: 120,
  maxCreationsPerHourPerTenant: 1000,
};

/** Resolves the OAuth token for the version-control connector an agent is bound
 *  to, for git-over-HTTPS inside a sandbox. Returns undefined when the agent has
 *  no connector for that host, in which case the clone is attempted
 *  unauthenticated — correct for a public repository, and a clear git error for
 *  a private one. */
export type GitCredentialResolver = (input: {
  tenantId: string;
  agentId: string;
  host: string;
}) => Promise<string | undefined>;
