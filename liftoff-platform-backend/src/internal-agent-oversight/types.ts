// Internal Agent Oversight Types
// Per implementation plan: Phase 1 HITL Enforcement

// Autonomy level determines default HITL behavior
export type AutonomyLevel = 'autonomous' | 'balanced' | 'controlled';

// Escalation level determines when to surface decisions
export type EscalationLevel = 'exceptions' | 'important' | 'sensitive';

// Communication mode determines how outbound messages are handled
export type CommunicationMode = 'draft' | 'auto' | 'review';

// Version source for audit trail
export type OversightVersionSource = 'create' | 'manual' | 'api';

// Sensitive work categories that can require human review
export interface SensitiveWorkConfig {
  customerCommunication: boolean;
  financialActions: boolean;
  dataChanges: boolean;
  externalPublishing: boolean;
  hiringDecisions: boolean;
  mergeToMain: boolean;
}

// Main oversight settings interface
export interface OversightSettings {
  tenantId: string;
  currentVersion: number;
  autonomy: AutonomyLevel;
  escalation: EscalationLevel;
  sensitiveWork: SensitiveWorkConfig;
  communication: CommunicationMode;
  /** Which meaning of the Escalation setting this workspace chose (migration
   *  505): 1 until a save names `escalation`, then 2. The runtime's surfacing
   *  policy is on only at 2. */
  escalationSemantics: number;
  /** The same for the Communication setting: the runtime clears a Review
   *  send on the message check only at 2. */
  communicationSemantics: number;
  createdAt: Date;
  updatedAt: Date;
}

// Input for updating oversight settings
export interface UpdateOversightSettingsInput {
  autonomy?: AutonomyLevel;
  escalation?: EscalationLevel;
  sensitiveWork?: Partial<SensitiveWorkConfig>;
  communication?: CommunicationMode;
}

// Version history entry
export interface OversightSettingsVersion {
  id: string;
  tenantId: string;
  version: number;
  autonomy: AutonomyLevel;
  escalation: EscalationLevel;
  sensitiveWork: SensitiveWorkConfig;
  communication: CommunicationMode;
  escalationSemantics: number;
  communicationSemantics: number;
  source: OversightVersionSource;
  createdBy: string | null;
  createdAt: Date;
}

// Default sensitive work configuration
//
// `mergeToMain` defaults ON, unlike the other late addition. It was added after
// the original five and shipped `false`, so every tenant created before it — and
// every tenant created after, who never opened the page — had the one control
// that governs merging to a default branch silently switched off. The Liftoff
// workspace itself was in that state: five categories on, mergeToMain absent
// from the row entirely, an operator reasonably believing merges were governed
// because that is what the page is for.
//
// A safety category that arrives off is indistinguishable from one nobody added,
// and the failure is silent in the direction that costs the most. Merging to a
// default branch is not reversible by the agent that did it.
export const DEFAULT_SENSITIVE_WORK: SensitiveWorkConfig = {
  customerCommunication: true,
  financialActions: true,
  dataChanges: false,
  externalPublishing: true,
  hiringDecisions: false,
  mergeToMain: true,
};

// HITL level resolution from autonomy
// Per plan: autonomous=4, balanced=3, controlled=2
/** The HITL level an agent actually runs at.
 *
 *  Two controls set this and they are not equal partners: /dashboard/oversight
 *  sets the workspace default, and the Autonomy Override on
 *  /dashboard/agents/update sets one agent's level. The override wins for that
 *  agent; everyone else follows the workspace.
 *
 *  This exists because the override was shipped, stored on
 *  internal_agents.autonomy_override, and then ignored by every consumer:
 *  each one called getDefaultHitlLevel(oversight.autonomy) directly, so the
 *  runtime received the workspace value and the override was recorded without
 *  ever taking effect. Resolving it in one place is what stops the next
 *  consumer reintroducing that. */
export function resolveAgentHitlLevel(
  autonomyOverride: AutonomyLevel | null | undefined,
  workspaceAutonomy: AutonomyLevel | null | undefined,
): number {
  return getDefaultHitlLevel(autonomyOverride ?? workspaceAutonomy ?? 'balanced');
}

export function getDefaultHitlLevel(autonomy: AutonomyLevel): number {
  switch (autonomy) {
    case 'autonomous':
      return 4;
    case 'balanced':
      return 3;
    case 'controlled':
      return 2;
    default:
      return 3;
  }
}
