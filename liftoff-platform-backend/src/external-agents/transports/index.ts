// Re-export shim — MCP transports now live at src/mcp/transports/.
export type {
  CustomHeader,
  TransportType,
  MCPTransportConfig,
  MCPTransport,
  Logger,
  CreateTransportOptions,
  CreateTransportResult,
  DetectionResult,
} from '../../mcp/transports';
export {
  StreamableHttpTransport,
  SseTransport,
  createTransport,
  createTransportSync,
  detectTransportType,
} from '../../mcp/transports';
