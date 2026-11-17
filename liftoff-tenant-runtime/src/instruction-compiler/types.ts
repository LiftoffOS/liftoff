// Instruction Compiler Types
// Per Section 9: v1 DSL must represent these elements

export interface CompileInput {
  // Per Section 9: Customer submits JSON + free text
  tenantId: string;
  structuredInput: Record<string, any>;
  freeTextInstructions: string;
}

// Per Section 9: The v1 DSL must represent
export interface CompiledInstruction {
  version: number;
  triggers: Trigger[];
  workflowObjective: string;
  conditionalBranches: ConditionalBranch[];
  allowedTools: string[];
  allowedConnectors: string[];
  allowedActionTypes: string[];
  writeScopes: WriteScope[];
  handoffPermissions: HandoffPermission[];
  escalationRules: EscalationRule[];
  approvalRules: ApprovalRule[];
  retryRules: RetryRule[];
  conflictPolicyRefs: string[];
  quotaHooks: QuotaHook[];
  undoHints: UndoHint[];
  instructionsMd?: string | null;
  learnedInstructionsMd?: string | null;
}

export interface Trigger {
  type: 'event' | 'schedule' | 'webhook' | 'manual';
  config: Record<string, any>;
}

export interface ConditionalBranch {
  condition: string;
  thenBranch: string;
  elseBranch?: string;
}

export interface WriteScope {
  connector: string;
  entityType: string;
  allowedFields: string[];
}

export interface HandoffPermission {
  fromAgentType: string;
  toAgentType: string;
  conditions: string[];
}

export interface EscalationRule {
  trigger: string;
  action: 'notify' | 'pause' | 'abort';
  target: string;
}

export interface ApprovalRule {
  actionType: string;
  requiresApproval: boolean;
  approvers: string[];
}

/** A constraint on what may be done with a tool's RESULT, as opposed to whether
 *  the tool may be called at all (allowedTools) or what happens when it fails
 *  (retryRules). Keyed by tool name for the same reason its siblings are keyed by
 *  actionType: the rule is about a specific thing the agent does, and the runtime
 *  looks it up by that key at the moment it acts. */
export interface ResultRule {
  /** Aliased tool name, in the same vocabulary as allowedTools. */
  toolName: string;
  /** The result may only be acted on in full.
   *
   *  A result too large for context is parked in the workspace and only a view
   *  reaches the model. For a call that decides whether a key already exists, how
   *  many records there are, or what differs between two systems, a view does not
   *  give a partial answer — it gives a wrong one, because everything unseen looks
   *  absent. Where this is set the runtime fails the call retryably instead of
   *  returning a view as a success. */
  requiresComplete: boolean;
}

export interface RetryRule {
  actionType: string;
  maxRetries: number;
  backoffStrategy: 'linear' | 'exponential';
}

export interface QuotaHook {
  resource: string;
  limit: number;
  period: string;
}

export interface UndoHint {
  actionType: string;
  undoStrategy: 'reverse' | 'compensate' | 'manual';
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// Per Section 9: Agent may move from DRAFT to ACTIVE
export type InstructionStatus = 'draft' | 'pending_approval' | 'approved' | 'active' | 'archived' | 'rejected';

// Persisted compiled instruction entity
export interface CompiledInstructionEntity {
  id: string;
  tenantId: string;
  agentId: string;
  version: number;
  status: InstructionStatus;
  instruction: CompiledInstruction;
  validationResult: ValidationResult | null;
  preview: Preview | null;
  createdAt: Date;
  updatedAt: Date;
  approvedAt: Date | null;
  approvedBy: string | null;
  activatedAt: Date | null;
  rejectionReason: string | null;
  // Fields from internal agent instruction creation
  systemPrompt?: string;
  userInstructions?: string;
  // `type` is the connector_type (e.g. 'google_sheets') OR the literal string
  // 'external_agent'. It is enriched at event-publish time by the platform backend
  // so the tenant runtime can resolve the integration to the CURRENT live connector
  // even after a reconnect changes the connector UUID. Older instructions may not
  // have `type` populated; the permission validator falls back to a JOIN through
  // the connectors table by id, so absence of `type` is not a hard failure.
  integrations?: Array<{ id: string; type?: string; selectedObjects?: string[] }>;
  // Phase 1 CLAUDE.md: DB-backed instructions_md column from platform backend
  instructionsMd?: string | null;
  // Autonomous learning loop: runtime-generated CLAUDE.md amendments from the slow loop
  learnedInstructionsMd?: string | null;
  // R5: capability tier — connector_only (default) or execution_enabled (grants shell/file tools)
  capabilityTier?: 'connector_only' | 'execution_enabled';
  // Per-tool constraints on result handling, authored by distillation and obeyed
  // by the tool gateway. Entity-level for the same reason capabilityTier is: the
  // fields INSIDE `instruction` are compiled here, while the ones the platform
  // decides arrive on the event payload and are stored alongside. Absent on every
  // agent compiled before this existed, which keeps them on today's behaviour.
  resultRules?: ResultRule[];
  /** Per-tool rules appended to those tools' descriptions, keyed by aliased
   *  tool name. Applied by every path that describes a tool to a model — see
   *  tool-gateway/tool-description-overrides.ts. */
  toolDescriptionOverrides?: Record<string, string>;
  /** Declared grounding rules, evaluated by the host at turn start so an
   *  agent's first read is the same on every engine. */
  groundsOn?: Array<{ label: string; terms: string[]; cues: string[]; toolName: string; enabled: boolean }>;
  /** Per-capability live | unwired | absent. The gateway refuses an absent
   *  capability's tools by name. */
  capabilityStates?: Record<string, 'live' | 'unwired' | 'absent'>;
  // Knowledge items pinned via [[knowledge:...]] markers. Used by corpus_search
  // as a retrieval bias — pinned items are positionally elevated above natural
  // matches when they match the query. Empty array when no pins.
  pinnedKnowledgeIds?: string[];
}

// Input for creating a new instruction draft
export interface CreateInstructionInput extends CompileInput {
  tenantId: string;
  agentId: string;
}

// Approval request
export interface ApprovalRequest {
  approvedBy: string;
  comment?: string;
}

// Rejection request
export interface RejectionRequest {
  rejectedBy: string;
  reason: string;
}

// Activation request
export interface ActivationRequest {
  activatedBy: string;
}

// Per Section 10: Preview UX contract
export interface Preview {
  // Level 1: Plain-language summary
  summary: string;

  // Level 2: Systems accessed, systems written to, key triggers
  systemsAccessed: string[];
  systemsWrittenTo: WriteScope[];
  keyTriggers: Trigger[];

  // Level 3: Detailed scope, escalation, and approval rules
  detailedScopes: WriteScope[];
  escalationRules: EscalationRule[];
  approvalRules: ApprovalRule[];

  // Level 4: Concrete example scenarios
  exampleScenarios: any[];
}
