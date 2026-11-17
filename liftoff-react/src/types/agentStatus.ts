// Mirrors tenant-runtime's AgentStatusResponse shape; served via platform-backend
// admin proxy at GET /api/admin/agent-status/:tenantId/:invocationId.

export interface AgentStatusEvent {
  type: 'tool_call' | 'tool_result' | 'message_output' | 'hitl_approval' | 'handoff'
  toolName?: string
  callId?: string
  errorPreview?: string
  contentPreview?: string
  at: string
}

export interface AgentStatusResponse {
  invocationId: string
  tenantId: string
  agentId: string
  agentName: string | null
  status: 'pending' | 'running' | 'interrupted' | 'complete' | 'failed'
  currentTurn: number
  maxTurns: number | null
  phase: 'executing' | 'awaiting_approval' | 'completed' | 'failed' | 'unknown'
  startedAt: string | null
  elapsedMs: number | null
  isTerminal: boolean
  currentTool: string | null
  recentEvents: AgentStatusEvent[]
  pendingApprovalId: string | null
  lastError: string | null
}
