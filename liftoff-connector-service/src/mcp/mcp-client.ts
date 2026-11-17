// MCP client wrapper around @liftoffos/mcp-transports.
//
// Ported from tenant-runtime/src/infrastructure/mcp-client.ts. Credentials
// flow through a TokenProvider (see ./token-provider.ts) so the wrapper
// always sends a live token. All calls go through @liftoffos/mcp-transports
// — no hand-rolled SSE or REST.
//
// Adaptations from source:
//   - logger import points at this service's infra/logging.ts shim.
//   - validateMCPUrl comes from catalog/mcp-server-registry.ts (already
//     ported).
//   - Sidecar auth header constants come from ./sidecar-secret.ts.

import { createTransport } from '@liftoffos/mcp-transports';
import type { MCPTransport } from '@liftoffos/mcp-transports';
import { logger } from '../infra/logging.js';
import { validateMCPUrl } from '../catalog/mcp-server-registry.js';
import { MCPError, MCPErrorCode } from './mcp-errors.js';
import { CircuitBreaker, type CircuitBreakerConfig } from './circuit-breaker.js';
import type { TokenProvider } from './token-provider.js';
import { SIDECAR_AUTH_HEADER, SIDECAR_SECRET } from './sidecar-secret.js';

interface MCPClientConfig {
  url: string;
  tokenProvider: TokenProvider;
  timeout?: number;
  circuitBreakerConfig?: CircuitBreakerConfig;
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface MCPToolResult {
  content: Array<{
    type: 'text' | 'image' | 'resource';
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
}

const transportLogger = {
  info: (obj: Record<string, unknown>, msg: string) => logger.info(obj, msg),
  debug: (obj: Record<string, unknown>, msg: string) => logger.debug(obj, msg),
  warn: (obj: Record<string, unknown>, msg: string) => logger.warn(obj, msg),
  error: (obj: Record<string, unknown>, msg: string) => logger.error(obj, msg),
};

export class MCPClient {
  private transport: MCPTransport | null = null;
  private transportPromise: Promise<MCPTransport> | null = null;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly timeout: number;
  private correlationId: string | null = null;

  constructor(private readonly config: MCPClientConfig) {
    this.timeout = config.timeout ?? 30000;
    this.circuitBreaker = new CircuitBreaker(config.circuitBreakerConfig);
  }

  setCorrelationId(id: string): void {
    this.correlationId = id;
  }

  private isLocalhostSidecar(url: string): boolean {
    try {
      const { hostname } = new URL(url);
      return hostname === 'localhost' || hostname === '127.0.0.1';
    } catch {
      return false;
    }
  }

  private async getTransport(): Promise<MCPTransport> {
    if (this.transport) return this.transport;
    if (this.transportPromise) return this.transportPromise;

    this.transportPromise = this.createAndConnect();
    try {
      this.transport = await this.transportPromise;
      return this.transport;
    } finally {
      this.transportPromise = null;
    }
  }

  private async createAndConnect(): Promise<MCPTransport> {
    if (!validateMCPUrl(this.config.url)) {
      throw new MCPError(
        MCPErrorCode.CONNECTION_FAILED,
        `MCP URL not in allowed domains: ${this.config.url}`,
      );
    }

    const isSidecar = this.isLocalhostSidecar(this.config.url);

    const token = await this.config.tokenProvider.getToken();
    const authConfig = isSidecar
      ? {
          authType: 'custom_headers' as const,
          customHeaders: [
            { key: 'Authorization', value: `Bearer ${token}` },
            { key: SIDECAR_AUTH_HEADER, value: SIDECAR_SECRET },
          ],
        }
      : {
          authType: 'bearer_token' as const,
          bearerToken: token,
        };

    logger.info(
      { url: this.config.url, correlationId: this.correlationId },
      'MCP connecting',
    );

    try {
      const { transport } = await createTransport({
        endpointUrl: this.config.url,
        ...authConfig,
        timeout: this.timeout,
        transportType: 'auto',
        logger: transportLogger,
      });
      logger.info(
        { url: this.config.url, correlationId: this.correlationId },
        'MCP connected',
      );
      return transport;
    } catch (error) {
      throw new MCPError(
        MCPErrorCode.CONNECTION_FAILED,
        `Failed to connect to MCP server: ${(error as Error).message}`,
      );
    }
  }

  async listTools(): Promise<MCPTool[]> {
    return this.circuitBreaker.execute(async () => {
      const transport = await this.getTransport();
      try {
        const result = await transport.request<{ tools?: MCPTool[] }>('tools/list');
        return result.tools || [];
      } catch (error) {
        throw new MCPError(
          MCPErrorCode.TOOL_NOT_FOUND,
          `Failed to list tools: ${(error as Error).message}`,
        );
      }
    });
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    return this.circuitBreaker.execute(async () => {
      const transport = await this.getTransport();
      logger.info(
        { tool: name, correlationId: this.correlationId },
        'MCP tool call',
      );
      try {
        const result = await transport.request<MCPToolResult>('tools/call', {
          name,
          arguments: args,
        });
        logger.info(
          { tool: name, isError: result.isError, correlationId: this.correlationId },
          'MCP tool result',
        );
        return result;
      } catch (error) {
        throw new MCPError(
          MCPErrorCode.TOOL_EXECUTION_FAILED,
          `Tool execution failed: ${(error as Error).message}`,
          undefined,
          { tool: name },
        );
      }
    });
  }

  disconnect(): void {
    if (this.transport) {
      this.transport.close();
      this.transport = null;
    }
    this.transportPromise = null;
    logger.info(
      { url: this.config.url, correlationId: this.correlationId },
      'MCP disconnected',
    );
  }
}
