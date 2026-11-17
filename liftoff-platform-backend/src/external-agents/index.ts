// External Agents Module
// Manages external AI agent configurations for A2A collaboration

export { externalAgentRouter } from './router';
export { externalAgentInternalRouter } from './internal-router';
export { discoverExternalAgentStreamRouter } from './discover-stream-router';
export { rediscoverExternalAgentStreamRouter } from './rediscover-stream-router';
export { analyzeManualStreamRouter } from './analyze-manual-stream-router';
export { externalAgentService } from './service';
export { refreshExpiringTokens, refreshSingleAgentToken } from './credential-refresh-service';
export { discoverExternalAgentWithProgress } from './discover-adapter';
export type { DiscoverStage, ProgressCallback } from './discover-adapter';
export { MCPClient } from '../mcp/client';
export type { MCPClientConfig, MCPDiscoveryResult } from '../mcp/client';
export { analyzeCapabilities } from './capability-analyzer';
export { analyzeManualCapabilities } from './manual-analyzer';
export { runHealthChecks, checkSingleAgentHealth } from './health-check-service';
export type {
  ExternalAgent,
  ExternalAgentStatus,
  ExternalAgentVersion,
  CreateExternalAgentInput,
  UpdateExternalAgentInput,
  PaginatedExternalAgentsResponse,
  ConnectionType,
  AuthType,
  CollaborationMode,
  RequestPermission,
  RequestType,
  DetectedCapability,
  DetectedResource,
  MCPToolDefinition,
  MCPResourceDefinition,
  InternalAgentRequestRule,
  CapabilityChange,
  CustomHeader,
  DiscoverInput,
  DiscoverOutput,
  ManualCapability,
  AnalyzeManualInput,
  AnalyzeManualStage,
  AnalyzeManualOutput,
} from './types';
