import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import { SessionNotFoundError } from '../shared/errors';

const SESSION_DIR = '/tmp/.nodejs-sessions';
const SAFE_BASE_ENV: Record<string, string> = {
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/tmp',
  LANG: 'en_US.UTF-8',
  TERM: 'xterm-256color',
  WORKSPACE_DIR: '/workspace',
  TMPDIR: '/tmp',
  // Make the bundled in-sandbox SDK resolvable from these ad-hoc scripts, which
  // run from SESSION_DIR (not under any node_modules). The image symlinks
  // @liftoffos/agent-sdk into this dir; see sandbox-sidecar/Dockerfile.
  NODE_PATH: '/opt/sandbox-node-path',
};

export class NodeReplSession {
  public readonly sessionId: string;
  private scriptPath: string;
  private accumulated = '';

  constructor() {
    this.sessionId = randomUUID();
    this.scriptPath = `${SESSION_DIR}/${this.sessionId}.js`;
  }

  static async ensureDir(): Promise<void> {
    await fs.mkdir(SESSION_DIR, { recursive: true });
  }

  async execute(snippet: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    await NodeReplSession.ensureDir();
    const combined = `${this.accumulated}\n;(async () => {\n${snippet}\n})().catch(e => { console.error(e); process.exit(1); });`;
    await fs.writeFile(this.scriptPath, combined, 'utf-8');
    return new Promise(resolve => {
      execFile(
        'node',
        [this.scriptPath],
        { timeout: 30_000, env: SAFE_BASE_ENV, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const exitCode = typeof err?.code === 'number' ? err.code : err ? 1 : 0;
          if (exitCode === 0) this.accumulated = combined;
          resolve({ stdout, stderr, exitCode });
        },
      );
    });
  }

  async destroy(): Promise<void> {
    await fs.unlink(this.scriptPath).catch(() => undefined);
  }
}

export class NodeReplManager {
  private sessions = new Map<string, NodeReplSession>();

  create(): NodeReplSession {
    const s = new NodeReplSession();
    this.sessions.set(s.sessionId, s);
    return s;
  }

  get(id: string): NodeReplSession {
    const s = this.sessions.get(id);
    if (!s) throw new SessionNotFoundError();
    return s;
  }

  list(): string[] {
    return Array.from(this.sessions.keys());
  }

  async destroy(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    await s.destroy();
    this.sessions.delete(id);
  }
}

export const nodeReplManager = new NodeReplManager();
