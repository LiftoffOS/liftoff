export type HookEventType = 'PreToolUse' | 'PostToolUse';
export type FailPolicy = 'fail_open' | 'fail_closed' | 'escalate_to_review';

// PreToolUse decisions affect WHETHER and HOW the tool runs.
export type PreToolUseDecision = 'allow' | 'deny' | 'rewrite' | 'escalate_to_review';
// PostToolUse decisions affect what the AGENT sees as the result.
// 'deny' isn't meaningful post-execution (action already happened); the analog
// is 'redact_result' which blocks the result from reaching the agent but still
// records the side effect in audit.
export type PostToolUseDecision = 'allow' | 'rewrite_result' | 'redact_result' | 'escalate_to_review';

export type HookDecision = PreToolUseDecision | PostToolUseDecision;

export interface CustomerHook {
  id: string;
  tenantId: string;
  name: string;
  enabled: boolean;
  eventType: HookEventType;
  toolPattern: string;       // RegExp source string
  webhookUrl: string;
  hmacSecretRef: string;
  timeoutMs: number;
  failPolicy: FailPolicy;
  qpsLimit: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface PreToolUseEventPayload {
  hookId: string;
  event: 'PreToolUse';
  invocationId: string;
  tenantId: string;
  agentId: string;
  agentName?: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  issuedAt: string;          // ISO timestamp
}

export interface PostToolUseEventPayload {
  hookId: string;
  event: 'PostToolUse';
  invocationId: string;
  tenantId: string;
  agentId: string;
  agentName?: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolOutput: unknown;
  toolSuccess: boolean;       // false on PostToolUseFailure path
  toolError?: string;         // populated only when toolSuccess === false
  issuedAt: string;
}

export interface WebhookResponse {
  decision: HookDecision;
  reason?: string;
  updatedInput?: Record<string, unknown>;
}

// HookEvaluationResult is the PreToolUse-specific aggregation record used by
// `pickStrictest` / `strictestToOutcome`. Narrowing `decision` to
// `PreToolUseDecision` (rather than the union `HookDecision`) means the
// strictest-priority table and the conversion to `ResolvedHookOutcome` are
// exhaustive without dummy entries or casts.
export interface HookEvaluationResult {
  decision: PreToolUseDecision;
  reason?: string;
  updatedInput?: Record<string, unknown>;
  hookId: string;
  // Always populated for observability
  source: 'webhook' | 'fail_policy';
  failPolicyApplied?: FailPolicy;
}

export interface ResolvedPreToolUseOutcome {
  outcome: PreToolUseDecision;
  reason?: string;
  updatedInput?: Record<string, unknown>;
  hookId?: string;
}

export interface ResolvedPostToolUseOutcome {
  outcome: PostToolUseDecision;
  reason?: string;
  rewrittenOutput?: unknown;   // present when outcome === 'rewrite_result'
  hookId?: string;
}

// Kept for compatibility with earlier sections; sdk-hooks branches on the
// event type and uses the appropriate Resolved* shape.
export type ResolvedHookOutcome = ResolvedPreToolUseOutcome;
