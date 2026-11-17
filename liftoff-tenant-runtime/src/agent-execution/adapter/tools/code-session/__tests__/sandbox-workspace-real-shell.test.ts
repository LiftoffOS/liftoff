// The sandbox workspace protocol, against the sidecar's REAL shell.
//
// `workspace.test.ts` drives this class through a fake that interprets its
// shell programs with regexes. That proves the calls are made; it cannot prove
// the programs work, and the programs are the risky part — a detached launch, a
// poll on an exit marker, a tail collector, and a process-group kill, all
// written as text and quoted by hand.
//
// So this suite runs them through `BashSession` from `sandbox-sidecar/src`, the
// same class the sidecar serves `/v1/bash/sessions/:id/exec` with. Real bash,
// real files, real exit codes, real signals. What it does not cover is the HTTP
// hop between the executor and the sidecar, which needs a deployed sandbox.
//
// `async-mutex` is stubbed because the sidecar's node_modules are not installed
// here. It serialises concurrent execs on one session; these are sequential, so
// stubbing it removes nothing this suite is claiming.

// `virtual` because the package is not installed at this root at all — it is a
// sandbox-sidecar dependency, and that workspace's node_modules are not part of
// this checkout.
jest.mock('async-mutex', () => ({
  Mutex: class {
    async runExclusive<T>(fn: () => Promise<T>): Promise<T> { return fn(); }
  },
}), { virtual: true });
jest.mock('../../../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BashSession } from '../../../../../../sandbox-sidecar/src/bash/session-manager';
import { SandboxCodeSessionWorkspace } from '../sandbox-workspace';
import { captureSessionChanges, recordSessionBase } from '../diff-capture';
import type {
  SandboxExecutorInterface,
  SandboxSession,
  SandboxToolCallInput,
  SandboxToolCallResult,
} from '../../../../../execution-environments/types';

/** The sidecar's bash surface, wired straight to the real session class.
 *
 *  This is the executor's dispatcher (`dispatchers/bash-dispatcher.ts`) with
 *  the HTTP hop removed: same tool names, same inputs, same returned shape. */
class RealShellExecutor implements SandboxExecutorInterface {
  private readonly sessions = new Map<string, BashSession>();

  async execute(_session: SandboxSession, call: SandboxToolCallInput): Promise<SandboxToolCallResult> {
    const input = call.input as Record<string, unknown>;
    switch (call.toolName) {
      case 'bash_session_create': {
        const session = new BashSession({
          cwd: input.cwd as string | undefined,
          env: input.env as Record<string, string> | undefined,
        });
        this.sessions.set(session.sessionId, session);
        return { success: true, data: { sessionId: session.sessionId } };
      }
      case 'bash_session_exec': {
        const session = this.sessions.get(input.sessionId as string);
        if (!session) return { success: false, data: {}, error: 'no such session' };
        return {
          success: true,
          data: await session.exec(input.args as string[], input.timeout_ms as number | undefined),
        };
      }
      case 'bash_session_kill': {
        this.sessions.get(input.sessionId as string)?.kill();
        return { success: true, data: {} };
      }
      default:
        return { success: false, data: {}, error: `unexpected tool ${call.toolName}` };
    }
  }
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' });

/**
 * Whether this machine has git.
 *
 * CI runs the suite on `node:20-slim`, which does NOT ship git — and finding
 * that out cost a build. The fixture repo was built in `beforeEach`, so the
 * missing binary threw there, and `execFileSync`'s error carries a circular
 * reference that jest-worker cannot serialise: the whole suite failed with
 * "Converting circular structure to JSON" and never said the word git.
 *
 * So the git-dependent case is skipped by name when git is absent, and
 * everything else — the launch, the poll, the collector, the process-group
 * kill, the quoting, the environment — is bash only and still runs there.
 * Those are the parts that were actually wrong.
 */
const HAS_GIT = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;
const itWithGit = HAS_GIT ? it : it.skip;

let base: string;
let origin: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'cs-real-'));
  origin = join(base, 'origin');
  if (!HAS_GIT) return;
  // A real repository to clone, so `git clone` and `git diff` are the real
  // commands the handler runs rather than stand-ins.
  execFileSync('mkdir', ['-p', origin]);
  git(origin, 'init', '--quiet', '-b', 'main');
  git(origin, 'config', 'user.email', 'test@example.com');
  git(origin, 'config', 'user.name', 'Test');
  writeFileSync(join(origin, 'README.md'), 'hello\n');
  writeFileSync(join(origin, 'CLAUDE.md'), '# preset\n');
  git(origin, 'add', '-A');
  git(origin, 'commit', '--quiet', '-m', 'init');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

async function realWorkspace(env?: Record<string, string>) {
  return SandboxCodeSessionWorkspace.create({
    executor: new RealShellExecutor(),
    tenantId: 't1',
    agentId: 'a1',
    invocationId: 'inv1',
    rootDir: join(base, 'workspace'),
    env,
  });
}

describe('the launch/poll/collect protocol, run by bash', () => {
  it('creates its directories and reports the checkout as root', async () => {
    const ws = await realWorkspace();
    expect(ws.root).toBe(join(base, 'workspace', 'repo'));
    const probe = await ws.exec(['sh', '-c', 'pwd']);
    expect(probe.stdout.trim()).toBe(ws.root);
    expect(probe.exitCode).toBe(0);
  });

  itWithGit('runs the real clone → edit → diff sequence the handler depends on', async () => {
    // The end-to-end shape of a code_session, minus the coding agent. If any
    // step ran somewhere other than the checkout, the diff comes back empty —
    // which is the failure this whole seam exists to prevent (INV-TR-017).
    const ws = await realWorkspace();

    const cloned = await ws.exec(['git', 'clone', '--quiet', origin, ws.root], { timeoutMs: 30_000 });
    expect(cloned.exitCode).toBe(0);

    expect(await ws.readFile('CLAUDE.md')).toBe('# preset\n');

    const edited = await ws.exec(['sh', '-c', 'printf "changed\\n" >> README.md']);
    expect(edited.exitCode).toBe(0);

    const diff = await ws.exec(['git', 'diff', '--no-color']);
    expect(diff.exitCode).toBe(0);
    expect(diff.stdout).toContain('+changed');

    const names = await ws.exec(['git', 'diff', '--name-only']);
    expect(names.stdout.split('\n').filter(Boolean)).toEqual(['README.md']);
  });

  itWithGit('captures a new file and a commit the session made, through the sandbox protocol', async () => {
    // The handler's capture (diff-capture.ts) passes GIT_INDEX_FILE per
    // command; here that goes through the sandbox's `env K=V` launch rather
    // than execFile's env, so it is proved on this path too.
    const ws = await realWorkspace();
    expect((await ws.exec(['git', 'clone', '--quiet', origin, ws.root], { timeoutMs: 30_000 })).exitCode).toBe(0);
    const base = await recordSessionBase(ws, ws.root);

    await ws.exec(['sh', '-c', 'printf "committed\\n" > committed.md && git add -A'
      + ' && git -c user.email=a@example.com -c user.name=A commit --quiet -m work']);
    await ws.exec(['sh', '-c', 'printf "new\\n" > new.md && printf "changed\\n" >> README.md']);

    const captured = await captureSessionChanges(ws, ws.root, base);
    expect(captured.error).toBeUndefined();
    expect(captured.filesModified.sort()).toEqual(['README.md', 'committed.md', 'new.md']);
    expect(captured.diff).toContain('+committed');
    expect(captured.diff).toContain('+new');
    // The real index is untouched: new.md is still untracked.
    expect((await ws.exec(['git', 'status', '--porcelain'])).stdout).toContain('?? new.md');
  });

  it('returns a non-zero exit with the output the command produced first', async () => {
    const ws = await realWorkspace();
    const result = await ws.exec(['sh', '-c', 'echo out; echo err 1>&2; exit 3']);
    expect(result.exitCode).toBe(3);
    expect(result.stdout.trim()).toBe('out');
    expect(result.stderr.trim()).toBe('err');
    expect(result.timedOut).toBe(false);
  });

  it('kills a command that outlives its budget and still collects what it printed', async () => {
    // The property metering depends on: a coding CLI killed at its deadline has
    // usually already printed the usage line, and losing it bills the session
    // as free.
    const ws = await realWorkspace();
    const result = await ws.exec(
      ['sh', '-c', 'echo "spent-tokens"; sleep 30'],
      { timeoutMs: 3_000 },
    );
    expect(result.timedOut).toBe(true);
    expect(result.stdout).toContain('spent-tokens');
  }, 30_000);

  it('actually stops the process group, rather than orphaning the child', async () => {
    // A plain kill on the recorded pid ends the subshell and leaves the real
    // command running in a sandbox nobody is watching. The marker file it would
    // keep writing is how that shows up.
    const ws = await realWorkspace();
    const witness = join(base, 'still-running');
    await ws.exec(
      ['sh', '-c', `sh -c 'while true; do echo tick >> ${witness}; sleep 0.2; done'`],
      { timeoutMs: 2_000 },
    );
    const sizeAfterKill = await ws.exec(['sh', '-c', `wc -c < ${witness} 2>/dev/null || echo 0`]);
    await new Promise((r) => setTimeout(r, 1_500));
    const sizeLater = await ws.exec(['sh', '-c', `wc -c < ${witness} 2>/dev/null || echo 0`]);
    expect(sizeLater.stdout.trim()).toBe(sizeAfterKill.stdout.trim());
  }, 30_000);

  it('quotes an argument that would otherwise end the shell program', async () => {
    // The sidecar escapes each element of an argv array, which is why exec()
    // takes one. The launch script is a SINGLE argument containing a shell
    // program, so anything interpolated into it is quoted by this class or not
    // at all.
    const ws = await realWorkspace();
    const nasty = "it's; touch /tmp/pwned-by-code-session; echo '";
    const result = await ws.exec(['sh', '-c', 'printf %s "$1"', 'sh', nasty]);
    expect(result.stdout).toBe(nasty);
    expect(result.exitCode).toBe(0);
  });

  it('runs in a directory whose name contains a quote', async () => {
    const ws = await realWorkspace();
    const odd = join(ws.root, "dir with ' quote");
    await ws.exec(['mkdir', '-p', odd]);
    const result = await ws.exec(['sh', '-c', 'pwd'], { cwd: odd });
    expect(result.stdout.trim()).toBe(odd);
  });

  it('carries session credentials and per-command additions to the process', async () => {
    const ws = await realWorkspace({ ANTHROPIC_AUTH_TOKEN: 'liftoff_byok_run' });
    const session = await ws.exec(['sh', '-c', 'printf "[%s]" "$ANTHROPIC_AUTH_TOKEN"']);
    expect(session.stdout).toBe('[liftoff_byok_run]');

    const perCommand = await ws.exec(['sh', '-c', 'printf "[%s]" "$OPENAI_BASE_URL"'], {
      env: { OPENAI_BASE_URL: 'https://openrouter.ai/api/v1' },
    });
    expect(perCommand.stdout).toBe('[https://openrouter.ai/api/v1]');
  });

  it('keeps the END of oversized output, because the bill is on the last line', async () => {
    const ws = await realWorkspace();
    // 200k lines: far past anything the tail cap would keep whole, with a
    // terminal line that must survive.
    const result = await ws.exec([
      'sh', '-c',
      'i=0; while [ $i -lt 20000 ]; do echo "filler line for padding"; i=$((i+1)); done; echo TERMINAL',
    ], { timeoutMs: 30_000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trimEnd().endsWith('TERMINAL')).toBe(true);
  }, 30_000);

  it('reads a file back, and reports a missing one as null', async () => {
    // No git: `readFile` is the workspace's own operation and the checkout is
    // just a directory. Keeping this git-free means the read path is still
    // covered on an image without it.
    const ws = await realWorkspace();
    await ws.exec(['sh', '-c', "printf '# preset\\n' > CLAUDE.md"]);
    expect(await ws.readFile('CLAUDE.md')).toBe('# preset\n');
    expect(await ws.readFile('nope.md')).toBeNull();
  });

  it('leaves no control directory entries behind', async () => {
    // Each command writes stdout/stderr/exit/pid under the control directory
    // and removes them afterwards. A leak there fills the sandbox's disk over a
    // long session.
    const ws = await realWorkspace();
    await ws.exec(['sh', '-c', 'echo one']);
    await ws.exec(['sh', '-c', 'echo two']);
    // One, not zero: the listing command is itself a launched command, so its
    // own control directory exists while it runs. What matters is that the
    // count does not grow with the number of commands before it.
    const listing = await ws.exec(['sh', '-c', `ls -1 ${join(base, 'workspace', '.code-session')} | wc -l`]);
    expect(listing.stdout.trim()).toBe('1');
  });
});
