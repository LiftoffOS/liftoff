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
  /** Whether status is terminal (frontend uses to stop polling). */
  isTerminal: boolean;
  currentTool: string | null;
  recentEvents: AgentStatusEvent[];
  pendingApprovalId: string | null;
  lastError: string | null;
}

export interface AgentStatusEvent {
  type: 'tool_call' | 'tool_result' | 'message_output' | 'hitl_approval' | 'handoff';
  toolName?: string;
  callId?: string;
  errorPreview?: string;        // truncated to 120 chars
  contentPreview?: string;      // truncated to 120 chars
  at: string;                   // ISO timestamp
}
