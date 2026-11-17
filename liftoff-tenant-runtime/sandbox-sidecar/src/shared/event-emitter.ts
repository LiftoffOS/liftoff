import { runtimeAuthHeaders } from '../auth/runtime-auth';
import { config } from '../config';
import { logger } from './logger';

export interface SandboxEvent {
  type: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  success?: boolean;
  durationMs?: number;
  data?: Record<string, unknown>;
  ts: number;
  /** Optional thread + invocation correlation so the runtime can broadcast to SSE. */
  threadId?: string;
  invocationId?: string;
}

const MAX_BATCH_SIZE = 10;
const MAX_BATCH_DELAY_MS = 200;
const MAX_BUFFER_SIZE = 1000;

/**
 * Module-level routing context. The runtime sets these via env vars at sandbox
 * provision time when the sandbox is bound to a specific thread/invocation
 * (one-shot agent runs). For longer-lived sandboxes, callers can update via
 * setRoutingContext(), or pass per-event overrides on emit().
 */
let routingContext: { threadId?: string; invocationId?: string } = {
  threadId: process.env.SANDBOX_THREAD_ID,
  invocationId: process.env.SANDBOX_INVOCATION_ID,
};

export function setRoutingContext(ctx: { threadId?: string; invocationId?: string }): void {
  routingContext = { ...routingContext, ...ctx };
}

export class EventEmitter {
  private buffer: SandboxEvent[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private droppedTotal = 0;

  emit(event: Omit<SandboxEvent, 'ts'> & { ts?: number }): void {
    const withTs: SandboxEvent = {
      ...event,
      ts: event.ts ?? Date.now(),
      threadId: event.threadId ?? routingContext.threadId,
      invocationId: event.invocationId ?? routingContext.invocationId,
    };
    if (this.buffer.length >= MAX_BUFFER_SIZE) {
      this.buffer.shift();
      this.droppedTotal++;
    }
    this.buffer.push(withTs);
    if (this.buffer.length >= MAX_BATCH_SIZE) {
      this.flushNow();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flushNow(), MAX_BATCH_DELAY_MS);
    }
  }

  async flushNow(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0, this.buffer.length);
    try {
      const authHeaders = await runtimeAuthHeaders(['events:write']);
      // Group by threadId so the runtime can route each group to the right SSE
      // subscriber set without inspecting each event.
      const byThread = new Map<string | undefined, SandboxEvent[]>();
      for (const e of batch) {
        const list = byThread.get(e.threadId) ?? [];
        list.push(e);
        byThread.set(e.threadId, list);
      }
      for (const [threadId, group] of byThread.entries()) {
        const invocationId = group.find(e => e.invocationId)?.invocationId;
        await fetch(`${config.runtimeBaseUrl}/internal/sandbox/events`, {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tenantId: config.tenantId,
            agentId: config.agentId,
            sandboxId: config.sandboxId,
            threadId,
            invocationId,
            events: group,
          }),
          signal: AbortSignal.timeout(5000),
        });
      }
    } catch (err) {
      logger.warn({ msg: 'event flush failed', err: String(err), dropped: batch.length });
    }
  }

  async flushAll(): Promise<void> {
    while (this.buffer.length > 0) await this.flushNow();
  }

  get dropped(): number {
    return this.droppedTotal;
  }
}

export const eventEmitter = new EventEmitter();
