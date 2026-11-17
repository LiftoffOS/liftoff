import { Router } from 'express';
import { requireSandboxJwt, type RequestWithClaims } from './middleware/sandbox-jwt-auth';
import { log } from '../infrastructure/logging';
import { streamingService } from '../streaming/service';
import { insertAuditLog } from '../audit/service';
import { randomUUID } from 'crypto';
import type { SSEEvent } from '../streaming/types';

export const sandboxEventsRouter = Router();
sandboxEventsRouter.use(requireSandboxJwt);

interface IncomingEvent {
  type: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  success?: boolean;
  durationMs?: number;
  ts?: number;
  data?: Record<string, unknown>;
}

function sandboxTypeFor(eventType: string): SSEEvent['type'] {
  switch (eventType) {
    case 'tool_start':
      return 'sandbox_tool_start';
    case 'tool_complete':
      return 'sandbox_tool_complete';
    case 'tool_error':
      return 'sandbox_tool_error';
    case 'file_change':
      return 'sandbox_file_change';
    case 'browser_navigation':
      return 'sandbox_browser_navigation';
    default:
      return 'sandbox_tool_complete';
  }
}

sandboxEventsRouter.post('/events', async (req: RequestWithClaims, res) => {
  if (!req.sandboxClaims) return res.status(401).json({ error: 'unauthorized' });
  const claims = req.sandboxClaims;
  const body = req.body as { threadId?: string; invocationId?: string; events: IncomingEvent[] };

  // Per-event values take precedence over the batch-level values (the sidecar
  // event-emitter groups by threadId but each event still carries its own
  // copy in case the buffer mixed multiple invocations during a flush window).
  for (const event of body.events ?? []) {
    const eventWithRouting = event as IncomingEvent & { threadId?: string; invocationId?: string };
    const threadId = eventWithRouting.threadId ?? body.threadId;
    const invocationId = eventWithRouting.invocationId ?? body.invocationId ?? `sandbox-${claims.sandboxId}`;
    if (threadId) {
      const sseEvent: SSEEvent = {
        type: sandboxTypeFor(event.type),
        eventId: randomUUID(),
        threadId,
        invocationId,
        timestamp: new Date(event.ts ?? Date.now()).toISOString(),
        data: {
          toolName: event.toolName ?? event.type,
          args: event.args,
          result: event.result,
          sandboxId: claims.sandboxId,
          ...event.data,
        },
      } as SSEEvent;
      streamingService.broadcast(threadId, sseEvent);
    }
    try {
      await insertAuditLog(null, claims.tenantId, {
        internalAgentId: claims.agentId,
        threadId,
        invocationId,
        action: event.toolName ?? event.type,
        inputArgs: (event.args as Record<string, unknown>) ?? {},
        outputSummary: typeof event.result === 'string' ? event.result.slice(0, 4000) : JSON.stringify(event.result ?? {}).slice(0, 4000),
        outcome: event.success === false ? 'error' : 'success',
        triggeredBy: 'sandbox_tool',
        source: 'sandbox_tool',
      });
    } catch (auditErr) {
      log.warn({ message: 'audit write failed (sandbox event)', error: (auditErr as Error).message });
    }
  }

  res.json({ accepted: body.events?.length ?? 0 });
});
