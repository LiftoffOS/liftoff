// Anthropic code_session runner, in-process transport.
// Uses @anthropic-ai/claude-agent-sdk@0.3.220 with the 'claude_code' preset
// (Bash/Read/Write/Edit/Glob/Grep/Task).
//
// This runner spawns inside the tenant runtime's own container. Reading the
// session is NOT here: it is in anthropic-stream.ts, shared with the sandboxed
// transport, which drives the same vendor through its CLI and receives the same
// messages. Only the transport differs, so only the transport is duplicated.

import { query } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '../../../../../infrastructure/logging';
import { childProcessEnv } from '../../../child-process-env';
import {
  ANTHROPIC_DEFAULT_TOOLS,
  anthropicCodeSessionPrompt,
  applyAnthropicMessage,
  createAnthropicStreamState,
  finalizeAnthropicStream,
  type AnthropicMessage,
} from './anthropic-stream';
import type { CodeSessionRunner, RunnerInvocation, RunnerResult } from '../types';
import { getManagedSecret } from '../../../../../infrastructure/secret-store';

export class AnthropicCodeSessionRunner implements CodeSessionRunner {
  readonly provider = 'anthropic' as const;

  async run(inv: RunnerInvocation): Promise<RunnerResult> {
    const state = createAnthropicStreamState();
    const allowedTools = inv.allowedTools.length > 0 ? inv.allowedTools : ANTHROPIC_DEFAULT_TOOLS;

    const sdkQuery = query({
      prompt: anthropicCodeSessionPrompt(inv.task, inv.workspaceRoot),
      options: {
        cwd: inv.workspaceRoot,
        // VERIFIED sdk.d.ts:1030 — string[] | { type: 'preset', preset: 'claude_code' }
        tools: { type: 'preset', preset: 'claude_code' } as Parameters<typeof query>[0]['options'] extends infer O
          ? O extends { tools?: infer T } ? T : never : never,
        allowedTools,
        maxTurns: 30,
        // Omitted unless an operator pinned one. sdk.d.ts:1710 — "Defaults to
        // the CLI default model", which is the behaviour we want: the coding
        // agent's own default is chosen for coding, and the outer agent's
        // reasoning model has no business overriding it. What this restores is
        // only that a DELIBERATE pin is no longer silently discarded.
        ...(inv.model ? { model: inv.model } : {}),
        // This session is the sharpest case for an allow-listed environment:
        // its whole job is running Bash in a checkout, so anything inherited
        // here is something the coding agent can read and be talked into
        // sending somewhere. The git credentials it pushes with are not
        // withheld by this — the clone URL already carries the token, so they
        // live in the checkout's own .git/config rather than in the
        // environment. See child-process-env.ts.
        env: childProcessEnv(
          inv.byok?.vendor === 'anthropic'
            ? {
                ANTHROPIC_BASE_URL: inv.byok.baseUrl,
                ANTHROPIC_AUTH_TOKEN: inv.byok.token,
                ANTHROPIC_API_KEY: inv.byok.token,
              }
            : { ANTHROPIC_API_KEY: getManagedSecret('ANTHROPIC_API_KEY') },
        ),
      },
    });

    // Part 6 §A3 — nested code_session capture (Anthropic case). If the
    // dispatch site opted in via captureNestedTrajectory, register a
    // recorder under the nested invocation id so each assistant turn's
    // raw blocks land in their own buffer.
    let nestedRecorder: ReturnType<typeof import('../../../../../trajectories/recorder').makeRecorder> | null = null;
    if (inv.captureNestedTrajectory && inv.nestedInvocationId) {
      const { makeRecorder } = await import('../../../../../trajectories/recorder');
      nestedRecorder = makeRecorder(inv.nestedInvocationId);
    }

    // The stream is consumed inside a try so a mid-session SDK failure returns
    // what the session already did — its tool calls, its summary, and above all
    // its usage — instead of throwing them away. A runner that throws loses the
    // tokens the vendor already charged us for, and the dispatch site cannot
    // meter what it never receives.
    try {
      for await (const message of sdkQuery) {
        if (inv.signal.aborted) {
          await sdkQuery.interrupt();
          state.exitReason = 'timeout';
          break;
        }
        if (nestedRecorder && message.type === 'assistant' && message.message) {
          nestedRecorder.recordRaw({
            invocationId: inv.nestedInvocationId!,
            provider: 'anthropic',
            // The REAL model id, off the assistant turn itself. The literal
            // 'claude-code-session' that used to sit here is not a model — it
            // named the engine, so no consumer of these trajectories could say
            // which model produced a given diff. The session runs on the CLI's
            // default, which is exactly the thing worth recording.
            model: message.message.model ?? 'claude-code-session',
            rawKind: 'anthropic_sdk_message',
            raw: message.message,
          });
        }
        applyAnthropicMessage(state, message as AnthropicMessage);
        if (state.done) break;
      }
    } catch (err) {
      // An abort surfaces here as a thrown error on some SDK paths; it is a
      // timeout, not a failure of the code.
      state.exitReason = inv.signal.aborted ? 'timeout' : 'error';
      logger.warn(
        { err: (err as Error).message, invocationId: inv.context.invocationId },
        'claude_code_session_stream_failed',
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
      ...(inv.captureNestedTrajectory && inv.nestedInvocationId
        ? { code_session_trajectory_id: inv.nestedInvocationId }
        : {}),
    };
  }
}
