// The two workspaces a code_session can run in, and the properties they must
// share.
//
// They are interchangeable by construction — the handler and the runners hold
// only the interface — so a difference between them does not surface as a
// workspace bug. It surfaces as a metering bug, or as an empty diff, in
// whichever path happens to be switched on. The shared-property block at the
// bottom is the guard against that.

import { LocalCodeSessionWorkspace } from '../workspace';
import { SandboxCodeSessionWorkspace } from '../sandbox-workspace';
import type {
  SandboxExecutorInterface,
  SandboxSession,
  SandboxToolCallInput,
  SandboxToolCallResult,
} from '../../../../../execution-environments/types';

jest.mock('../../../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ── A sandbox that actually runs the scripts, so the protocol is exercised ───
//
// The interesting code is the shell program this class writes: launch
// detached, poll an exit marker, collect the tail. A mock that pattern-matched
// on tool names would assert the calls happen and prove nothing about whether
// the program works. This one keeps a tiny in-memory filesystem and interprets
// the handful of shell forms the workspace emits, so a quoting mistake or a
// wrong marker path fails the test.
class FakeSandbox implements SandboxExecutorInterface {
  files = new Map<string, string>();
  dirs = new Set<string>(['/workspace']);
  sessions = new Map<string, string>();
  killed: string[] = [];
  calls: Array<{ toolName: string; input: Record<string, unknown> }> = [];
  lastSession?: SandboxSession;
  /** Number of create attempts to refuse with `retryable` before succeeding. */
  provisioningCalls = 0;
  /** argv → {stdout, exitCode} for the caller's launched command. */
  programs = new Map<string, { stdout: string; stderr?: string; exitCode: number }>();
  /** Commands the fake never completes, so the poll loop has to time out. */
  neverFinish = new Set<string>();
  private running = new Map<string, string>();

  async execute(session: SandboxSession, call: SandboxToolCallInput): Promise<SandboxToolCallResult> {
    this.lastSession = session;
    this.calls.push({ toolName: call.toolName, input: call.input });

    if (call.toolName === 'bash_session_create') {
      if (this.provisioningCalls > 0) {
        this.provisioningCalls -= 1;
        return {
          success: false, data: {}, error: 'The workspace for this run is still starting.',
          errorCode: 'vendor_unavailable', retryable: true, retryAfterMs: 1,
        };
      }
      const id = `bash-${this.sessions.size + 1}`;
      this.sessions.set(id, String(call.input.cwd ?? '/workspace'));
      return { success: true, data: { sessionId: id } };
    }
    if (call.toolName === 'bash_session_kill') {
      this.killed.push(String(call.input.sessionId));
      return { success: true, data: {} };
    }
    if (call.toolName !== 'bash_session_exec') {
      return { success: false, data: {}, error: `unexpected tool ${call.toolName}` };
    }

    const args = call.input.args as string[];
    return { success: true, data: this.interpret(args) };
  }

  private interpret(args: string[]): { stdout: string; stderr: string; exitCode: number } {
    const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });

    if (args[0] === 'mkdir') {
      for (const a of args.slice(2)) this.dirs.add(a);
      return ok();
    }
    if (args[0] === 'cat') {
      const body = this.files.get(args[1]);
      return body === undefined ? { stdout: '', stderr: 'no such file', exitCode: 1 } : ok(body);
    }
    if (args[0] === 'rm') return ok();
    // bash, because the launcher needs `set -m` (job control) to make the
    // background job a process-group leader. See sandbox-workspace.ts.
    if ((args[0] !== 'bash' && args[0] !== 'sh') || args[1] !== '-c') return ok();

    const script = args[2];

    // The launcher: `set -m; mkdir -p 'D'; cd 'C'; ( CMD > 'D/stdout' ...`
    // `set -m` and the subshell redirection are load-bearing in production and
    // proved by sandbox-workspace-real-shell.test.ts; this fake only has to
    // recognise the shape.
    const launch = script.match(/^set -m; mkdir -p '([^']+)'; cd '([^']+)'; \( (.+?) > '([^']+)\/stdout'/s);
    if (launch) {
      const [, dir, , command] = launch;
      this.dirs.add(dir);
      const program = this.programs.get(command);
      if (this.neverFinish.has(command)) {
        this.running.set(dir, command);
        this.files.set(`${dir}/pid`, '4242');
        return ok();
      }
      const outcome = program ?? { stdout: '', exitCode: 127 };
      this.files.set(`${dir}/stdout`, outcome.stdout);
      this.files.set(`${dir}/stderr`, outcome.stderr ?? '');
      this.files.set(`${dir}/exit`, String(outcome.exitCode));
      this.files.set(`${dir}/pid`, '4242');
      return ok();
    }

    // The poll: `if [ -f 'D/exit' ]; then cat 'D/exit'; else echo RUNNING; fi`
    const poll = script.match(/^if \[ -f '([^']+)' \]; then cat '[^']+'; else echo RUNNING; fi$/);
    if (poll) {
      const body = this.files.get(poll[1]);
      return ok(body === undefined ? 'RUNNING\n' : `${body}\n`);
    }

    // The collector: `tail -c N 'D/stdout' 2>/dev/null || true`
    const tail = script.match(/^tail -c \d+ '([^']+)' 2>\/dev\/null \|\| true$/);
    if (tail) return ok(this.files.get(tail[1]) ?? '');

    // The killer.
    if (script.startsWith('p=$(cat ')) {
      const dir = script.match(/p=\$\(cat '([^']+)\/pid'/)?.[1];
      if (dir) {
        this.running.delete(dir);
        this.files.set(`${dir}/exit`, '143');
      }
      return ok();
    }
    return ok();
  }
}

async function sandboxWorkspace(fake: FakeSandbox, env?: Record<string, string>) {
  return SandboxCodeSessionWorkspace.create({
    executor: fake, tenantId: 't1', agentId: 'a1', invocationId: 'inv1', env,
  });
}

describe('LocalCodeSessionWorkspace', () => {
  it('returns a non-zero exit rather than throwing, and keeps the output', async () => {
    // execFile throws on a non-zero exit and hands the output back on the
    // error. A runner written against that habit drops the usage line a coding
    // CLI printed just before it failed.
    const ws = await LocalCodeSessionWorkspace.create('ws-test-');
    const result = await ws.exec(['sh', '-c', 'echo out; echo err 1>&2; exit 3']);
    expect(result.exitCode).toBe(3);
    expect(result.stdout.trim()).toBe('out');
    expect(result.stderr.trim()).toBe('err');
    expect(result.timedOut).toBe(false);
    await ws.destroy();
  });

  it('reports a timeout as timedOut, not as a failure of the code', async () => {
    const ws = await LocalCodeSessionWorkspace.create('ws-test-');
    const result = await ws.exec(['sh', '-c', 'sleep 5'], { timeoutMs: 250 });
    expect(result.timedOut).toBe(true);
    await ws.destroy();
  });

  it('withholds this process\'s secrets from the command', async () => {
    // The one property that makes it safe to run agent-authored commands here
    // at all while the in-process path is still the default.
    process.env.CODE_SESSION_WORKSPACE_PROBE = 'super-secret';
    const ws = await LocalCodeSessionWorkspace.create('ws-test-');
    const result = await ws.exec(['sh', '-c', 'echo "[${CODE_SESSION_WORKSPACE_PROBE}]"']);
    expect(result.stdout.trim()).toBe('[]');
    delete process.env.CODE_SESSION_WORKSPACE_PROBE;
    await ws.destroy();
  });

  it('carries an addition the caller passes', async () => {
    const ws = await LocalCodeSessionWorkspace.create('ws-test-');
    const result = await ws.exec(['sh', '-c', 'echo "[$GATEWAY]"'], { env: { GATEWAY: 'https://x' } });
    expect(result.stdout.trim()).toBe('[https://x]');
    await ws.destroy();
  });

  it('gives the command a stdin already at EOF, so a CLI that reads it does not hang', async () => {
    // opencode's `run` does `process.stdin.isTTY ? undefined : await
    // Bun.stdin.text()`. execFile opens stdin as a pipe and never closed it, so
    // every in-process opencode session waited on it until the timeout killed
    // it (opencode_code_session_did_not_finish, empty stderr). A real child
    // reading stdin to EOF is the only honest way to prove it now returns.
    const ws = await LocalCodeSessionWorkspace.create('ws-test-');
    const script = "let n=0;process.stdin.on('data',d=>{n+=d.length});process.stdin.on('end',()=>{console.log('eof:'+n)})";
    const started = Date.now();
    const result = await ws.exec([process.execPath, '-e', script], { timeoutMs: 5_000 });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('eof:0');
    expect(Date.now() - started).toBeLessThan(4_000);
    await ws.destroy();
  });

  it('destroy removes the checkout', async () => {
    const ws = await LocalCodeSessionWorkspace.create('ws-test-');
    await ws.exec(['sh', '-c', 'echo hi > file.txt']);
    expect(await ws.readFile('file.txt')).toBe('hi\n');
    await ws.destroy();
    expect(await ws.readFile('file.txt')).toBeNull();
  });
});

describe('SandboxCodeSessionWorkspace', () => {
  it('asks for the coding image, under a session id keyed on the invocation', async () => {
    // Its own sessionId keeps the coding image from leaking into the sandbox an
    // agent's own primitives share. Keyed on the invocation ALONE, with no
    // random suffix, so a second code_session in the same turn reuses it.
    const fake = new FakeSandbox();
    const ws = await sandboxWorkspace(fake);
    expect(fake.lastSession?.template).toBe('aio-sandbox-coding');
    expect(fake.lastSession?.sessionId).toBe('code-session-inv1');
    expect(ws.kind).toBe('sandbox');
    // The CHECKOUT is still per call, under its own directory.
    expect(ws.root).toMatch(/^\/workspace\/cs-[0-9a-f]{8}\/repo$/);
  });

  it('shares one sandbox across a turn, and never the working tree', async () => {
    // The whole point of dropping the random suffix. Provisioning takes tens
    // of seconds even warm; paying it per CALL means a turn that edits three
    // files pays it three times.
    //
    // Sharing the checkout would be the wrong half to share: `git clone` into a
    // directory that already holds one fails, so the second call of a turn
    // would break.
    const fake = new FakeSandbox();
    const first = await sandboxWorkspace(fake);
    const second = await sandboxWorkspace(fake);

    const sessions = fake.calls
      .filter((c) => c.toolName === 'bash_session_create')
      .map(() => fake.lastSession?.sessionId);
    expect(new Set(sessions).size).toBe(1);
    expect(first.sandboxSessionId).toBe(second.sandboxSessionId);
    expect(first.root).not.toBe(second.root);
  });

  it('waits out provisioning instead of failing the call', async () => {
    // The executor refuses with `retryable` while the sandbox starts, rather
    // than holding the request open. A caller that treats that as an error
    // fails every first code_session of a run.
    const fake = new FakeSandbox();
    fake.provisioningCalls = 3;
    const ws = await sandboxWorkspace(fake);
    expect(ws.sandboxSessionId).toBeTruthy();
    expect(fake.calls.filter((c) => c.toolName === 'bash_session_create')).toHaveLength(4);
  });

  it('gives up when the sandbox refuses for good', async () => {
    const fake = new FakeSandbox();
    fake.execute = async () => ({ success: false, data: {}, error: 'quota exhausted' });
    await expect(sandboxWorkspace(fake)).rejects.toThrow(/quota exhausted/);
  });

  it('runs a command detached and returns its exit code and output', async () => {
    const fake = new FakeSandbox();
    fake.programs.set("'git' 'diff'", { stdout: 'diff --git a/x b/x\n', exitCode: 0 });
    const ws = await sandboxWorkspace(fake);
    const result = await ws.exec(['git', 'diff']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('diff --git a/x b/x\n');
    expect(result.timedOut).toBe(false);
  });

  it('surfaces a non-zero exit without throwing', async () => {
    const fake = new FakeSandbox();
    fake.programs.set("'claude'", { stdout: 'partial\n', exitCode: 1 });
    const ws = await sandboxWorkspace(fake);
    const result = await ws.exec(['claude']);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('partial\n');
  });

  it('kills a command that outlives its budget, and still collects what it printed', async () => {
    // The whole reason the protocol exists. A coding CLI killed at its deadline
    // has usually already emitted the terminal usage line, and a runner that
    // gets nothing back cannot meter tokens the vendor already charged for.
    const fake = new FakeSandbox();
    fake.neverFinish.add("'claude' '-p'");
    const ws = await sandboxWorkspace(fake);
    const result = await ws.exec(['claude', '-p'], { timeoutMs: 10 });
    expect(result.timedOut).toBe(true);
    // The killer wrote an exit marker for the process group, so the command is
    // not left running in a sandbox nobody is watching.
    expect(fake.calls.some((c) => String((c.input.args as string[])?.[2] ?? '').startsWith('p=$(cat '))).toBe(true);
  });

  it('keeps the END of oversized output, because the bill is on the last line', async () => {
    const fake = new FakeSandbox();
    const ws = await sandboxWorkspace(fake);
    await ws.exec(['claude']);
    const collector = fake.calls
      .map((c) => String((c.input.args as string[])?.[2] ?? ''))
      .find((s) => s.startsWith('tail -c'));
    expect(collector).toMatch(/^tail -c \d+ '\/workspace\/cs-[0-9a-f]{8}\/\.code-session\/[^']+\/stdout'/);
  });

  it('quotes what it interpolates, so a branch name cannot become a command', async () => {
    // The sidecar escapes each element of an argv array, which is why exec()
    // takes one. These scripts are a single argument containing a shell
    // program, so the quoting has to happen here or it does not happen.
    const fake = new FakeSandbox();
    const ws = await sandboxWorkspace(fake);
    // A short budget so the poll gives up quickly: the fake's own launcher
    // pattern is deliberately naive and does not read a cwd containing a quote,
    // which is the whole point of the case. What is under test is the script
    // this class writes, not whether the fake can run it.
    await ws.exec(['git', 'checkout', "x'; rm -rf /; echo '"], { cwd: "/tmp/it's", timeoutMs: 5 });
    const launch = fake.calls
      .map((c) => String((c.input.args as string[])?.[2] ?? ''))
      .find((s) => s.startsWith('set -m; mkdir -p '));
    expect(launch).toContain(`'x'\\''; rm -rf /; echo '\\'''`);
    expect(launch).toContain(`cd '/tmp/it'\\''s'`);
  });

  it('reads a file back, and reports absence as null rather than an error', async () => {
    const fake = new FakeSandbox();
    const ws = await sandboxWorkspace(fake);
    // Seeded against the workspace's OWN root, which is per call.
    fake.files.set(`${ws.root}/CLAUDE.md`, '# preset');
    expect(await ws.readFile('CLAUDE.md')).toBe('# preset');
    expect(await ws.readFile('nope.md')).toBeNull();
  });

  it('puts the run credentials on the session, not on every command line', async () => {
    // A token on the command line is in the sandbox's own process list for
    // every exec that follows it.
    const fake = new FakeSandbox();
    await sandboxWorkspace(fake, { ANTHROPIC_AUTH_TOKEN: 'liftoff_byok_run' });
    const create = fake.calls.find((c) => c.toolName === 'bash_session_create');
    expect(create?.input.env).toEqual({ ANTHROPIC_AUTH_TOKEN: 'liftoff_byok_run' });
  });

  it('closes its bash sessions on destroy', async () => {
    const fake = new FakeSandbox();
    const ws = await sandboxWorkspace(fake);
    await ws.destroy();
    expect(fake.killed.length).toBeGreaterThan(0);
  });
});

describe('the two workspaces agree on the contract', () => {
  // Each property here is one a runner relies on. Where they diverge, the
  // divergence shows up as a metering or diff bug in whichever path is on.
  it('neither throws on a non-zero exit', async () => {
    const local = await LocalCodeSessionWorkspace.create('ws-test-');
    const localResult = await local.exec(['sh', '-c', 'exit 7']);
    await local.destroy();

    const fake = new FakeSandbox();
    fake.programs.set("'sh' '-c' 'exit 7'", { stdout: '', exitCode: 7 });
    const sandbox = await sandboxWorkspace(fake);
    const sandboxResult = await sandbox.exec(['sh', '-c', 'exit 7']);

    expect(localResult.exitCode).toBe(7);
    expect(sandboxResult.exitCode).toBe(7);
  });

  it('both report a missing file as null', async () => {
    const local = await LocalCodeSessionWorkspace.create('ws-test-');
    expect(await local.readFile('absent')).toBeNull();
    await local.destroy();

    const sandbox = await sandboxWorkspace(new FakeSandbox());
    expect(await sandbox.readFile('absent')).toBeNull();
  });

  it('both honour a per-command environment addition', async () => {
    // The sandbox took its environment only at bash-session creation for a
    // while, and silently dropped `opts.env`. Nothing failed: the coding CLI
    // simply had no credential and reported an auth error, which reads as a
    // provider problem rather than as a workspace one.
    const local = await LocalCodeSessionWorkspace.create('ws-test-');
    const localResult = await local.exec(['sh', '-c', 'echo "[$TOKEN]"'], { env: { TOKEN: 'abc' } });
    await local.destroy();
    expect(localResult.stdout.trim()).toBe('[abc]');

    const fake = new FakeSandbox();
    const sandbox = await sandboxWorkspace(fake);
    await sandbox.exec(['claude'], { env: { TOKEN: 'abc' } });
    const launch = fake.calls
      .map((c) => String((c.input.args as string[])?.[2] ?? ''))
      .find((s) => s.startsWith('set -m; mkdir -p '));
    expect(launch).toContain(`env 'TOKEN=abc' 'claude'`);
  });

  it('both name an absolute root', async () => {
    const local = await LocalCodeSessionWorkspace.create('ws-test-');
    expect(local.root.startsWith('/')).toBe(true);
    await local.destroy();

    const sandbox = await sandboxWorkspace(new FakeSandbox());
    expect(sandbox.root.startsWith('/')).toBe(true);
  });
});
