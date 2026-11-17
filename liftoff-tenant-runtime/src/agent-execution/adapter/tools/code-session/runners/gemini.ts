// Gemini code_session runner.
//
// Spawns the `gemini` CLI (from @google/gemini-cli, installed globally in
// the Dockerfile) as a child process in headless mode. Reads JSON output
// produced by the CLI's JsonFormatter:
//
//   {
//     "session_id": "<uuid>",
//     "response": "<final assistant text>",
//     "stats": { ... per-turn metrics, including token totals ... },
//     "error": { "type": "...", "message": "..." } | undefined,
//     "warnings": ["..."] | undefined
//   }
//
// JsonFormatter shape verified at node_modules/@google/gemini-cli/bundle/
// chunk-6ZHP2EJW.js (search: `var JsonFormatter = class`). The CLI exits
// with a non-zero code on hard failure; the `error` field is also populated
// when the model itself errors mid-turn.
//
// No SDK package exists yet (`@google/gemini-cli-sdk` returns 404 on npm),
// so we shell out via execFile and parse the buffered stdout.
//
// Auth: the CLI reads GEMINI_API_KEY / GOOGLE_GENAI_USE_VERTEXAI /
// GOOGLE_GENAI_USE_GCA from env. Production runs on tenant-runtime where
// GEMINI_API_KEY is mounted from Secret Manager via Cloud Run.

import { execFile } from 'child_process';
import { promisify } from 'util';
import { logger } from '../../../../../infrastructure/logging';
import { childProcessEnv } from '../../../child-process-env';
import type {
  CodeSessionModelUsage,
  CodeSessionRunner,
  RunnerInvocation,
  RunnerResult,
} from '../types';

const execFileAsync = promisify(execFile);

export interface GeminiJsonOutput {
  session_id?: string;
  response?: string;
  stats?: Record<string, unknown>;
  error?: { type?: string; message?: string };
  warnings?: string[];
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Per-model usage out of the CLI's `stats` blob.
 *
 * The shape is verified against the pinned CLI (@google/gemini-cli@0.52.0,
 * `bundle/chunk-7LQRUKPT.js`): in `-o json` mode the CLI hands `JsonFormatter`
 * the raw `uiTelemetryService.getMetrics()` SessionMetrics, whose `models` map
 * is keyed BY MODEL NAME with `tokens.{total, prompt, candidates, cached}` —
 * the same fields `convertToStreamStats` reads for its own per-model
 * breakdown. So the Gemini path knows exactly which model ran and can be priced
 * off the normal rate table rather than counted as unpriceable.
 *
 * Still read defensively and claims NOTHING when the shape does not match:
 * `stats` is the CLI's contract, not ours, and a CLI upgrade could move it.
 * Returning zeroes instead would be worse than returning nothing — zeroes look
 * like a metered session that happened to be free and would hide the gap
 * forever. The caller logs a mismatch so an unmetered session is visible.
 */
export function geminiModelUsage(
  inv: RunnerInvocation,
  stats: Record<string, unknown> | undefined,
): CodeSessionModelUsage[] | undefined {
  const models = (stats as { models?: Record<string, unknown> } | undefined)?.models;
  if (!models || typeof models !== 'object') {
    if (stats) {
      logger.warn(
        { invocationId: inv.context.invocationId, statsKeys: Object.keys(stats) },
        'gemini_code_session_usage_unreadable',
      );
    }
    return undefined;
  }

  const usage: CodeSessionModelUsage[] = [];
  for (const [model, entry] of Object.entries(models)) {
    const tokens = (entry as { tokens?: Record<string, unknown> } | undefined)?.tokens;
    if (!tokens || typeof tokens !== 'object') continue;
    const inputTokens = num(tokens.prompt);
    const outputTokens = num(tokens.candidates);
    const cachedTokens = num(tokens.cached);
    if (inputTokens === 0 && outputTokens === 0 && cachedTokens === 0) continue;
    // The CLI's own key IS the model id. A pin cannot override it: what ran is
    // what ran, and the pin is only a request.
    usage.push({ model, inputTokens, outputTokens, cachedTokens });
  }

  if (usage.length === 0) {
    logger.warn(
      { invocationId: inv.context.invocationId, modelKeys: Object.keys(models) },
      'gemini_code_session_usage_unreadable',
    );
    return undefined;
  }
  return usage;
}

/** The model that did most of the generating, for labelling the trajectory.
 *  The CLI can touch more than one model in a session (a flash summariser
 *  alongside the main model); the one that produced the most output is the one
 *  a reader means by "which model wrote this". */
export function primaryModel(usage: CodeSessionModelUsage[] | undefined): string | undefined {
  if (!usage || usage.length === 0) return undefined;
  return usage.reduce((best, u) => (u.outputTokens > best.outputTokens ? u : best)).model;
}

export class GeminiCodeSessionRunner implements CodeSessionRunner {
  readonly provider = 'google' as const;

  async run(inv: RunnerInvocation): Promise<RunnerResult> {
    const args = [
      '-p', inv.task,
      '-o', 'json',
      '--yolo',                       // auto-approve tool actions
      '--skip-trust',                 // workspace is a fresh temp dir; trust it
      '--approval-mode', 'yolo',      // belt-and-suspenders with --yolo
      // Only when an operator pinned one. Without it the CLI keeps its own
      // default model, which is the behaviour we intend.
      ...(inv.model ? ['-m', inv.model] : []),
    ];

    try {
      const running = execFileAsync('gemini', args, {
        cwd: inv.workspaceRoot,
        // Allow-listed, not inherited. This child runs the agent's shell in a
        // checkout; handing it this process's environment hands it the Cloud
        // SQL password and every service token. See child-process-env.ts.
        env: childProcessEnv({ GEMINI_API_KEY: process.env.GEMINI_API_KEY }),
        signal: inv.signal,
        // Coding sessions can produce large diffs; the outer handler caps the
        // workspace at 200MB, so this matches the worst-case stdout footprint.
        maxBuffer: 200 * 1024 * 1024,
        timeout: inv.timeoutMs,
      });
      // The CLI reads a piped prompt whenever stdin is not a TTY, and execFile's
      // stdin is a pipe it never closes: EOF now, so it never waits on it. The
      // same rule as the code_session workspace (workspace.ts, property 3).
      (running as { child?: { stdin?: { end(): void } | null } }).child?.stdin?.end();
      const { stdout } = await running;

      let parsed: GeminiJsonOutput;
      try {
        parsed = JSON.parse(stdout);
      } catch (parseErr) {
        logger.warn(
          { err: (parseErr as Error).message, invocationId: inv.context.invocationId, head: stdout.slice(0, 500) },
          'gemini_json_parse_failed',
        );
        return { summary: '', tool_calls_made: [], exit_reason: 'error' };
      }

      if (parsed.error) {
        logger.warn(
          { err: parsed.error.message, errType: parsed.error.type, invocationId: inv.context.invocationId },
          'gemini_turn_errored',
        );
        // Metered on the error path too: a turn that errored mid-way still
        // spent every token it spent before erroring.
        const erroredUsage = geminiModelUsage(inv, parsed.stats);
        return {
          summary: parsed.response ?? '',
          tool_calls_made: [],
          exit_reason: 'error',
          usage: parsed.stats,
          ...(erroredUsage ? { modelUsage: erroredUsage } : {}),
        };
      }

      // Part 6 §A3 — nested code_session capture (Gemini CLI subprocess).
      // The CLI's JsonFormatter doesn't expose inner SDK blocks, so we
      // synthesize a single canonical message from the summary and write
      // it directly to the recorder buffer.
      const succeededUsage = geminiModelUsage(inv, parsed.stats);
      if (inv.captureNestedTrajectory && inv.nestedInvocationId && parsed.response) {
        const { recordCanonicalMessage } = await import('../../../../../trajectories/recorder');
        // The REAL model, off the CLI's own per-model stats — not a placeholder
        // and not the pin, because a pin is a request and this is what ran.
        // 'gemini-cli-session' survives only for a session whose stats the CLI
        // did not report, where no model id exists to record.
        const model = primaryModel(succeededUsage) ?? inv.model ?? 'gemini-cli-session';
        recordCanonicalMessage(inv.nestedInvocationId, 'google', model, {
          role: 'assistant',
          content: [{ type: 'text', text: parsed.response }],
        });
      }
      return {
        summary: parsed.response ?? '',
        // The CLI's JsonFormatter doesn't expose per-tool-call detail. The
        // outer handler still captures `files_modified` from the post-run
        // git diff scan, so the platform doesn't lose visibility into file
        // changes — only into shell commands and MCP tool dispatches.
        tool_calls_made: [],
        exit_reason: 'success',
        usage: parsed.stats,
        ...(succeededUsage ? { modelUsage: succeededUsage } : {}),
        ...(inv.captureNestedTrajectory && inv.nestedInvocationId
          ? { code_session_trajectory_id: inv.nestedInvocationId }
          : {}),
      };
    } catch (err) {
      if (inv.signal.aborted) {
        return { summary: '', tool_calls_made: [], exit_reason: 'timeout' };
      }
      const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
      // execFile rejects with the partial stdout on non-zero exit. Try to
      // surface the JSON error shape if it's there.
      if (e.stdout) {
        try {
          const parsed = JSON.parse(e.stdout) as GeminiJsonOutput;
          if (parsed.error) {
            logger.warn(
              { err: parsed.error.message, invocationId: inv.context.invocationId },
              'gemini_subprocess_errored',
            );
            // Same reasoning as the in-band error path: a non-zero exit does
            // not refund the tokens already spent.
            const failedUsage = geminiModelUsage(inv, parsed.stats);
            return {
              summary: parsed.response ?? '',
              tool_calls_made: [],
              exit_reason: 'error',
              usage: parsed.stats,
              ...(failedUsage ? { modelUsage: failedUsage } : {}),
            };
          }
        } catch {
          // fall through to generic error
        }
      }
      logger.warn(
        { err: e.message, code: e.code, invocationId: inv.context.invocationId },
        'gemini_sub_handler_errored',
      );
      return { summary: '', tool_calls_made: [], exit_reason: 'error' };
    }
  }
}
