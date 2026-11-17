// code_session — vendor-neutral outer handler for delegating a bounded
// code task to a vendor-native coding agent (Claude Code / Codex / Gemini).
// Provisions workspace, clones repo, picks the vendor preset, dispatches
// to a CodeSessionRunner, captures diff + files, cleans up.


import { logger } from '../../../../infrastructure/logging';
import { getEntitlementsClient } from '../../../../entitlements-client/service';
import { calculateCost } from '../../../../llm/pricing';
import type { LLMProvider } from '../../../../llm/types';
import { incCounter } from '../../../../memory/metrics';
import { unknownModelSentinel } from '../../../code-session-cost';
import { AnthropicCodeSessionRunner } from './runners/anthropic';
import { OpenAICodeSessionRunner } from './runners/openai';
import {
  OpenRouterCodeSessionRunner,
  OPENROUTER_BASE_URL,
  isGrokCodeSession,
  codeModelForSession,
  openWeightsRunnerKind,
  xaiCodeSessionBaseUrl,
} from './runners/openrouter';
import {
  familyOfModelId,
  isGatewayServed,
  GATEWAY_DEFAULT_FAMILY,
} from '../../model-family';
import { OpencodeCodeSessionRunner } from './runners/opencode';
import { GeminiCodeSessionRunner } from './runners/gemini';
import type {
  CodeSessionInput,
  CodeSessionContext,
  CodeSessionModelUsage,
  CodeSessionOutput,
  CodeSessionProvider,
  CodeSessionRunner,
  RunnerResult,
} from './types';
import { CODE_SESSION_DEFAULT_TIMEOUT_SECONDS } from './types';
import { captureSessionChanges, recordSessionBase } from './diff-capture';
import type { ByokAdapterCredential, NestedSpecialistEngineId } from '../../types';
import { openByokSession } from '../../../../byok/session';
import { openCodeSessionWorkspace } from './open-workspace';
import { SANDBOXED_RUNNERS } from './runners/sandboxed';
import type { CodeSessionWorkspace } from './workspace';

/** Nested code_session specialist engine per runner provider.
 * Distinct from the outer ExecutionEngineId so an outer OpenAI Codex engine is
 * never conflated with a nested Codex coding task. */
function nestedEngineFor(provider: CodeSessionProvider): NestedSpecialistEngineId {
  switch (provider) {
    case 'anthropic': return 'claude-code-session';
    case 'openai': return 'codex-code-session';
    case 'google': return 'gemini-code-session';
    // Derived from the SAME switch that selects the runner, never restated, so
    // the id cannot outlive the engine it names.
    case 'openrouter':
      return openWeightsRunnerKind() === 'opencode'
        ? 'opencode-code-session'
        : 'codex-open-weights-code-session';
  }
}

export {
  CODE_SESSION_TOOL,
  type CodeSessionInput,
  type CodeSessionContext,
  type CodeSessionOutput,
} from './types';
import { getManagedSecret } from '../../../../infrastructure/secret-store';


const OPENCODE_RUNNER = new OpencodeCodeSessionRunner();

const RUNNERS: Record<CodeSessionProvider, CodeSessionRunner> = {
  anthropic: new AnthropicCodeSessionRunner(),
  openai: new OpenAICodeSessionRunner(),
  openrouter: new OpenRouterCodeSessionRunner(),
  google: new GeminiCodeSessionRunner(),
};

/** The runner for a vendor, in the place this session is going to run.
 *
 *  The family follows the WORKSPACE rather than the flag that chose it, and
 *  they are not interchangeable: an in-process runner links a vendor SDK that
 *  spawns in THIS container, so pairing one with a sandbox workspace puts the
 *  coding agent and its checkout in different containers. Nothing errors — the
 *  agent works in an empty directory, the diff comes back empty, and the
 *  calling agent reads that as "nothing needed changing". */
export function runnerFor(
  provider: CodeSessionProvider,
  workspaceKind: CodeSessionWorkspace['kind'],
): CodeSessionRunner {
  // opencode is the one runner that serves BOTH families from a single
  // implementation: it drives a CLI through the workspace handle rather than
  // linking an SDK into this process, so it honours a sandbox workspace and a
  // local one alike. The family split below exists for the SDK-based runners,
  // which cannot.
  if (provider === 'openrouter' && openWeightsRunnerKind() === 'opencode') {
    return OPENCODE_RUNNER;
  }
  const runner = workspaceKind === 'sandbox' ? SANDBOXED_RUNNERS[provider] : RUNNERS[provider];
  if (!runner) {
    throw new Error(`No ${workspaceKind} runner registered for provider: ${provider}`);
  }
  return runner;
}

/** Vendor-specific preset filenames. The outer handler reads whichever exists
 *  in the cloned repo and passes its content to the matched sub-handler. */
const PRESET_FILES: Record<CodeSessionProvider, string> = {
  anthropic: 'CLAUDE.md',
  openai: 'AGENTS.md',
  openrouter: 'AGENTS.md',
  google: 'GEMINI.md',
};

export async function codeSessionHandler(
  input: CodeSessionInput,
  context: CodeSessionContext,
): Promise<CodeSessionOutput> {
  const provider = resolveProvider(input, context);

  // The model this coding session runs on, or undefined to let the vendor
  // coding agent keep its own default. Resolved once, here, so every runner
  // receives an already-validated value.
  const model = await resolveCodeModel(context, provider);

  // Whose account funds this coding session. Asked here rather than inherited
  // from the outer run's credential for two reasons: the session can be sent to
  // a DIFFERENT vendor than the outer agent (`prefer_provider`), so the outer
  // run's key may be for the wrong provider entirely; and the model is resolved
  // above, which is what tells a Grok session from any other OpenRouter one.
  //
  // Keyed to the OUTER invocation id, because `computeCodeSessionCost` adds this
  // session's spend to that invocation's cost. Usage rows keyed anywhere else
  // would leave the run reading as partly unfunded and bill it in full.
  const byok = await openByokSession({
    tenantId: context.tenantId,
    invocationId: context.invocationId,
    resolvedProvider: provider,
    resolvedModelId: model ?? context.outerModelId ?? null,
    // The coding session IS the agent's work for this turn, not a tagged
    // side-call, so it asks under the same kind as the turn that spawned it.
    call: { callKind: 'agent_invocation' },
    runtimeAgentId: context.agentId,
  });

  const timeoutMs = (input.timeout_seconds ?? CODE_SESSION_DEFAULT_TIMEOUT_SECONDS) * 1000;
  const allowedTools = input.allowed_tools ?? [];

  // 1. Provision workspace.
  //
  // Where this runs is the one thing CODE_SESSION_EXECUTION decides. Every step
  // below goes through the workspace, so the clone, the preset read, the coding
  // agent and the diff all land in the same place as each other — which is the
  // property that matters. Sandboxing the coding agent while diffing a local
  // directory would return an empty diff, and an empty diff reads as "nothing
  // needed changing" rather than as a failure.
  const workspace: CodeSessionWorkspace = await openCodeSessionWorkspace({
    context,
    env: byokEnvironmentFor(provider, byok, context),
  });
  const workspaceRoot = workspace.root;

  let diff = '';
  let filesModified: string[] = [];
  // Nested spend, split by whether we could price it. Both stay undefined when
  // the vendor reported no usage at all, so an absent field means "nothing was
  // reported" rather than "it cost nothing".
  let codeSessionCostUsd: number | undefined;
  let unpricedTokens: { input: number; output: number } | undefined;
  let runnerResult: RunnerResult = {
    summary: '',
    tool_calls_made: [],
    exit_reason: 'error',
  };

  try {
    // Selected INSIDE the try: the workspace above is already provisioned, and
    // a sandbox one is a live container. A throw between the two — which is
    // what an unroutable provider is — would leak it past the cleanup below.
    const runner = runnerFor(provider, workspace.kind);

    // 2. Clone repo at the requested branch. Host + git-over-HTTPS auth username
    //    are provider-specific: GitHub authenticates a token as
    //    x-access-token:<token>@github.com, GitLab as oauth2:<token>@gitlab.com.
    //    The nested coding agent commits + pushes to this same tokenized origin,
    //    so this remote is both the clone source and the push target.
    const gitRemote = context.gitProvider === 'gitlab'
      ? { host: 'gitlab.com', user: 'oauth2' }
      : { host: 'github.com', user: 'x-access-token' };
    const repoUrl = context.gitCloneToken
      ? `https://${gitRemote.user}:${context.gitCloneToken}@${gitRemote.host}/${input.repo}.git`
      : `https://${gitRemote.host}/${input.repo}.git`;
    // The software-engineer workflow usually names a NEW feature branch (the branch
    // the PR/MR will be opened from), which does not exist on the remote yet —
    // `git clone --branch <new>` fails with "Remote branch not found". So: try the
    // branch directly (continuing work on an existing branch), and only on a
    // branch-not-found fall back to cloning the default branch and creating the
    // requested branch locally. The nested coding agent commits + pushes it as a new
    // remote branch, which is exactly what opening a PR/MR needs. Any other clone
    // failure (auth, network, missing repo) is re-thrown unchanged.
    const cloned = await workspace.exec(
      ['git', 'clone', '--depth=1', '--branch', input.branch, repoUrl, workspaceRoot],
      { cwd: workspaceRoot, timeoutMs: 120_000 },
    );
    if (cloned.exitCode !== 0) {
      // `exec` reports a failure rather than throwing one, so the branch-missing
      // case is read off the exit status and stderr instead of a message on a
      // thrown Error. Same two outcomes as before: a missing remote branch falls
      // back to the default branch, anything else (auth, network, no such repo)
      // is fatal and keeps its text.
      if (!/not found in upstream|Could not find remote branch/i.test(cloned.stderr)) {
        throw new Error(`git clone failed: ${cloned.stderr.trim() || `exit ${cloned.exitCode}`}`);
      }
      const fallback = await workspace.exec(
        ['git', 'clone', '--depth=1', repoUrl, workspaceRoot],
        { cwd: workspaceRoot, timeoutMs: 120_000 },
      );
      if (fallback.exitCode !== 0) {
        throw new Error(`git clone failed: ${fallback.stderr.trim() || `exit ${fallback.exitCode}`}`);
      }
      const branched = await workspace.exec(
        ['git', '-C', workspaceRoot, 'checkout', '-b', input.branch],
        { cwd: workspaceRoot, timeoutMs: 30_000 },
      );
      if (branched.exitCode !== 0) {
        throw new Error(`git checkout -b failed: ${branched.stderr.trim() || `exit ${branched.exitCode}`}`);
      }
    }

    // Where the session starts, so what it changed can be measured from here
    // rather than from whatever HEAD it leaves behind (diff-capture.ts).
    const sessionBase = await recordSessionBase(workspace, workspaceRoot);

    // 3. Read vendor preset (best-effort). Absence is ordinary, and the
    //    workspace reports it as null rather than as an error.
    const presetContent = (await workspace.readFile(PRESET_FILES[provider])) ?? '';

    // Part 6 §A3 — nested code_session capture gate. Off by default
    // (default `false`). When the per-tenant config opts in, the runner
    // records inner SDK output into a fresh nested invocation id; we keep
    // the id here so the writer can emit the trajectory after the runner
    // returns.
    const { getTenantRuntimeConfig } = await import('../../../../tenant-runtime-config/service');
    const tenantConfig = await getTenantRuntimeConfig(context.tenantId);
    const captureNestedTrajectory = tenantConfig.trajectoryCaptureNestedCodeSessions === true
      && process.env.TRAJECTORY_SINK_ENABLED !== 'false';
    const { randomUUID } = await import('crypto');
    const nestedInvocationId = captureNestedTrajectory ? randomUUID() : undefined;

    // 4. Dispatch to sub-handler.
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => abortController.abort(), timeoutMs);
    try {
      runnerResult = await runner.run({
        task: presetContent
          ? `${presetContent}\n\n---\n\n${input.task}`
          : input.task,
        workspaceRoot,
        workspace,
        allowedTools,
        timeoutMs,
        signal: abortController.signal,
        context,
        captureNestedTrajectory,
        nestedInvocationId,
        model,
        ...(byok ? { byok } : {}),
      });
    } finally {
      clearTimeout(timeoutHandle);
    }

    // Meter what the nested coding agent spent. This runs against the vendor
    // API directly, in its own subprocess, on credentials this runtime holds —
    // so until this existed the most expensive thing an agent does cost the
    // platform real money and appeared nowhere: not in llm_usage_log, not in
    // the invocation's cost, not in the Operating Unit buckets.
    //
    // Deliberately placed where a timed-out or errored session is metered too.
    // Tokens spent before a timeout are spent.
    const meterResult = await meterNestedUsage(
      context,
      billingProviderFor(provider, context),
      runnerResult.modelUsage,
    );
    codeSessionCostUsd = meterResult.costUsd;
    unpricedTokens = meterResult.unpricedTokens;

    // A session that reported NO usage at all is spend we cannot even see —
    // worse than spend we can see but cannot rate. It happens where a vendor
    // reports nothing on a path (Codex emits usage on turn.completed and the
    // SDK's turn.failed carries none), and it would otherwise look exactly like
    // a free session. Counted so the size of the blind spot is a number.
    if (!runnerResult.modelUsage || runnerResult.modelUsage.length === 0) {
      incCounter('code_session_unmetered_total', { provider, exit_reason: runnerResult.exit_reason });
      logger.warn(
        { invocationId: context.invocationId, provider, exitReason: runnerResult.exit_reason },
        'code_session_reported_no_usage',
      );
    }

    // Part 6 §A3 — write the nested trajectory now that the runner has
    // populated the recorder buffer. Failure is non-fatal so a buggy nested
    // sink doesn't bring down the outer code_session call.
    if (captureNestedTrajectory && nestedInvocationId) {
      try {
        const { buildCanonical } = await import('../../../../trajectories/canonical-builder');
        const { TrajectorySink } = await import('../../../../trajectories/sink');
        const { Storage } = await import('@google-cloud/storage');
        const { releaseBuffer } = await import('../../../../trajectories/recorder');
        const { trajectory_nested_code_session_total } = await import('../../../../observability/runtime-extensions-metrics');

        const trajectory = buildCanonical({
          invocationId: nestedInvocationId,
          systemPrompt: '',
          objective: input.task,
          // Record the nested vendor coding agent's ALLOWED toolset as the
          // trajectory's designed set, so downstream evaluation (diagnostics
          // conformance) judges the nested run against ITS OWN tools — not the
          // parent agent's catalog. allowed_tools is the per-invocation grant
          // (Claude Code / Codex / Gemini tool names); empty when the caller
          // didn't constrain it (then the designed set is left unresolved rather
          // than wrongly attributed to the parent).
          toolDefs: allowedTools.map((name) => ({ name, description: '', input_schema: {} })),
          meta: {
            tenantId: context.tenantId,
            // Owning agent — the outer agent that invoked code_session.
            // Threaded through CodeSessionContext so agent_trajectories.agent_id
            // is a real agent uuid, not the outer invocation id.
            agentId: context.agentId,
            parentInvocationId: context.invocationId,
            nestedKind: 'code_session',
            nestedEngine: nestedEngineFor(provider),
            completed: runnerResult.exit_reason === 'success',
            outcome: runnerResult.exit_reason === 'success' ? 'success' : 'error',
          },
        });
        if (trajectory) {
          const bucket = `trajectories-${process.env.ENVIRONMENT ?? 'dev'}`;
          // bypassQualityFilter:true — nested code_session captures don't
          // carry `thinking` blocks (Anthropic Claude Code's inner stream
          // does; OpenAI Codex and Gemini CLI subprocesses don't expose
          // them). Without the bypass, OpenAI/Gemini nested captures would
          // silently skip the GCS write and only an empty index row would
          // land, defeating the opt-in feature.
          await new TrajectorySink(bucket, new Storage()).write(trajectory, {
            bypassQualityFilter: true,
          });
          trajectory_nested_code_session_total.inc({ provider });
        }
        releaseBuffer(nestedInvocationId);
      } catch (err) {
        logger.warn({
          message: 'nested code_session trajectory write failed',
          err: (err as Error).message,
        });
      }
    }

    // 5. Capture diff + modified files (vendor-neutral): everything since the
    //    session's starting commit, new files and the agent's own commits
    //    included. Plain `git diff` missed both.
    const captured = await captureSessionChanges(workspace, workspaceRoot, sessionBase);
    if (captured.error === undefined) {
      diff = captured.diff;
      filesModified = captured.filesModified;
    } else {
      logger.warn(
        {
          err: captured.error,
          invocationId: context.invocationId,
          provider,
          workspaceKind: workspace.kind,
        },
        'code_session_diff_capture_failed',
      );
    }
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, invocationId: context.invocationId, provider },
      'code_session_errored',
    );
    runnerResult.exit_reason = 'error';
  } finally {
    // 6. Cleanup.
    await workspace.destroy().catch((err) => {
      logger.warn(
        { err: (err as Error).message, workspaceRoot, workspaceKind: workspace.kind },
        'code_session_cleanup_failed',
      );
    });
  }

  return {
    provider_used: provider,
    diff,
    summary: runnerResult.summary,
    tool_calls_made: runnerResult.tool_calls_made,
    files_modified: filesModified,
    exit_reason: runnerResult.exit_reason,
    usage: runnerResult.usage,
    ...(codeSessionCostUsd !== undefined ? { cost_usd: codeSessionCostUsd } : {}),
    ...(unpricedTokens ? { unpriced_tokens: unpricedTokens } : {}),
  };
}

/** The credentials this session's coding CLI needs, and nothing else.
 *
 *  Resolved at the dispatch site rather than inside each runner because the
 *  SANDBOX needs them before any runner exists: a sandbox bash session carries
 *  its environment from the moment it is created, and putting a token on each
 *  command line instead would leave it in the sandbox's own process list for
 *  every command that follows.
 *
 *  BYOK first, and it is a REPLACEMENT rather than an addition: when the
 *  customer funds the call, Liftoff's own key must not also be present, or a
 *  CLI that prefers one over the other bills the wrong account and nothing
 *  says so. The token here is never the customer's key — it is a short-lived
 *  per-run credential for Liftoff's gateway, which holds the key.
 *
 *  Returns undefined values freely; the workspace drops them rather than
 *  passing the string "undefined", which a CLI would try to authenticate with. */
function byokEnvironmentFor(
  provider: CodeSessionProvider,
  byok: ByokAdapterCredential | undefined,
  context: CodeSessionContext,
): Record<string, string | undefined> {
  if (byok) {
    const base = byok.baseUrl.replace(/\/+$/, '');
    switch (byok.vendor) {
      case 'anthropic':
        // Both names: the CLI reads ANTHROPIC_AUTH_TOKEN as a bearer and
        // ANTHROPIC_API_KEY as an x-api-key, and which one it picks has moved
        // between releases.
        return {
          ANTHROPIC_BASE_URL: base,
          ANTHROPIC_AUTH_TOKEN: byok.token,
          ANTHROPIC_API_KEY: byok.token,
        };
      case 'openai':
      case 'xai':
        // Codex speaks the OpenAI wire format to both. `/v1` because the
        // gateway is mounted at the vendor root, as the SDK path does.
        return { OPENAI_BASE_URL: `${base}/v1`, OPENAI_API_KEY: byok.token };
      case 'google':
        return { GOOGLE_GEMINI_BASE_URL: base, GEMINI_API_KEY: byok.token };
    }
  }
  // Managed: Liftoff's own key for this vendor, and only this vendor. The
  // runtime holds all of them; a coding session gets the one it is for.
  switch (provider) {
    case 'anthropic':
      return { ANTHROPIC_API_KEY: getManagedSecret('ANTHROPIC_API_KEY') };
    case 'openai':
      return { OPENAI_API_KEY: getManagedSecret('OPENAI_API_KEY') };
    case 'google':
      return { GEMINI_API_KEY: process.env.GEMINI_API_KEY };
    case 'openrouter':
      // Grok collapses onto this provider (there is no Grok coding CLI) but not
      // onto this HOST: it codes on Liftoff's own xAI account, the same one its
      // turns run on. An OpenRouter key here would authenticate a request for a
      // model under a namespace api.x.ai does not serve.
      if (isGrokCodeSession(context)) {
        return {
          OPENAI_BASE_URL: xaiCodeSessionBaseUrl(),
          OPENAI_API_KEY: getManagedSecret('XAI_API_KEY'),
        };
      }
      return {
        OPENAI_BASE_URL: OPENROUTER_BASE_URL,
        OPENAI_API_KEY: getManagedSecret('OPENROUTER_API_KEY'),
      };
  }
}

/** CodeSessionProvider for an outer agent-execution provider.
 *
 *  'openrouter' here names a CLI, not a vendor: the Codex binary pointed at the
 *  gateway, which is what every family without a coding CLI of its own gets.
 *  Grok is among them — there is no Grok coding CLI — and so are the four
 *  open-weight families. The collapse is about the BINARY only: the host, the
 *  model-id namespace and the rate key all stay the family's own. */
function codeSessionProviderFor(outerProvider: CodeSessionContext['outerProvider']): CodeSessionProvider {
  // Derived: a family reached through the gateway is a family with no CLI of
  // its own. Listed by hand, this missed GLM the day GLM stopped being spelled
  // 'openrouter' — and a missed family falls through to `return outerProvider`,
  // which is a CodeSessionProvider the RUNNERS table has no entry for.
  if (outerProvider === 'xai' || isGatewayServed(outerProvider)) return 'openrouter';
  return outerProvider;
}

/** The vendor this session's tokens are RATED and RECORDED under.
 *
 *  Not the same question as which CLI ran, and the gateway CLI is where the two
 *  separate: one binary serves five families, and each of them rates under its
 *  own key. Rated as 'openrouter' the key would be `openrouter:grok-4.6` or
 *  `openrouter:z-ai/glm-5.2` — and an unmatched rate key does not fail, it
 *  records the tokens at no cost, indefinitely and without a signal.
 *
 *  The outer provider answers it, because that is the family whose model the
 *  session was matched to. A session sent elsewhere by `prefer_provider` is
 *  rated where it actually ran, which is why only the collapse is undone here. */
function billingProviderFor(
  provider: CodeSessionProvider,
  context: CodeSessionContext,
): LLMProvider {
  if (provider !== 'openrouter') return provider;
  if (isGrokCodeSession(context)) return 'xai';
  if (isGatewayServed(context.outerProvider)) return context.outerProvider;
  // Reached only when `prefer_provider` forced the gateway CLI from an outer
  // agent on another vendor. The coding model is then the runner's own choice,
  // so the id it picked is what says which family to rate.
  return familyOfModelId(codeModelForSession(context)) ?? GATEWAY_DEFAULT_FAMILY;
}

/**
 * The model this coding session should run on, or `undefined` to leave the
 * vendor coding agent on its own default.
 *
 * `undefined` is the normal answer and the intended one. Nothing about running
 * a coding session implies the outer agent's model should also be the coding
 * model, and the vendor defaults (Claude Code's CLI default, the model Codex
 * fetches from its own remote manifest) are chosen for coding. What was broken
 * was narrower: a model an operator DELIBERATELY pinned was silently discarded
 * by the Anthropic and Codex runners, while the OpenRouter runner honoured its
 * own. Same tool, three different answers, none of them documented.
 *
 * Precedence:
 *   1. The agent's own `model_config.modelId` — the per-agent override.
 *   2. A workspace `code_session` task override — the workspace-level pin,
 *      read through `getTaskModelOverride` so it means "someone pinned a model
 *      FOR CODING", never "resolution fell through to the workspace default".
 *   3. Nothing. The vendor default stands.
 *
 * Cross-vendor guard: a model id only means something to the vendor that
 * publishes it, and `prefer_provider` lets a caller send this session to a
 * DIFFERENT vendor than the outer agent runs on. Handing Codex a Claude model
 * id is exactly the failure that once sent `claude-sonnet-4-6` to OpenRouter on
 * a Qwen workspace. So a pin applies only when it belongs to the runner that
 * was actually selected; otherwise it is dropped and that vendor's default
 * stands, which is a working session rather than a 400.
 */
async function resolveCodeModel(
  context: CodeSessionContext,
  provider: CodeSessionProvider,
): Promise<string | undefined> {
  const outerAsCodeSession = codeSessionProviderFor(context.outerProvider);

  // 1. Per-agent pin. It belongs to the outer agent's provider by construction.
  if (context.explicitModelId) {
    if (provider === outerAsCodeSession) return context.explicitModelId;
    logger.info(
      {
        invocationId: context.invocationId,
        pinnedModel: context.explicitModelId,
        pinnedProvider: outerAsCodeSession,
        runnerProvider: provider,
      },
      'code_session_pinned_model_dropped_cross_vendor',
    );
    return undefined;
  }

  // 2. Workspace pin for coding specifically.
  try {
    const override = await getEntitlementsClient().getTaskModelOverride(context.tenantId, 'code_session');
    if (override?.model) {
      // A pair with no provider half names no vendor to cross — the policy
      // names none anywhere — so it is read as belonging to the outer agent's
      // provider, which is the same assumption the entitlements client makes.
      const pairProvider = override.provider
        ? codeSessionProviderFor(override.provider as CodeSessionContext['outerProvider'])
        : outerAsCodeSession;
      if (pairProvider === provider) return override.model;
      logger.info(
        {
          invocationId: context.invocationId,
          pinnedModel: override.model,
          pinnedProvider: pairProvider,
          runnerProvider: provider,
        },
        'code_session_workspace_model_dropped_cross_vendor',
      );
    }
  } catch (err) {
    // A routing lookup that fails must not fail the coding session — it only
    // means we could not learn about a pin, and no pin is the normal case.
    logger.warn(
      { err: (err as Error).message, tenantId: context.tenantId, invocationId: context.invocationId },
      'code_session_model_override_lookup_failed',
    );
  }

  return undefined;
}

/**
 * Persist the nested session's token consumption and split its spend into the
 * part we can price and the part we cannot.
 *
 * Three sources of a price, in order of authority:
 *   1. The vendor's own figure. The Claude Agent SDK reports `costUSD` per
 *      model on its result message. This is load-bearing: the session runs on
 *      whatever model the CLI defaulted to, and our rate table cannot be
 *      assumed to have an entry for it.
 *   2. The platform rate table, whenever the vendor at least NAMED the model —
 *      which the Gemini CLI does (its stats are keyed by model name) and Codex
 *      does whenever a model was pinned. Same table that prices every other
 *      call, so a coding session and a normal turn on the same model agree.
 *   3. Nothing. Only spend under a vendor that named no model at all lands
 *      here, and it is reported as unpriced rather than billed at a guess — a
 *      visible zero gets fixed, an invented number never does.
 *
 * Failure to persist is non-fatal: losing a usage row must not fail a coding
 * session that already did its work.
 */
async function meterNestedUsage(
  context: CodeSessionContext,
  provider: LLMProvider,
  modelUsage: readonly CodeSessionModelUsage[] | undefined,
): Promise<{ costUsd?: number; unpricedTokens?: { input: number; output: number } }> {
  if (!modelUsage || modelUsage.length === 0) return {};

  let costUsd: number | undefined;
  let unpricedInput = 0;
  let unpricedOutput = 0;

  for (const usage of modelUsage) {
    const priced = priceOne(usage, provider);
    if (priced !== undefined) {
      costUsd = (costUsd ?? 0) + priced;
    } else if (usage.inputTokens > 0 || usage.outputTokens > 0) {
      unpricedInput += usage.inputTokens;
      unpricedOutput += usage.outputTokens;
    }
  }

  try {
    const { persistUsageEvent } = await import('../../../../llm/usage-tracker');
    const timestamp = new Date();
    for (const usage of modelUsage) {
      await persistUsageEvent({
        timestamp,
        provider,
        // A vendor that named no model still gets its tokens recorded, under an
        // explicit sentinel shared with the unpriced-token metric so the row
        // and the metric can be joined by name. Never filed under a model that
        // did not run.
        model: usage.model ?? unknownModelSentinel(provider),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedTokens: usage.cachedTokens,
        success: true,
        context: {
          tenantId: context.tenantId,
          agentId: context.agentId,
          invocationId: context.invocationId,
          purpose: 'code_session',
        },
      });
    }
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, invocationId: context.invocationId, provider },
      'code_session_usage_persist_failed',
    );
  }

  return {
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(unpricedInput > 0 || unpricedOutput > 0
      ? { unpricedTokens: { input: unpricedInput, output: unpricedOutput } }
      : {}),
  };
}

/** USD for one model's usage, or undefined when nothing can price it. */
function priceOne(usage: CodeSessionModelUsage, provider: LLMProvider): number | undefined {
  if (typeof usage.costUsd === 'number') return usage.costUsd;
  if (!usage.model) return undefined;
  const priced = calculateCost(
    usage.model,
    provider,
    usage.inputTokens,
    usage.outputTokens,
    usage.cachedTokens,
    // These are per-model TOTALS for the whole session — the coding SDKs report
    // no per-request breakdown — so a conditional rate band cannot be evaluated
    // against them and is deliberately not applied. See CalculateCostOptions.
    { aggregated: true },
  );
  // null means the rate table has no entry for this model — a real gap, and one
  // the unpriced-token meter is there to surface.
  return priced?.costUsd;
}

/** Which vendor coding CLI serves this session.
 *
 *  The outer-provider mapping belongs to `codeSessionProviderFor` and is not
 *  restated here. A second switch over the same union is a second place for a
 *  provider to be missed, and it cannot be missed loudly: `strictNullChecks` is
 *  off in this package, so a non-exhaustive switch returns undefined and builds
 *  clean. What reaches the runner lookup is then a provider no runner is keyed
 *  by, which fails every session for that vendor. */
function resolveProvider(
  input: CodeSessionInput,
  context: CodeSessionContext,
): CodeSessionProvider {
  const explicit = input.prefer_provider;
  if (explicit && explicit !== 'auto') return explicit;
  return codeSessionProviderFor(context.outerProvider);
}
