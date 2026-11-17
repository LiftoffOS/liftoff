// SSE Transport (Legacy HTTP+SSE)
// Deprecated MCP transport (2024-11-05) but still used by servers like Cloudflare
// GET /sse for event stream, POST /message for sending requests

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

interface PendingRequest<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export interface SseTransportOptions {
  config: MCPTransportConfig;
  logger?: Logger;
}

export class SseTransport implements MCPTransport {
  private config: MCPTransportConfig;
  private requestId = 0;
  private messageEndpoint: string | null = null;
  private sessionId: string | null = null;
  private pendingRequests = new Map<number, PendingRequest<unknown>>();
  private abortController: AbortController | null = null;
  private connected = false;
  private sseReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private logger: Logger;

  constructor(options: SseTransportOptions | MCPTransportConfig) {
    // Support both new options format and legacy config-only format
    if ('config' in options) {
      this.config = options.config;
      this.logger = options.logger || noopLogger;
    } else {
      this.config = options;
      this.logger = noopLogger;
    }
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

  async connect(): Promise<void> {
    if (this.connected) return;

    this.logger.info({ endpoint: this.config.endpointUrl }, 'MCP SSE: Connecting');

    this.abortController = new AbortController();

    // Open SSE connection
    const response = await fetch(this.config.endpointUrl, {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        'Cache-Control': 'no-cache',
        ...this.getAuthHeaders(),
      },
      signal: this.abortController.signal,
    });

    if (!response.ok) {
      throw new Error(`SSE connection failed: HTTP ${response.status}`);
    }

    if (!response.body) {
      throw new Error('SSE connection has no body');
    }

    this.sseReader = response.body.getReader();

    // Wait for endpoint event
    await this.waitForEndpointEvent();

    // Start background event processing
    this.processEvents().catch(err => {
      this.logger.error({ error: err.message }, 'MCP SSE: Event processing error');
      this.close();
    });

    this.connected = true;
    this.logger.info(
      { endpoint: this.config.endpointUrl, messageEndpoint: this.messageEndpoint },
      'MCP SSE: Connected'
    );
  }

  private async waitForEndpointEvent(): Promise<void> {
    if (!this.sseReader) throw new Error('No SSE reader');

    const decoder = new TextDecoder();
    let buffer = '';

    // Create a timeout promise that rejects after 10 seconds
    const timeoutMs = this.config.timeout || 10000;
    let timeoutId: NodeJS.Timeout;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error('SSE endpoint event timeout'));
      }, timeoutMs);
    });

    try {
      while (!this.messageEndpoint) {
        // Race between reading next chunk and timeout
        const readPromise = this.sseReader.read();
        const { done, value } = await Promise.race([readPromise, timeoutPromise]);

        if (done) {
          throw new Error('SSE connection closed before endpoint event');
        }

        buffer += decoder.decode(value, { stream: true });

        // Process events looking for endpoint
        const events = buffer.split('\n\n');
        buffer = events.pop() || '';

        for (const event of events) {
          const parsed = this.parseEvent(event);
          if (parsed?.type === 'endpoint') {
            this.handleEndpointEvent(parsed.data);
            clearTimeout(timeoutId!);
            return;
          }
        }
      }
    } catch (error) {
      clearTimeout(timeoutId!);
      throw error;
    }
  }

  private handleEndpointEvent(data: string): void {
    // Parse endpoint data - can be just URL or JSON object
    try {
      const parsed = JSON.parse(data);
      this.messageEndpoint = parsed.url || parsed.endpoint || data;
    } catch {
      // Not JSON, treat as plain URL
      this.messageEndpoint = data.trim();
    }

    // Resolve relative URLs
    if (this.messageEndpoint && !this.messageEndpoint.startsWith('http')) {
      const base = new URL(this.config.endpointUrl);
      this.messageEndpoint = new URL(this.messageEndpoint, base.origin).toString();
    }

    // Extract session ID from URL if present
    if (this.messageEndpoint) {
      const url = new URL(this.messageEndpoint);
      this.sessionId = url.searchParams.get('session_id') ||
                       url.searchParams.get('sessionId') ||
                       url.searchParams.get('sid');
    }
  }

  private async processEvents(): Promise<void> {
    if (!this.sseReader) return;

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (this.connected) {
        const { done, value } = await this.sseReader.read();

        if (done) {
          this.logger.info({}, 'MCP SSE: Connection closed by server');
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        // Process complete events
        const events = buffer.split('\n\n');
        buffer = events.pop() || '';

        for (const event of events) {
          const parsed = this.parseEvent(event);
          if (parsed) {
            this.handleEvent(parsed.type, parsed.data);
          }
        }
      }
    } finally {
      this.sseReader.releaseLock();
      this.sseReader = null;
    }
  }

  private parseEvent(event: string): { type: string; data: string } | null {
    if (!event.trim()) return null;

    const lines = event.split('\n');
    let type = 'message';
    const dataLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith('event:')) {
        type = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        // SSE spec: multiple data lines should be joined with newlines
        dataLines.push(line.slice(5).trim());
      }
    }

    const data = dataLines.join('\n');
    return data ? { type, data } : null;
  }

  private handleEvent(type: string, data: string): void {
    if (type === 'message') {
      try {
        const response: MCPResponse = JSON.parse(data);
        const pending = this.pendingRequests.get(response.id);

        if (pending) {
          this.pendingRequests.delete(response.id);
          clearTimeout(pending.timeout);

          if (response.error) {
            pending.reject(new Error(`MCP error ${response.error.code}: ${response.error.message}`));
          } else {
            pending.resolve(response.result);
          }
        }
      } catch (e) {
        this.logger.warn({ data, error: (e as Error).message }, 'MCP SSE: Failed to parse message');
      }
    } else if (type === 'ping' || type === 'keep-alive') {
      // Ignore keep-alive events
    } else {
      this.logger.debug({ type, data }, 'MCP SSE: Unhandled event type');
    }
  }

  async request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (!this.messageEndpoint) {
      throw new Error('Not connected - call connect() first');
    }

    const id = ++this.requestId;
    const request: MCPRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params && { params }),
    };

    this.logger.debug({ endpoint: this.messageEndpoint, method }, 'MCP SSE request');

    return new Promise<T>((resolve, reject) => {
      // Set up timeout
      const timeout = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request timeout for ${method}`));
        }
      }, this.config.timeout || 30000);

      // Store pending request
      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      });

      // Send request via POST
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...this.getAuthHeaders(),
      };

      if (this.sessionId) {
        headers['Mcp-Session-Id'] = this.sessionId;
      }

      fetch(this.messageEndpoint!, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
      })
        .then(response => {
          if (!response.ok) {
            this.pendingRequests.delete(id);
            clearTimeout(timeout);
            reject(new Error(`MCP request failed: HTTP ${response.status}`));
          }
          // Response comes via SSE stream, not here
        })
        .catch(err => {
          this.pendingRequests.delete(id);
          clearTimeout(timeout);
          reject(err);
        });
    });
  }

  close(): void {
    this.connected = false;

    // Cancel pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Transport closed'));
      this.pendingRequests.delete(id);
    }

    // Abort SSE connection
    this.abortController?.abort();
    this.abortController = null;

    // Release reader
    this.sseReader?.releaseLock();
    this.sseReader = null;

    this.messageEndpoint = null;
    this.sessionId = null;

    this.logger.info({}, 'MCP SSE: Disconnected');
  }

  getType(): TransportType {
    return 'sse';
  }
}
