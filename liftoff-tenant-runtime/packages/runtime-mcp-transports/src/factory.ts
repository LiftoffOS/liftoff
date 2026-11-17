// MCP Transport Factory
// Creates appropriate transport based on config or auto-detection

import type { MCPTransport, MCPTransportConfig, TransportType, Logger } from './types.js';
import { noopLogger } from './types.js';
import { StreamableHttpTransport } from './streamable-http.js';
import { SseTransport } from './sse.js';

export interface CreateTransportOptions extends MCPTransportConfig {
  transportType?: TransportType;
  logger?: Logger;
}

/**
 * Result of transport detection - includes initialize result for reuse
 */
export interface DetectionResult {
  transportType: 'streamable-http' | 'sse';
  initializeResult?: {
    protocolVersion: string;
    capabilities: Record<string, unknown>;
    serverInfo: { name: string; version: string };
  };
  /** True if notifications/initialized was already sent during detection */
  initializedNotificationSent?: boolean;
  /** Session ID returned by server (used for subsequent requests) */
  sessionId?: string | null;
}

/**
 * Build auth headers from config
 */
function getAuthHeaders(config: MCPTransportConfig): Record<string, string> {
  switch (config.authType) {
    case 'api_key':
      return { 'X-API-Key': config.apiKey! };
    case 'bearer_token':
      return { Authorization: `Bearer ${config.bearerToken}` };
    case 'custom_headers':
      return Object.fromEntries((config.customHeaders || []).map(h => [h.key, h.value]));
    default:
      return {};
  }
}

/**
 * Detect the transport type supported by an MCP endpoint
 *
 * Detection strategy:
 * 1. Try Streamable HTTP (POST initialize) - if success, server supports new standard
 * 2. If 4xx/5xx, try SSE (GET with Accept: text/event-stream) - legacy transport
 *
 * Returns the initialize result for Streamable HTTP to avoid duplicate requests.
 */
export async function detectTransportType(
  config: MCPTransportConfig,
  logger: Logger = noopLogger
): Promise<DetectionResult> {
  const { endpointUrl } = config;
  const authHeaders = getAuthHeaders(config);

  logger.info({ endpoint: endpointUrl }, 'MCP: Auto-detecting transport type');

  // Try Streamable HTTP first
  try {
    const response = await fetch(endpointUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...authHeaders,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'platform', version: '1.0.0' },
        },
      }),
      signal: AbortSignal.timeout(config.timeout || 10000),
    });

    if (response.ok) {
      // Parse the initialize result for reuse
      const contentType = response.headers.get('content-type') || '';
      const sessionId = response.headers.get('mcp-session-id');
      let initializeResult: DetectionResult['initializeResult'];

      if (contentType.includes('application/json')) {
        const jsonResponse = (await response.json()) as {
          result?: DetectionResult['initializeResult'];
          error?: { code: number; message: string };
        };
        if (jsonResponse.result) {
          initializeResult = jsonResponse.result;
        }
      } else if (contentType.includes('text/event-stream')) {
        // Parse SSE response to extract initialize result
        const text = await response.text();
        const dataMatch = text.match(/^data:\s*(.+)$/m);
        if (dataMatch) {
          try {
            const parsed = JSON.parse(dataMatch[1]) as {
              result?: DetectionResult['initializeResult'];
              error?: { code: number; message: string };
            };
            if (parsed.result) {
              initializeResult = parsed.result;
            }
          } catch {
            logger.debug({ endpoint: endpointUrl }, 'MCP: Failed to parse SSE response');
          }
        }
      }

      if (initializeResult) {
        // MCP protocol requires sending notifications/initialized after receiving initialize response
        // Send it immediately to complete the handshake
        let initializedNotificationSent = false;
        try {
          const notifyHeaders: Record<string, string> = {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            ...authHeaders,
          };
          if (sessionId) {
            notifyHeaders['mcp-session-id'] = sessionId;
          }
          await fetch(endpointUrl, {
            method: 'POST',
            headers: notifyHeaders,
            body: JSON.stringify({
              jsonrpc: '2.0',
              method: 'notifications/initialized',
            }),
            signal: AbortSignal.timeout(config.timeout || 5000),
          });
          initializedNotificationSent = true;
        } catch (notifyError) {
          // Log but don't fail - some servers may not require this notification
          logger.debug(
            { endpoint: endpointUrl, error: (notifyError as Error).message },
            'MCP: Failed to send notifications/initialized during detection'
          );
        }

        logger.info({ endpoint: endpointUrl }, 'MCP: Detected Streamable HTTP transport');
        return { transportType: 'streamable-http', initializeResult, initializedNotificationSent, sessionId };
      }

      logger.info({ endpoint: endpointUrl }, 'MCP: Detected Streamable HTTP transport');
      return { transportType: 'streamable-http' };
    }

    // 4xx/5xx - try SSE
    logger.debug(
      { endpoint: endpointUrl, status: response.status },
      'MCP: Streamable HTTP failed, trying SSE'
    );
  } catch (error) {
    logger.debug(
      { endpoint: endpointUrl, error: (error as Error).message },
      'MCP: Streamable HTTP error, trying SSE'
    );
  }

  // Try SSE transport detection
  const abortController = new AbortController();
  try {
    const response = await fetch(endpointUrl, {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        'Cache-Control': 'no-cache',
        ...authHeaders,
      },
      signal: abortController.signal,
    });

    const contentType = response.headers.get('content-type') || '';

    if (response.ok && contentType.includes('text/event-stream')) {
      logger.info({ endpoint: endpointUrl }, 'MCP: Detected SSE transport');
      // Properly close the connection
      abortController.abort();
      return { transportType: 'sse' };
    }

    // Not SSE, abort and continue
    abortController.abort();
  } catch (error) {
    // Ignore abort errors, log others
    if ((error as Error).name !== 'AbortError') {
      logger.debug(
        { endpoint: endpointUrl, error: (error as Error).message },
        'MCP: SSE detection error'
      );
    }
  }

  // Default to Streamable HTTP (will fail properly during actual connect)
  logger.warn(
    { endpoint: endpointUrl },
    'MCP: Could not detect transport, defaulting to Streamable HTTP'
  );
  return { transportType: 'streamable-http' };
}

/**
 * Result of createTransport - includes transport and detection info
 */
export interface CreateTransportResult {
  transport: MCPTransport;
  detectionResult?: DetectionResult;
}

/**
 * Create an MCP transport based on configuration
 *
 * If transportType is 'auto' or not specified, will auto-detect.
 * Returns both the transport and detection result (which includes initialize response
 * for Streamable HTTP, avoiding duplicate initialize requests).
 */
export async function createTransport(
  options: CreateTransportOptions
): Promise<CreateTransportResult> {
  let detectionResult: DetectionResult | undefined;
  const logger = options.logger || noopLogger;

  const config: MCPTransportConfig = {
    endpointUrl: options.endpointUrl,
    authType: options.authType,
    apiKey: options.apiKey,
    bearerToken: options.bearerToken,
    customHeaders: options.customHeaders,
    timeout: options.timeout,
  };

  // Determine transport type
  let transportType: 'streamable-http' | 'sse';

  if (!options.transportType || options.transportType === 'auto') {
    // Auto-detect and capture the result
    detectionResult = await detectTransportType(config, logger);
    transportType = detectionResult.transportType;
  } else {
    transportType = options.transportType;
  }

  // Create the appropriate transport
  if (transportType === 'sse') {
    const transport = new SseTransport({ config, logger });
    await transport.connect();
    return { transport, detectionResult };
  }

  // Default: Streamable HTTP
  const transport = new StreamableHttpTransport({
    config,
    logger,
    sessionId: detectionResult?.sessionId,
  });
  await transport.connect(); // No-op for Streamable HTTP, but consistent interface
  return { transport, detectionResult };
}

/**
 * Create transport for a specific type (no auto-detection)
 * Use when transport type is already known (e.g., stored in database)
 */
export function createTransportSync(
  transportType: 'streamable-http' | 'sse',
  config: MCPTransportConfig,
  logger?: Logger
): MCPTransport {
  if (transportType === 'sse') {
    return new SseTransport({ config, logger: logger || noopLogger });
  }
  return new StreamableHttpTransport({ config, logger: logger || noopLogger });
}
