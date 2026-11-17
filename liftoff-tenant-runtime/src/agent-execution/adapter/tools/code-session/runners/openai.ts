// OpenAI Codex code_session runner.
//
// Uses @openai/codex-sdk@^0.139.0 (ESM-only). API surface verified against
// node_modules/@openai/codex-sdk/dist/index.d.ts:
//   - new Codex(options?: CodexOptions)
//   - codex.startThread(options?: ThreadOptions): Thread
//   - thread.runStreamed(input, turnOptions?): Promise<StreamedTurn>
//   - StreamedTurn.events: AsyncGenerator<ThreadEvent>
// ThreadEvent variants: thread.started | turn.started | turn.completed |
//                       turn.failed | item.started | item.updated |
//                       item.completed | error
// ThreadItem variants (carried by item.completed):
//   agent_message | reasoning | command_execution | file_change |
//   mcp_tool_call | web_search | todo_list | error
//
// The SDK spawns the Codex CLI binary as a child process. The Dockerfile
// must install Codex CLI globally:
//   RUN npm install -g @openai/codex@latest

import type { Codex, Thread, ThreadEvent, ThreadItem, Usage } from '@openai/codex-sdk';
import { esmImport } from '../../../esm-import';
import { logger } from '../../../../../infrastructure/logging';
import { childProcessEnv } from '../../../child-process-env';
import { handleItem, modelUsageFrom, usageToRecord } from './codex-events';
import type {
  CodeSessionModelUsage,
  CodeSessionProvider,
  CodeSessionRunner,
  RunnerInvocation,
  RunnerResult,
} from '../types';
import { getManagedSecret } from '../../../../../infrastructure/secret-store';

export class OpenAICodeSessionRunner implements CodeSessionRunner {
  readonly provider: CodeSessionProvider = 'openai';

  /** Construct the Codex client. OpenAI reads OPENAI_API_KEY from env; subclasses
   *  (OpenRouterCodeSessionRunner) override to point Codex at another OpenAI-wire host.
   *
   *  BYO provider keys re-point it at the Liftoff gateway with a short-lived
   *  per-run token, which is why the invocation is a parameter: the credential
   *  belongs to the run, not to the runner. The token is never a customer key —
   *  the real one is attached on the far side, out of reach of the coding
   *  agent's own shell. */
  protected async makeCodex(inv: RunnerInvocation): Promise<Codex> {
    // @openai/codex-sdk is ESM-only (exports map, no CJS main); a static import
    // compiles to require() and throws ERR_PACKAGE_PATH_NOT_EXPORTED under Node's
    // CJS loader. Load it via dynamic import at runtime instead.
    const { Codex } = await esmImport<typeof import('@openai/codex-sdk')>('@openai/codex-sdk');
    const codexPathOverride = process.env.CODEX_CLI_PATH || '/usr/local/bin/codex';
    // `env` replaces the child's environment rather than extending it (the SDK
    // says so: "When provided, the SDK will not inherit variables from
    // process.env"), which is exactly what is wanted — this child runs the
    // agent's shell. See child-process-env.ts.
    if (inv.byok?.vendor === 'openai') {
      // The `/v1` suffix is the Codex CLI's own convention for an OpenAI-wire
      // base URL, the same shape the OpenRouter subclass passes.
      return new Codex({
        baseUrl: `${inv.byok.baseUrl.replace(/\/+$/, '')}/v1`,
        apiKey: inv.byok.token,
        codexPathOverride,
        env: childProcessEnv(),
      });
    }
    return new Codex({
      codexPathOverride,
      env: childProcessEnv({ OPENAI_API_KEY: getManagedSecret('OPENAI_API_KEY') }),
    });
  }

  /** Model to run the thread on. `undefined` → the Codex default, which the
   *  CLI resolves from its OWN server-fetched models manifest — so it can move
   *  without a deploy here, and that is deliberate: Codex's default is chosen
   *  for coding. Returns a model only when an operator pinned one, which the
   *  dispatch site has already checked belongs to this vendor.
   *
   *  Receives the invocation so subclasses (OpenRouter) can fall back to
   *  picking the model from the outer agent's resolved model id (vendor
   *  prefix) when no pin is present. */
  protected threadModel(inv: RunnerInvocation): string | undefined {
    return inv.model;
  }

  async run(inv: RunnerInvocation): Promise<RunnerResult> {
    const toolCallsMade: RunnerResult['tool_calls_made'] = [];
    let summary = '';
    let exitReason: RunnerResult['exit_reason'] = 'success';
    let usage: Record<string, unknown> | undefined;
    let modelUsage: CodeSessionModelUsage[] | undefined;

    const codex = await this.makeCodex(inv);
    const model = this.threadModel(inv);
    const thread: Thread = codex.startThread({
      workingDirectory: inv.workspaceRoot,
      // Pre-cloned by the outer handler; skip the SDK's git-repo init check.
      skipGitRepoCheck: true,
      // Codex defaults to workspace-write sandbox, which scopes file ops
      // to cwd. That matches our temp-workspace lifecycle exactly.
      sandboxMode: 'workspace-write',
      ...(model ? { model } : {}),
    });

    try {
      const streamed = await thread.runStreamed(inv.task, { signal: inv.signal });
      for await (const event of streamed.events as AsyncGenerator<ThreadEvent>) {
        if (inv.signal.aborted) {
          exitReason = 'timeout';
          break;
        }
        switch (event.type) {
          case 'item.completed':
            handleItem(event.item, toolCallsMade, (s) => { summary = s; });
            break;
          case 'turn.completed':
            usage = usageToRecord(event.usage);
            modelUsage = modelUsageFrom(event.usage, model) ?? modelUsage;
            break;
          case 'turn.failed':
            exitReason = 'error';
            // A failed turn spent whatever it spent before failing. The SDK's
            // TurnFailedEvent declares `error` only (index.d.ts:136), so read
            // any usage defensively rather than assuming it can never appear —
            // if the vendor starts reporting it, this meters it the day it
            // lands instead of the day someone notices.
            modelUsage = modelUsageFrom(
              (event as { usage?: Usage }).usage,
              model,
            ) ?? modelUsage;
            logger.warn(
              { err: event.error.message, invocationId: inv.context.invocationId },
              'codex_turn_failed',
            );
            break;
          case 'error':
            exitReason = 'error';
            logger.warn(
              { err: event.message, invocationId: inv.context.invocationId },
              'codex_stream_error',
            );
            break;
          // thread.started / turn.started / item.started / item.updated: observed but
          // not user-visible; ignore.
        }
      }
    } catch (err) {
      if (inv.signal.aborted) {
        exitReason = 'timeout';
      } else {
        logger.warn(
          { err: (err as Error).message, invocationId: inv.context.invocationId },
          'codex_sub_handler_errored',
        );
        exitReason = 'error';
      }
    }

    // Part 6 §A3 — nested code_session capture (OpenAI Codex subprocess).
    // Codex spawns a child binary; we can't tap the inner SDK so we
    // synthesize a single canonical message from summary + tool_calls_made
    // and write it directly to the recorder buffer. (Routing it through the
    // anthropic mapper would work but mis-labels the data path; the direct
    // canonical write is the correct mechanism for synthetic captures.)
    if (inv.captureNestedTrajectory && inv.nestedInvocationId) {
      const { recordCanonicalMessage } = await import('../../../../../trajectories/recorder');
      const content: import('../../../../../trajectories/types').CanonicalContentBlock[] = [];
      if (summary) content.push({ type: 'text', text: summary });
      for (const t of toolCallsMade) {
        content.push({
          type: 'tool_use',
          id: '',
          name: t.tool,
          input: (t.args ?? {}) as Record<string, unknown>,
        });
      }
      // The pinned model when there is one, otherwise the engine label. Codex
      // exposes no model id on any event, so unlike the Anthropic runner this
      // cannot report the real default — and inventing one would be worse than
      // an obviously-generic label.
      recordCanonicalMessage(inv.nestedInvocationId, 'openai', model ?? 'codex-session', {
        role: 'assistant',
        content,
      });
    }

    return {
      summary, tool_calls_made: toolCallsMade, exit_reason: exitReason, usage,
      ...(modelUsage ? { modelUsage } : {}),
      ...(inv.captureNestedTrajectory && inv.nestedInvocationId
        ? { code_session_trajectory_id: inv.nestedInvocationId }
        : {}),
    };
  }
}
