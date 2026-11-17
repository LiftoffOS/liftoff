// LLM Module
// Multi-provider LLM infrastructure

export { llmClient } from './client';
// Runtime export (class) — thrown by the client on a safety refusal; callers
// that want to tolerate refusals catch this explicitly.
export { LLMRefusalError } from './types';
export type {
  LLMProvider,
  LLMMessage,
  LLMCompletionRequest,
  LLMCompletionResponse,
  LLMProviderClient,
  LLMClientConfig,
  LLMUsageEvent,
  LLMUsageCallback,
  // Phase 4 — multi-tool + streaming
  LLMToolDefinition,
  LLMToolCall,
  LLMToolResult,
  LLMStopReason,
  LLMStreamEvent,
} from './types';
