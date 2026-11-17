// Shared types for the code_session tool.

import type { McpToolDefinition } from '../../catalog-types';
import type { ResolvedProvider } from '../../../../agent-execution/adapter/types';

// THIS UNION NAMES CLIs, not vendors, which is why 'openrouter' belongs here
// and does not belong in the provider union: it is the Codex binary pointed at
// the gateway, and it is a real binary that a real endpoint answers.
//
// Five vendors have no coding CLI of their own — Grok and the four open-weight
// families — and all five collapse onto it. Only the BINARY is shared: the
// host, the model-id namespace and the rate key stay each family's own
// (runners/openrouter.ts), so the collapse must not be read as those sessions
// running on OpenRouter's account. Grok's does not.
export type CodeSessionProvider = 'anthropic' | 'openai' | 'google' | 'openrouter';
export type CodeSessionExitReason = 'success' | 'timeout' | 'error';

/** A coding session's budget when the caller names none. One value, read by
 *  the handler that enforces it AND by the transports that must outlast it
 *  (mcp-bridge.ts), which a literal in each place would let drift apart. */
export const CODE_SESSION_DEFAULT_TIMEOUT_SECONDS = 600;

export interface CodeSessionInput {
  task: string;
  repo: string;
  branch: string;
  timeout_seconds?: number;
  allowed_tools?: string[];
  prefer_provider?: CodeSessionProvider | 'auto';
}

export interface CodeSessionContext {
  tenantId: string;
  /** Outer agent's id — the agent that called the code_session tool.
   *  Threaded into nested trajectory rows so `agent_trajectories.agent_id`
   *  carries the owning agent's uuid, not the outer invocation id. */
  agentId: string;
  invocationId: string;
  outerProvider: ResolvedProvider;
  /** Outer agent's invocation-level resolved model id. The gateway runner reads
   *  its publisher prefix (z-ai/ vs qwen/ vs deepseek/ vs moonshotai/) to pick
   *  the matching coding model, because one runner serves every family that
   *  shares the CLI. Absent → the runner's GLM default applies. */
  outerModelId?: string;
  /** A model id an operator DELIBERATELY pinned — the agent's own
   *  `model_config.modelId`. Distinct from `outerModelId`, which is always
   *  populated (it falls back to the workspace policy default and then to the
   *  tier table), and so cannot tell "someone chose this" from "this is what
   *  resolution landed on".
   *
   *  Only a deliberate pin may override a vendor coding agent's own default
   *  model. Absent — the normal case — means the runner passes no model and the
   *  vendor default stands, which is the behaviour we intend to keep. */
  explicitModelId?: string;
  /** OAuth token for cloning/pushing the repo over HTTPS. Resolved from the
   *  agent's bound version-control connector (GetCredentials). */
  gitCloneToken?: string;
  /** Which host the repo lives on — selects the clone/push remote host AND the
   *  git-over-HTTPS auth username (github → x-access-token, gitlab → oauth2).
   *  Resolved from the bound connector's type; defaults to github. */
  gitProvider?: 'github' | 'gitlab';
}

/** One vendor model's token + cost usage inside a nested coding session.
 *
 *  `costUsd` is present ONLY when the vendor reports an authoritative figure.
 *  The Claude Agent SDK does, per model, on its result message — which matters
 *  because the nested session runs on the CLI's default model and we cannot
 *  assume our rate table has an entry for it. Codex and the Gemini CLI report
 *  tokens but name no model, so their spend arrives unpriceable; the caller
 *  records the tokens and counts them as unpriced rather than inventing a
 *  number (INV: a tool that cannot do the thing says so). */
export interface CodeSessionModelUsage {
  /** Vendor model id, when the SDK/CLI reports one. Undefined for Codex and
   *  the Gemini CLI: neither exposes a model on any event it emits. */
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd?: number;
}

export interface CodeSessionOutput {
  provider_used: CodeSessionProvider;
  diff: string;
  summary: string;
  tool_calls_made: Array<{ tool: string; args: unknown; result: string }>;
  files_modified: string[];
  exit_reason: CodeSessionExitReason;
  usage?: Record<string, unknown>;
  /** Nested LLM spend for this coding session in USD, when the vendor reported
   *  an authoritative figure for every model it used.
   *
   *  Read back off the completed tool call at invocation completion by
   *  `computeCodeSessionCost` and added to the invocation's billed cost. It
   *  rides the tool output rather than a side-channel accumulator on purpose:
   *  the completion path already holds these results, so there is no
   *  module-level state to leak when a run never reaches a terminal state. */
  cost_usd?: number;
  /** Tokens this session really spent but that NOTHING here can price, because
   *  the vendor reported no model id to look a rate up by (Codex, Gemini CLI).
   *
   *  Carried out separately from `cost_usd` so the completion path can count
   *  them through the same unpriced-token meter every other pricing site uses.
   *  Fabricating a price for them would be worse than reporting zero: zero that
   *  is visibly zero gets fixed, and a guess never does. */
  unpriced_tokens?: { input: number; output: number };
}

export interface RunnerInvocation {
  task: string;
  /** Absolute path of the checkout, in whatever context the workspace runs
   *  commands. Kept as a plain string because vendor SDKs take a `cwd`. */
  workspaceRoot: string;
  /** Where this session's commands run. A runner that drives a CLI must go
   *  through this rather than spawning, or it runs in the tenant runtime's
   *  container while its checkout is somewhere else entirely — and returns an
   *  empty diff, which reads as "nothing needed changing".
   *
   *  Optional only so the SDK-based runners, which spawn in-process by
   *  definition, are not forced to take a handle they cannot honour. Check
   *  `workspace.kind` before assuming either. */
  workspace?: import('./workspace').CodeSessionWorkspace;
  allowedTools: string[];
  timeoutMs: number;
  signal: AbortSignal;
  context: CodeSessionContext;
  /** Part 6 §A3 — when true, the runner captures its inner SDK output into
   *  the trajectory recorder buffer keyed under a nested invocation id so
   *  the dispatch site can write a separate code_session trajectory linked
   *  to the outer one via parent_invocation_id. */
  captureNestedTrajectory?: boolean;
  /** Nested invocation id (pre-allocated by the dispatch site) so the outer
   *  trajectory can carry a stable code_session_trajectory_id reference in
   *  the tool_result for the code_session call. */
  nestedInvocationId?: string;
  /** BYO provider keys, when the customer's own account funds the outer run.
   *
   *  Carries a Liftoff gateway base URL and a short-lived per-run token, never
   *  the customer's key. The distinction matters more here than anywhere: this
   *  session's whole job is running Bash in a checkout of the customer's own
   *  repository, so a provider key in its environment is a key the coding agent
   *  can read, print, and be talked into exfiltrating.
   *
   *  Keyed to the OUTER invocation, because that is where these tokens are
   *  billed: `computeCodeSessionCost` adds this session's spend to the outer
   *  invocation's cost, so its usage rows have to settle onto the same ledger
   *  row. */
  byok?: import('../../types').ByokAdapterCredential;
  /** Model the runner must run the coding session on, or undefined to let the
   *  vendor default stand. Resolved ONCE at the dispatch site (deliberate agent
   *  pin, else a workspace `code_session` task override) and already checked to
   *  belong to this runner's provider, so a runner may pass it through without
   *  re-validating it. */
  model?: string;
}

export interface RunnerResult {
  summary: string;
  tool_calls_made: CodeSessionOutput['tool_calls_made'];
  exit_reason: CodeSessionExitReason;
  usage?: Record<string, unknown>;
  /** Per-model token + cost usage for metering. Empty/absent when the vendor
   *  reported nothing at all. */
  modelUsage?: CodeSessionModelUsage[];
  /** Part 6 §A3 — populated when captureNestedTrajectory was true. The
   *  dispatch site uses this to attach a code_session_trajectory_id to the
   *  outer trajectory's tool_result block so offline consumers can join. */
  code_session_trajectory_id?: string;
}

export interface CodeSessionRunner {
  readonly provider: CodeSessionProvider;
  run(invocation: RunnerInvocation): Promise<RunnerResult>;
}

export const CODE_SESSION_TOOL: McpToolDefinition = {
  name: 'code_session',
  description:
    'Delegate a bounded code task to a vendor-native coding agent. Provisions ' +
    'a fresh temp workspace, clones the requested repo + branch, runs the ' +
    'coding agent (Claude Code / Codex / Gemini coding agent depending on ' +
    '`prefer_provider`), captures the resulting diff. Use for code changes, ' +
    'debugging, multi-step shell + file operations. By default, uses the same ' +
    'vendor as the outer agent that called this tool; override with ' +
    'prefer_provider to use a different vendor.',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string' },
      repo: { type: 'string', description: 'owner/name format (e.g. liftoff/backend).' },
      branch: { type: 'string' },
      timeout_seconds: { type: 'number', default: CODE_SESSION_DEFAULT_TIMEOUT_SECONDS },
      allowed_tools: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional vendor-specific tool whitelist.',
      },
      prefer_provider: {
        type: 'string',
        enum: ['anthropic', 'openai', 'google', 'openrouter', 'auto'],
        default: 'auto',
        description:
          "'auto' uses the outer agent's provider. Override to force a specific " +
          "vendor (e.g. 'anthropic' for Claude Code regardless of outer agent).",
      },
    },
    required: ['task', 'repo', 'branch'],
  },
  serverId: 'builtin',
};
