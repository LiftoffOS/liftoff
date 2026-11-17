import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import { Mutex } from 'async-mutex';
import { SessionNotFoundError } from '../shared/errors';

const SAFE_BASE_ENV: Record<string, string> = {
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/tmp',
  LANG: 'en_US.UTF-8',
  TERM: 'xterm-256color',
  WORKSPACE_DIR: '/workspace',
  TMPDIR: '/tmp',
  // So `node /workspace/foo.js` run from a bash session can
  // require('@liftoffos/agent-sdk'); the image symlinks the SDK into this dir
  // (see sandbox-sidecar/Dockerfile). Harmless for python/bash invocations.
  NODE_PATH: '/opt/sandbox-node-path',
};

function shellEscape(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

export class BashSession {
  public readonly sessionId: string;
  private cwd: string;
  private env: Record<string, string>;
  private outputBuffer: Array<{ stdout: string; stderr: string }> = [];
  public readonly createdAt = Date.now();
  private lastActivity = Date.now();
  private closed = false;
  // Per-session mutex so two concurrent exec() calls on the same session don't
  // clobber each other's /tmp/lastpwd-${sessionId} markers (cwd would drift).
  private mutex = new Mutex();

  constructor(opts: { sessionId?: string; cwd?: string; env?: Record<string, string> } = {}) {
    this.sessionId = opts.sessionId ?? randomUUID();
    this.cwd = opts.cwd ?? '/workspace';
    this.env = { ...SAFE_BASE_ENV, ...(opts.env ?? {}) };
  }

  get currentCwd(): string {
    return this.cwd;
  }

  async exec(args: string[], timeoutMs = 30_000): Promise<{ stdout: string; stderr: string; exitCode: number; cwdAfter: string }> {
    if (this.closed) throw new SessionNotFoundError();
    return this.mutex.runExclusive(async () => {
      this.lastActivity = Date.now();
      const quoted = args.map(shellEscape).join(' ');
      const cwdMarker = `/tmp/lastpwd-${this.sessionId}`;
      const exitMarker = `/tmp/lastexit-${this.sessionId}`;
      const wrapped = `cd ${shellEscape(this.cwd)} && ${quoted}; ec=$?; pwd > ${shellEscape(cwdMarker)}; echo $ec > ${shellEscape(exitMarker)}; exit $ec`;
      const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
        execFile('bash', ['-c', wrapped], { timeout: timeoutMs, env: this.env, cwd: this.cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
          resolve({
            stdout,
            stderr,
            exitCode: typeof err?.code === 'number' ? err.code : err ? 1 : 0,
          });
        });
      });
      let cwdAfter = this.cwd;
      try {
        cwdAfter = (await fs.readFile(cwdMarker, 'utf-8')).trim() || cwdAfter;
        this.cwd = cwdAfter;
      } catch {
        // marker not written (process killed)
      }
      this.outputBuffer.push({ stdout: result.stdout, stderr: result.stderr });
      while (this.outputBuffer.length > 100) this.outputBuffer.shift();
      return { ...result, cwdAfter };
    });
  }

  /** Drain the output ring (last 100 KB) */
  output(): { stdout: string; stderr: string } {
    const stdout = this.outputBuffer.map(e => e.stdout).join('');
    const stderr = this.outputBuffer.map(e => e.stderr).join('');
    return { stdout, stderr };
  }

  kill(): void {
    this.closed = true;
  }

  toDescriptor(): { id: string; cwd: string; createdAt: string } {
    return {
      id: this.sessionId,
      cwd: this.cwd,
      createdAt: new Date(this.createdAt).toISOString(),
    };
  }

  get lastActivityMs(): number {
    return this.lastActivity;
  }
}

export class BashSessionManager {
  private sessions = new Map<string, BashSession>();

  create(opts: { cwd?: string; env?: Record<string, string> } = {}): BashSession {
    const s = new BashSession(opts);
    this.sessions.set(s.sessionId, s);
    return s;
  }

  get(id: string): BashSession {
    const s = this.sessions.get(id);
    if (!s) throw new SessionNotFoundError();
    return s;
  }

  list(): BashSession[] {
    return Array.from(this.sessions.values());
  }

  destroy(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.kill();
    this.sessions.delete(id);
  }

  killAll(): void {
    for (const s of this.sessions.values()) s.kill();
    this.sessions.clear();
  }
}

export const bashSessionManager = new BashSessionManager();
