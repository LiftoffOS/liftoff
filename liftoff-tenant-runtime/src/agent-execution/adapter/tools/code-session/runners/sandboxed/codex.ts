// Codex as a CLI, inside the sandbox.
//
// `@openai/codex-sdk` spawns this same binary and translates its JSONL into
// ThreadEvents, so the event names and item shapes here are the SDK's — which
// is why the item mapper and the usage mappers come from codex-events.ts,
// shared with the in-process runner, rather than being written again.
//
// ── The flag ───────────────────────────────────────────────────────────────
// The JSONL flag has been renamed, and the two names do not overlap. Measured:
// `@openai/codex-sdk@0.146.0` passes `--experimental-json`, while the CLI at
// 0.144.6 advertises `--json` and does NOT accept `--experimental-json`. So the
// name is a property of the CLI in the image, not something to infer from the
// SDK version, and the coding image pins a version whose flag was checked.
//
// ── Why the vendor sandbox is off ──────────────────────────────────────────
// `--dangerously-bypass-approvals-and-sandbox` reads alarmingly and is exactly
// right here. Codex's own help gives its intended use: "Intended solely for
// running in environments that are externally sandboxed." This is that
// environment. Leaving Codex's seatbelt/landlock sandbox on inside a container
// that is already the isolation boundary buys nothing and fails in ways that
// depend on the host kernel.

import { logger } from '../../../../../../infrastructure/logging';
import { parseNdjson } from '../anthropic-stream';
import { handleItem, modelUsageFrom, usageToRecord } from '../codex-events';
import {
  OPENROUTER_BASE_URL,
  codeModelForSession,
  isGrokCodeSession,
  usesXaiHost,
  xaiCodeSessionBaseUrl,
} from '../openrouter';
import { xaiNativeModelId } from '../../../../../../llm/providers/xai';
import { classifyCliExit, MAX_CLI_STDOUT_BYTES, requireWorkspace, stderrForLog } from './shared';
import type {
  CodeSessionModelUsage,
  CodeSessionProvider,
  CodeSessionRunner,
  RunnerInvocation,
  RunnerResult,
} from '../../types';

/** The JSONL flag the pinned CLI accepts. See the header. */
const CODEX_JSON_FLAG = '--json';

interface CodexCliEvent {
  type?: string;
  item?: { type?: string } & Record<string, unknown>;
  usage?: Record<string, unknown>;
  error?: { message?: string };
  message?: string;
}

export class SandboxedOpenAICodeSessionRunner implements CodeSessionRunner {
  readonly provider: CodeSessionProvider = 'openai';

  /** The model to run on, or undefined to let Codex keep its own default. */
  protected threadModel(inv: RunnerInvocation): string | undefined {
    return inv.model;
  }

  /** Where the CLI sends its requests, when it is not the vendor default. */
  protected baseUrlOverride(_inv: RunnerInvocation): string | undefined {
    return undefined;
  }

  async run(inv: RunnerInvocation): Promise<RunnerResult> {
    const workspace = requireWorkspace(inv);
    const model = this.threadModel(inv);
    const baseUrl = this.baseUrlOverride(inv);

    const argv = [
      'codex', 'exec',
      CODEX_JSON_FLAG,
      '--cd', inv.workspaceRoot,
      // The outer handler already cloned; Codex need not insist on finding a
      // repository of its own making.
      '--skip-git-repo-check',
      // The container is the sandbox. See the header.
      '--dangerously-bypass-approvals-and-sandbox',
      // Nothing here outlives the session, and a session file written into the
      // checkout would show up in the diff as the agent's work.
      '--ephemeral',
      ...(model ? ['--model', model] : []),
      inv.task,
    ];

    const result = await workspace.exec(argv, {
      cwd: inv.workspaceRoot,
      timeoutMs: inv.timeoutMs,
      signal: inv.signal,
      maxOutputBytes: MAX_CLI_STDOUT_BYTES,
      ...(baseUrl ? { env: { OPENAI_BASE_URL: baseUrl } } : {}),
    });

    const toolCallsMade: RunnerResult['tool_calls_made'] = [];
    let summary = '';
    let usage: Record<string, unknown> | undefined;
    let modelUsage: CodeSessionModelUsage[] | undefined;
    let sawTerminal = false;
    let streamExitReason: RunnerResult['exit_reason'] = 'success';

    for (const event of parseNdjson<CodexCliEvent>(result.stdout)) {
      switch (event.type) {
        case 'item.completed':
          if (event.item) {
            handleItem(
              event.item,
              toolCallsMade,
              (s) => { summary = s; },
            );
          }
          break;
        case 'turn.completed':
          sawTerminal = true;
          usage = event.usage ? usageToRecord(event.usage) : usage;
          modelUsage = modelUsageFrom(
            event.usage,
            model,
          ) ?? modelUsage;
          break;
        case 'turn.failed':
          sawTerminal = true;
          streamExitReason = 'error';
          // A failed turn spent whatever it spent before failing. Read usage
          // defensively rather than assuming it can never appear: if the vendor
          // starts reporting it, this meters it the day it lands.
          modelUsage = modelUsageFrom(
            event.usage,
            model,
          ) ?? modelUsage;
          logger.warn(
            { err: event.error?.message, invocationId: inv.context.invocationId },
            'codex_turn_failed',
          );
          break;
        case 'error':
          sawTerminal = true;
          streamExitReason = 'error';
          logger.warn(
            { err: event.message, invocationId: inv.context.invocationId },
            'codex_stream_error',
          );
          break;
        // thread.started / turn.started / item.started / item.updated: observed
        // but not user-visible; ignore.
      }
    }

    const exitReason = classifyCliExit({
      result, sawTerminal, streamExitReason, aborted: inv.signal.aborted,
    });

    if (!sawTerminal) {
      logger.warn(
        {
          invocationId: inv.context.invocationId,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          stderr: stderrForLog(result),
        },
        'codex_cli_session_produced_no_terminal_event',
      );
    }

    if (inv.captureNestedTrajectory && inv.nestedInvocationId) {
      const { recordCanonicalMessage } = await import('../../../../../../trajectories/recorder');
      const content: import('../../../../../../trajectories/types').CanonicalContentBlock[] = [];
      if (summary) content.push({ type: 'text', text: summary });
      for (const t of toolCallsMade) {
        content.push({
          type: 'tool_use', id: '', name: t.tool, input: (t.args ?? {}) as Record<string, unknown>,
        });
      }
      // The pinned model when there is one, otherwise the engine label. Codex
      // exposes no model id on any event, so unlike the Anthropic path this
      // cannot report the real default, and inventing one would be worse.
      recordCanonicalMessage(
        inv.nestedInvocationId,
        'openai',
        model ?? 'codex-cli-session',
        { role: 'assistant', content },
      );
    }

    return {
      summary,
      tool_calls_made: toolCallsMade,
      exit_reason: exitReason,
      ...(usage ? { usage } : {}),
      ...(modelUsage ? { modelUsage } : {}),
      ...(inv.captureNestedTrajectory && inv.nestedInvocationId
        ? { code_session_trajectory_id: inv.nestedInvocationId }
        : {}),
    };
  }
}

/** The open-weights coder: the same Codex binary pointed at OpenRouter, or at
 *  xAI directly for Grok. */
export class SandboxedOpenRouterCodeSessionRunner extends SandboxedOpenAICodeSessionRunner {
  override readonly provider: CodeSessionProvider = 'openrouter';

  protected override baseUrlOverride(inv: RunnerInvocation): string {
    // Grok leaves OpenRouter entirely — see the in-process runner's header for
    // why the host, the id namespace and the rate table move together. A
    // customer-funded session reaches xAI through Liftoff's gateway; a managed
    // one goes to xAI directly. Same OpenAI wire format on every path.
    if (inv.byok?.vendor === 'xai') return `${inv.byok.baseUrl.replace(/\/+$/, '')}/v1`;
    if (isGrokCodeSession(inv.context)) return xaiCodeSessionBaseUrl();
    return OPENROUTER_BASE_URL;
  }

  /** Always a model, unlike the OpenAI case.
   *
   *  Codex against api.openai.com has a default of its own; against OpenRouter
   *  it does not, so omitting the flag there is not "let the vendor choose", it
   *  is an unroutable request. Falls back to the vendor-matched coder picked
   *  from the outer agent's model id, exactly as the in-process runner does.
   *
   *  A Grok session names the model WITHOUT the OpenRouter publisher prefix:
   *  `x-ai/grok-4.6` is OpenRouter's namespace for it, and xAI's own API — the
   *  host every Grok session now uses — calls it `grok-4.6`. */
  protected override threadModel(inv: RunnerInvocation): string {
    const model = inv.model ?? codeModelForSession(inv.context);
    return usesXaiHost(inv) ? xaiNativeModelId(model) : model;
  }
}
