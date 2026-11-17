import { randomUUID } from 'crypto';
import { PtySession, type PtyCreateOpts } from './pty-session';
import { SessionNotFoundError } from '../shared/errors';

export class PtyManager {
  private sessions = new Map<string, PtySession>();

  create(opts: PtyCreateOpts): PtySession {
    const sessionId = randomUUID();
    const session = new PtySession(sessionId, opts);
    this.sessions.set(sessionId, session);
    return session;
  }

  get(sessionId: string): PtySession {
    const s = this.sessions.get(sessionId);
    if (!s) throw new SessionNotFoundError();
    return s;
  }

  list(): Array<{ sessionId: string; createdAt: string; status: 'active' | 'exited' }> {
    return Array.from(this.sessions.values()).map(s => {
      const stats = s.stats();
      return {
        sessionId: s.sessionId,
        createdAt: new Date(Date.now() - stats.ageMs).toISOString(),
        status: stats.status,
      };
    });
  }

  destroy(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.kill('SIGTERM');
    this.sessions.delete(sessionId);
  }

  async killAll(): Promise<void> {
    for (const s of this.sessions.values()) s.kill('SIGTERM');
    this.sessions.clear();
  }
}

export const ptyManager = new PtyManager();
