export type MemoryType = 'ARCHITECTURAL_DECISION' | 'CONVENTION' | 'GOTCHA' | 'CONTEXT' | 'PREFERENCE';
export type MemoryLayer = 'global' | 'role';

export interface ClassificationResult {
  worthy: boolean;
  memoryType?: MemoryType;
  confidence?: number;
  extractedContent?: string;
  suggestedTags?: string[];
  suggestedLayer?: MemoryLayer;
  roleHint?: string;
}

export interface HarvestEvent {
  tenantId: string;
  connectorId: string | null;
  connectorType: string;
  entityType: string;
  entityId: string;
  data: Record<string, unknown>;
  messageId: string; // Pub/Sub message ID (for idempotency)
}

/**
 * The relay request shape. Re-exported from @liftoffos/shared-types rather
 * than hand-written here.
 *
 * The local copy this replaces was wrong in two ways, and neither could fail
 * at compile time because both were typed loosely:
 *
 *  - `responseSchema?: Record<string, unknown>` accepted a BARE JSON Schema,
 *    but the relay expects the {name, description?, schema} wrapper. Without
 *    `name` the provider emitted `tool_choice: {type:'tool', name: undefined}`
 *    and Anthropic rejected every harvest classification.
 *  - `tier` listed 'large', which is not a tier the relay knows
 *    ('flagship' | 'medium' | 'small'). It resolved to an undefined model.
 *    Latent only because this service always sends 'small'.
 *
 * Importing the canonical type is what makes the next such mismatch a
 * compile error here instead of a 400 from the vendor in production.
 */
export type { LLMWireRequest as LLMCompletionRequest } from '@liftoffos/shared-types';

export interface LLMCompletionResponse {
  content: string;
  model: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

export type NodeType =
  | 'connector_event'
  | 'agent_action'
  | 'system_event'
  | 'hitl_event'
  | 'chat_feedback'
  | 'memory'
  | 'instruction_amendment';

export interface MemoryWriteSource {
  nodeType: NodeType;
  refId: string;
  connectorId?: string | null;
  agentId?: string | null;
  confidence?: number;
  metadata?: Record<string, unknown>;
}

export interface CostEvent {
  tenantId: string;
  connectorId: string | null;
  connectorType: string;
  entityType: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  memoryType: string | null;
  worthy: boolean;
  sourceRecordId: string;
  // DB-001: Pub/Sub message id is the canonical idempotency key for
  // cost events. Required: every pipeline event has a messageId.
  messageId: string;
}
