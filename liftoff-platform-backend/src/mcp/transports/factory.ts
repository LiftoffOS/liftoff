// MCP Transport Factory
// Wraps @liftoffos/mcp-transports with application logging

import { log } from '../../infrastructure/logging';
import {
  createTransport as sharedCreateTransport,
  createTransportSync as sharedCreateTransportSync,
  detectTransportType as sharedDetectTransportType,
  type CreateTransportOptions as SharedCreateTransportOptions,
  type CreateTransportResult,
  type DetectionResult,
  type MCPTransport,
  type MCPTransportConfig,
  type Logger,
} from '@liftoffos/mcp-transports';

// Re-export types
export type { CreateTransportResult, DetectionResult };

export type CreateTransportOptions = SharedCreateTransportOptions;

/**
 * Application logger adapter for the shared package
 */
const appLogger: Logger = {
  info: (obj, msg) => log.info(obj, msg),
  debug: (obj, msg) => log.debug(obj, msg),
  warn: (obj, msg) => log.warn(obj, msg),
  error: (obj, msg) => log.error(obj, msg),
};

/**
 * Detect the transport type supported by an MCP endpoint
 * Uses application logging.
 */
export async function detectTransportType(config: MCPTransportConfig): Promise<DetectionResult> {
  return sharedDetectTransportType(config, appLogger);
}

/**
 * Create an MCP transport based on configuration
 * Uses application logging.
 */
export async function createTransport(
  options: CreateTransportOptions
): Promise<CreateTransportResult> {
  return sharedCreateTransport({ ...options, logger: appLogger });
}

/**
 * Create transport for a specific type (no auto-detection)
 * Uses application logging.
 */
export function createTransportSync(
  transportType: 'streamable-http' | 'sse',
  config: MCPTransportConfig
): MCPTransport {
  return sharedCreateTransportSync(transportType, config, appLogger);
}
