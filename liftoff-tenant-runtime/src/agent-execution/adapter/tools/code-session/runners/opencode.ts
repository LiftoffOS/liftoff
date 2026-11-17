// The open-weights coder, run as opencode rather than as Codex.
//
// ONE RUNNER FOR BOTH FAMILIES, unlike every other vendor here, and that is a
// property of the tool rather than a shortcut. The other vendors ship an SDK
// that spawns in THIS process, so the in-process and sandboxed variants cannot
// share an implementation. opencode's `run` subcommand is non-interactive and
// takes its whole configuration from argv and the environment, so this drives
// the CLI through the workspace handle — which is the sandbox's container when
// there is one and a curated child process when there is not.
//
// Driving the CLI is also what keeps the child's environment ALLOW-LISTED:
// `workspace.exec` builds the child environment explicitly. (The engine adapter
// reaches the same footing by spawning its server itself — adapter/opencode/server.ts —
// since `@opencode-ai/sdk`'s createOpencode takes no `env`.)
//
// CONFIG TRAVELS IN THE ENVIRONMENT, not in a file. opencode reads
// `OPENCODE_CONFIG_CONTENT` as inline JSON, and the alternative — an
// `opencode.json` in the project root — would be written INTO the checkout and
// come back in `git diff` as the agent's own work. The Codex runner passes
// `--ephemeral` for the same reason.
//
// WHY THE MODEL MUST BE REGISTERED: opencode validates against a bundled
// models.dev snapshot that lags the vendors, so a current slug is rejected as
// "Model not found" even with a valid key. See opencode/model-config.ts for
// what a registered entry has to carry and which defaults are wrong.

import { logger } from '../../../../../infrastructure/logging';
import { getOpenRouterApiKey, getXaiApiKey } from '../../../../../infrastructure/secrets';
import { opencodeModelEntry } from '../../../opencode/model-config';
import { familyOfModelId } from '../../../model-family';
import { parseNdjson } from './anthropic-stream';
import { codeModelForSession, usesXaiHost, xaiCodeSessionBaseUrl, OPENROUTER_BASE_URL } from './openrouter';
import { MAX_CLI_STDOUT_BYTES, classifyCliExit, requireWorkspace, stderrForLog } from './sandboxed/shared';
import type {
  CodeSessionModelUsage,
  CodeSessionProvider,
  CodeSessionRunner,
  RunnerInvocation,
  RunnerResult,
} from '../types';

/** opencode's provider id for each host this runner uses. Both are providers
 *  opencode ships natively, so neither needs an npm/baseURL definition — only
 *  a key and the model registration. */
const OPENROUTER_PROVIDER_ID = process.env.OPENCODE_PROVIDER_ID || 'openrouter';
const XAI_PROVIDER_ID = process.env.OPENCODE_XAI_PROVIDER_ID || 'xai';

/**
 * Built-ins this coding session switches OFF, and it is a list of one.
 *
 * The ENGINE adapter denies every built-in, because there the agent's
 * capabilities arrive through Liftoff's governed MCP catalog and a built-in
 * would bypass the gate. The inverse holds here: a coding session's whole
 * purpose is to edit a checkout and run its tests, so bash / edit / write /
 * read / grep / glob are the capability being delegated, and denying them
 * leaves an agent that can only talk about the repository.
 *
 * `question` is the exception, and it is not a governance decision. That tool
 * asks a person and WAITS. There is nobody attached to a coding session, so the
 * turn does not fail, it stops: the process stays up, produces no terminal
 * event, and the session burns its whole wall clock before the runner can call
 * it anything. A tool that cannot be answered must not be offered.
 */
const OPENCODE_CODING_TOOLS_DENIED: Record<string, boolean> = { question: false };

/** One line of `opencode run --format json`.
 *
 *  NOT opencode's Event union. `run`'s own loop consumes the event stream and
 *  RE-EMITS a selected few as `{type, timestamp, sessionID, ...data}` — the
 *  payload flattened, not nested under `properties`. Read off the pinned
 *  1.18.7 source rather than inferred: the emitted types are exactly
 *  `text`, `tool_use`, `step_start`, `step_finish`, `reasoning` and `error`.
 *
 *  THERE IS NO TERMINAL EVENT. `run` breaks its loop on `session.status` =
 *  idle and emits nothing for it, so completion is signalled by the PROCESS:
 *  it exits 0 when the session went idle with no error, and 1 when the loop
 *  returned one. A runner waiting for an idle event waits forever and then
 *  calls a finished session unfinished — which is what this file did on its
 *  first live run. */
interface OpencodeRunEvent {
  type: string;
  part?: {
    type?: string;
    text?: string;
    tool?: string;
    state?: { status?: string; input?: unknown; output?: string; error?: string };
    /** step-finish carries this step's usage. Per STEP, so the session total is
     *  the sum across them — unlike an assistant message, whose counts are
     *  cumulative and would be double-counted by summing. */
    tokens?: {
      input?: number;
      output?: number;
      reasoning?: number;
      cache?: { read?: number; write?: number };
    };
  };
  error?: { name?: string; data?: { message?: string } };
}

export class OpencodeCodeSessionRunner implements CodeSessionRunner {
  readonly provider: CodeSessionProvider = 'openrouter';

  async run(inv: RunnerInvocation): Promise<RunnerResult> {
    const workspace = requireWorkspace(inv);
    const xai = usesXaiHost(inv);
    const providerId = xai ? XAI_PROVIDER_ID : OPENROUTER_PROVIDER_ID;
    const model = inv.model ?? codeModelForSession(inv.context);

    const launch = await this.launchSettings(inv, providerId, model, xai);
    if (!launch) {
      // A key we do not hold is a session that cannot run. Said plainly rather
      // than attempted: opencode with no credential fails somewhere inside its
      // own startup, and that surfaces to the calling agent as a coding session
      // that did nothing and explained nothing.
      return {
        summary: '',
        tool_calls_made: [],
        exit_reason: 'error',
      };
    }

    const argv = [
      'opencode', 'run',
      // The checkout, which in the sandboxed family is a path in ANOTHER
      // container. Passed explicitly rather than relying on cwd so the two
      // cannot drift apart.
      '--dir', inv.workspaceRoot,
      '--model', `${providerId}/${model}`,
      '--format', 'json',
      // Auto-approve anything not explicitly denied above. The container is the
      // boundary here, exactly as it is for the Codex runner's
      // `--dangerously-bypass-approvals-and-sandbox`; a prompt nobody can answer
      // is the failure mode this avoids.
      '--auto',
      inv.task,
    ];

    const result = await workspace.exec(argv, {
      cwd: inv.workspaceRoot,
      timeoutMs: inv.timeoutMs,
      signal: inv.signal,
      maxOutputBytes: MAX_CLI_STDOUT_BYTES,
      env: { OPENCODE_CONFIG_CONTENT: launch.config, ...launch.env },
    });

    const toolCallsMade: RunnerResult['tool_calls_made'] = [];
    let summary = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;
    let sawStepFinish = false;
    let streamExitReason: RunnerResult['exit_reason'] = 'success';

    for (const event of parseNdjson<OpencodeRunEvent>(result.stdout)) {
      const part = event.part;
      switch (event.type) {
        // Emitted only for a COMPLETED text part, and each carries the whole
        // part rather than a delta, so the last one is the answer.
        case 'text':
          if (typeof part?.text === 'string' && part.text.trim()) summary = part.text;
          break;
        // Already filtered to settled parts by `run` — it emits tool_use only
        // for status completed or error.
        case 'tool_use':
          if (part?.tool) {
            toolCallsMade.push({
              tool: part.tool,
              args: part.state?.input ?? {},
              result: part.state?.error ?? part.state?.output ?? '',
            });
          }
          break;
        case 'step_finish': {
          const t = part?.tokens;
          if (!t) break;
          sawStepFinish = true;
          inputTokens += t.input ?? 0;
          outputTokens += t.output ?? 0;
          cachedTokens += t.cache?.read ?? 0;
          break;
        }
        case 'error':
          streamExitReason = 'error';
          logger.warn(
            {
              err: event.error?.data?.message ?? event.error?.name,
              invocationId: inv.context.invocationId,
            },
            'opencode_code_session_error',
          );
          break;
      }
    }

    // Priced from the TOKENS, never from opencode's own `cost`. It computes
    // that from the rate in the model record THIS runner supplied, which
    // carries none — so the figure would be our own zero handed back to us.
    // The model is named from the resolved id because `step-finish` carries no
    // model, and usage filed under no model cannot be rated at all.
    const modelUsage: CodeSessionModelUsage[] | undefined = sawStepFinish
      ? [{ model, inputTokens, outputTokens, cachedTokens }]
      : undefined;

    const exitReason = classifyCliExit({
      result,
      // `run` emits no terminal event, so the PROCESS is the terminal signal:
      // it exits 0 only after the session reached idle without an error. A
      // killed or OOM-ed CLI exits non-zero (or trips `timedOut`), so this
      // keeps the property `sawTerminal` exists for — success is never
      // inferred from a stream that merely stopped.
      sawTerminal: result.exitCode === 0,
      streamExitReason,
      aborted: inv.signal.aborted,
    });

    if (exitReason !== 'success') {
      logger.warn(
        {
          invocationId: inv.context.invocationId,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          // Whether it got as far as reporting any usage at all — the tell
          // between "ran and failed" and "never started".
          sawStepFinish,
          stderr: stderrForLog(result),
        },
        'opencode_code_session_did_not_finish',
      );
    }

    return {
      summary,
      tool_calls_made: toolCallsMade,
      exit_reason: exitReason,
      ...(modelUsage ? { modelUsage } : {}),
      ...(inv.captureNestedTrajectory && inv.nestedInvocationId
        ? { code_session_trajectory_id: inv.nestedInvocationId }
        : {}),
    };
  }

  /** The inline config opencode runs under and what its environment must carry
   *  beside it, or null when no credential for this host is configured.
   *
   *  On the xAI host the credential goes into the environment as well, under
   *  the catalog's name for it: opencode registers its xai model loader — the
   *  one that selects the Responses API over the bundled SDK's chat completions
   *  model, whose stream handling fails a turn on a chunk carrying reasoning
   *  and content together — only for a provider that exists when its loaders
   *  run, and a key in the config alone does not create one. The config's
   *  `options.apiKey` stays the credential actually used (adapter/opencode/server.ts). */
  private async launchSettings(
    inv: RunnerInvocation,
    providerId: string,
    model: string,
    xai: boolean,
  ): Promise<{ config: string; env: Record<string, string> } | null> {
    // A customer-funded Grok session reaches xAI through Liftoff's gateway,
    // which holds the real key; the token here is the per-run credential for
    // that gateway, never the customer's own.
    const byokXai = inv.byok?.vendor === 'xai' ? inv.byok : undefined;
    const apiKey = byokXai ? byokXai.token : xai ? await getXaiApiKey() : await getOpenRouterApiKey();
    if (!apiKey) {
      logger.warn(
        { providerId, invocationId: inv.context.invocationId },
        'opencode_code_session_no_api_key: no credential configured for this host',
      );
      return null;
    }

    const baseURL = byokXai
      ? `${byokXai.baseUrl.replace(/\/+$/, '')}/v1`
      : xai ? xaiCodeSessionBaseUrl() : OPENROUTER_BASE_URL;

    const config = JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      provider: {
        [providerId]: {
          options: { apiKey, baseURL },
          // The registry files a model under its FAMILY; `providerId` above is
          // the TRANSPORT opencode reaches it through. They were the same
          // string while the gateway families all resolved to 'openrouter',
          // and stopped being the same the day a family became its own
          // provider — so looking the window up by transport silently missed
          // and every coding session lost its compaction limit.
          models: { [model]: opencodeModelEntry(familyOfModelId(model) ?? providerId, model) },
        },
      },
      tools: OPENCODE_CODING_TOOLS_DENIED,
      permission: { question: 'deny' },
    });
    return { config, env: xai ? { XAI_API_KEY: apiKey } : {} };
  }
}
