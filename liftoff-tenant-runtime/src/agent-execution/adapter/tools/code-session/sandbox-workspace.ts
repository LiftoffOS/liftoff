// A code_session workspace inside an isolated sandbox.
//
// Same three operations as the in-process workspace, reached through the
// sandbox executor so every command keeps its audit row, its rate limit and its
// credit accounting. What changes is WHERE the command runs, and that is the
// whole point:
//
//   in-process   the tenant runtime's own container, as root, under the runtime
//                service account — which holds project-level
//                secretmanager.secretAccessor, aiplatform.user and
//                cloudsql.client on the tenant project.
//   sandbox      a per-tenant Cloud Run service under `sandbox-runtime`, a
//                service account with ZERO project roles. The metadata server
//                is still reachable there (a VPC firewall cannot block a
//                link-local address — proven in this estate with an in-sandbox
//                curl), so the token an agent can mint is real. It is simply
//                worth nothing, which is the only form of this control that
//                actually holds.
//
// ── Why every command is launched detached and polled ──────────────────────
//
// Not a style choice. `SandboxExecutorClient.execute` aborts at 120 seconds
// (AbortSignal.timeout(120_000)), and a code_session's default budget is 600.
// A coding CLI cannot be a single request, so each command is started in the
// background writing to files, polled for its exit marker, and collected.
//
// One protocol for every command rather than a short path and a long path: a
// threshold is a thing to get wrong, and `git clone` on a large repository is
// exactly the "surely that's quick" case that would sit right on it.

import { randomUUID } from 'node:crypto';
import { logger } from '../../../../infrastructure/logging';
import type {
  SandboxExecutorInterface,
  SandboxSession,
} from '../../../../execution-environments/types';
import type {
  CodeSessionExecOpts,
  CodeSessionExecResult,
  CodeSessionWorkspace,
} from './workspace';

/** Where the sandbox image mounts its writable volume. */
const SANDBOX_WORKSPACE = '/workspace';
/** Where the FIRST command runs, before the workspace tree is known to exist.
 *
 *  The sidecar prefixes every command with `cd <session cwd> &&`, so a session
 *  opened on a directory that is not there yet fails with exit 1 and no output
 *  — for every command, including the `mkdir` that would have created it. The
 *  bootstrap therefore runs somewhere that always exists and creates the tree,
 *  and only then does any session open on the workspace itself. */
const BOOTSTRAP_CWD = '/tmp';
/** The checkout, one level down so the bookkeeping directory is a sibling. */
const checkoutDir = (base: string): string => `${base}/repo`;
/** Per-command stdout/stderr/exit markers. */
const controlDir = (base: string): string => `${base}/.code-session`;

/** Bound on a single executor round trip. Well under the client's 120s abort so
 *  a slow sandbox surfaces as our timeout, with a message, rather than as a
 *  transport error with none. */
const CALL_TIMEOUT_MS = 60_000;
/** Poll backoff: how long to wait before asking again whether the command has
 *  finished.
 *
 *  It starts short and grows, rather than sitting at a single interval, because
 *  the two things being polled for are nothing alike. Most commands here are
 *  bookkeeping — `git clone`, `git diff`, a preset read — and finish in
 *  milliseconds; a flat 2-second interval made every one of them cost two
 *  seconds. A coding session runs for minutes, and polling THAT every 100ms
 *  would spend the sandbox's rate limit on questions.
 *
 *  Doubling from 100ms to 2s gives both: a fast command is noticed almost
 *  immediately, and a long one settles at the slow rate within a few seconds. */
const POLL_INITIAL_MS = 100;
const POLL_MAX_MS = 2_000;
/** Most stdout carried back from one command. The vendor CLIs stream NDJSON and
 *  the LAST line is the one that carries usage, so truncation keeps the tail
 *  rather than the head — see collectOutput. */
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

/** Sandbox provisioning is asynchronous; the executor answers `retryable` with
 *  a `retryAfterMs` until the workspace is up. */
const PROVISION_MAX_WAIT_MS = 180_000;

interface BashExecData {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  cwdAfter?: string;
}

export interface SandboxWorkspaceOpts {
  executor: SandboxExecutorInterface;
  tenantId: string;
  agentId: string;
  /** The OUTER invocation. Used for the sandbox session id and for logs, so a
   *  leaked sandbox can be traced back to the call that made it. */
  invocationId: string;
  instructionVersion?: number;
  /** Variables the coding CLI needs — the BYOK gateway URL and its per-run
   *  token, or a managed provider key. Set on the bash session at create time
   *  rather than on each command line, so they are not in the sandbox's own
   *  process list for every exec. */
  env?: Record<string, string | undefined>;
  /** The writable mount to work under. Defaults to `/workspace`, which is where
   *  the sandbox image puts it and what production always uses.
   *
   *  Injectable for one reason: the shell programs this class writes — the
   *  detached launch, the exit-marker poll, the tail collector, the process
   *  group kill — are the part most likely to be wrong, and the only way to
   *  test them against a real shell rather than a regex is to run the sidecar's
   *  own BashSession locally, where `/workspace` does not exist. A parameter
   *  with a production default buys that; a mocked shell would not. */
  rootDir?: string;
}

export class SandboxCodeSessionWorkspace implements CodeSessionWorkspace {
  readonly kind = 'sandbox' as const;
  readonly root: string;

  private constructor(
    private readonly executor: SandboxExecutorInterface,
    private readonly session: SandboxSession,
    /** The writable mount; `root` and the control directory hang off it. */
    private readonly base: string,
    /** One bash session per working directory. The sidecar's session carries a
     *  persistent cwd, so this is how a command runs somewhere other than the
     *  checkout — without a `cd` whose effect would outlive the command. */
    private readonly bashSessions: Map<string, string>,
    private readonly env: Record<string, string> | undefined,
  ) {
    this.root = checkoutDir(base);
  }

  static async create(opts: SandboxWorkspaceOpts): Promise<SandboxCodeSessionWorkspace> {
    const session: SandboxSession = {
      tenantId: opts.tenantId,
      agentId: opts.agentId,
      invocationId: opts.invocationId,
      // Its own session, not the agent's — so the coding image cannot leak into
      // the sandbox the agent's primitives share.
      //
      // Keyed on the INVOCATION and nothing else, so every code_session in one
      // turn reuses one sandbox. It used to carry a random suffix, which made
      // each call provision its own: tens of seconds even warm, paid again for
      // every call. A turn that edits three files paid it three times.
      //
      // Freshness is preserved a level down instead: each CALL gets its own
      // base directory (see `base` below), so the checkout is still empty and
      // `git clone` still lands in nothing. Sharing the sandbox shares the
      // container, not the working tree.
      sessionId: `code-session-${opts.invocationId}`,
      template: 'aio-sandbox-coding',
      instructionVersion: opts.instructionVersion,
    };

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.env ?? {})) {
      if (typeof v === 'string' && v.length > 0) env[k] = v;
    }

    // Per CALL, not per sandbox: the sandbox is shared across a turn and the
    // working tree is not. `git clone` into a directory that already holds a
    // checkout fails, so a shared root would break the second call of a turn.
    const base = opts.rootDir ?? `${SANDBOX_WORKSPACE}/cs-${randomUUID().slice(0, 8)}`;
    const workspace = new SandboxCodeSessionWorkspace(
      opts.executor,
      session,
      base,
      new Map(),
      Object.keys(env).length > 0 ? env : undefined,
    );

    // First call provisions, and is the one that has to wait out the sandbox
    // starting: everything after it finds the sandbox ready.
    //
    // It runs from BOOTSTRAP_CWD, not from the workspace. `/workspace` is a
    // mount that the image provides and production always has, but a session
    // opened on a missing directory cannot even run `mkdir` — see BOOTSTRAP_CWD
    // — so depending on it here would turn one missing mount into every command
    // failing with exit 1 and an empty message.
    const created = await workspace.runToCompletion(
      ['mkdir', '-p', checkoutDir(base), controlDir(base)],
      BOOTSTRAP_CWD,
      CALL_TIMEOUT_MS,
    );
    if (created.exitCode !== 0) {
      throw new Error(
        `could not create the code_session workspace under ${base}: `
        + `${created.stderr.trim() || `exit ${created.exitCode}`}`,
      );
    }
    return workspace;
  }

  /** The sandbox session id, for logs and for the caller that has to explain
   *  which sandbox a failure happened in. */
  get sandboxSessionId(): string {
    return this.session.sessionId;
  }

  async exec(argv: string[], opts: CodeSessionExecOpts = {}): Promise<CodeSessionExecResult> {
    if (argv.length === 0) throw new Error('exec requires a command');
    const cwd = opts.cwd ?? this.root;
    const runId = randomUUID().slice(0, 12);
    const dir = `${controlDir(this.base)}/${runId}`;

    // Launch detached. The subshell records the exit status AFTER the command
    // finishes, so the marker file's existence is the completion signal and its
    // contents are the status — one file answering both questions, which is
    // what makes the poll a single call.
    // Per-command variables, on top of whatever the bash session was created
    // with. `env` rather than `K=V cmd` so the assignment cannot be mistaken
    // for the command when a value is empty, and quoted here because this is a
    // shell program rather than an argv array.
    const assignments = Object.entries(opts.env ?? {})
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0)
      .map(([key, value]) => shellQuote(`${key}=${value}`));
    const command = (assignments.length > 0 ? ['env', ...assignments] : [])
      .concat(argv.map(shellQuote))
      .join(' ');
    // TWO details make it genuinely detached, and both were found by running
    // this against a real shell rather than a mock:
    //
    //   `> /dev/null 2>&1 < /dev/null` ON THE SUBSHELL. Redirecting the
    //   command's own streams is not enough: the subshell still holds the
    //   stdout/stderr pipes it inherited, and the caller waits for those pipes
    //   to CLOSE, not for the foreground process to exit. Without this the
    //   launch blocks for the full life of the coding session — which is the
    //   exact 120-second abort this whole protocol exists to avoid.
    //
    //   `set -m`. Job control makes the background job a process-group leader,
    //   so the recorded pid is also a pgid and `kill -TERM -$pid` reaches the
    //   coding CLI. Without it the subshell shares this shell's group, the
    //   negative-pid kill fails, and killing the subshell alone leaves the CLI
    //   running in a sandbox nobody is watching.
    const launch = [
      'set -m',
      `mkdir -p ${shellQuote(dir)}`,
      `cd ${shellQuote(cwd)}`,
      `( ${command} > ${shellQuote(`${dir}/stdout`)} 2> ${shellQuote(`${dir}/stderr`)} < /dev/null;`
        + ` echo $? > ${shellQuote(`${dir}/exit`)} )`
        + ' > /dev/null 2>&1 < /dev/null &'
        + ` echo $! > ${shellQuote(`${dir}/pid`)}`,
    ].join('; ');

    // `bash`, not `sh`: `set -m` is job control, and the sidecar's own layer
    // already runs bash, so it is present wherever this runs.
    const launched = await this.runToCompletion(['bash', '-c', launch], cwd, CALL_TIMEOUT_MS);
    if (launched.exitCode !== 0) {
      return {
        stdout: '',
        stderr: launched.stderr || `failed to start: ${argv[0]}`,
        exitCode: launched.exitCode,
        timedOut: false,
      };
    }

    const deadline = Date.now() + (opts.timeoutMs ?? CALL_TIMEOUT_MS);
    let timedOut = false;
    let exitCode: number | null = null;
    let pollMs = POLL_INITIAL_MS;

    for (;;) {
      if (opts.signal?.aborted || Date.now() > deadline) {
        timedOut = true;
        await this.kill(dir, cwd);
        break;
      }
      const probe = await this.runToCompletion(
        ['bash', '-c', `if [ -f ${shellQuote(`${dir}/exit`)} ]; then cat ${shellQuote(`${dir}/exit`)}; else echo RUNNING; fi`],
        cwd,
        CALL_TIMEOUT_MS,
      );
      const state = probe.stdout.trim();
      if (state !== 'RUNNING' && state !== '') {
        const parsed = Number.parseInt(state, 10);
        exitCode = Number.isNaN(parsed) ? null : parsed;
        break;
      }
      await sleep(pollMs);
      pollMs = Math.min(pollMs * 2, POLL_MAX_MS);
    }

    // Collected whether it finished or was killed. A coding CLI that is killed
    // mid-session has usually already printed the usage line we bill from, and
    // throwing that away is how a timed-out session gets billed as free.
    const { stdout, stderr } = await this.collectOutput(dir, cwd);
    await this.runToCompletion(['rm', '-rf', dir], cwd, CALL_TIMEOUT_MS).catch(() => undefined);

    return { stdout, stderr, exitCode, timedOut };
  }

  async readFile(relativePath: string): Promise<string | null> {
    const full = `${this.root}/${relativePath}`;
    const result = await this.runToCompletion(['cat', full], this.root, CALL_TIMEOUT_MS);
    return result.exitCode === 0 ? result.stdout : null;
  }

  async destroy(): Promise<void> {
    // This call's working tree, not the sandbox. A later code_session in the
    // same turn reuses the container, so leaving checkouts behind would fill
    // its disk over a long turn.
    //
    // Guarded on the base being a directory UNDER the mount rather than the
    // mount itself. Nothing in production passes `rootDir`, so this cannot
    // trigger today — but the sandbox is now shared across a turn, which means
    // an `rm -rf /workspace` here would take the next call's checkout with it,
    // and a recursive delete is not the place to rely on nobody ever passing
    // the wrong string.
    if (this.base.startsWith(`${SANDBOX_WORKSPACE}/`) && this.base.length > SANDBOX_WORKSPACE.length + 1) {
      await this.runToCompletion(['rm', '-rf', this.base], BOOTSTRAP_CWD, CALL_TIMEOUT_MS)
        .catch(() => undefined);
    }

    for (const sessionId of this.bashSessions.values()) {
      await this.call('bash_session_kill', { sessionId }).catch(() => undefined);
    }
    this.bashSessions.clear();

    // The sandbox service itself is released by the executor: its heartbeat
    // stops once the turn stops calling it, and the GC sweep destroys it.
    // Deliberately NOT torn down from here — `SandboxExecutorInterface` is one
    // method wide, and widening a shared interface so this one caller can free
    // a resource the sweep already frees would buy latency, not correctness.
    // It also must not be torn down here now that the sandbox outlives a single
    // call: the next code_session of the turn is relying on it.
    logger.info(
      {
        sessionId: this.session.sessionId,
        invocationId: this.session.invocationId,
        workspace: this.base,
      },
      'code_session_workspace_released',
    );
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /** The bash session for a directory, created on first use. */
  private async bashSessionFor(cwd: string): Promise<string> {
    const existing = this.bashSessions.get(cwd);
    if (existing) return existing;

    const deadline = Date.now() + PROVISION_MAX_WAIT_MS;
    for (;;) {
      const result = await this.executor.execute(this.session, {
        toolName: 'bash_session_create',
        input: { cwd, ...(this.env ? { env: this.env } : {}) },
      });
      if (result.success) {
        const sessionId = (result.data as { sessionId?: string }).sessionId;
        if (!sessionId) throw new Error('sandbox returned no bash sessionId');
        this.bashSessions.set(cwd, sessionId);
        return sessionId;
      }
      // The sandbox is still starting. The executor says so explicitly rather
      // than holding the request open, and says when to come back.
      if (result.retryable && Date.now() < deadline) {
        await sleep(result.retryAfterMs ?? POLL_MAX_MS);
        continue;
      }
      throw new Error(`sandbox workspace unavailable: ${result.error ?? 'unknown'}`);
    }
  }

  private async call(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<BashExecData> {
    const result = await this.executor.execute(this.session, { toolName, input });
    if (!result.success) throw new Error(result.error ?? `${toolName} failed`);
    return (result.data ?? {}) as BashExecData;
  }

  /** One bounded command, start to finish, in a single executor round trip.
   *  Only used for the short bookkeeping commands this class issues itself —
   *  never for a caller's command, which always goes through exec(). */
  private async runToCompletion(
    argv: string[],
    cwd: string,
    timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    const sessionId = await this.bashSessionFor(cwd);
    const data = await this.call('bash_session_exec', {
      sessionId,
      args: argv,
      timeout_ms: timeoutMs,
    });
    return {
      stdout: String(data.stdout ?? ''),
      stderr: String(data.stderr ?? ''),
      exitCode: typeof data.exitCode === 'number' ? data.exitCode : null,
    };
  }

  /** Read back what the command printed, keeping the END of stdout.
   *
   *  Deliberate: the vendor CLIs emit NDJSON and the terminal message — the one
   *  carrying token counts and cost — is the last line. Truncating the head
   *  loses transcript; truncating the tail loses the bill. */
  private async collectOutput(dir: string, cwd: string): Promise<{ stdout: string; stderr: string }> {
    const out = await this.runToCompletion(
      ['bash', '-c', `tail -c ${MAX_STDOUT_BYTES} ${shellQuote(`${dir}/stdout`)} 2>/dev/null || true`],
      cwd,
      CALL_TIMEOUT_MS,
    );
    const err = await this.runToCompletion(
      ['bash', '-c', `tail -c ${MAX_STDERR_BYTES} ${shellQuote(`${dir}/stderr`)} 2>/dev/null || true`],
      cwd,
      CALL_TIMEOUT_MS,
    );
    return { stdout: out.stdout, stderr: err.stdout };
  }

  private async kill(dir: string, cwd: string): Promise<void> {
    // The recorded pid is the subshell's and the coding CLI is its child, so the
    // process GROUP is what has to go — `set -m` at launch is what makes that
    // pid a group id. Killing the subshell alone leaves the CLI running in a
    // sandbox nobody is watching until the sweep reaps the whole thing.
    //
    // Falls back to the bare pid plus its direct children when the group kill
    // does not land, which is the shape of failure on a shell without job
    // control. TERM first, so a CLI can flush the usage line it has already
    // earned; KILL after a grace period for one that will not go.
    //
    // Writes the exit marker itself. The killed subshell never will, and the
    // collector that runs next has to see the run as finished rather than
    // reading as still in flight.
    const pid = shellQuote(`${dir}/pid`);
    const script = [
      `p=$(cat ${pid} 2>/dev/null) || exit 0`,
      '[ -n "$p" ] || exit 0',
      'kill -TERM -"$p" 2>/dev/null || { pkill -TERM -P "$p" 2>/dev/null; kill -TERM "$p" 2>/dev/null; }',
      'sleep 1',
      'kill -KILL -"$p" 2>/dev/null || { pkill -KILL -P "$p" 2>/dev/null; kill -KILL "$p" 2>/dev/null; }',
      `echo 143 > ${shellQuote(`${dir}/exit`)} 2>/dev/null || true`,
      'exit 0',
    ].join('; ');
    await this.runToCompletion(['bash', '-c', script], cwd, CALL_TIMEOUT_MS).catch(() => undefined);
  }
}

/** POSIX single-quote quoting.
 *
 *  The sidecar shell-escapes each element of `args` before joining them, so an
 *  argv array is already safe. These scripts are different: they are ONE
 *  argument containing a shell program, so anything interpolated into them —
 *  a path built from a caller's branch name, a command the runner assembled —
 *  has to be quoted here or the quoting stops at the sidecar's boundary. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
