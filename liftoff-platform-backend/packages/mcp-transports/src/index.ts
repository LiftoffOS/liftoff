// @liftoffos/mcp-transports
// MCP transport implementations for Liftoff platform services

// Types
export type {
  TransportType,
  CustomHeader,
  MCPTransportConfig,
  MCPTransport,
  Logger,
} from './types.js';
export { noopLogger, CLIENT_PROTOCOL_VERSION, CLIENT_INFO } from './types.js';

// Transport implementations
export { StreamableHttpTransport, type StreamableHttpTransportOptions } from './streamable-http.js';
export { SseTransport, type SseTransportOptions } from './sse.js';

// Factory functions
export {
  createTransport,
  createTransportSync,
  detectTransportType,
  type CreateTransportOptions,
  type CreateTransportResult,
  type DetectionResult,
} from './factory.js';

// E1: exported so callers can pre-validate an endpoint before a transport
// is built (e.g. at registration time).
export { assertEndpointAllowed } from './url-guard.js';
