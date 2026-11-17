// A chat stream cannot be ended without a terminal frame.
//
// EOF is byte-identical to a socket that died mid-turn. `reader.read()`
// reporting `done` in the browser says the body ended; it does not say why, and
// the two reasons are opposites. So every chat stream ends with one explicit
// `event: done` frame, and its ABSENCE at EOF is what the client
// (`Liftoff-React/src/services/chatSse.ts`) reports as STREAM_TRUNCATED.
//
// That contract was written down in both routers that broke it. The guarantee
// lived in a `finally` attached to one `try`, so every exit ABOVE the try
// bypassed it — and the `interrupt_delivered` acknowledgment is exactly such an
// exit on Liftoff and Insights. Steering a running turn therefore raised "The
// connection dropped before the reply finished arriving." every single time, on
// a message that had in fact been delivered. Agent chat happened to route its
// interrupt through the `finally`, which is luck, not design, and nothing held
// it there.
//
// The socket is a raw `res` any code path may end, so the contract was
// unenforceable by construction. This module makes it structural: the routers no
// longer hold a writable response, only a ChatStream, and
// `src/__tests__/chat-stream-terminal-frame.test.ts` fails the build if `res.end`
// or `res.write` reappears in any of the three.
//
// It also owns the five SSE headers and `flushHeaders()`, which were copy-pasted
// at four sites in the Liftoff router alone.

import type { Response } from 'express';

/** One chat SSE stream. The only writer the chat routers have. */
export interface ChatStream {
  /** One SSE frame: an event-name line, a JSON data line, a blank line. */
  send(event: string, data: unknown): void;
  /**
   * An SSE comment line (`: heartbeat`).
   *
   * Its own method because `send()` cannot express it: a comment has no event
   * name and no JSON body, and clients are required to ignore it while proxies
   * still see traffic. Without this the heartbeat writer would need the raw
   * response back, which is the thing this module exists to take away.
   */
  comment(text: string): void;
  /**
   * Write the terminal `done` frame, exactly once, and close.
   *
   * Idempotent, so a `finally` and a hard timeout racing each other cannot
   * produce two terminal frames or a write after end. When the response is
   * already unusable it closes out without writing: a `done` frame into a dead
   * socket reaches nobody and would only raise an EPIPE on the way out.
   */
  end(): void;
  /**
   * True once this stream is finished, for either reason.
   *
   * ONE question with ONE answer. The routers used to ask `res.writableEnded`,
   * which conflates "we finished" with "the client left" — both are reasons to
   * stop writing, and keeping them apart at every call site bought nothing and
   * cost a missing check.
   */
  readonly ended: boolean;
}

/**
 * Open an SSE response and return the only handle to it.
 *
 * Headers are set and flushed here, so a caller cannot open a stream that a
 * front proxy buffers. `X-Accel-Buffering: no` and `Content-Encoding: identity`
 * are both load-bearing on Cloud Run: without them events accumulate behind the
 * proxy and a person watches nothing happen for the length of the turn.
 */
export function openChatStream(res: Response): ChatStream {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // Disable buffering from nginx/Cloud Run front proxies so events flush promptly.
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Content-Encoding', 'identity');
  res.flushHeaders();
  return new ResponseChatStream(res);
}

class ResponseChatStream implements ChatStream {
  private closed = false;

  constructor(private readonly res: Response) {}

  get ended(): boolean {
    // `closed` is our own terminal state; the other two are the client's. A
    // stream is over if either side is done with it.
    return this.closed || this.res.writableEnded || this.res.destroyed;
  }

  send(event: string, data: unknown): void {
    if (this.ended) return;
    this.res.write(`event: ${event}\n`);
    this.res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  comment(text: string): void {
    if (this.ended) return;
    this.res.write(`: ${text}\n\n`);
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    // The socket may already be gone — a client that navigated away, a
    // connection cut underneath us. There is nobody to tell, and writing would
    // raise rather than inform.
    if (this.res.writableEnded || this.res.destroyed) return;
    this.res.write('event: done\ndata: {}\n\n');
    this.res.end();
  }
}
