// LLM Type Definitions
//
// Shared types for messages, content blocks, tool definitions, and responses
// used across the workforce planning CAIO chat service and any future
// LLM-powered features.

export interface LLMTextBlock {
  type: 'text';
  text: string;
}

export interface LLMToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * An image the person attached, on its way to a model.
 *
 * Base64 rather than a URL: the bytes live in the control plane's private
 * bucket behind a membership check, and every URL it can mint for them expires
 * in an hour — a vendor handed a link would either need the bucket public or
 * would fail whenever it fetched late.
 */
export interface LLMImageBlock {
  type: 'image';
  mimeType: string;
  dataBase64: string;
  alt?: string;
}

export type LLMContentBlock = LLMTextBlock | LLMToolUseBlock | LLMImageBlock;

export interface LLMMessage {
  role: 'user' | 'assistant';
  content: string | LLMContentBlock[];
}

export interface LLMToolResultContent {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type LLMStopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
export type LLMToolCall = LLMToolUseBlock;
export type LLMToolResult = LLMToolResultContent;

/** Schema-only definition handed to the LLM as part of a tool list. */
export interface LLMToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface LLMStreamEvent {
  type: string;
  [key: string]: unknown;
}

export interface LLMUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface LLMResponse {
  id: string;
  content: LLMContentBlock[];
  stop_reason: LLMStopReason;
  usage: LLMUsage;
}
