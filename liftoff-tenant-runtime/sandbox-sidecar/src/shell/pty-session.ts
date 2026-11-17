import { spawn, type IPty } from 'node-pty';
import { ByteRingBuffer } from '../shared/ring-buffer';
import { SessionExitedError } from '../shared/errors';

const SAFE_ENV = {
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/tmp',
  LANG: 'en_US.UTF-8',
  TERM: 'xterm-256color',
  WORKSPACE_DIR: '/workspace',
  TMPDIR: '/tmp',
};

export interface PtyCreateOpts {
  command?: string[];
  cwd?: string;
  cols?: number;
  rows?: number;
}

export class PtySession {
  private pty: IPty;
  private ringBuffer = new ByteRingBuffer(1024 * 1024);
  private exitCode: number | null = null;
  private exitedAt: number | null = null;
  private createdAt = Date.now();
  private bytesIn = 0;
  // Concurrent waitForExit callers share this list; one node-pty onExit
  // listener fans out to all of them.
  private exitWaiters: Array<(exitCode: number | null) => void> = [];

  constructor(public readonly sessionId: string, opts: PtyCreateOpts) {
    const cmd = opts.command?.[0] ?? 'bash';
    const args = opts.command?.slice(1) ?? [];
    this.pty = spawn(cmd, args, {
      cwd: opts.cwd ?? '/workspace',
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      env: { ...SAFE_ENV },
    });
    this.pty.onData(chunk => this.ringBuffer.push(chunk));
    this.pty.onExit(({ exitCode }) => {
      this.exitCode = exitCode;
      this.exitedAt = Date.now();
      const waiters = this.exitWaiters.splice(0);
      for (const resolve of waiters) resolve(exitCode);
    });
  }

  write(data: string): void {
    if (this.exitCode !== null) throw new SessionExitedError();
    this.bytesIn += data.length;
    this.pty.write(data);
  }

  view(offset = 0): { content: string; cursor: number } {
    const content = this.ringBuffer.read(offset);
    return { content, cursor: this.ringBuffer.totalBytes };
  }

  async waitForExit(timeoutMs: number): Promise<{ exitCode: number | null }> {
    if (this.exitCode !== null) return { exitCode: this.exitCode };
    return new Promise(resolve => {
      let resolved = false;
      const waiter = (exitCode: number | null) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        resolve({ exitCode });
      };
      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        const i = this.exitWaiters.indexOf(waiter);
        if (i >= 0) this.exitWaiters.splice(i, 1);
        resolve({ exitCode: null });
      }, timeoutMs);
      this.exitWaiters.push(waiter);
    });
  }

  kill(signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): void {
    try {
      this.pty.kill(signal);
    } catch {
      // already exited
    }
  }

  resize(cols: number, rows: number): void {
    this.pty.resize(cols, rows);
  }

  stats() {
    return {
      bytesIn: this.bytesIn,
      bytesOut: this.ringBuffer.totalBytes,
      exitCode: this.exitCode,
      ageMs: Date.now() - this.createdAt,
      status: (this.exitCode === null ? 'active' : 'exited') as 'active' | 'exited',
      exitedAt: this.exitedAt,
    };
  }
}
