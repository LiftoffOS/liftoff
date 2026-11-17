// MCP Transport Factory
// Wraps @liftoffos/runtime-mcp-transports with application logging

import { log } from '../../infrastructure/logging';
import {
  createTransportSync as sharedCreateTransportSync,
  type MCPTransport,
  type MCPTransportConfig,
  type Logger,
} from '@liftoffos/runtime-mcp-transports';
import type { TransportType } from './index';

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
 * Create transport for a specific type (no auto-detection)
 * Use when transport type is already known (e.g., stored in database)
 */
export function createTransportSync(
  transportType: Exclude<TransportType, 'a2a'>,
  config: MCPTransportConfig
): MCPTransport {
  return sharedCreateTransportSync(transportType, config, appLogger);
}
