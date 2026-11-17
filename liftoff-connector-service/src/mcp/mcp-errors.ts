// MCP error enum and error class.
// Ported from tenant-runtime/src/infrastructure/mcp-errors.ts (behaviourally
// identical — no platform/runtime assumptions to remap).

export enum MCPErrorCode {
  // Connection errors
  CONNECTION_FAILED = 'MCP_CONNECTION_FAILED',
  CONNECTION_TIMEOUT = 'MCP_CONNECTION_TIMEOUT',
  CONNECTION_CLOSED = 'MCP_CONNECTION_CLOSED',

  // Authentication errors
  AUTH_FAILED = 'MCP_AUTH_FAILED',
  TOKEN_EXPIRED = 'MCP_TOKEN_EXPIRED',
  TOKEN_REFRESH_FAILED = 'MCP_TOKEN_REFRESH_FAILED',

  // Protocol errors
  INVALID_RESPONSE = 'MCP_INVALID_RESPONSE',
  TOOL_NOT_FOUND = 'MCP_TOOL_NOT_FOUND',
  TOOL_EXECUTION_FAILED = 'MCP_TOOL_EXECUTION_FAILED',

  // Validation errors
  INVALID_ENTITY_TYPE = 'MCP_INVALID_ENTITY_TYPE',
  INVALID_INPUT = 'MCP_INVALID_INPUT',

  // Circuit breaker
  CIRCUIT_OPEN = 'MCP_CIRCUIT_OPEN',

  // Tenant errors
  TENANT_NOT_FOUND = 'MCP_TENANT_NOT_FOUND',
  INVALID_CREDENTIALS = 'MCP_INVALID_CREDENTIALS',
}

export class MCPError extends Error {
  constructor(
    public readonly code: MCPErrorCode,
    message: string,
    public readonly cause?: Error,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'MCPError';
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      context: this.context,
      cause: this.cause?.message,
    };
  }
}
