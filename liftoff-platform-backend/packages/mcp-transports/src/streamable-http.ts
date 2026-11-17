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

export class StreamableHttpTransport implements MCPTransport {
  private config: MCPTransportConfig;
  private requestId = 0;
  private logger: Logger;
  private sessionId: string | null = null;

  constructor(options: StreamableHttpTransportOptions | MCPTransportConfig) {
    // Support both new options format and legacy config-only format
    if ('config' in options) {
      this.config = options.config;
      this.logger = options.logger || noopLogger;
      this.sessionId = options.sessionId || null;
    } else {
      this.config = options;
      this.logger = noopLogger;
    }
  }

  /**
   * Set session ID (used when detection returns a session ID)
   */
  setSessionId(sessionId: string | null): void {
    this.sessionId = sessionId;
  }

  async connect(): Promise<void> {
    // Streamable HTTP doesn't require persistent connection
    // Connection is established per-request
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
      // MCP 2026-07-28 routing headers (set AFTER auth headers so they always
      // reflect the actual request and can't be shadowed by a custom header).
      // `Mcp-Method` on every POST; `Mcp-Name` for the target-scoped methods.
      // Strict 2026-07-28 servers reject requests without them; older servers
      // ignore the extra headers.
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
      if (response.status === 401 || response.status === 403) {
        throw new Error('Authentication failed. Check your credentials.');
      }
      throw new Error(`MCP request failed: HTTP ${response.status}`);
    }

    // Capture session ID from response if present
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

    // Return the FULL result object verbatim — including MCP 2026-07-28
    // `resultType`/`inputRequests`/`requestState` when present. The caller
    // (e.g. Tenant-Runtime tool execution) inspects `resultType` to detect the
    // Multi Round-Trip Requests "input_required" interim result; the transport
    // must not collapse it into a "complete" result here.
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
