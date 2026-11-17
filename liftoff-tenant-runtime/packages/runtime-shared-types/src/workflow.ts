/**
 * Canonical WorkflowStep shape. Uses camelCase to match the rest of both
 * codebases. Tenant-runtime's historical snake_case variant is deprecated
 * and removed in Phase 3.
 *
 * This is the canonical v1 shape for Type C / workflow agents. Every field
 * here is understood by the Phase 4 workflow executor.
 */

export interface WorkflowStepLoop {
  /** Dot-path into the current stepOutput pointing at an array */
  over: string;
  /** Name under which each item is exposed in templates (default "item") */
  itemVar?: string;
  /** Safety cap; default 100, hard max 1000 */
  maxIterations?: number;
  /** If true, aggregate iteration outputs into an array at output.<stepId> */
  collect?: boolean;
}

export interface WorkflowStepRetry {
  /** Default 1 (no retry). Counts against execConfig.maxToolCalls. */
  maxAttempts: number;
  /** Default 1000ms, doubles per attempt, ceiling 30000ms */
  backoffMs?: number;
}

/** A vendor-agnostic capability NEED, stored on a `capability` step.
 *
 *  Capability discovery is live per query and its fine-grained ids carry the
 *  vendor name, so a durable step cannot store a capability id or an opaque
 *  handle — only this need. The runtime resolves it to a concrete capability at
 *  execution time (search then run), and the vendor is named nowhere in agent
 *  config. Mirrors the discovery service's CapabilitySpec, minus the fields the
 *  runtime supplies itself (tenantId, boundConnectorTypes). */
export interface WorkflowCapabilityNeed {
  /** Verb phrase, e.g. "enrich person", "send text message". */
  operation: string;
  /** What comes back / what the action targets, e.g. "profiles", "message". */
  entity: string;
  /** 'public_data' for third-party or public-web information; 'own_account'
   *  for the workspace's own systems. */
  mode: 'public_data' | 'own_account';
  /** Platform the need concerns, lowercase, e.g. "instagram". Omit if cross-system. */
  targetSystem?: string;
  /** What the step will actually hold when it runs (drives judge scoring). */
  availableInputs?: string[];
  /** Fields the deliverable needs from this step's output. */
  requiredOutputFields?: string[];
}

export interface WorkflowStep {
  stepId: string;
  description: string;

  /** Step variant. Defaults to 'tool_call' when omitted for back-compat.
   *  'capability' resolves a vendor-agnostic `capabilityNeed` to a concrete
   *  capability at run time and runs it through the same admission/HITL path as
   *  a model-issued run_capability (so a write/outbound capability pauses for
   *  approval); the vendor is never named in config. */
  type?: 'tool_call' | 'llm_reason' | 'delay' | 'ask_user' | 'capability';

  // Tool execution
  /** Canonical aliased form, e.g. "salesforce_prod__read_record" */
  toolName?: string;
  /** The vendor-agnostic capability need; required when type === 'capability'.
   *  The call arguments come from toolInput / toolInputTemplate as for a
   *  tool_call, and outputField threads the result to later steps. */
  capabilityNeed?: WorkflowCapabilityNeed;
  /** Static tool input */
  toolInput?: Record<string, unknown>;
  /** JSON template with {{input.X}} / {{output.X}} / {{item.X}} substitution */
  toolInputTemplate?: string;
  /** Dot-path into the result for the next step's stepOutput */
  outputField?: string;

  // Control flow
  /** Condition evaluated by condition.ts (Phase 3) */
  condition?: string;
  /** Next stepId on success; empty string = terminate */
  onSuccess?: string;
  /** Fallback stepId on failure */
  onFailure?: string;
  /** Optional loop iteration configuration */
  loop?: WorkflowStepLoop;

  // Reliability
  retry?: WorkflowStepRetry;
  /** Per-step timeout; default 60000ms (inherited from execConfig if set) */
  timeoutMs?: number;
  /** Delay configuration; required when type === 'delay' */
  delay?: WorkflowDelayStep;

  // Human-in-the-loop
  /** Force HITL gate on this step regardless of agent hitlLevel */
  requiresApproval?: boolean;

  /** Plain-text clarification question; required when type === 'ask_user'. */
  question?: string;

  /** Opt-in LLM-driven semantic validation of the step output. */
  semanticValidation?: boolean;

  /**
   * Optional explicit idempotency key. If absent, the executor derives one as
   * sha256(runId + stepId + iteration + toolName + canonical(toolInput)).
   */
  idempotencyKey?: string;
}

export interface WorkflowDelayStep {
  /** Duration in seconds — min 60, max 30 days (2592000). */
  durationSeconds?: number;
  /** Resume at an absolute ISO timestamp. Mutually exclusive with durationSeconds. */
  untilIso?: string;
  /** Operator-supplied delay context tag. */
  contextRef?: string;
}
