/**
 * Canonical Pub/Sub envelope shapes for internal_agent.* events.
 * All events carry a schema_version field so subscribers can route
 * forward-compatibly.
 */

import type { AgentType, HitlLevel, MemoryScope, ModelConfig, ExecConfig, TriggerConfig } from './agent.js';
import type { WorkflowStep } from './workflow.js';

export interface InternalAgentEventEnvelope<TPayload> {
  schema_version: 1;
  entityType: 'internal_agent';
  entityId: string;
  entityVersion: number;
  eventVersion: number;
  eventType: string;
  tenantId: string;
  payload: TPayload;
}

export interface InternalAgentCreatedPayload {
  internalAgentId: string;
  name: string;
  agentType: AgentType;
  hitlLevel?: HitlLevel;
  modelConfig?: ModelConfig;
  memoryScope?: MemoryScope;
  execConfig?: ExecConfig;
  workflowSteps?: WorkflowStep[];
  triggerConfig?: TriggerConfig;
  systemPrompt?: string | null;
  userInstructions?: string | null;
}

export interface InternalAgentStatusChangedPayload {
  internalAgentId: string;
  previousStatus: 'draft' | 'active' | 'paused';
  newStatus: 'draft' | 'active' | 'paused';
  agentType: AgentType;
  triggerConfig?: TriggerConfig;
}

export interface InternalAgentRuntimeConfigUpdatedPayload {
  internalAgentId: string;
  agentType: AgentType;
  hitlLevel?: HitlLevel | null;
  modelConfig?: ModelConfig;
  execConfig?: ExecConfig;
  memoryScope?: MemoryScope;
  triggerConfig?: TriggerConfig | null;
  workflowSteps?: WorkflowStep[] | null;
}

export type InternalAgentCreatedEvent = InternalAgentEventEnvelope<InternalAgentCreatedPayload>;
export type InternalAgentStatusChangedEvent = InternalAgentEventEnvelope<InternalAgentStatusChangedPayload>;
export type InternalAgentRuntimeConfigUpdatedEvent = InternalAgentEventEnvelope<InternalAgentRuntimeConfigUpdatedPayload>;
