// PR3: SSE bridge for browser-session events. Opens a server-streaming
// Connect-RPC call against tenant-runtime and forwards each frame as an SSE
// event. Mirrors insights/stream-router.ts heartbeat + hard-timeout pattern.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { toJson } from '@bufbuild/protobuf';
import { TimestampSchema } from '@bufbuild/protobuf/wkt';
import {
  StreamSessionEventsResponse_Type,
  BrowserSessionSchema,
} from '@liftoffos/proto-gen/dist/liftoff/platform/v1/browser_sessions_pb.js';
import { getBrowserSessionsServiceClient } from '../connectors/tenant-runtime-service-client';
import { resolveCaller } from '../auth/resolve-caller';
import { findThreadOnSurface, surfaceQuerySchema } from './thread-surface';
import { log as logger } from '../infrastructure/logging';

export const browserSessionsStreamRouter = Router();

/**
 * One SSE frame. A frame that cannot be serialized is DROPPED, not thrown.
 *
 * This used to throw straight out of the `for await` below, into the catch
 * that ends the stream — so one unserializable field did not lose an event, it
 * lost every subsequent one. For example, a protobuf Timestamp holds `bigint`
 * seconds, `JSON.stringify` refuses a BigInt, and the FIRST session event
 * kills the stream: the pane silently falls back to its 90-second poll while
 * the log says "browser session stream failed" and nothing says which event
 * or why.
 *
 * The payload is serialized properly at the call site now. This is the floor
 * under it: a live-update stream that dies on one bad frame is worse than one
 * that skips it, because the failure is invisible to the person watching.
 */
function sendSseEvent(res: Response, event: string, data: unknown): void {
  let payload: string;
  try {
    payload = JSON.stringify(data);
  } catch (err) {
    logger.error(
      { err: (err as Error).message, event },
      'browser session stream: frame dropped, could not serialize',
    );
    return;
  }
  res.write(`event: ${event}\n`);
  res.write(`data: ${payload}\n\n`);
}

// The wire `type` is the numeric proto enum. Map it to the string SSE event
// name the frontend hook keys on (SESSION_CREATED / SESSION_UPDATED /
// SESSION_CLOSED) — emitting String(type) would send "1"/"2"/"3" and the
// client would never match.
function eventTypeName(type: StreamSessionEventsResponse_Type): string {
  switch (type) {
    case StreamSessionEventsResponse_Type.SESSION_CREATED: return 'SESSION_CREATED';
    case StreamSessionEventsResponse_Type.SESSION_UPDATED: return 'SESSION_UPDATED';
    case StreamSessionEventsResponse_Type.SESSION_CLOSED:  return 'SESSION_CLOSED';
    default: return 'SESSION_UNKNOWN';
  }
}

browserSessionsStreamRouter.get(
  '/threads/:threadId/browser-sessions/stream',
  async (req: Request, res: Response) => {
    const params = z.object({ threadId: z.string().uuid() }).safeParse(req.params);
    const query = z.object({ tenantId: z.string().uuid() }).safeParse(req.query);
    const surfaceParse = surfaceQuerySchema.safeParse(req.query);
    if (!params.success || !query.success || !surfaceParse.success) return res.status(400).end();

    // Membership is proved BEFORE the thread is read, on every surface. The
    // surface only chooses the table, exactly as the REST router does.
    const resolution = await resolveCaller(req.ctx?.userId, query.data.tenantId);
    if (!resolution.ok) return res.status(resolution.status).end();
    const thread = await findThreadOnSurface(
      surfaceParse.data.surface ?? 'agent', params.data.threadId, query.data.tenantId, resolution.caller,
    );
    if (!thread) return res.status(404).end();

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Content-Encoding', 'identity');
    res.flushHeaders();

    let aborted = false;
    const onClose = () => { aborted = true; };
    req.on('close', onClose);

    const heartbeat = setInterval(() => {
      if (!aborted && !res.writableEnded) res.write(`: heartbeat\n\n`);
    }, 30_000);
    const hardTimeout = setTimeout(() => {
      sendSseEvent(res, 'error', { message: 'Stream timeout' });
      res.end();
    }, 10 * 60 * 1000);

    try {
      const client = await getBrowserSessionsServiceClient(query.data.tenantId);
      const stream = client.streamSessionEvents({
        tenantContext: { tenantId: query.data.tenantId },
        threadId: thread.id,
      });
      for await (const event of stream) {
        if (aborted || res.writableEnded) break;
        // The WHOLE per-event build is guarded, not just the write. `toJson`
        // throws on a message it cannot convert, and that throw is at this
        // call site — outside sendSseEvent — so guarding only the write left
        // exactly the failure being fixed: one bad event unwinding into the
        // catch below and ending the stream for good.
        try {
        // proto-JSON, not the message object. The Connect client returns
        // protobuf-es MESSAGES whose Timestamp fields hold `bigint` seconds,
        // and res.write(JSON.stringify(...)) refuses a BigInt — the same
        // reason browser-sessions/router.ts serializes with toJson for its
        // REST replies. That file learned this and this one did not, so the
        // two routers carrying the same message disagreed about whether it
        // could be written at all.
        //
        // Using toJson here also makes the SSE payload the same shape as the
        // REST payload (camelCase keys, RFC3339 timestamps), rather than a
        // second shape nobody specified. The REST route's extra enrichment —
        // owner, driver — is deliberately NOT done per event: it costs a
        // database read, and the pane's hook reads only the event NAME and
        // refetches, so a heavier frame would buy nothing.
          sendSseEvent(res, eventTypeName(event.type), {
            session: event.session ? toJson(BrowserSessionSchema, event.session) : null,
            emittedAt: event.emittedAt ? toJson(TimestampSchema, event.emittedAt) : null,
          });
        } catch (err) {
          logger.error(
            { err: (err as Error).message, event: eventTypeName(event.type) },
            'browser session stream: frame dropped, could not serialize',
          );
        }
      }
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'browser session stream failed');
      if (!res.writableEnded) sendSseEvent(res, 'error', { message: 'stream error' });
    } finally {
      clearInterval(heartbeat);
      clearTimeout(hardTimeout);
      req.off('close', onClose);
      if (!res.writableEnded) res.end();
    }
  },
);
