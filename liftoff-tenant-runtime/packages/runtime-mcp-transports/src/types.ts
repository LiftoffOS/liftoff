// MCP Transport Types
// Shared between Platform Backend and Tenant Runtime

export type TransportType = 'streamable-http' | 'sse' | 'auto';

export interface CustomHeader {
  key: string;
  value: string;
}

export interface MCPTransportConfig {
  endpointUrl: string;
  authType: 'none' | 'api_key' | 'bearer_token' | 'custom_headers';
  apiKey?: string;
  bearerToken?: string;
  customHeaders?: CustomHeader[];
  timeout?: number;
}

export interface MCPTransport {
  /**
   * Connect to the MCP server (for transports that require persistent connections)
   */
  connect(): Promise<void>;

  /**
   * Send a JSON-RPC request and wait for response
   */
  request<T>(method: string, params?: Record<string, unknown>): Promise<T>;

  /**
   * Close the transport connection
   */
  close(): void;

  /**
   * Get the transport type
   */
  getType(): TransportType;
}

/**
 * Optional logger interface - inject your own logger or use defaults
 */
export interface Logger {
  info: (obj: Record<string, unknown>, message: string) => void;
  debug: (obj: Record<string, unknown>, message: string) => void;
  warn: (obj: Record<string, unknown>, message: string) => void;
  error: (obj: Record<string, unknown>, message: string) => void;
}

/**
 * Default no-op logger
 */
export const noopLogger: Logger = {
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
};
