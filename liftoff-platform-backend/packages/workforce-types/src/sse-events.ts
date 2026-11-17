// CAIO draft SSE event stream — native text/event-stream at the
// workforce-service edge (Phase 3e). The types here match the captured
// fixture library used in contract tests.

export type DraftPlanEventKind =
  | 'session_started'
  | 'message_delta'
  | 'tool_call'
  | 'agent_proposed'
  | 'plan_ready_for_approval'
  | 'session_ended'
  | 'error';

export interface DraftPlanEventBase {
  eventId: string;
  planId: string;
  occurredAt: Date;
}

export interface SessionStartedEvent extends DraftPlanEventBase {
  kind: 'session_started';
  sessionId: string;
}

export interface MessageDeltaEvent extends DraftPlanEventBase {
  kind: 'message_delta';
  role: 'assistant';
  textDelta: string;
}

export interface ToolCallEvent extends DraftPlanEventBase {
  kind: 'tool_call';
  toolName: string;
  toolInput: unknown;
  toolOutput: unknown | null;
}

export interface AgentProposedEvent extends DraftPlanEventBase {
  kind: 'agent_proposed';
  proposedAgentIndex: number;
  name: string;
  role: string;
}

export interface PlanReadyForApprovalEvent extends DraftPlanEventBase {
  kind: 'plan_ready_for_approval';
  proposedAgentCount: number;
}

export interface SessionEndedEvent extends DraftPlanEventBase {
  kind: 'session_ended';
  reason: 'user_disconnected' | 'plan_finalized' | 'timeout';
}

export interface ErrorEvent extends DraftPlanEventBase {
  kind: 'error';
  code: string;
  message: string;
}

export type DraftPlanEvent =
  | SessionStartedEvent
  | MessageDeltaEvent
  | ToolCallEvent
  | AgentProposedEvent
  | PlanReadyForApprovalEvent
  | SessionEndedEvent
  | ErrorEvent;
