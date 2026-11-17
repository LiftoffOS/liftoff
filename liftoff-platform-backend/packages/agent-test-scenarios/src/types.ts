// Shared types for the agent test harness — used by:
//   - TR-side runner (tools/agent-test-harness/run.ts in tenant-runtime),
//     which hits TR's POST /api/internal/test-harness/run-agent and
//     drives executeTask directly. EXECUTION-LAYER probe.
//   - PB-side runner (tools/agent-test-harness/run.ts in
//     platform-backend), which hits PB's POST
//     /api/internal/test-harness/run-chat and drives runAgentChatTurn
//     (which forwards to TR via Connect-RPC). END-TO-END probe.
//
// Both runners produce AgentHarnessRunResult and run scenarios through
// assertScenario(). Tool-call name matching is the common assertion
// surface — args / results live in TR and are populated only by the
// TR runner; the PB runner leaves those undefined.

/**
 * Pre-conditions the harness can establish before running the prompt.
 * Each scenario declares its preconditions; the endpoint (TR or PB)
 * actuates them before building the catalog / driving the turn.
 *
 * Browser-inspect tools are gated on hasActiveBrowserSession in TR's
 * expose-tools — without setup, the catalog doesn't include them and
 * the scenario's tool assertion is incoherent. The runner / endpoint
 * surfaces this by SKIPPING the scenario when requiresExposedTools
 * names a tool that isn't in the returned catalog.
 */
export interface ScenarioSetup {
  /** Pre-spawn an Anchor browser session for the synthetic thread so
   *  scenarios that need browser inspection have a live page to read.
   *  Optional initialUrl pre-navigates the session. */
  browserSession?: { initialUrl?: string };
  /** Caller role to run the scenario as. Used by the role-gated CAIO/Insights
   *  scenario sets (e.g. a viewer must not reach payroll tools). Ignored by the
   *  user-created TR/PB harness. */
  role?: 'owner' | 'admin' | 'member' | 'viewer';
}

/** B.1 — Audit-log assertion shape. Scenarios that touch the audit ledger
 *  declare expected rows by action name and (optionally) an error_code
 *  substring. Both fields must match for the assertion to succeed. The
 *  runner pulls these rows from TR's audit_logs table for the invocation
 *  and surfaces them as `AgentHarnessRunResult.auditLogs`. */
export interface AuditLogExpectation {
  /** Bare action name as written to audit_logs (e.g. `memory_save`,
   *  `gmail__send_email`, `<connectorAlias>__search`). */
  action: string;
  /** Optional substring that error_code must include. Used to assert
   *  guardrail rows (citation, sensitive_data). Omit to match on action
   *  name only. */
  errorCodeIncludes?: string;
}

/** B.1 — sanitization-regression assertion. For `sensitive_data.*`
 *  scenarios, the runner verifies that the sanitized input_args persisted
 *  to audit_logs did NOT survive the redaction layers. The regex MUST NOT
 *  match the JSON-stringified input_args of the named row. */
export interface AuditLogSanitizationExpectation {
  action: string;
  mustNotMatch: RegExp;
}

/** Union of every pause kind a scenario can assert. Covers both the kinds
 *  the adapter emits today AND reserved future kinds the runtime hasn't
 *  shipped yet, so a scenario file can reference them ahead of the wire
 *  support landing. The runner maps adapter PauseReason values to the
 *  first three; the last two stay `'none'` until the adapter starts
 *  emitting them. */
export type PauseKind =
  | 'none'
  | 'hitl_approval'      // adapter 'hitl_gate' — operator HITL approval gate
  | 'ask_user'           // adapter 'ask_user' — agent asked the user for clarification
  | 'admin_pause'        // adapter 'admin' — operator paused the run
  | 'circuit_breaker'    // future: tenant-runtime circuit-breaker trip
  | 'budget_exceeded';   // future: credit / token / time budget exhausted

/** B.1 — pause-state assertion. Scenarios that expect the agent to enter a
 *  paused state declare the expected kind. The runner sources this from
 *  the adapter's pause_requested event surfaced as
 *  `AgentHarnessRunResult.pauseState`. */
export interface HitlPauseExpectation {
  kind: Exclude<PauseKind, 'none'>;
}

export interface AgentTestScenario {
  /** Stable short id for log / output grouping. */
  id: string;
  /** Human-readable description shown in the CLI table. */
  description: string;
  /** The user message sent to the agent. */
  prompt: string;
  /** Pre-conditions to establish before the prompt runs. */
  setup?: ScenarioSetup;
  /** Bare tool names the catalog MUST expose for this scenario to be a
   *  meaningful test. Missing tools mark the scenario SKIPPED (not
   *  failed) so the report distinguishes "agent picked wrong" from
   *  "the right tool wasn't even available". */
  requiresExposedTools?: string[];
  /** Bare tool names that MUST appear in the call sequence (any order). */
  expectsTools?: string[];
  /** AND-of-ORs: each inner set must have at least one match. For
   *  "either tool is fine" put both names in ONE set:
   *    expectsOneOf: [['A', 'B']]
   *  TWO sets means "both groups must match independently" — rarely
   *  what you want. */
  expectsOneOf?: string[][];
  /** Bare tool names that MUST NOT appear (anti-regression). */
  forbidsTools?: string[];
  /** If set, the final assistant text must include this substring
   *  (case-insensitive). */
  expectsTextIncludes?: string;
  /** If set, the final assistant text must NOT match this regex —
   *  "no leaked internals", etc. */
  forbidsTextMatching?: RegExp;
  /** B.1 — Audit-log rows that MUST exist in this invocation's ledger.
   *  All entries must match for the scenario to pass. */
  expectsAuditLogContains?: AuditLogExpectation[];
  /** B.1 — For each entry, the JSON-stringified sanitized input_args of
   *  the named row must NOT match the regex. Verifies the sanitizeArgs +
   *  redactPii pipeline catches credential-shaped values. */
  expectsAuditLogInputArgsNotMatching?: AuditLogSanitizationExpectation[];
  /** B.1 — Asserts the agent entered the named pause state instead of
   *  completing. Cannot be combined with `ok:true` expectations. */
  expectsHitlPause?: HitlPauseExpectation;
  /** C4 — post-run assertions against EXTERNAL system state (the fixture GitHub repo),
   *  activated only when the tr-runner is invoked with `--external-checks=github`. When the
   *  flag is off (unit runs, other suites) these are ignored, so a scenario file can carry them
   *  without requiring a live repo. */
  externalChecks?: ExternalChecks;
  /** Cap SDK turns so a runaway agent doesn't burn credits. */
  maxTurns?: number;
  /** Tags so the runner can filter (--tag=browser). */
  tags?: string[];
}

/** C4 — external post-run checks polled against the fixture GitHub repo. `repo` defaults to the
 *  DIAGNOSTICS_FIXTURE_REPO env the runner is configured with; branch patterns support a
 *  `<runId>` placeholder for the run-id-prefixed branch namespace. */
export interface ExternalChecks {
  provider: 'github';
  repo?: string;
  /** A branch matching this name (or glob) must exist. */
  branchExists?: string;
  /** An OPEN pull request must exist for the run's branch. */
  prOpen?: boolean;
  /** All required status checks on the PR head must be successful. */
  checksGreen?: boolean;
  /** The PR's mergeable_state must equal this. */
  mergeState?: 'clean' | 'blocked' | 'behind' | 'dirty' | 'unstable';
}

/**
 * The shape both endpoints (TR-direct and PB-end-to-end) return for a
 * single scenario run. Optional fields are populated by whichever
 * surface has them; the runner / assertion is tolerant of either.
 */
export interface AgentHarnessRunResult {
  /** True when the agent run reached a terminal success outcome. */
  ok: boolean;
  /** UUID of the invocation row (TR-side identifier for debugging). */
  invocationId: string;
  /** UUID of the synthetic thread row. */
  threadId: string;
  /** Final assistant text (last assistant_message block joined). */
  finalText: string;
  /** Ordered list of tool calls the agent fired. PB-side populates
   *  toolName only; TR-side also populates args / result / error. */
  toolCalls: ToolCallTrace[];
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** Adapter completion outcome — 'success' / 'error' / 'escalated'.
   *  Populated by TR-direct runs. PB runs derive ok from the
   *  `complete` event and may leave outcome null. */
  outcome: string | null;
  outcomeReason?: string;
  /** Tools the catalog actually exposed for this run. Populated by
   *  TR-direct runs (it builds the catalog). PB-side leaves this
   *  empty because PB doesn't see TR's catalog; requiresExposedTools
   *  on PB-side runs is therefore a no-op. */
  exposedToolNames: string[];
  durationMs: number;
  /** What setup ran before the prompt (e.g. "browserSession=spawned:..."). */
  setup?: { steps: string[] };
  // Failure-response shape — populated when the HTTP call itself
  // failed before the agent could run.
  error?: string;
  message?: string;
  /** Set client-side when the HTTP response wasn't JSON. */
  httpStatus?: number;
  rawSnippet?: string;
  /** B.1 — Audit rows the harness loaded from audit_logs for this
   *  invocation. Capped to 50 rows by TR's run-agent router (older rows
   *  truncated). Populated only by TR-direct; PB pass-through copies from
   *  the upstream TR response when present. */
  auditLogs?: AuditLogTrace[];
  /** B.1 — Derived from the adapter's pause_requested event. Defaults to
   *  `{kind: 'none'}` when the run completed without a pause. */
  pauseState?: PauseState;
}

/** B.1 — single audit_logs row as the runner sees it. The `inputArgs` is
 *  what the ledger persisted (post-sanitizeArgs + redactPii). */
export interface AuditLogTrace {
  id: string;
  action: string;
  outcome: string;
  errorCode: string | null;
  inputArgs: unknown;
}

/** B.1 — pause-state taxonomy. The runner ALWAYS sets `kind` (defaults to
 *  'none' when the invocation completed without a pause). `reason` carries
 *  the raw adapter string for debugging — useful when the kind is the
 *  catch-all `'none'` because the adapter emitted something unexpected. */
export interface PauseState {
  kind: PauseKind;
  reason?: string;
}

export interface ToolCallTrace {
  callId: string;
  toolName: string;
  args?: unknown;
  result?: unknown;
  error?: string;
}

export type AssertionStatus = 'pass' | 'fail' | 'skip';

export interface AssertionResult {
  status: AssertionStatus;
  failures: string[];
  skipReasons?: string[];
}
