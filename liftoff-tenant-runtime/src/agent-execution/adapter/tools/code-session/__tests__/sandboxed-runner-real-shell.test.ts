// A sandboxed runner, end to end, through real bash.
//
// `sandboxed-runners.test.ts` hands each runner a stub workspace and a string.
// That proves the parsing. It does not prove that the argv the runner builds
// survives a shell, that the CLI is found on PATH, or that a process's real
// stdout arrives intact through the launch/poll/collect protocol.
//
// This suite runs the runner against `SandboxCodeSessionWorkspace` backed by the
// sidecar's own `BashSession`, with a real executable on PATH standing in for
// the vendor CLI. Everything between the runner and the process is production
// code.
//
// ── About the fixture ──────────────────────────────────────────────────────
//
// `fixtures-claude-cli-api-error.jsonl` is not hand-written. It is the verbatim
// output of `claude -p … --output-format stream-json --verbose --max-turns 30
// --permission-mode bypassPermissions --allowedTools Bash Read Write Edit Glob
// Grep Task` — the exact argv `SandboxedAnthropicCodeSessionRunner` builds —
// against the real CLI at 2.1.88. Two things it establishes that no
// hand-written fixture could:
//
//   1. The real binary ACCEPTS every one of those flags. A wrong flag name
//      would have failed with "unknown option" instead of running.
//   2. A plain API error really does arrive as
//      `{"subtype":"success","is_error":true}`, which is the case that used to
//      be reported to the calling agent as finished work.

jest.mock('async-mutex', () => ({
  Mutex: class {
    async runExclusive<T>(fn: () => Promise<T>): Promise<T> { return fn(); }
  },
}), { virtual: true });
jest.mock('../../../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BashSession } from '../../../../../../sandbox-sidecar/src/bash/session-manager';
import { SandboxCodeSessionWorkspace } from '../sandbox-workspace';
import { SandboxedAnthropicCodeSessionRunner } from '../runners/sandboxed/claude';
import type { RunnerInvocation } from '../types';
import type {
  SandboxExecutorInterface,
  SandboxSession,
  SandboxToolCallInput,
  SandboxToolCallResult,
} from '../../../../../execution-environments/types';

const REAL_CLI_API_ERROR = readFileSync(
  join(__dirname, 'fixtures-claude-cli-api-error.jsonl'),
  'utf8',
);

class RealShellExecutor implements SandboxExecutorInterface {
  private readonly sessions = new Map<string, BashSession>();
  async execute(_s: SandboxSession, call: SandboxToolCallInput): Promise<SandboxToolCallResult> {
    const input = call.input as Record<string, unknown>;
    if (call.toolName === 'bash_session_create') {
      const session = new BashSession({
        cwd: input.cwd as string | undefined,
        env: input.env as Record<string, string> | undefined,
      });
      this.sessions.set(session.sessionId, session);
      return { success: true, data: { sessionId: session.sessionId } };
    }
    if (call.toolName === 'bash_session_exec') {
      const session = this.sessions.get(input.sessionId as string);
      if (!session) return { success: false, data: {}, error: 'no such session' };
      return {
        success: true,
        data: await session.exec(input.args as string[], input.timeout_ms as number | undefined),
      };
    }
    if (call.toolName === 'bash_session_kill') return { success: true, data: {} };
    return { success: false, data: {}, error: `unexpected ${call.toolName}` };
  }
}

let base: string;
let binDir: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'cs-runner-'));
  binDir = join(base, 'bin');
  mkdirSync(binDir, { recursive: true });
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

/** Put an executable named `claude` on PATH that behaves as the script says. */
function installClaudeStub(body: string): void {
  const path = join(binDir, 'claude');
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
}

async function workspace() {
  return SandboxCodeSessionWorkspace.create({
    executor: new RealShellExecutor(),
    tenantId: 't1',
    agentId: 'a1',
    invocationId: 'inv1',
    rootDir: join(base, 'workspace'),
    // The sidecar's session env replaces PATH wholesale, so the stub directory
    // has to be named here or the CLI is simply not found.
    env: { PATH: `${binDir}:/usr/bin:/bin` },
  });
}

function invocation(over: Partial<RunnerInvocation> = {}): RunnerInvocation {
  return {
    task: 'add a changelog entry',
    workspaceRoot: '',
    allowedTools: [],
    timeoutMs: 30_000,
    signal: new AbortController().signal,
    context: { tenantId: 't1', agentId: 'a1', invocationId: 'inv1', outerProvider: 'anthropic' },
    ...over,
  };
}

describe('SandboxedAnthropicCodeSessionRunner through real bash', () => {
  it('reads a real API-error session as an error, not as finished work', async () => {
    // The whole chain on production code: argv → bash → process → stdout →
    // launch/poll/collect → NDJSON parse → exit classification.
    installClaudeStub(`cat <<'EOF'\n${REAL_CLI_API_ERROR}EOF`);
    const ws = await workspace();
    const result = await new SandboxedAnthropicCodeSessionRunner()
      .run(invocation({ workspace: ws, workspaceRoot: ws.root }));

    expect(result.exit_reason).toBe('error');
  }, 60_000);

  it('captures per-model cost from a session that really ran', async () => {
    // Same terminal shape the SDK yields, since the SDK is a wrapper over this
    // CLI. The account used to record the fixture cannot reach a model, so a
    // successful session is synthesised HERE — but it travels the same path.
    const success = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      total_cost_usd: 0.042,
      usage: { input_tokens: 1200, output_tokens: 300 },
      modelUsage: {
        'claude-opus-4-8': {
          inputTokens: 1200, outputTokens: 300, cacheReadInputTokens: 900, costUSD: 0.042,
        },
      },
    });
    const assistant = JSON.stringify({
      type: 'assistant',
      message: { model: 'claude-opus-4-8', content: [{ type: 'text', text: 'added the entry' }] },
    });
    installClaudeStub(`cat <<'EOF'\n${assistant}\n${success}\nEOF`);

    const ws = await workspace();
    const result = await new SandboxedAnthropicCodeSessionRunner()
      .run(invocation({ workspace: ws, workspaceRoot: ws.root }));

    expect(result.exit_reason).toBe('success');
    expect(result.summary).toBe('added the entry');
    expect(result.modelUsage).toEqual([{
      model: 'claude-opus-4-8',
      inputTokens: 1200,
      outputTokens: 300,
      cachedTokens: 900,
      costUsd: 0.042,
    }]);
  }, 60_000);

  it('passes the task and the flags through the shell intact', async () => {
    // The argv crosses two quoting layers: this class's shell program, and the
    // sidecar's own per-argument escaping. A task with quotes and semicolons is
    // where that goes wrong.
    installClaudeStub(
      'printf \'{"type":"result","subtype":"success","is_error":false,"modelUsage":{}}\\n\'\n'
      + `printf '%s' "$*" > ${join(base, 'argv.txt')}`,
    );
    const ws = await workspace();
    const nasty = "fix the parser's \"quote\" bug; rm -rf /; done";
    const result = await new SandboxedAnthropicCodeSessionRunner()
      .run(invocation({ workspace: ws, workspaceRoot: ws.root, task: nasty }));

    expect(result.exit_reason).toBe('success');
    const argv = readFileSync(join(base, 'argv.txt'), 'utf8');
    expect(argv).toContain(nasty);
    expect(argv).toContain('--output-format stream-json');
    expect(argv).toContain('--permission-mode bypassPermissions');
    // And the injection attempt stayed data: nothing ran it.
    expect(argv).toContain('rm -rf /');
  }, 60_000);

  it('calls a CLI that dies without a terminal message an error', async () => {
    // Exit 0, plausible-looking output, no result message — a crash or an OOM
    // kill. Reported as success it would hand the calling agent an empty diff.
    installClaudeStub('echo "Killed"; exit 0');
    const ws = await workspace();
    const result = await new SandboxedAnthropicCodeSessionRunner()
      .run(invocation({ workspace: ws, workspaceRoot: ws.root }));

    expect(result.exit_reason).toBe('error');
  }, 60_000);

  it('reports a missing CLI as an error rather than an empty success', async () => {
    // No stub installed at all: exit 127, command not found. The sandbox image
    // is what guarantees the binary exists, so this is the shape of "the image
    // is wrong" and it must not read as a session that changed nothing.
    const ws = await workspace();
    const result = await new SandboxedAnthropicCodeSessionRunner()
      .run(invocation({ workspace: ws, workspaceRoot: ws.root }));

    expect(result.exit_reason).toBe('error');
  }, 60_000);
});
