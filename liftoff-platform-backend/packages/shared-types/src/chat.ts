/**
 * Canonical types for the interactive agent chat system.
 * Used by platform-backend (chat service, SSE streaming, Slack adapter)
 * and tenant-runtime (tool proxy endpoints).
 *
 * Phase 2-3 of the Interactive Mode implementation plan.
 */

// ── Execution path discriminator ────────────────────────────────────────

/** Distinguishes autonomous task threads from interactive chat threads. */
export type ExecutionPath = 'autonomous' | 'interactive';

// ── Channel types ───────────────────────────────────────────────────────

/** The messaging channel a chat thread originates from. */
export type AgentChatChannel = 'web' | 'slack';

// ── Chat turn request/response ──────────────────────────────────────────

/** Request shape sent from platform backend to tenant runtime tool proxy. */
export interface ChatTurnRequest {
  tenantId: string;
  agentId: string;
  threadId: string;
  userId: string;
  userDisplayName: string;
  content: string;
  channelHint?: AgentChatChannel;
  mentionedAgentIds?: string[];
}

// ── Tool call proxy types ───────────────────────────────────────────────

/** Request sent from platform backend to tenant runtime for tool execution. */
export interface AgentToolCallRequest {
  tenantId: string;
  invocationId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  userId: string;
}

/** Response from tenant runtime tool execution. */
export interface AgentToolCallResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  hitlGated?: boolean;
  approvalId?: string;
}

// ── Feedback types ──────────────────────────────────────────────────────

/** Feedback types as sent by the frontend. */
export type FrontendFeedbackType = 'thumbs_up' | 'thumbs_down' | 'text';

/** Feedback types as stored by the tenant runtime. */
export type RuntimeFeedbackType = 'correction' | 'positive' | 'preference';

/** Feedback signal sent from frontend → platform backend → tenant runtime. */
export interface ChatFeedbackSignal {
  threadId: string;
  messageId: string;
  feedbackType: FrontendFeedbackType | RuntimeFeedbackType;
  content: string;
  userId: string;
}

// ── SSE event types ─────────────────────────────────────────────────────

/** Chat error codes for the error event. */
export type AgentChatErrorCode =
  | 'PROVIDER_ERROR'
  | 'MAX_ITERATIONS'
  | 'TOKEN_BUDGET'
  | 'INTERNAL'
  | 'AGENT_PAUSED'
  | 'AGENT_NOT_FOUND';

/** Discriminated union of events yielded by the chat service. */
export type AgentChatEventType =
  | { type: 'thinking' }
  | { type: 'agent_start'; agentId: string; agentName?: string }
  | { type: 'tool_call'; tool: string }
  | { type: 'text_delta'; text: string }
  | { type: 'hitl_required'; approvalId: string; reason: string }
  | { type: 'complete'; messageId: string; content: string; inputTokens: number; outputTokens: number }
  | { type: 'error'; code: AgentChatErrorCode; message: string };

// ── Slack adapter types ─────────────────────────────────────────────────

/** Task payload for async Slack chat processing via Cloud Tasks. */
export interface SlackChatTask {
  tenantId: string;
  agentId: string;
  slackAppId: string;
  slackTeamId: string;
  slackUserId: string;
  slackChannelId: string;
  slackThreadTs: string;
  text: string;
  eventTs: string;
  botToken: string;
}

/** Slack event payload from the Events API. */
export interface SlackEventPayload {
  type: 'url_verification' | 'event_callback';
  challenge?: string;
  token?: string;
  team_id?: string;
  api_app_id?: string;
  event_id?: string;
  event?: {
    type: string;
    user?: string;
    text?: string;
    channel?: string;
    ts?: string;
    thread_ts?: string;
    bot_id?: string;
  };
}
