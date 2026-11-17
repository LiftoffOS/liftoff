// MCP Transport Abstraction
// Re-exports from @liftoffos/runtime-mcp-transports with application logging

// Re-export types from the shared package
// Note: Tenant Runtime doesn't use 'auto' - transport type is always known from discovery
export type TransportType = 'streamable-http' | 'sse' | 'a2a';

export type {
  CustomHeader,
  MCPTransportConfig,
  MCPTransport,
  Logger,
} from '@liftoffos/runtime-mcp-transports';

// Re-export transport classes
export { StreamableHttpTransport, SseTransport } from '@liftoffos/runtime-mcp-transports';

// Re-export factory function
export { createTransportSync } from './factory';
