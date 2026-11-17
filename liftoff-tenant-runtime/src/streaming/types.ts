// SSE Streaming Types
// Per implementation plan: Phase 4 SSE Event Streaming

// SSE event types (discriminated union)
export type SSEEventType =
  | 'agent_status'
  | 'tool_start'
  | 'tool_progress'
  | 'tool_complete'
  | 'tool_error'
  | 'hitl_required'
  | 'hitl_resolved'
  | 'text_delta'
  | 'message_complete'
  | 'error'
  | 'rescue_branch'
  | 'sandbox_tool_start'
  | 'sandbox_tool_complete'
  | 'sandbox_tool_error'
  | 'sandbox_file_change'
  | 'sandbox_browser_navigation';

// Base event structure
export interface BaseSSEEvent {
  eventId: string;
  threadId: string;
  invocationId: string;
  timestamp: string;
}

// Agent status event
export interface AgentStatusEvent extends BaseSSEEvent {
  type: 'agent_status';
  data: {
    status: 'thinking' | 'executing' | 'waiting' | 'complete';
    agentId: string;
    agentRole: string;
  };
}

// Tool start event
export interface ToolStartEvent extends BaseSSEEvent {
  type: 'tool_start';
  data: {
    toolCallId: string;
    toolName: string;
    input: Record<string, unknown>;
  };
}

// Tool progress event (for long-running tools)
export interface ToolProgressEvent extends BaseSSEEvent {
  type: 'tool_progress';
  data: {
    toolCallId: string;
    toolName: string;
    progress: number;
    message?: string;
  };
}

// Tool complete event
export interface ToolCompleteEvent extends BaseSSEEvent {
  type: 'tool_complete';
  data: {
    toolCallId: string;
    toolName: string;
    output: unknown;
  };
}

// Tool error event
export interface ToolErrorEvent extends BaseSSEEvent {
  type: 'tool_error';
  data: {
    toolCallId: string;
    toolName: string;
    error: string;
    retryable: boolean;
  };
}

// HITL required event
export interface HitlRequiredEvent extends BaseSSEEvent {
  type: 'hitl_required';
  data: {
    approvalId: string;
    reason: string;
    pendingToolCalls: Array<{
      id: string;
      name: string;
      input: Record<string, unknown>;
    }>;
    /** Optional — autonomous adapter-driven pauses don't always have
     *  the expiry on hand at the moment of emit. Resolves via the
     *  hitl_approval_requests row when present. */
    expiresAt?: string;
  };
}

// HITL resolved event
export interface HitlResolvedEvent extends BaseSSEEvent {
  type: 'hitl_resolved';
  data: {
    approvalId: string;
    decision: 'approved' | 'rejected';
    decidedBy?: string;
  };
}

// Text delta event (streaming LLM output)
export interface TextDeltaEvent extends BaseSSEEvent {
  type: 'text_delta';
  data: {
    delta: string;
    role: 'assistant';
  };
}

// Message complete event
export interface MessageCompleteEvent extends BaseSSEEvent {
  type: 'message_complete';
  data: {
    messageId: string;
    content: string;
    role: 'assistant';
    inputTokens: number;
    outputTokens: number;
  };
}

// Error event
export interface ErrorEvent extends BaseSSEEvent {
  type: 'error';
  data: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

// Rescue branch event — emitted when an agent hits the turn limit with uncommitted work
export interface RescueBranchEvent extends BaseSSEEvent {
  type: 'rescue_branch';
  data: {
    branchName: string;
  };
}

// Sandbox-originated events forwarded by the in-container sidecar via the
// runtime /internal/sandbox/events callback. Each carries the sandboxId so
// the frontend can render sandbox activity distinctly from LLM-loop events.
export interface SandboxToolStartEvent extends BaseSSEEvent {
  type: 'sandbox_tool_start';
  data: {
    toolName: string;
    args: unknown;
    sandboxId: string;
  };
}

export interface SandboxToolCompleteEvent extends BaseSSEEvent {
  type: 'sandbox_tool_complete';
  data: {
    toolName: string;
    args: unknown;
    result: unknown;
    sandboxId: string;
  };
}

export interface SandboxToolErrorEvent extends BaseSSEEvent {
  type: 'sandbox_tool_error';
  data: {
    toolName: string;
    args: unknown;
    error: unknown;
    sandboxId: string;
  };
}

export interface SandboxFileChangeEvent extends BaseSSEEvent {
  type: 'sandbox_file_change';
  data: {
    path: string;
    kind: 'add' | 'change' | 'unlink';
    sandboxId: string;
  };
}

export interface SandboxBrowserNavigationEvent extends BaseSSEEvent {
  type: 'sandbox_browser_navigation';
  data: {
    tabId: string;
    url: string;
    sandboxId: string;
  };
}

// Union of all SSE events
export type SSEEvent =
  | AgentStatusEvent
  | ToolStartEvent
  | ToolProgressEvent
  | ToolCompleteEvent
  | ToolErrorEvent
  | HitlRequiredEvent
  | HitlResolvedEvent
  | TextDeltaEvent
  | MessageCompleteEvent
  | ErrorEvent
  | RescueBranchEvent
  | SandboxToolStartEvent
  | SandboxToolCompleteEvent
  | SandboxToolErrorEvent
  | SandboxFileChangeEvent
  | SandboxBrowserNavigationEvent;

// SSE client connection
export interface SSEClient {
  id: string;
  tenantId: string;
  threadId: string;
  userId?: string;
  connectedAt: Date;
  lastPingAt: Date;
}
