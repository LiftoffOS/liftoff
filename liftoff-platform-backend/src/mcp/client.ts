// MCP Client for discovering MCP server capabilities (generic, consumer-agnostic).
// Implements the subset of MCP spec needed for capability discovery.
// MCP (Model Context Protocol) is a JSON-RPC 2.0 based protocol for AI agent interoperability.
//
// Phase 0 extraction: moved from src/external-agents/mcp-client.ts. All MCP
// consumers (external_agents, custom_mcp_servers) call into this module.

import { log } from '../infrastructure/logging';
import type { CustomHeader, MCPToolDefinition, MCPResourceDefinition, DegradedTool } from './types';
import type { MCPTransport, TransportType, CreateTransportResult } from './transports';
import { createTransport, CLIENT_PROTOCOL_VERSION, CLIENT_INFO } from './transports';
import { classifyMcpTools } from './tool-validator';

interface MCPInitializeResult {
  protocolVersion: string;
  capabilities: {
    tools?: Record<string, unknown>;
    resources?: Record<string, unknown>;
  };
  serverInfo: {
    name: string;
    version: string;
  };
}

interface MCPToolsListResult {
  tools: MCPToolDefinition[];
}

interface MCPResourcesListResult {
  resources: MCPResourceDefinition[];
}

export interface MCPDiscoveryResult {
  serverName: string;
  serverVersion: string;
  protocolVersion: string;
  tools: MCPToolDefinition[];
  resources: MCPResourceDefinition[];
  transportType: 'streamable-http' | 'sse';
  /** Tools excluded from the LLM-facing set because their schema is not
   *  LLM-tool-API-acceptable. The tools themselves remain in `tools` (annotated
   *  with `degraded: true`); this is the operator-visible summary. */
  degradedTools: DegradedTool[];
}

export interface MCPClientConfig {
  endpointUrl: string;
  authType: 'none' | 'api_key' | 'bearer_token' | 'custom_headers';
  apiKey?: string;
  bearerToken?: string;
  customHeaders?: CustomHeader[];
  timeout?: number; // ms, default 30000
  transportType?: TransportType; // 'auto' by default
}

export class MCPClient {
  private config: MCPClientConfig;
  private transport: MCPTransport | null = null;
  private detectedTransportType: TransportType | null = null;

  constructor(config: MCPClientConfig) {
    this.config = config;
  }

  /**
   * Get the transport type detected during the last discovery.
   * Returns null if discover() has not been called yet.
   */
  getDetectedTransportType(): TransportType | null {
    return this.detectedTransportType;
  }

  /**
   * Perform MCP discovery - initialize connection and fetch tools/resources
   * Auto-detects transport type (Streamable HTTP or SSE) if not specified.
   *
   * When auto-detecting, reuses the initialize response from detection to avoid
   * duplicate requests.
   */
  async discover(): Promise<MCPDiscoveryResult> {
    log.info({ endpoint: this.config.endpointUrl }, 'MCP: Starting discovery');

    const { transport, detectionResult }: CreateTransportResult = await createTransport({
      endpointUrl: this.config.endpointUrl,
      authType: this.config.authType,
      apiKey: this.config.apiKey,
      bearerToken: this.config.bearerToken,
      customHeaders: this.config.customHeaders,
      timeout: this.config.timeout,
      transportType: this.config.transportType,
    });

    this.transport = transport;
    this.detectedTransportType = transport.getType() as 'streamable-http' | 'sse';

    log.info(
      { endpoint: this.config.endpointUrl, transportType: this.detectedTransportType },
      'MCP: Transport connected'
    );

    try {
      let initResult: MCPInitializeResult;

      let needsInitializedNotification = true;

      if (detectionResult?.initializeResult) {
        log.debug(
          { endpoint: this.config.endpointUrl },
          'MCP: Reusing initialize result from detection'
        );
        initResult = {
          protocolVersion: detectionResult.initializeResult.protocolVersion,
          capabilities: detectionResult.initializeResult.capabilities as MCPInitializeResult['capabilities'],
          serverInfo: detectionResult.initializeResult.serverInfo,
        };
        needsInitializedNotification = !detectionResult.initializedNotificationSent;
      } else {
        initResult = await this.transport.request<MCPInitializeResult>('initialize', {
          protocolVersion: CLIENT_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: CLIENT_INFO,
        });
      }

      if (needsInitializedNotification) {
        await this.transport.request('notifications/initialized');
      }

      log.info({ endpoint: this.config.endpointUrl }, 'MCP: Fetching tools list');
      const tools = await this.safeRequest<MCPToolsListResult>('tools/list');

      const toolsList = tools?.tools || [];
      // No hard reject: partition into usable vs degraded. A tool whose schema
      // the LLM tool API cannot consume is annotated `degraded` (so the runtime
      // excludes it from the LLM-facing set) but the server still onboards with
      // its remaining tools. Mirrors the flag-not-reject stance of injection
      // findings — a legitimate server is never hard-dropped over one odd tool.
      const { degradedTools } = classifyMcpTools(toolsList);
      if (degradedTools.length > 0) {
        const reasonsByName = new Map(degradedTools.map((d) => [d.toolName, d.reasons]));
        for (const t of toolsList) {
          const reasons = reasonsByName.get(t.name);
          if (reasons) {
            t.degraded = true;
            t.degradeReasons = reasons;
          }
        }
        log.warn(
          {
            endpoint: this.config.endpointUrl,
            serverName: initResult.serverInfo.name,
            degradedCount: degradedTools.length,
            degradedTools,
          },
          'MCP: some tools are not LLM-tool-API-acceptable; excluding them from the LLM set but onboarding the server'
        );
      }

      log.info({ endpoint: this.config.endpointUrl }, 'MCP: Fetching resources list');
      const resources = await this.safeRequest<MCPResourcesListResult>('resources/list');

      return {
        serverName: initResult.serverInfo.name,
        serverVersion: initResult.serverInfo.version,
        protocolVersion: initResult.protocolVersion,
        tools: toolsList,
        resources: resources?.resources || [],
        transportType: this.detectedTransportType!,
        degradedTools,
      };
    } finally {
      this.transport.close();
      this.transport = null;
    }
  }

  private async safeRequest<T>(method: string): Promise<T | null> {
    if (!this.transport) return null;

    try {
      return await this.transport.request<T>(method);
    } catch (error) {
      log.warn(
        { endpoint: this.config.endpointUrl, method, error },
        `MCP: ${method} not supported`
      );
      return null;
    }
  }

  /**
   * Lightweight health check - just initialize without fetching tools/resources
   */
  async ping(): Promise<boolean> {
    try {
      const { transport, detectionResult } = await createTransport({
        endpointUrl: this.config.endpointUrl,
        authType: this.config.authType,
        apiKey: this.config.apiKey,
        bearerToken: this.config.bearerToken,
        customHeaders: this.config.customHeaders,
        timeout: this.config.timeout || 10000,
        transportType: this.config.transportType,
      });

      try {
        if (detectionResult?.initializeResult) {
          return true;
        }

        await transport.request<MCPInitializeResult>('initialize', {
          protocolVersion: CLIENT_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: CLIENT_INFO,
        });
        return true;
      } finally {
        transport.close();
      }
    } catch {
      return false;
    }
  }
}
