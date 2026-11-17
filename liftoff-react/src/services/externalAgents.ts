// External Agents Service
// Manages external AI agent connections with the backend
// Follows teams.ts patterns for consistency

import { api } from './api'
import { auth } from '../config/firebase'

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080'

// === Types ===

export type ConnectionType = 'automatic' | 'custom'
export type TransportType = 'streamable-http' | 'sse'
export type AuthType = 'none' | 'api_key' | 'bearer_token' | 'custom_headers'

export type CollaborationMode =
  | 'request_help'
  | 'receive_delegated'
  | 'two_way'
  | 'observe_only'

export type RequestPermission = 'allowed' | 'approval_required' | 'blocked'

export type RequestType =
  | 'read_summaries'
  | 'run_analysis'
  | 'draft_outputs'
  | 'propose_updates'

export const REQUEST_TYPES: RequestType[] = [
  'read_summaries',
  'run_analysis',
  'draft_outputs',
  'propose_updates',
]

export const REQUEST_TYPE_LABELS: Record<RequestType, string> = {
  read_summaries: 'Read summaries',
  run_analysis: 'Run analysis',
  draft_outputs: 'Draft outputs',
  propose_updates: 'Propose updates',
}

export const COLLABORATION_MODE_LABELS: Record<CollaborationMode, { title: string; description: string }> = {
  request_help: {
    title: 'Request help',
    description: 'The external agent can ask your agent to perform work.',
  },
  receive_delegated: {
    title: 'Receive delegated work',
    description: 'Your agent can send tasks to the external agent.',
  },
  two_way: {
    title: 'Two-way collaboration',
    description: 'Both sides can exchange tasks and outputs.',
  },
  observe_only: {
    title: 'Observe only',
    description: 'The external agent can receive status and summaries, but cannot initiate actions.',
  },
}

export interface DetectedCapability {
  id: string
  name: string
  description: string
  rawToolName?: string
}

// Contextual resources from the collaborator's own systems
// These are reference materials the collaborator can consult, NOT your data
// Stored for completeness but NOT displayed in UI
export interface DetectedResource {
  id: string
  name: string
  description: string
  rawUri?: string  // MCP resource URI (collaborator's internal reference)
}

export interface CustomHeader {
  key: string
  value: string
}

export interface TeamRequestRule {
  teamId: string
  teamName: string // For display
  permissions: Record<RequestType, RequestPermission>
}

export type ExternalAgentStatus = 'pending' | 'connected' | 'disconnected' | 'error' | 'pending_review'

// Get the appropriate action label for an external agent based on its status
export function getExternalAgentActionLabel(status: ExternalAgentStatus): string {
  switch (status) {
    case 'connected':
      return 'Pause Team'
    case 'disconnected':
      return 'Resume Team'
    case 'pending':
    case 'pending_review':
      return 'Start Team'
    case 'error':
      return 'Retry Connection'
    default:
      return 'Pause Team'
  }
}

// Sensitivity categories (same as backend tool-classifier.ts)
export type SensitivityCategory =
  | 'customerCommunication'
  | 'financialActions'
  | 'dataChanges'
  | 'externalPublishing'
  | 'hiringDecisions'

export interface CapabilityChange {
  type: 'added' | 'removed' | 'classification_changed'
  toolName: string
  oldClassifications?: SensitivityCategory[]
  newClassifications?: SensitivityCategory[]
}

export interface ExternalAgent {
  id: string
  tenantId: string
  name: string
  endpointUrl: string
  description: string
  connectionType: ConnectionType
  authType: AuthType
  // Credential hints (last 4 chars) - stored in DB, never retrieved from Secret Manager
  apiKeyHint?: string           // e.g., "•••3f2x"
  bearerTokenHint?: string      // e.g., "•••8k2m"
  customHeaderKeys?: string[]   // e.g., ["X-Api-Key", "Authorization"]
  collaborationMode: CollaborationMode
  summary: string | null           // Distilled scope summary
  collaborationHints: string | null // How internal agents should work with this
  detectedCapabilities: DetectedCapability[]
  detectedResources: DetectedResource[]
  toolClassifications: Record<string, SensitivityCategory[]>  // For HITL enforcement
  allowedInternalAgentIds: string[]
  requestRules: TeamRequestRule[]
  status: ExternalAgentStatus
  capabilityChanges: CapabilityChange[] | null  // Changes pending review (null when no pending changes)
  costAmount: number | null
  costType: 'per_task' | 'per_month' | null
  monthlyCost: number | null
  tasks30d: number
  currentVersion: number
  createdAt: string
  updatedAt: string
  lastActivity: string | null
  lastActivityAction: string | null
  /** Non-null when the agent's endpoint is reached via a tunnel route. */
  tunnelRouteId: string | null
}

export interface CreateExternalAgentInput {
  name: string
  endpointUrl: string
  transportType?: TransportType
  description: string
  connectionType: ConnectionType
  authType: AuthType
  apiKey?: string
  bearerToken?: string
  customHeaders?: CustomHeader[]
  collaborationMode: CollaborationMode
  allowedInternalAgentIds: string[]
  requestRules: TeamRequestRule[]
  // Distilled content from discovery
  summary?: string
  collaborationHints?: string
  detectedCapabilities?: DetectedCapability[]
  detectedResources?: DetectedResource[]
  toolClassifications?: Record<string, SensitivityCategory[]>
  // Echoed from DiscoverOutput beside the categories: the effect class per
  // tool and the classification version that produced it. The backend
  // stores them with the tool's classification, and the runtime's oversight
  // gate reads the effect class on every call to this collaborator.
  toolEffectClasses?: Record<string, ToolEffectClass>
  toolClassificationVersions?: Record<string, number>
  rawMcpTools?: unknown[]
  rawMcpResources?: unknown[]
  discoveryCorrelationId?: string  // From DiscoverOutput.correlationId; attributes the initial discovery LLM cost to this agent
  /** Optional FK to a mcp_tunnel_routes row. When present, endpointUrl must equal that route's public_url. */
  tunnelRouteId?: string
}

export interface UpdateExternalAgentInput {
  name?: string
  description?: string
  collaborationMode?: CollaborationMode
  allowedInternalAgentIds?: string[]
  requestRules?: TeamRequestRule[]
  costAmount?: number | null
  costType?: 'per_task' | 'per_month' | null
}

// === Error Message Helpers ===

export function getUserFriendlyErrorMessage(rawMessage: string, statusCode?: number): string {
  const lowerMessage = rawMessage.toLowerCase()

  if (statusCode === 406 || lowerMessage.includes('406')) {
    return 'Unable to connect. The endpoint may not support the expected protocol.'
  }
  if (statusCode === 401 || lowerMessage.includes('401') || lowerMessage.includes('unauthorized')) {
    return 'Authentication failed. Please check your credentials.'
  }
  if (statusCode === 403 || lowerMessage.includes('403') || lowerMessage.includes('forbidden')) {
    return 'Access denied. The endpoint rejected the connection.'
  }
  if (statusCode === 404 || lowerMessage.includes('404') || lowerMessage.includes('not found')) {
    return 'MCP Endpoint not found. Please verify the URL is correct.'
  }
  if (statusCode === 500 || lowerMessage.includes('500') || lowerMessage.includes('internal server')) {
    return 'The external service encountered an error. Please try again later.'
  }
  if (lowerMessage.includes('timeout') || lowerMessage.includes('timed out')) {
    return 'Connection timed out. The MCP endpoint may be unavailable.'
  }
  if (lowerMessage.includes('econnrefused') || lowerMessage.includes('connection refused')) {
    return 'Connection refused. Please verify the MCP endpoint is running and accessible.'
  }
  if (lowerMessage.includes('enotfound') || lowerMessage.includes('getaddrinfo')) {
    return 'Could not resolve the MCP endpoint address. Please check the URL.'
  }
  if (lowerMessage.includes('mcp') || lowerMessage.includes('failed to connect')) {
    return 'Unable to connect to the external agent. Please check the MCP endpoint URL.'
  }

  return 'Unable to connect. Please check the MCP endpoint and try again.'
}

// === Discovery Streaming (follows distillAITeamStream pattern) ===

export type DiscoverStage =
  | 'connected'
  | 'validating'
  | 'discovering'
  | 'analyzing'
  | 'classifying'  // Tool risk classification for HITL
  | 'finalizing'

export interface DiscoverInput {
  endpointUrl: string
  name: string
  description: string
  authType: AuthType
  apiKey?: string
  bearerToken?: string
  customHeaders?: CustomHeader[]
}

/** What a tool does, as the backend classified it at discovery. */
export type ToolEffectClass = 'read' | 'write' | 'destructive' | 'outbound'

export interface DiscoverOutput {
  capabilities: DetectedCapability[]
  resources: DetectedResource[]           // Stored but NOT displayed in UI (avoid data access confusion)
  toolClassifications: Record<string, SensitivityCategory[]>  // For HITL enforcement
  // Per tool, only where the backend was confident; absent from an older backend.
  toolEffectClasses?: Record<string, ToolEffectClass>
  toolClassificationVersions?: Record<string, number>
  rawMcpTools?: unknown[]
  rawMcpResources?: unknown[]
  transportType: TransportType
  summary: string
  collaborationHints: string
  correlationId?: string  // Echoed from backend; must be sent back in the save payload for LLM cost attribution
}

export interface DiscoverStreamCallbacks {
  onProgress: (stage: DiscoverStage) => void
  onComplete: (result: DiscoverOutput) => void
  onError: (error: Error) => void
}

export async function discoverExternalAgentStream(
  tenantId: string,
  input: DiscoverInput,
  callbacks: DiscoverStreamCallbacks
): Promise<void> {
  try {
    const token = await auth.currentUser?.getIdToken()

    const response = await fetch(
      `${API_BASE_URL}/api/external-agents/discover-stream?tenantId=${tenantId}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token && { Authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(120000), // 2 minute timeout for discovery
      }
    )

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({ message: 'Request failed' }))
      // Backend may return { error: "..." } or { message: "..." }
      const rawMessage = errorBody.message || errorBody.error || `HTTP ${response.status}`
      callbacks.onError(new Error(getUserFriendlyErrorMessage(rawMessage, response.status)))
      return
    }

    const reader = response.body?.getReader()
    const decoder = new TextDecoder()

    if (!reader) {
      callbacks.onError(new Error('Unable to connect. Please try again.'))
      return
    }

    let buffer = ''
    let receivedComplete = false
    let currentEvent = '' // Persists across chunks - critical for large payloads!

    // Helper to process a single SSE line
    const processLine = (line: string) => {
      if (line.startsWith('event: ')) {
        currentEvent = line.slice(7)
      } else if (line.startsWith('data: ') && currentEvent) {
        try {
          const data = JSON.parse(line.slice(6))

          if (currentEvent === 'progress') {
            callbacks.onProgress(data.stage as DiscoverStage)
          } else if (currentEvent === 'complete') {
            receivedComplete = true
            callbacks.onComplete(data as DiscoverOutput)
          } else if (currentEvent === 'error') {
            receivedComplete = true
            callbacks.onError(new Error(getUserFriendlyErrorMessage(data.message)))
          }
        } catch {
          // Ignore JSON parse errors
        }
        currentEvent = ''
      }
    }

    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        // Flush any remaining bytes from decoder and process final buffer
        buffer += decoder.decode()
        if (buffer.trim()) {
          buffer.split('\n').forEach(processLine)
        }
        break
      }

      buffer += decoder.decode(value, { stream: true })

      // Parse complete SSE lines from buffer, keep incomplete line for next chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      lines.forEach(processLine)
    }

    // Stream ended without complete/error event
    if (!receivedComplete) {
      callbacks.onError(new Error('Connection closed unexpectedly. Please try again.'))
    }
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : 'Connection interrupted'
    callbacks.onError(new Error(getUserFriendlyErrorMessage(rawMessage)))
  }
}

// === Standard CRUD APIs ===

export interface PaginatedExternalAgentsResponse {
  agents: ExternalAgent[]
  cursor: string | null
  hasMore: boolean
  total: number
}

export async function listExternalAgents(
  tenantId: string,
  options?: { cursor?: string; limit?: number; status?: ExternalAgentStatus }
): Promise<PaginatedExternalAgentsResponse> {
  const params = new URLSearchParams({ tenantId })
  if (options?.cursor) params.append('cursor', options.cursor)
  if (options?.limit) params.append('limit', options.limit.toString())
  if (options?.status) params.append('status', options.status)

  return await api.get<PaginatedExternalAgentsResponse>(
    `/api/external-agents?${params.toString()}`
  )
}

export async function getExternalAgent(
  agentId: string,
  tenantId: string
): Promise<ExternalAgent> {
  return await api.get<ExternalAgent>(
    `/api/external-agents/${agentId}?tenantId=${tenantId}`
  )
}

export async function createExternalAgent(
  tenantId: string,
  data: CreateExternalAgentInput,
  idempotencyKey: string
): Promise<ExternalAgent> {
  return await api.post<ExternalAgent>(
    `/api/external-agents?tenantId=${tenantId}`,
    data,
    { headers: { 'Idempotency-Key': idempotencyKey } }
  )
}

export async function updateExternalAgent(
  agentId: string,
  tenantId: string,
  data: UpdateExternalAgentInput
): Promise<ExternalAgent> {
  return await api.put<ExternalAgent>(
    `/api/external-agents/${agentId}?tenantId=${tenantId}`,
    data
  )
}

export async function updateExternalAgentStatus(
  agentId: string,
  tenantId: string,
  status: ExternalAgentStatus
): Promise<ExternalAgent> {
  return await api.patch<ExternalAgent>(
    `/api/external-agents/${agentId}/status?tenantId=${tenantId}`,
    { status }
  )
}

export async function deleteExternalAgent(
  agentId: string,
  tenantId: string
): Promise<void> {
  await api.delete(`/api/external-agents/${agentId}?tenantId=${tenantId}`)
}

// Get versions for an external agent
export async function getExternalAgentVersions(
  agentId: string,
  tenantId: string
): Promise<{ versions: ExternalAgentVersion[] }> {
  return await api.get<{ versions: ExternalAgentVersion[] }>(
    `/api/external-agents/${agentId}/versions?tenantId=${tenantId}`
  )
}

// Rollback to a specific version
export async function rollbackExternalAgentVersion(
  agentId: string,
  tenantId: string,
  version: number
): Promise<ExternalAgent> {
  return await api.post<ExternalAgent>(
    `/api/external-agents/${agentId}/rollback?tenantId=${tenantId}`,
    { version }
  )
}

// Version source indicates how the version was created
export type ExternalAgentVersionSource = 'create' | 'discover' | 'manual'

// External agent version - snapshot of configuration at a point in time
export interface ExternalAgentVersion {
  id: string
  externalAgentId: string
  version: number
  name: string
  description: string | null
  summary: string | null
  collaborationHints: string | null
  detectedCapabilities: DetectedCapability[]
  detectedResources: DetectedResource[]
  toolClassifications: Record<string, SensitivityCategory[]>
  allowedInternalAgentIds: string[]
  requestRules: TeamRequestRule[]
  collaborationMode: CollaborationMode
  source: ExternalAgentVersionSource
  createdBy: string | null
  createdAt: string
}

