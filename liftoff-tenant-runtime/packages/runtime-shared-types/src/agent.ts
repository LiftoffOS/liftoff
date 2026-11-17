/**
 * Canonical agent types. These MUST match across platform-backend,
 * tenant-runtime, and liftoff-react. Any local duplicate is a drift bug.
 *
 * NOTE: The legacy taxonomy was { 'A' | 'B' | 'C' }. This package uses
 * the post-collapse canonical form { 'agent' | 'workflow' }. During the
 * Phase 1 rolling migration, consumers temporarily accept both shapes;
 * after Phase 1c lands, only the canonical form is accepted.
 */

/**
 * Agent execution model.
 * - 'agent' = dynamic LLM loop, runtime decides tool calls (formerly Type A / Type B).
 * - 'workflow' = predetermined step graph executed verbatim (formerly Type C).
 */
export type AgentType = 'agent' | 'workflow';

/**
 * Human-in-the-loop level:
 * 1 = full approval required on every action
 * 2 = destructive actions only
 * 3 = balanced checkpoints
 * 4 = autonomous with occasional checkpoints
 * 5 = fully autonomous
 */
export type HitlLevel = 1 | 2 | 3 | 4 | 5;

export interface ModelConfig {
  modelId?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface MemoryScope {
  readableLayers?: Array<'global' | 'role' | 'individual'>;
  writableLayers?: Array<'global' | 'role' | 'individual'>;
  scopeKeys?: string[];
}

export interface ExecConfig {
  maxToolCalls?: number;
  timeoutMs?: number;
  maxWallClockMs?: number;
  maxLlmTokens?: number;
}

export interface TriggerConfig {
  type: 'cron' | 'event' | 'manual';
  cronExpr?: string;
  eventTopic?: string;
  timezone?: string;
}
