// Streamable HTTP Transport
// Current MCP standard (2025-03-26)
// Single endpoint, POST for requests, responses can be JSON or SSE stream

import type { MCPTransport, MCPTransportConfig, TransportType, Logger } from './types.js';
import { noopLogger } from './types.js';

interface MCPRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface MCPResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface StreamableHttpTransportOptions {
  config: MCPTransportConfig;
  logger?: Logger;
  sessionId?: string | null;
}

// MCP protocol version this client speaks. Sent in the initialize handshake
// so the server knows which version of the spec we're using.
const MCP_PROTOCOL_VERSION = '2025-03-26';

// Default client identification sent during initialize. Servers can log this
// for diagnostics; it has no functional effect.
const DEFAULT_CLIENT_INFO = {
  name: 'mcp-transport',
  version: '1.0.0',
};

export class StreamableHttpTransport implements MCPTransport {
  private config: MCPTransportConfig;
  private requestId = 0;
  private logger: Logger;
  private sessionId: string | null = null;
  // Tracks whether the MCP initialize handshake has completed for this
  // transport instance. The handshake establishes a session-id which the
  // server then requires on every subsequent request. Without it,
  // spec-compliant servers (CoinGecko, etc.) reject tools/call with HTTP 400
  // "Mcp-Session-Id header is required".
  private initialized = false;
  private initializePromise: Promise<void> | null = null;

  constructor(options: StreamableHttpTransportOptions | MCPTransportConfig) {
    // Support both new options format and legacy config-only format
    if ('config' in options) {
      this.config = options.config;
      this.logger = options.logger || noopLogger;
      this.sessionId = options.sessionId || null;
      // If a session ID was provided up front (e.g., from a previous
      // discovery handshake that already initialized), skip the handshake.
      this.initialized = !!this.sessionId;
    } else {
      this.config = options;
      this.logger = noopLogger;
    }
  }

  /**
   * Set session ID (used when detection returns a session ID).
   * Marks the transport as initialized since a session ID is only ever
   * issued by a successful initialize handshake.
   */
  setSessionId(sessionId: string | null): void {
    this.sessionId = sessionId;
    this.initialized = !!sessionId;
  }

  async connect(): Promise<void> {
    // Streamable HTTP doesn't require a persistent connection, but the MCP
    // spec DOES require an `initialize` handshake before any other request.
    // Calling connect() up front is the cleanest place to do this. If the
    // caller skips connect() and goes straight to request(), request()
    // will lazily initialize before its first non-initialize call.
    await this.ensureInitialized();
  }

  /**
   * Lazily run the MCP initialize handshake if it hasn't completed yet.
   * Concurrent callers share the same in-flight promise so we never send
   * two initialize requests for one transport instance.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    if (this.initializePromise) {
      await this.initializePromise;
      return;
    }
    this.initializePromise = this.doInitialize();
    try {
      await this.initializePromise;
    } finally {
      this.initializePromise = null;
    }
  }

  private async doInitialize(): Promise<void> {
    this.logger.debug({ endpoint: this.config.endpointUrl }, 'MCP initialize handshake');
    // initialize must NOT carry a session-id header (we don't have one yet);
    // the server's response gives us one in the mcp-session-id response header.
    // We bypass the higher-level request() to avoid recursion.
    const initRequest: MCPRequest = {
      jsonrpc: '2.0',
      id: ++this.requestId,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: DEFAULT_CLIENT_INFO,
      },
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...this.getAuthHeaders(),
    };

    const response = await fetch(this.config.endpointUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(initRequest),
      signal: AbortSignal.timeout(this.config.timeout || 30000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '<unreadable body>');
      if (response.status === 401 || response.status === 403) {
        throw new Error(`MCP initialize failed: authentication rejected (HTTP ${response.status}): ${body.slice(0, 500)}`);
      }
      throw new Error(`MCP initialize failed: HTTP ${response.status}: ${body.slice(0, 500)}`);
    }

    // A server MAY assign a session id at initialize. One that does expects
    // it on every later request (CoinGecko answers HTTP 400 "Mcp-Session-Id
    // header is required" without it); one that does not is stateless and
    // gets no such header, which is the other half of the same rule.
    const responseSessionId = response.headers.get('mcp-session-id');
    if (responseSessionId) {
      this.sessionId = responseSessionId;
    }

    // Drain the response body so we don't leak the connection. The
    // initialize result itself isn't useful to us — we only need the
    // session-id header. Some servers return SSE for initialize (CoinGecko
    // does), others return JSON. Handle both.
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('text/event-stream')) {
      // Drain the SSE stream until the server closes it. We don't need
      // the parsed result, just need to read it so the server-side
      // session is properly established.
      try {
        await this.readSseResponse<unknown>(response, initRequest.id);
      } catch (e) {
        // Drain errors are non-fatal — the handshake itself succeeded.
        this.logger.warn({ error: (e as Error).message }, 'MCP initialize SSE drain failed (non-fatal)');
      }
    } else if (contentType.includes('application/json')) {
      try {
        await response.json();
      } catch (e) {
        this.logger.warn({ error: (e as Error).message }, 'MCP initialize JSON parse failed (non-fatal)');
      }
    }

    this.initialized = true;
    this.logger.debug(
      { endpoint: this.config.endpointUrl, sessionId: this.sessionId, stateless: this.sessionId === null },
      'MCP initialize handshake complete',
    );

    // Send the post-initialize notification per the MCP spec. Some servers
    // require this before they accept tools/call (others ignore it). It is
    // a notification (no id), so the server does not respond. We fire and
    // forget; failures are non-fatal because not every server implements it.
    try {
      await this.sendNotification('notifications/initialized');
    } catch (e) {
      this.logger.debug(
        { error: (e as Error).message },
        'MCP notifications/initialized failed (non-fatal — not all servers implement it)'
      );
    }
  }

  /**
   * Send a JSON-RPC notification (a request with no id, no response expected).
   * Used for the post-initialize handshake notification.
   */
  private async sendNotification(method: string, params?: Record<string, unknown>): Promise<void> {
    const notification = {
      jsonrpc: '2.0' as const,
      method,
      ...(params && { params }),
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...this.getAuthHeaders(),
    };
    if (this.sessionId) {
      headers['mcp-session-id'] = this.sessionId;
    }

    const response = await fetch(this.config.endpointUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(notification),
      signal: AbortSignal.timeout(this.config.timeout || 30000),
    });

    // Notifications: 200/202/204 are all valid. Anything else is a soft error
    // — we log and ignore (the caller doesn't depend on the result).
    if (!response.ok && response.status !== 202 && response.status !== 204) {
      const body = await response.text().catch(() => '');
      throw new Error(`Notification ${method} failed: HTTP ${response.status}: ${body.slice(0, 200)}`);
    }
    // Drain body if any so we don't leak the connection.
    try { await response.text(); } catch { /* ignore */ }
  }

  private getAuthHeaders(): Record<string, string> {
    switch (this.config.authType) {
      case 'api_key':
        return { 'X-API-Key': this.config.apiKey! };
      case 'bearer_token':
        return { Authorization: `Bearer ${this.config.bearerToken}` };
      case 'custom_headers':
        return Object.fromEntries(
          (this.config.customHeaders || []).map(h => [h.key, h.value])
        );
      default:
        return {};
    }
  }

  async request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    // Lazy-initialize if the caller didn't explicitly call connect() first.
    // initialize itself is sent through doInitialize() which bypasses this
    // path, so we don't recurse.
    if (method !== 'initialize') {
      await this.ensureInitialized();
    }

    const request: MCPRequest = {
      jsonrpc: '2.0',
      id: ++this.requestId,
      method,
      ...(params && { params }),
    };

    this.logger.debug({ endpoint: this.config.endpointUrl, method }, 'MCP Streamable HTTP request');

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...this.getAuthHeaders(),
      // MCP 2026-07-28 routing headers (set AFTER auth so they always reflect
      // the actual request): `Mcp-Method` on every POST; `Mcp-Name` for the
      // target-scoped methods. Strict 2026-07-28 servers reject requests
      // without them; older servers ignore the extra headers.
      'Mcp-Method': method,
    };
    const mcpName =
      method === 'resources/read'
        ? (params?.uri as string | undefined)
        : method === 'tools/call' || method === 'prompts/get'
          ? (params?.name as string | undefined)
          : undefined;
    if (mcpName) headers['Mcp-Name'] = mcpName;
    if (this.sessionId) {
      headers['mcp-session-id'] = this.sessionId;
    }

    const response = await fetch(this.config.endpointUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(this.config.timeout || 30000),
    });

    if (!response.ok) {
      // Read the body so the error message has the actual server response
      // instead of an opaque "HTTP 400". MCP servers always return a
      // JSON-RPC error envelope on failure with a useful `message` field.
      const body = await response.text().catch(() => '<unreadable body>');
      if (response.status === 401 || response.status === 403) {
        throw new Error(`Authentication failed (HTTP ${response.status}): ${body.slice(0, 500)}`);
      }
      throw new Error(`MCP request failed: HTTP ${response.status}: ${body.slice(0, 500)}`);
    }

    // Capture session ID from response if present (rare on non-initialize
    // requests, but harmless to keep checking).
    const responseSessionId = response.headers.get('mcp-session-id');
    if (responseSessionId && !this.sessionId) {
      this.sessionId = responseSessionId;
    }

    const contentType = response.headers.get('content-type') || '';

    // Handle SSE streaming response
    if (contentType.includes('text/event-stream')) {
      return this.readSseResponse<T>(response, request.id);
    }

    // Handle standard JSON response
    const result: MCPResponse = await response.json();

    if (result.error) {
      throw new Error(`MCP error ${result.error.code}: ${result.error.message}`);
    }

    return result.result as T;
  }

  /**
   * Read SSE streaming response and extract the final result
   * Streamable HTTP servers may return SSE for long-running operations
   */
  private async readSseResponse<T>(response: Response, requestId: number): Promise<T> {
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body for SSE stream');
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let result: T | undefined;

    // Parse one SSE event frame; adopt its result when it matches our request.
    const processEvent = (event: string): void => {
      if (!event.trim()) return;
      let eventType = 'message';
      let eventData = '';
      for (const line of event.split('\n')) {
        if (line.startsWith('event:')) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          eventData += line.slice(5).trim();
        }
      }
      if (!eventData || eventType !== 'message') return;
      try {
        const parsed: MCPResponse = JSON.parse(eventData);
        if (parsed.id === requestId) {
          if (parsed.error) {
            throw new Error(`MCP error ${parsed.error.code}: ${parsed.error.message}`);
          }
          result = parsed.result as T;
        }
      } catch (e) {
        if (e instanceof SyntaxError) {
          this.logger.warn({ eventData }, 'Failed to parse SSE event data');
        } else {
          throw e;
        }
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Split on the SSE event delimiter; the trailing piece is either an
        // incomplete event (keep buffering) or the final event on a stream
        // that closes WITHOUT a trailing blank line — flushed after the loop.
        const events = buffer.split('\n\n');
        buffer = events.pop() || '';
        for (const event of events) processEvent(event);
      }
      // Flush the decoder and process whatever remains. A spec-compliant MCP
      // server may end the stream on the last `data:` frame with no trailing
      // "\n\n"; without this the final event — often the ONLY event, carrying
      // the whole response — was silently dropped ("No response received").
      buffer += decoder.decode();
      if (buffer.trim()) processEvent(buffer);
    } finally {
      reader.releaseLock();
    }

    if (result === undefined) {
      throw new Error('No response received from SSE stream');
    }

    return result;
  }

  close(): void {
    // No persistent connection to close
  }

  getType(): TransportType {
    return 'streamable-http';
  }
}
