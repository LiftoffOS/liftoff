import { randomBytes } from 'crypto';
import type { AuthTicketPurpose } from '@liftoffos/sandbox-contracts';

interface TicketRecord {
  purpose: AuthTicketPurpose;
  exp: number;
  used: boolean;
}

const SWEEP_INTERVAL_MS = 60_000;

export class TicketStore {
  private tickets = new Map<string, TicketRecord>();
  private sweepTimer: NodeJS.Timeout;

  constructor() {
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  issue(purpose: AuthTicketPurpose, ttlMs: number): { ticket: string; expiresAt: number } {
    const ticket = randomBytes(24).toString('hex');
    const exp = Date.now() + Math.min(ttlMs, 300_000);
    this.tickets.set(ticket, { purpose, exp, used: false });
    return { ticket, expiresAt: exp };
  }

  /**
   * Single-use consume. Returns claims if valid; null otherwise.
   * After consumption, the ticket cannot be reused.
   */
  consume(ticket: string): { purpose: AuthTicketPurpose } | null {
    const record = this.tickets.get(ticket);
    if (!record) return null;
    if (record.used) return null;
    if (record.exp < Date.now()) return null;
    record.used = true;
    return { purpose: record.purpose };
  }

  sessionInsert(sessionId: string, purpose: AuthTicketPurpose, ttlMs: number): void {
    // Sessions reuse the ticket map keyed by sessionId, marked already-used so
    // a subsequent ticket-style consume returns null. Used directly via session lookup.
    this.tickets.set(sessionId, { purpose, exp: Date.now() + ttlMs, used: true });
  }

  sessionValid(sessionId: string): boolean {
    const record = this.tickets.get(sessionId);
    return !!record && record.exp > Date.now();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.tickets) {
      if (v.exp < now) this.tickets.delete(k);
    }
  }
}

export const ticketStore = new TicketStore();
