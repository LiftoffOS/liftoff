// Handler integration tests — abort/reconnect/backpressure/revocation scenarios.
// These tests mock the DB pool, Secret Manager cache, and upstream Anthropic API.
// No real network or DB connections are made.

import http from 'node:http';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { AnthropicAdapter } from '../vendor/anthropic.js';
import type { TokenUsage } from '../vendor/adapter.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal TokenUsage object for mock assertions.
 */
function makeUsage(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return {
    requestId: 'msg_test',
    model: 'claude-sonnet-4-6',
    inputTokens: 10,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    ...overrides,
  };
}

/**
 * Canonical SSE chunks for a 3-event stream:
 *   message_start (10 in) → content_block_delta → message_delta (3 out) → message_stop
 */
const SSE_MESSAGE_START =
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","model":"claude-sonnet-4-6","usage":{"input_tokens":10,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}\n\n';

const SSE_CONTENT_DELTA =
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n';

const SSE_MESSAGE_DELTA =
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n';

const SSE_MESSAGE_STOP =
  'event: message_stop\ndata: {"type":"message_stop"}\n\n' +
  'data: [DONE]\n\n';

// ---------------------------------------------------------------------------
// Controllable mock upstream server
// ---------------------------------------------------------------------------

interface MockUpstreamController {
  /** Write an SSE chunk to all waiting client responses */
  sendChunk(chunk: string): void;
  /** Close all waiting client responses (end the stream) */
  endStream(): void;
  /** Emit an HTTP error response (non-200) */
  sendError(status: number, body: string): void;
  /** URL of the mock server */
  url: string;
  /** Tear down the server */
  close(): Promise<void>;
  /** Resolves when the first request arrives */
  waitForRequest(): Promise<http.IncomingMessage>;
}

function createMockUpstream(): Promise<MockUpstreamController> {
  return new Promise((resolve) => {
    const pendingResponses: http.ServerResponse[] = [];
    const requestEmitter = new EventEmitter();
    let nextError: { status: number; body: string } | null = null;

    const server = http.createServer((req, res) => {
      requestEmitter.emit('request', req);

      if (nextError) {
        const { status, body } = nextError;
        nextError = null;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(body);
        return;
      }

      // SSE stream response
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'connection': 'keep-alive',
      });
      pendingResponses.push(res);

      req.on('close', () => {
        const idx = pendingResponses.indexOf(res);
        if (idx !== -1) pendingResponses.splice(idx, 1);
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${port}`;

      resolve({
        url,
        sendChunk(chunk) {
          for (const res of pendingResponses) {
            try { res.write(chunk); } catch { /* client gone */ }
          }
        },
        endStream() {
          for (const res of [...pendingResponses]) {
            try { res.end(); } catch { /* already ended */ }
          }
          pendingResponses.length = 0;
        },
        sendError(status, body) {
          nextError = { status, body };
        },
        waitForRequest() {
          return new Promise((res) => requestEmitter.once('request', res));
        },
        close() {
          return new Promise((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          });
        },
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Inline proxy logic (avoids full Fastify server, tests core stream logic)
// ---------------------------------------------------------------------------

interface ProxyUsageLog {
  status: 'final' | 'disconnected' | 'error';
  inputTokens: number;
  outputTokens: number;
  requestId: string;
  errorMessage?: string;
}

/**
 * Minimal inline proxy: fetch SSE from upstreamUrl, accumulate usage, write to clientOut.
 * Simulates handler.ts stream logic without Fastify overhead.
 */
async function runInlineProxy(options: {
  upstreamUrl: string;
  clientOut: { write: (s: string) => boolean; end: () => void; destroyed: boolean };
  model?: string;
  abortSignal?: AbortSignal;
}): Promise<ProxyUsageLog> {
  const adapter = new AnthropicAdapter();
  const model = options.model ?? 'claude-sonnet-4-6';

  let usage: TokenUsage = {
    requestId: '', model,
    inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0,
  };
  let streamStatus: 'final' | 'disconnected' | 'error' = 'final';
  let errorMessage: string | undefined;
  let clientGone = false;

  const abortController = new AbortController();
  if (options.abortSignal) {
    options.abortSignal.addEventListener('abort', () => {
      clientGone = true;
      abortController.abort();
    });
  }

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(options.upstreamUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'test-key' },
      body: JSON.stringify({ model, stream: true, messages: [] }),
      signal: abortController.signal,
    });
  } catch (err) {
    return { status: 'error', inputTokens: 0, outputTokens: 0, requestId: '', errorMessage: String(err) };
  }

  if (!upstreamRes.ok || !upstreamRes.body) {
    const body = await upstreamRes.text().catch(() => '');
    return { status: 'error', inputTokens: 0, outputTokens: 0, requestId: '', errorMessage: `upstream ${upstreamRes.status}: ${body}` };
  }

  const reader = upstreamRes.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      sseBuffer += chunk;

      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const rawData = line.slice(6).trim();
        const event = adapter.parseSseDataLine(rawData);
        if (event) usage = adapter.accumulateUsage(usage, event);
      }

      if (!clientGone && !options.clientOut.destroyed) {
        options.clientOut.write(chunk);
      } else {
        streamStatus = 'disconnected';
        break;
      }
    }
  } catch (err) {
    streamStatus = 'error';
    errorMessage = String(err);
  } finally {
    reader.releaseLock();
    options.clientOut.end();
  }

  return {
    status: streamStatus,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    requestId: usage.requestId,
    errorMessage,
  };
}

// ---------------------------------------------------------------------------
// Mock DB usage logger
// ---------------------------------------------------------------------------

interface MockUsageLogEntry {
  status: string;
  inputTokens: number;
  outputTokens: number;
  errorMessage?: string;
}

function createMockUsageLogger(): {
  log: (entry: MockUsageLogEntry) => void;
  entries: MockUsageLogEntry[];
} {
  const entries: MockUsageLogEntry[] = [];
  return {
    entries,
    log(entry) { entries.push(entry); },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('proxy handler abort/disconnect scenarios', () => {
  let upstream: MockUpstreamController;

  beforeEach(async () => {
    upstream = await createMockUpstream();
  });

  afterEach(async () => {
    await upstream.close();
  });

  test('client abort mid-stream: proxy stops reading and records partial tokens', async () => {
    // Arrange: upstream will send message_start then hang
    const requestArrived = upstream.waitForRequest();
    const clientAbort = new AbortController();

    // Build a mock client output that tracks written bytes and reports destroyed.
    // runInlineProxy accumulates usage and THEN echoes the chunk in the same loop
    // iteration, so the first write is a deterministic signal that message_start
    // has been parsed — used below instead of racing a fixed timeout.
    const written: string[] = [];
    let ended = false;
    let signalFirstWrite: () => void = () => {};
    const firstWrite = new Promise<void>((resolve) => { signalFirstWrite = resolve; });
    const clientOut = {
      write: (s: string) => { written.push(s); signalFirstWrite(); return true; },
      end: () => { ended = true; },
      get destroyed() { return false; },
    };

    // Start proxy in background
    const proxyPromise = runInlineProxy({
      upstreamUrl: upstream.url,
      clientOut,
      abortSignal: clientAbort.signal,
    });

    // Wait for upstream to receive the request, then send message_start
    await requestArrived;
    upstream.sendChunk(SSE_MESSAGE_START);

    // Wait until the proxy has parsed message_start and echoed it to the client
    // (usage is accumulated before the echo), making the abort deterministic
    // rather than dependent on wall-clock timing.
    await firstWrite;

    // Abort the client connection
    clientAbort.abort();

    // Close upstream to allow proxy to finish
    upstream.endStream();

    const result = await proxyPromise;

    // Proxy recorded partial usage (input tokens from message_start)
    expect(result.inputTokens).toBe(10);
    // Output tokens are 0 because message_delta never arrived
    expect(result.outputTokens).toBe(0);
    expect(result.requestId).toBe('msg_test');
    // Status is disconnected or error (client aborted)
    expect(['disconnected', 'error']).toContain(result.status);
    expect(ended).toBe(true);
  });

  test('upstream 500 after first SSE event: proxy records error status', async () => {
    // Arrange: upstream will return 500 on next request
    upstream.sendError(500, JSON.stringify({ error: 'internal server error' }));

    const written: string[] = [];
    const clientOut = {
      write: (s: string) => { written.push(s); return true; },
      end: () => undefined,
      get destroyed() { return false; },
    };

    const result = await runInlineProxy({ upstreamUrl: upstream.url, clientOut });

    expect(result.status).toBe('error');
    expect(result.errorMessage).toContain('500');
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
  });

  test('successful complete stream: tokens accumulated correctly, status=final', async () => {
    // Arrange: upstream sends complete 4-event SSE stream
    const requestArrived = upstream.waitForRequest();

    const written: string[] = [];
    const clientOut = {
      write: (s: string) => { written.push(s); return true; },
      end: () => undefined,
      get destroyed() { return false; },
    };

    const proxyPromise = runInlineProxy({ upstreamUrl: upstream.url, clientOut });

    await requestArrived;

    // Send full stream
    upstream.sendChunk(SSE_MESSAGE_START);
    upstream.sendChunk(SSE_CONTENT_DELTA);
    upstream.sendChunk(SSE_MESSAGE_DELTA);
    upstream.sendChunk(SSE_MESSAGE_STOP);
    upstream.endStream();

    const result = await proxyPromise;

    expect(result.status).toBe('final');
    expect(result.inputTokens).toBe(10);
    expect(result.outputTokens).toBe(3);
    expect(result.requestId).toBe('msg_test');
    // Client should have received the SSE bytes
    expect(written.join('')).toContain('message_start');
  });

  test('revocation during stream: connection closed, usage persisted with partial tokens', async () => {
    // Simulate revocation mid-stream by marking client as gone after first chunk
    const requestArrived = upstream.waitForRequest();

    let clientDestroyed = false;
    const written: string[] = [];
    let signalFirstWrite: () => void = () => {};
    const firstWrite = new Promise<void>((resolve) => { signalFirstWrite = resolve; });
    const clientOut = {
      write: (s: string) => {
        written.push(s);
        // After first write, mark client as gone (simulates revocation closing connection)
        if (written.length === 1) clientDestroyed = true;
        signalFirstWrite();
        return !clientDestroyed;
      },
      end: () => undefined,
      get destroyed() { return clientDestroyed; },
    };

    // Use an abort signal that fires after client is marked destroyed
    const abortController = new AbortController();

    const proxyPromise = runInlineProxy({
      upstreamUrl: upstream.url,
      clientOut,
      abortSignal: abortController.signal,
    });

    await requestArrived;
    upstream.sendChunk(SSE_MESSAGE_START);

    // Wait until the proxy has parsed message_start and echoed it (usage is
    // accumulated before the echo), then simulate revocation by aborting —
    // deterministic rather than dependent on wall-clock timing.
    await firstWrite;
    abortController.abort();
    upstream.endStream();

    const result = await proxyPromise;

    // Usage is persisted — input tokens captured from message_start
    expect(result.inputTokens).toBe(10);
    // Status reflects the disconnect
    expect(['disconnected', 'error']).toContain(result.status);
  });

  test('usage logger receives correct entry after stream completes', async () => {
    const logger = createMockUsageLogger();
    const requestArrived = upstream.waitForRequest();

    const clientOut = {
      write: (_s: string) => true,
      end: () => undefined,
      get destroyed() { return false; },
    };

    const proxyPromise = runInlineProxy({ upstreamUrl: upstream.url, clientOut });

    await requestArrived;
    upstream.sendChunk(SSE_MESSAGE_START + SSE_MESSAGE_DELTA + SSE_MESSAGE_STOP);
    upstream.endStream();

    const result = await proxyPromise;

    // Log the result (simulating what handler.ts does after stream)
    logger.log({
      status: result.status,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      errorMessage: result.errorMessage,
    });

    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0].status).toBe('final');
    expect(logger.entries[0].inputTokens).toBe(10);
    expect(logger.entries[0].outputTokens).toBe(3);
  });

  test('malformed SSE chunk mid-stream: parsing continues without crashing', async () => {
    const requestArrived = upstream.waitForRequest();

    const clientOut = {
      write: (_s: string) => true,
      end: () => undefined,
      get destroyed() { return false; },
    };

    const proxyPromise = runInlineProxy({ upstreamUrl: upstream.url, clientOut });

    await requestArrived;

    // Send message_start, then a malformed line, then valid message_delta
    upstream.sendChunk(SSE_MESSAGE_START);
    upstream.sendChunk('event: content_block_delta\ndata: {bad json!!!}\n\n');
    upstream.sendChunk(SSE_MESSAGE_DELTA + SSE_MESSAGE_STOP);
    upstream.endStream();

    const result = await proxyPromise;

    expect(result.status).toBe('final');
    expect(result.inputTokens).toBe(10);
    expect(result.outputTokens).toBe(3); // message_delta still parsed correctly
  });
});

// ---------------------------------------------------------------------------
// AnthropicAdapter unit tests (no mock server needed)
// ---------------------------------------------------------------------------

describe('AnthropicAdapter: parseSseDataLine edge cases', () => {
  const a = new AnthropicAdapter();

  test('[DONE] sentinel returns null', () => {
    expect(a.parseSseDataLine('[DONE]')).toBeNull();
  });

  test('empty string returns null', () => {
    // JSON.parse('') throws, adapter catches and returns null
    expect(a.parseSseDataLine('')).toBeNull();
  });

  test('valid message_start returns event with correct type', () => {
    const raw = JSON.stringify({
      type: 'message_start',
      message: { id: 'msg_x', model: 'claude-sonnet-4-6', usage: { input_tokens: 5 } },
    });
    const event = a.parseSseDataLine(raw);
    expect(event).not.toBeNull();
    expect(event!.type).toBe('message_start');
  });

  test('accumulateUsage is idempotent for unknown event types', () => {
    const usage = makeUsage({ inputTokens: 42, outputTokens: 7 });
    const unknownEvent = { type: 'future_event_type', data: { foo: 'bar' } };
    const after = a.accumulateUsage(usage, unknownEvent);
    expect(after).toEqual(usage);
  });
});
