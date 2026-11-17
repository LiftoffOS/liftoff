// Pieces every sandboxed runner needs.
//
// A sandboxed runner drives the vendor's CLI through the workspace instead of
// linking its SDK, because an SDK runs in THIS process and the checkout is in
// another container. The runners differ in which binary they invoke and how
// they read its output; everything below is what they share.

import type { CodeSessionExitReason, RunnerInvocation } from '../../types';
import type { CodeSessionExecResult, CodeSessionWorkspace } from '../../workspace';

/** Most stdout a coding CLI may return. The sandbox caps its own transfer well
 *  below this; the number is here so the in-process workspace, which has no
 *  such cap, does not buffer an unbounded stream on a runaway session. */
export const MAX_CLI_STDOUT_BYTES = 8 * 1024 * 1024;

/** The workspace, or a refusal that says what is actually wrong.
 *
 *  A sandboxed runner cannot fall back to spawning in-process: that is the
 *  behaviour it exists to replace, and doing it silently would put the coding
 *  agent back in the runtime's container under the runtime's service account
 *  while the logs said `sandbox`. */
export function requireWorkspace(inv: RunnerInvocation): CodeSessionWorkspace {
  if (!inv.workspace) {
    throw new Error(
      'sandboxed code_session runner requires a workspace; none was provided',
    );
  }
  return inv.workspace;
}

/**
 * How a CLI session ended, given what the process did and whether its output
 * ever reached a terminal message.
 *
 * The third case is the one worth naming. A CLI that is killed, crashes, or is
 * OOM-ed prints no terminal message, so a reducer that starts optimistic still
 * reads `success` — and the handler then returns whatever diff exists (usually
 * none) as a completed piece of work. "The coding agent decided nothing needed
 * changing" is a plausible answer, so nothing downstream questions it.
 *
 * `sawTerminal` is therefore a REQUIREMENT for success, not a detail: no
 * terminal message means the session did not finish, whatever the exit code
 * says.
 */
export function classifyCliExit(opts: {
  result: CodeSessionExecResult;
  sawTerminal: boolean;
  /** What the stream itself concluded, when it reached a terminal message. */
  streamExitReason: CodeSessionExitReason;
  aborted: boolean;
}): CodeSessionExitReason {
  if (opts.result.timedOut || opts.aborted) return 'timeout';
  if (!opts.sawTerminal) return 'error';
  return opts.streamExitReason;
}

/** A short, bounded slice of stderr for a log line. Never returned to the
 *  model: a coding CLI's stderr routinely echoes its own argv, and the argv can
 *  carry a gateway token. */
export function stderrForLog(result: CodeSessionExecResult): string {
  return result.stderr.trim().slice(-2000);
}
