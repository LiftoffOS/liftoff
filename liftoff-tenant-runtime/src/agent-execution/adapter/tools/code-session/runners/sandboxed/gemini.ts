// The Gemini CLI, inside the sandbox.
//
// The shortest of the four, because the in-process runner was already a CLI:
// there is no SDK for it (`@google/gemini-cli-sdk` 404s on npm), so the only
// difference here is which workspace runs the binary.
//
// It is also the one whose error handling gets simpler rather than more
// complicated. `execFile` rejects on a non-zero exit and hands the output back
// on the error object, so the in-process runner has to parse the same JSON in
// two places — once on the happy path and once out of `err.stdout`. The
// workspace does not throw, so there is one path here.

import { logger } from '../../../../../../infrastructure/logging';
import { geminiModelUsage, primaryModel, type GeminiJsonOutput } from '../gemini';
import { classifyCliExit, MAX_CLI_STDOUT_BYTES, requireWorkspace, stderrForLog } from './shared';
import type { CodeSessionRunner, RunnerInvocation, RunnerResult } from '../../types';

export class SandboxedGeminiCodeSessionRunner implements CodeSessionRunner {
  readonly provider = 'google' as const;

  async run(inv: RunnerInvocation): Promise<RunnerResult> {
    const workspace = requireWorkspace(inv);

    const argv = [
      'gemini',
      '-p', inv.task,
      '-o', 'json',
      '--yolo',                       // auto-approve tool actions
      '--skip-trust',                 // a fresh checkout in a sandbox; trust it
      '--approval-mode', 'yolo',      // belt-and-suspenders with --yolo
      // Only when an operator pinned one. Without it the CLI keeps its own
      // default model, which is the behaviour we intend.
      ...(inv.model ? ['-m', inv.model] : []),
    ];

    const result = await workspace.exec(argv, {
      cwd: inv.workspaceRoot,
      timeoutMs: inv.timeoutMs,
      signal: inv.signal,
      maxOutputBytes: MAX_CLI_STDOUT_BYTES,
    });

    let parsed: GeminiJsonOutput | null = null;
    try {
      parsed = JSON.parse(result.stdout) as GeminiJsonOutput;
    } catch (parseErr) {
      logger.warn(
        {
          err: (parseErr as Error).message,
          invocationId: inv.context.invocationId,
          head: result.stdout.slice(0, 500),
          exitCode: result.exitCode,
          stderr: stderrForLog(result),
        },
        'gemini_json_parse_failed',
      );
    }

    // Unparseable output means the session did not report a result, whatever
    // the exit code said — the same requirement the other two CLIs get from
    // `sawTerminal`.
    const exitReason = classifyCliExit({
      result,
      sawTerminal: parsed !== null,
      streamExitReason: parsed?.error ? 'error' : 'success',
      aborted: inv.signal.aborted,
    });

    if (!parsed) {
      return { summary: '', tool_calls_made: [], exit_reason: exitReason };
    }
    if (parsed.error) {
      logger.warn(
        { err: parsed.error.message, errType: parsed.error.type, invocationId: inv.context.invocationId },
        'gemini_turn_errored',
      );
    }

    // Metered on every path: a turn that errored or was killed mid-way still
    // spent every token it spent before that.
    const usage = geminiModelUsage(inv, parsed.stats);

    if (inv.captureNestedTrajectory && inv.nestedInvocationId && parsed.response) {
      const { recordCanonicalMessage } = await import('../../../../../../trajectories/recorder');
      // The REAL model, off the CLI's own per-model stats — not a placeholder
      // and not the pin, because a pin is a request and this is what ran.
      const model = primaryModel(usage) ?? inv.model ?? 'gemini-cli-session';
      recordCanonicalMessage(inv.nestedInvocationId, 'google', model, {
        role: 'assistant',
        content: [{ type: 'text', text: parsed.response }],
      });
    }

    return {
      summary: parsed.response ?? '',
      // The CLI's JsonFormatter exposes no per-tool-call detail. The outer
      // handler still captures `files_modified` from the post-run git diff, so
      // file changes stay visible — only shell commands and MCP dispatches do
      // not.
      tool_calls_made: [],
      exit_reason: exitReason,
      ...(parsed.stats ? { usage: parsed.stats } : {}),
      ...(usage ? { modelUsage: usage } : {}),
      ...(inv.captureNestedTrajectory && inv.nestedInvocationId
        ? { code_session_trajectory_id: inv.nestedInvocationId }
        : {}),
    };
  }
}
