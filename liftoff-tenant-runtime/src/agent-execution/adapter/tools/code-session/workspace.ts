// Where a code_session's checkout lives and where its commands run.
//
// `code_session` is the one tool that hands an agent a shell. Everything else
// in this runtime reaches the outside world through a typed dispatch that
// governs it; this one clones a repository, runs a vendor coding agent over it,
// and captures a diff. Until this seam existed all of that happened in the
// tenant runtime's OWN container — as root, under the runtime's service
// account, with the metadata server one curl away.
//
// The seam is deliberately narrow: exec, read a file, go away. Those three are
// everything the handler and the runners need, and each has a faithful
// implementation both in-process and inside an isolated sandbox. Anything wider
// (a real fs handle, a spawned child the caller keeps) would have no sandbox
// counterpart and would quietly pin the feature to the in-process path.
//
// Two properties the implementations must share, because the runners depend on
// them and a divergence would show up as a metering or classification bug
// rather than as a workspace bug:
//
//   1. `exec` does NOT throw on a non-zero exit. It returns the code, and the
//      output the command managed to produce first. A coding CLI that fails
//      after doing work has usually already printed the usage line we bill
//      from, and `execFile`'s habit of throwing that output away is how a
//      timed-out session gets billed as free.
//   2. `readFile` returns null for a missing file rather than throwing. Every
//      caller here treats absence as ordinary.
//   3. The command's stdin is at EOF from the start. Nothing here is
//      interactive, and a CLI that reads a piped prompt when stdin is not a TTY
//      (opencode's `run` awaits `Bun.stdin.text()`) otherwise waits on a pipe
//      nobody will ever close, until the timeout kills it. The sandbox gives
//      its commands `< /dev/null` for the same reason.

import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export interface CodeSessionExecOpts {
  /** Directory to run in. Absolute, and must be inside the workspace root.
   *  Defaults to the root. */
  cwd?: string;
  timeoutMs?: number;
  /** Cap on captured stdout. Output past it is truncated, not an error — a
   *  10MB diff is a real diff. */
  maxOutputBytes?: number;
  /** Extra variables for this command only. The base environment is the
   *  allow-list in child-process-env.ts, never this process's own. */
  env?: Record<string, string | undefined>;
  /** Aborts the command. The result still carries whatever it printed. */
  signal?: AbortSignal;
}

export interface CodeSessionExecResult {
  stdout: string;
  stderr: string;
  /** Null when the process was killed by a signal rather than exiting. */
  exitCode: number | null;
  /** Killed by `timeoutMs` or `signal` rather than finishing on its own. */
  timedOut: boolean;
}

export type CodeSessionWorkspaceKind = 'in-process' | 'sandbox';

export interface CodeSessionWorkspace {
  /** Absolute path of the checkout, in the execution context commands see. */
  readonly root: string;
  readonly kind: CodeSessionWorkspaceKind;
  /** argv[0] is the command. Never a shell string: there is no shell between
   *  this and the process, in either implementation, so nothing here can be
   *  quote-injected by a repo name or a branch. */
  exec(argv: string[], opts?: CodeSessionExecOpts): Promise<CodeSessionExecResult>;
  /** Path relative to the root. Null when absent or unreadable. */
  readFile(relativePath: string): Promise<string | null>;
  destroy(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

/** The runtime's own container: a temp directory and child processes here.
 *
 *  This is what `code_session` has always done, kept behaviour-for-behaviour so
 *  the sandbox path can be introduced beside it and compared against it. */
export class LocalCodeSessionWorkspace implements CodeSessionWorkspace {
  readonly kind = 'in-process' as const;

  private constructor(readonly root: string) {}

  static async create(prefix: string): Promise<LocalCodeSessionWorkspace> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    return new LocalCodeSessionWorkspace(root);
  }

  async exec(argv: string[], opts: CodeSessionExecOpts = {}): Promise<CodeSessionExecResult> {
    const [command, ...args] = argv;
    if (!command) throw new Error('exec requires a command');

    // `childProcessEnv` rather than the ambient environment: this is the
    // process that runs agent-authored commands, and the runtime holds
    // fourteen secrets. See child-process-env.ts (INV-TR-016).
    const { childProcessEnv } = await import('../../child-process-env');

    return new Promise<CodeSessionExecResult>((resolve) => {
      let timedOut = false;
      const child = execFile(
        command,
        args,
        {
          cwd: opts.cwd ?? this.root,
          timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          maxBuffer: opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
          env: childProcessEnv(opts.env ?? {}),
          signal: opts.signal,
        },
        (err, stdout, stderr) => {
          // execFile reports a kill (timeout, abort, or maxBuffer overrun) as an
          // error, and hands back what the process printed before it died.
          // That output is the point: a coding CLI that is killed mid-session
          // has usually already emitted the usage we bill from.
          const killed = err !== null
            && (('killed' in err && (err as { killed?: boolean }).killed === true)
              || ('signal' in err && (err as { signal?: string }).signal != null));
          if (killed) timedOut = true;
          resolve({
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
            exitCode: err === null
              ? 0
              : ((err as { code?: number | string }).code as number | undefined) ?? null,
            timedOut,
          });
        },
      );
      // execFile always opens stdin as a pipe and never closes it; its options
      // take no `stdio`. Ending it here is `stdio: ['ignore', …]` by another
      // route: the child reads EOF at once instead of blocking. Optional-chained
      // because a mocked execFile returns no child.
      child?.stdin?.end();
      child?.on('error', () => {
        // Covered by the callback above; the listener only stops an
        // unhandled 'error' from taking the process down when the binary is
        // missing entirely (exit 127's cousin, ENOENT).
      });
    });
  }

  async readFile(relativePath: string): Promise<string | null> {
    try {
      return await fs.readFile(path.join(this.root, relativePath), 'utf-8');
    } catch {
      return null;
    }
  }

  async destroy(): Promise<void> {
    await fs.rm(this.root, { recursive: true, force: true });
  }
}
