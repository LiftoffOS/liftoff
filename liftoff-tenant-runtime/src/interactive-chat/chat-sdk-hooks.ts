// Chat SSE helper
//
// Phase 3 of the provider-aware interactive chat plan decommissioned the
// chat-only engine: fresh chat turns now run through the shared agent-execution
// engine (executeTask → runAgentHybridLoop), so the bespoke `buildChatSdkHooks`
// (HITL / circuit breaker / citation-warning / audit for the direct Claude Agent
// SDK path) was removed — that governance is now the engine's once-only pipeline
// (the citation-warning guardrail moved to tool-gateway/mcp-server.ts so it
// covers chat AND autonomous). `writeSSE` survives as the SSE-relay helper the
// chat-turn handler uses to translate engine events onto the response stream.

import type { Response } from 'express';

/**
 * Write a Server-Sent Event to the Express response and wait for the write
 * to drain into the OS socket buffer.
 *
 * Why the await: Node's `res.write(data)` returns immediately and queues the
 * data into the Node-side writable buffer. Under sustained SSE load on Cloud
 * Run, the proxy / GFE can batch the buffered chunks and only flush them to
 * the consumer after either (a) a large-enough batch accumulates, (b) the
 * stream ends, or (c) a long quiet period elapses on the underlying TCP
 * stream. For chat turns where the agent emits 0-N events with seconds of
 * silence between them, the trailing `complete` event was getting buffered
 * with everything else and lost at res.end(). The dual-surface harness
 * deterministically reproduced this: TR's chat-turn ran to completion (logs
 * showed Invocation completed / Memory saved / lock_released) yet PB's
 * consumer saw only the first event then EOF.
 *
 * The fix is to use `res.write(chunk, callback)` and AWAIT the callback.
 * Node calls the callback when the chunk has been flushed to the kernel
 * socket buffer (not just queued internally). Together with the
 * setNoDelay() the chat-turn-handler sets on the underlying socket (so
 * Nagle's algorithm doesn't coalesce small SSE frames), this forces each
 * SSE event to leave the Node process AS its own TCP packet, which the
 * Cloud Run proxy then has to forward immediately because it never gets
 * a chance to coalesce them either.
 *
 * Backpressure handling: if `res.write()` returns false, the writable
 * stream is full and the callback won't fire until the buffer drains. We
 * still await — that's the entire point: the SDK loop SHOULD pause when
 * the network is congested. Returning early would let the SDK keep
 * producing events that pile up in the in-process buffer and exacerbate
 * the very buffering this function is trying to defeat.
 *
 * Format: `event: <type>\ndata: <json>\n\n`
 */
export async function writeSSE(res: Response, event: string, data: unknown): Promise<void> {
  if (res.writableEnded) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  await new Promise<void>((resolve, reject) => {
    const ok = res.write(payload, (err) => {
      if (err) reject(err);
      else resolve();
    });
    // ok === false means the writable buffer is full; the callback will
    // still fire once the kernel drains it. No special handling needed —
    // we already await the callback.
    void ok;
  });
}
