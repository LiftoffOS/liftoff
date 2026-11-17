// MCP Transport Abstraction
// Re-exports from @liftoffos/mcp-transports with application logging

import type { CustomHeader as SharedCustomHeader } from '@liftoffos/mcp-transports';

// Re-export all types from the shared package
export type {
  TransportType,
  MCPTransportConfig,
  MCPTransport,
  Logger,
} from '@liftoffos/mcp-transports';

// Re-export the CustomHeader type (also available from ../types.ts)
export type { SharedCustomHeader as CustomHeader };

// Re-export transport classes
export { StreamableHttpTransport, SseTransport } from '@liftoffos/mcp-transports';

// Re-export the client version/identity constants (single source of truth in
// the shared package) so consumers negotiate with one agreed protocol version.
export { CLIENT_PROTOCOL_VERSION, CLIENT_INFO } from '@liftoffos/mcp-transports';

// Re-export factory functions and types
export {
  createTransport,
  createTransportSync,
  detectTransportType,
  type CreateTransportOptions,
  type CreateTransportResult,
  type DetectionResult,
} from './factory';
