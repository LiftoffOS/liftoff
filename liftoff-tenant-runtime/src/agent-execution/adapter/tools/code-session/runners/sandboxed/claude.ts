// Claude Code as a CLI, inside the sandbox.
//
// Same vendor and same session semantics as the in-process runner beside it;
// what changes is that the binary runs in an isolated container and its output
// arrives as one buffered NDJSON document rather than as an async iterable.
//
// The messages are identical — `claude -p --output-format stream-json
// --verbose` prints exactly the SDKMessage union the SDK yields, verified
// against the CLI at 2.1.88 — so this file does no interpreting of its own. It
// builds an argv, hands the output to the shared reducer, and classifies the
// exit. Anything it decided for itself would be a second opinion on questions
// the in-process path already answers.

import { logger } from '../../../../../../infrastructure/logging';
import {
  ANTHROPIC_DEFAULT_TOOLS,
  anthropicCodeSessionPrompt,
  applyAnthropicMessage,
  createAnthropicStreamState,
  finalizeAnthropicStream,
  parseNdjson,
} from '../anthropic-stream';
import { classifyCliExit, MAX_CLI_STDOUT_BYTES, requireWorkspace, stderrForLog } from './shared';
import type { CodeSessionRunner, RunnerInvocation, RunnerResult } from '../../types';

const MAX_TURNS = 30;

export class SandboxedAnthropicCodeSessionRunner implements CodeSessionRunner {
  readonly provider = 'anthropic' as const;

  async run(inv: RunnerInvocation): Promise<RunnerResult> {
    const workspace = requireWorkspace(inv);
    const allowedTools = inv.allowedTools.length > 0 ? inv.allowedTools : ANTHROPIC_DEFAULT_TOOLS;

    const argv = [
      'claude',
      '-p', anthropicCodeSessionPrompt(inv.task, inv.workspaceRoot),
      '--output-format', 'stream-json',
      // stream-json in print mode emits nothing without it; the SDK passes it
      // for the same reason.
      '--verbose',
      '--max-turns', String(MAX_TURNS),
      // The CLI's own permission prompts have no one to answer them here, and
      // its help names this flag's intended setting exactly: "Recommended only
      // for sandboxes". That is what this is — the isolation is the container,
      // not the CLI's own gate.
      '--permission-mode', 'bypassPermissions',
      '--allowedTools', ...allowedTools,
      // Only when an operator pinned one; otherwise the CLI's own default
      // model stands, which is what it is chosen for.
      ...(inv.model ? ['--model', inv.model] : []),
    ];

    const result = await workspace.exec(argv, {
      cwd: inv.workspaceRoot,
      timeoutMs: inv.timeoutMs,
      signal: inv.signal,
      maxOutputBytes: MAX_CLI_STDOUT_BYTES,
    });

    const state = createAnthropicStreamState();
    let nestedRecorder: ReturnType<typeof import('../../../../../../trajectories/recorder').makeRecorder> | null = null;
    if (inv.captureNestedTrajectory && inv.nestedInvocationId) {
      const { makeRecorder } = await import('../../../../../../trajectories/recorder');
      nestedRecorder = makeRecorder(inv.nestedInvocationId);
    }

    for (const message of parseNdjson(result.stdout)) {
      if (nestedRecorder && message.type === 'assistant' && message.message) {
        nestedRecorder.recordRaw({
          invocationId: inv.nestedInvocationId!,
          provider: 'anthropic',
          model: message.message.model ?? 'claude-code-session',
          rawKind: 'anthropic_sdk_message',
          raw: message.message,
        });
      }
      applyAnthropicMessage(state, message);
      if (state.done) break;
    }

    const exitReason = classifyCliExit({
      result,
      sawTerminal: state.done,
      streamExitReason: state.exitReason,
      aborted: inv.signal.aborted,
    });

    if (!state.done) {
      // No terminal message. Whatever the exit code, this session did not
      // finish, and its usage is unknown rather than zero.
      logger.warn(
        {
          invocationId: inv.context.invocationId,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          stderr: stderrForLog(result),
        },
        'claude_code_cli_session_produced_no_result_message',
      );
    }
    if (state.apiErrorUnderSuccess) {
      logger.warn(
        {
          invocationId: inv.context.invocationId,
          apiErrorStatus: state.apiErrorUnderSuccess.status,
        },
        'claude_code_session_api_error_under_success_subtype',
      );
    }

    return {
      ...finalizeAnthropicStream(state),
      exit_reason: exitReason,
      ...(inv.captureNestedTrajectory && inv.nestedInvocationId
        ? { code_session_trajectory_id: inv.nestedInvocationId }
        : {}),
    };
  }
}
