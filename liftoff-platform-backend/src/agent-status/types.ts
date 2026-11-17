// Mirrors the AgentStatusResponse shape returned by tenant-runtime's
// /api/invocations/:id/status endpoint. Kept here as a local copy so this
// service can compile without importing from the runtime workspace.

export interface AgentStatusEvent {
  type: 'tool_call' | 'tool_result' | 'message_output' | 'hitl_approval' | 'handoff';
  toolName?: string;
  callId?: string;
  errorPreview?: string;
  contentPreview?: string;
  at: string;
}

export interface AgentStatusResponse {
  invocationId: string;
  tenantId: string;
  agentId: string;
  agentName: string | null;
  status: 'pending' | 'running' | 'interrupted' | 'complete' | 'failed';
  currentTurn: number;
  maxTurns: number | null;
  phase: 'executing' | 'awaiting_approval' | 'completed' | 'failed' | 'unknown';
  startedAt: string | null;
  elapsedMs: number | null;
  isTerminal: boolean;
  currentTool: string | null;
  recentEvents: AgentStatusEvent[];
  pendingApprovalId: string | null;
  lastError: string | null;
}
