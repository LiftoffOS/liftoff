// SSE Streaming Service
// Per implementation plan: Phase 4 SSE Event Streaming

import { Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { log } from '../infrastructure/logging';
import { SSEEvent, SSEClient } from './types';

// In-memory client registry (for single-instance)
// For multi-instance deployment, use Redis pub/sub
const clientsByThread = new Map<string, Map<string, { res: Response; client: SSEClient }>>();

// Heartbeat interval (30 seconds)
const HEARTBEAT_INTERVAL = 30000;

export class StreamingService {
  private heartbeatTimers = new Map<string, NodeJS.Timeout>();

  // Register a new SSE client
  registerClient(
    res: Response,
    threadId: string,
    tenantId: string,
    userId?: string
  ): SSEClient {
    const client: SSEClient = {
      id: uuidv4(),
      tenantId,
      threadId,
      userId,
      connectedAt: new Date(),
      lastPingAt: new Date(),
    };

    // Initialize thread bucket if needed
    if (!clientsByThread.has(threadId)) {
      clientsByThread.set(threadId, new Map());
    }

    clientsByThread.get(threadId)!.set(client.id, { res, client });

    // Setup heartbeat
    this.startHeartbeat(client.id, threadId, res);

    log.info({
      clientId: client.id,
      threadId,
      tenantId,
    }, 'SSE client connected');

    return client;
  }

  // Unregister a client
  unregisterClient(clientId: string, threadId: string): void {
    const threadClients = clientsByThread.get(threadId);
    if (threadClients) {
      threadClients.delete(clientId);

      // Clean up empty thread buckets
      if (threadClients.size === 0) {
        clientsByThread.delete(threadId);
      }
    }

    // Stop heartbeat
    const timer = this.heartbeatTimers.get(clientId);
    if (timer) {
      clearInterval(timer);
      this.heartbeatTimers.delete(clientId);
    }

    log.info({ clientId, threadId }, 'SSE client disconnected');
  }

  // Broadcast event to all clients on a thread
  broadcast(threadId: string, event: SSEEvent): void {
    const threadClients = clientsByThread.get(threadId);
    if (!threadClients || threadClients.size === 0) {
      return;
    }

    const serialized = this.serializeEvent(event);

    for (const [clientId, { res }] of threadClients) {
      try {
        res.write(serialized);
      } catch (error) {
        log.warn({ clientId, error }, 'Failed to send SSE event, removing client');
        this.unregisterClient(clientId, threadId);
      }
    }

    log.debug({
      threadId,
      eventType: event.type,
      clientCount: threadClients.size,
    }, 'SSE event broadcast');
  }

  // Send event to a specific client
  sendToClient(clientId: string, threadId: string, event: SSEEvent): void {
    const threadClients = clientsByThread.get(threadId);
    const clientEntry = threadClients?.get(clientId);

    if (!clientEntry) {
      return;
    }

    try {
      clientEntry.res.write(this.serializeEvent(event));
    } catch (error) {
      log.warn({ clientId, error }, 'Failed to send SSE event, removing client');
      this.unregisterClient(clientId, threadId);
    }
  }

  // Get connected client count for a thread
  getClientCount(threadId: string): number {
    return clientsByThread.get(threadId)?.size || 0;
  }

  // Check if thread has any connected clients
  hasClients(threadId: string): boolean {
    return this.getClientCount(threadId) > 0;
  }

  // Helper: Emit agent status event
  emitAgentStatus(
    threadId: string,
    invocationId: string,
    status: 'thinking' | 'executing' | 'waiting' | 'complete',
    agentId: string,
    agentRole: string
  ): void {
    this.broadcast(threadId, {
      type: 'agent_status',
      eventId: uuidv4(),
      threadId,
      invocationId,
      timestamp: new Date().toISOString(),
      data: { status, agentId, agentRole },
    });
  }

  // Helper: Emit tool start event
  emitToolStart(
    threadId: string,
    invocationId: string,
    toolCallId: string,
    toolName: string,
    input: Record<string, unknown>
  ): void {
    this.broadcast(threadId, {
      type: 'tool_start',
      eventId: uuidv4(),
      threadId,
      invocationId,
      timestamp: new Date().toISOString(),
      data: { toolCallId, toolName, input },
    });
  }

  // Helper: Emit tool complete event
  emitToolComplete(
    threadId: string,
    invocationId: string,
    toolCallId: string,
    toolName: string,
    output: unknown
  ): void {
    this.broadcast(threadId, {
      type: 'tool_complete',
      eventId: uuidv4(),
      threadId,
      invocationId,
      timestamp: new Date().toISOString(),
      data: { toolCallId, toolName, output },
    });
  }

  // Helper: Emit HITL required event
  emitHitlRequired(
    threadId: string,
    invocationId: string,
    approvalId: string,
    reason: string,
    pendingToolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
    expiresAt?: Date,
  ): void {
    this.broadcast(threadId, {
      type: 'hitl_required',
      eventId: uuidv4(),
      threadId,
      invocationId,
      timestamp: new Date().toISOString(),
      data: {
        approvalId,
        reason,
        pendingToolCalls,
        expiresAt: expiresAt ? expiresAt.toISOString() : undefined,
      },
    });
  }

  /** Emit a HITL-rejected event so the chat UI tears down its
   *  approval-pending state and shows the rejection. Re-uses the existing
   *  `hitl_resolved` event type (decision='rejected'). Called from
   *  `finalizeHitlRejected` after the operator clicks Reject and the
   *  resume task fires; also from `finalizeHitlExpired` when the 24h
   *  timer elapses without a decision. `rejectionReason` is recorded on
   *  the approval row and surfaced separately via the approvals API;
   *  this event carries the structured signal only. */
  emitHitlRejected(
    threadId: string,
    invocationId: string,
    approvalId: string,
    rejectionReason?: string,
  ): void {
    void rejectionReason;
    this.broadcast(threadId, {
      type: 'hitl_resolved',
      eventId: uuidv4(),
      threadId,
      invocationId,
      timestamp: new Date().toISOString(),
      data: {
        approvalId,
        decision: 'rejected',
      },
    });
  }

  // Helper: Emit rescue branch event (emitted when agent hits turn limit with uncommitted work)
  emitRescueBranch(threadId: string, invocationId: string, branchName: string): void {
    this.broadcast(threadId, {
      type: 'rescue_branch',
      eventId: uuidv4(),
      threadId,
      invocationId,
      timestamp: new Date().toISOString(),
      data: { branchName },
    });
  }

  // Helper: Emit text delta event
  emitTextDelta(threadId: string, invocationId: string, delta: string): void {
    this.broadcast(threadId, {
      type: 'text_delta',
      eventId: uuidv4(),
      threadId,
      invocationId,
      timestamp: new Date().toISOString(),
      data: { delta, role: 'assistant' },
    });
  }

  // Helper: Emit error event
  emitError(
    threadId: string,
    invocationId: string,
    code: string,
    message: string,
    retryable: boolean
  ): void {
    this.broadcast(threadId, {
      type: 'error',
      eventId: uuidv4(),
      threadId,
      invocationId,
      timestamp: new Date().toISOString(),
      data: { code, message, retryable },
    });
  }

  // Serialize event for SSE format
  private serializeEvent(event: SSEEvent): string {
    const lines = [
      `event: ${event.type}`,
      `id: ${event.eventId}`,
      `data: ${JSON.stringify(event)}`,
      '',
      '',
    ];
    return lines.join('\n');
  }

  // Start heartbeat for a client
  private startHeartbeat(clientId: string, threadId: string, res: Response): void {
    const timer = setInterval(() => {
      try {
        res.write(`:ping\n\n`);

        // Update last ping time
        const threadClients = clientsByThread.get(threadId);
        const clientEntry = threadClients?.get(clientId);
        if (clientEntry) {
          clientEntry.client.lastPingAt = new Date();
        }
      } catch {
        this.unregisterClient(clientId, threadId);
      }
    }, HEARTBEAT_INTERVAL);

    this.heartbeatTimers.set(clientId, timer);
  }
}

export const streamingService = new StreamingService();
