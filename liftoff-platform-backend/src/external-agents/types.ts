// External Agents Types — consumer-specific types only.
//
// MCP-generic types (AuthType, CustomHeader, TransportType, MCPToolDefinition,
// MCPResourceDefinition, DetectedCapability, DetectedResource, DiscoverInput,
// DiscoverOutput, DiscoverStage, JsonSchemaProperty) live in src/mcp/types.ts
// after the Phase 0 extraction. They're re-exported here for backwards
// compatibility with the many call sites that already pull them from this
// module.

import type { SensitivityCategory } from '../mcp/tool-classifier';
import type {
  AuthType,
  CustomHeader,
  DetectedCapability,
  DetectedResource,
  MCPResourceDefinition,
  MCPToolDefinition,
  TransportType,
} from '../mcp/types';

// Re-export MCP-generic types so existing imports continue to work.
export type {
  AuthType,
  CustomHeader,
  DetectedCapability,
  DetectedResource,
  JsonSchemaProperty,
  MCPResourceDefinition,
  MCPToolDefinition,
  TransportType,
  DiscoverStage,
  DiscoverInput,
  DiscoverOutput,
} from '../mcp/types';

// ── External-agent-specific types ──────────────────────────────────────

// Connection type determines authentication flow
export type ConnectionType = 'automatic' | 'custom';

// Collaboration mode determines A2A communication pattern
export type CollaborationMode =
  | 'request_help'      // Internal agents can call external agent tools (Internal → External)
  | 'receive_delegated' // External agent can delegate work to internal agents (External → Internal)
  | 'two_way'           // Both directions allowed
  | 'observe_only';     // No active tool execution, status/summaries only

// Permission level for request rules
export type RequestPermission = 'allowed' | 'approval_required' | 'blocked';

// Request types for permission matrix
export type RequestType =
  | 'read_summaries'
  | 'run_analysis'
  | 'draft_outputs'
  | 'propose_updates';

// Status of external agent connection
export type ExternalAgentStatus =
  | 'pending'
  | 'connected'
  | 'disconnected'
  | 'error'
  | 'pending_review';

// Version source indicates how the version was created
export type VersionSource = 'create' | 'discover' | 'manual';

// Capability source indicates how capabilities were defined
export type CapabilitySource = 'mcp_discovery' | 'manual';

// Per-internal-agent request rules
export interface InternalAgentRequestRule {
  internalAgentId: string;
  internalAgentName: string;
  permissions: Record<RequestType, RequestPermission>;
}

// Capability change detected during re-discovery
export interface CapabilityChange {
  type: 'added' | 'removed' | 'classification_changed';
  toolName: string;
  oldClassifications?: SensitivityCategory[];
  newClassifications?: SensitivityCategory[];
}

// Main external agent entity
export interface ExternalAgent {
  id: string;
  tenantId: string;
  name: string;
  endpointUrl: string;
  transportType: TransportType;
  description: string | null;
  connectionType: ConnectionType;
  authType: AuthType;
  credentialSecretName: string | null;
  // Credential hints (last 4 chars) - stored in DB, never retrieved from Secret Manager
  apiKeyHint: string | null;
  bearerTokenHint: string | null;
  customHeaderKeys: string[] | null;
  collaborationMode: CollaborationMode;
  summary: string | null;
  collaborationHints: string | null;
  detectedCapabilities: DetectedCapability[];
  detectedResources: DetectedResource[];
  toolClassifications: Record<string, SensitivityCategory[]>;
  rawMcpTools: MCPToolDefinition[];
  rawMcpResources: MCPResourceDefinition[];
  allowedInternalAgentIds: string[];
  requestRules: InternalAgentRequestRule[];
  status: ExternalAgentStatus;
  capabilityChanges: CapabilityChange[] | null;
  capabilitySource: CapabilitySource;
  lastCheckedAt: Date | null;
  lastError: string | null;
  costAmount: number | null;
  costType: 'per_task' | 'per_month' | null;
  monthlyCost: number | null;
  /** Trailing 30-day successful task count from audit_logs. Computed at read time. */
  tasks30d: number;
  currentVersion: number;
  createdAt: Date;
  updatedAt: Date;
  /** ISO timestamp of latest entry in agent_audit_logs. Null if no activity. Populated by workforce endpoint only. */
  lastActivity: string | null;
  /** Action string of latest entry in agent_audit_logs. Null if no activity. Populated by workforce endpoint only. */
  lastActivityAction: string | null;
  /** When non-null, this agent's endpoint is reached via a tunnel route. UI shows a "Tunneled via" line in Advanced Settings. */
  tunnelRouteId: string | null;
}

// External agent version snapshot
export interface ExternalAgentVersion {
  id: string;
  externalAgentId: string;
  version: number;
  name: string;
  description: string | null;
  summary: string | null;
  collaborationHints: string | null;
  detectedCapabilities: DetectedCapability[];
  detectedResources: DetectedResource[];
  toolClassifications: Record<string, SensitivityCategory[]>;
  allowedInternalAgentIds: string[];
  requestRules: InternalAgentRequestRule[];
  collaborationMode: CollaborationMode;
  source: VersionSource;
  createdBy: string | null;
  createdAt: Date;
}

// Create input
export interface CreateExternalAgentInput {
  name: string;
  endpointUrl: string;
  transportType?: TransportType;
  description?: string;
  connectionType: ConnectionType;
  authType: AuthType;
  apiKey?: string;
  bearerToken?: string;
  customHeaders?: CustomHeader[];
  collaborationMode: CollaborationMode;
  allowedInternalAgentIds?: string[];
  requestRules?: InternalAgentRequestRule[];
  summary?: string;
  collaborationHints?: string;
  detectedCapabilities?: DetectedCapability[];
  detectedResources?: DetectedResource[];
  toolClassifications?: Record<string, SensitivityCategory[]>;
  /** 1b: the discovery result's effect class per tool and the classification
   *  version that produced it, echoed by the caller beside the categories.
   *  Absent on a payload from before the effect head existed: the rows are
   *  then written without one and the next rediscovery fills them. */
  toolEffectClasses?: Record<string, string>;
  toolClassificationVersions?: Record<string, number>;
  rawMcpTools?: MCPToolDefinition[];
  rawMcpResources?: MCPResourceDefinition[];
  capabilitySource?: CapabilitySource;
  discoveryCorrelationId?: string;
  /** Optional FK to a mcp_tunnel_routes row. When present, endpointUrl must equal that route's public_url. */
  tunnelRouteId?: string;
}

// Update input
export interface UpdateExternalAgentInput {
  name?: string;
  description?: string;
  collaborationMode?: CollaborationMode;
  allowedInternalAgentIds?: string[];
  requestRules?: InternalAgentRequestRule[];
  costAmount?: number | null;
  costType?: 'per_task' | 'per_month' | null;
}

// Paginated response
export interface PaginatedExternalAgentsResponse {
  agents: ExternalAgent[];
  cursor: string | null;
  hasMore: boolean;
  total: number;
}

// Manual capability input from user
export interface ManualCapability {
  id: string;
  name: string;
  description: string;
  toolName: string;
  sensitivityCategories: SensitivityCategory[];
}

// Analyze manual input
export interface AnalyzeManualInput {
  capabilities: ManualCapability[];
  agentName: string;
  agentDescription: string;
}

// Analyze manual stages (subset of discover stages)
export type AnalyzeManualStage =
  | 'connected'
  | 'validating'
  | 'analyzing'
  | 'classifying'
  | 'finalizing';

// Analyze manual output (same shape as DiscoverOutput for UI consistency)
export interface AnalyzeManualOutput {
  capabilities: DetectedCapability[];
  toolClassifications: Record<string, SensitivityCategory[]>;
  summary: string;
  collaborationHints: string;
}

// External agent with context for runtime tool schema injection
export interface ExternalAgentWithContext {
  id: string;
  name: string;
  summary: string | null;
  collaborationHints: string | null;
  rawMcpTools: MCPToolDefinition[];
  toolClassifications: Record<string, SensitivityCategory[]>;
  collaborationMode: CollaborationMode;
  requestRules: InternalAgentRequestRule[];
  status: ExternalAgentStatus;
  transportType: TransportType;
  /** Connection details the tenant runtime needs to enumerate this agent's
   *  CURRENT tools when it builds a run's catalog. Without them the runtime can
   *  only serve raw_mcp_tools — the discovery-time snapshot — which is how an
   *  agent ends up being offered tools its server no longer exposes.
   *  `credentialSecretName` is the fully-qualified Secret Manager resource name,
   *  resolved on the way out (see resolveCredentialSecretResourceName): the
   *  runtime cannot reconstruct it, because the secret may live in the tenant
   *  project or the control-plane project. */
  endpointUrl: string;
  authType: 'none' | 'api_key' | 'bearer_token' | 'custom_headers';
  credentialSecretName: string | null;
}
