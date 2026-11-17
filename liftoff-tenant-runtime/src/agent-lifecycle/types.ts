// Agent Types
// Per Section 8: Agent lifecycle

// Agent type determines execution pattern.
// Phase 1c: collapsed from legacy {A, B, C} to canonical {agent, workflow}.
export type AgentType = 'agent' | 'workflow';

// Model configuration for agent execution
export interface ModelConfig {
  modelId?: string;
  maxTokens?: number;
  temperature?: number;
}

// Memory scope defines what memory layers the agent can access
// D5: readableLayers widened to include 'conversation' so the per-agent scope
// can opt into thread-scoped memory. retrieveMemories short-circuits when
// threadId is absent. writableLayers retains the original 3-layer set —
// conversation-layer writes are gated server-side by saveMemory's threadId
// enforcement, not by an opt-in writable bit on the scope.
export interface MemoryScope {
  readableLayers?: Array<'global' | 'role' | 'individual' | 'conversation'>;
  // 'conversation' included because the runtime writes it: `memory_save`
  // resolves a conversation-layer write against the thread and its default
  // writable list carries it. The type said otherwise and nothing checked.
  writableLayers?: Array<'global' | 'role' | 'individual' | 'conversation'>;
  scopeKeys?: string[];
}

// Execution configuration for runtime limits
export interface ExecConfig {
  maxToolCalls?: number;
  timeoutMs?: number;
}

export interface Agent {
  id: string;
  tenantId: string;
  name: string;
  instructionId: string | null;

  // Per Section 8: Lifecycle state
  lifecycle: AgentLifecycle;

  // Per Section 8: Runtime status
  runtimeStatus: AgentRuntimeStatus;

  // Runtime config fields (from Phase 1 migration)
  agentType: AgentType;
  hitlLevel: number;
  modelConfig: ModelConfig;
  execConfig: ExecConfig;
  memoryScope: MemoryScope;
  systemPrompt: string;
  userInstructions: string;
  entityVersion: number;

  // Per implementation plan Phase 2: Trigger configuration for scheduled agents
  triggerConfig?: TriggerConfig | null;

  createdAt: Date;
  updatedAt: Date;
}

export interface CompanionCron {
  label: string;                // /^[a-z][a-z0-9-]{0,31}$/, unique per agent
  cronExpr: string;
  timezone?: string;
  objective?: string;           // optional per-companion objective handed to the agent
}

// Trigger configuration for agents
// Supports both cronExpr (from Platform Backend) and cron_expression (snake_case)
export interface TriggerConfig {
  type: 'cron' | 'event' | 'manual';
  cron_expression?: string;  // snake_case format
  cronExpr?: string;         // camelCase format from Platform Backend
  timezone?: string;
  event_topics?: string[];
  eventTopic?: string;       // camelCase format from Platform Backend
  objective?: string;

  /** @deprecated singular form retained for back-compat; loader normalizes to companionCrons. */
  companionCron?: { cronExpr: string; timezone?: string };

  /** Companion cron schedules. Up to 5 per agent, labels unique within an agent. */
  companionCrons?: CompanionCron[];

  /** Reactive subscriptions over the unified connector-event stream. Up to 10 per agent. */
  reactiveSubscriptions?: ReactiveSubscription[];
}

// ──────────────────────────────────────────────────────────────────────────
// Reactive subscriptions
// ──────────────────────────────────────────────────────────────────────────

export type SubscriptionSource =
  | { kind: 'connector_event'; connectorRef: string; entityType?: string }
  | { kind: 'system_event'; topic: string }
  | {
      kind: 'computed_metric';
      connectorRef: string;
      fn: string;
      args?: Record<string, unknown>;
      pollIntervalSeconds: number;
      extractPath?: string;
      /**
       * Semantics of the polled predicate:
       *  - 'opportunity' (default): `filter` describes an INTERESTING condition.
       *    The poller EDGE-fires the agent when it crosses false→true.
       *  - 'invariant': `filter` describes a condition that should ALWAYS hold.
       *    The interesting event is the predicate going FALSE. On the
       *    satisfied→violated edge the poller ESCALATES to a human (HITL) rather
       *    than firing the agent, and every check is appended to `goal_ledger`.
       */
      mode?: 'opportunity' | 'invariant';
    };

export type PredicateExpr =
  | { op: 'and' | 'or'; operands: PredicateExpr[] }
  | { op: 'not'; operand: PredicateExpr }
  | { op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte'; path: string; value: string | number | boolean }
  | { op: 'in' | 'nin'; path: string; values: Array<string | number> }
  | { op: 'exists' | 'not_exists'; path: string }
  | { op: 'changed_to'; path: string; value: string | number }
  | { op: 'matches'; path: string; pattern: string };

export interface WindowSpec {
  aggregate: 'count' | 'sum' | 'avg' | 'rate' | 'min' | 'max';
  field?: string;
  durationSeconds: number;
  threshold: { comparator: 'gt' | 'gte' | 'lt' | 'lte'; value: number };
}

export interface ReactiveSubscription {
  label: string;
  source: SubscriptionSource;
  filter?: PredicateExpr;
  window?: WindowSpec;
  cooldownSeconds?: number;
  objective: string;
}

// ──────────────────────────────────────────────────────────────────────────
// Invocation triggers — discriminated union covering every way an agent run
// can start. Forwarded into the executor via ExecuteTaskInput.trigger so
// each handler can apply trigger-specific behavior (e.g. webhook payloads
// run with trustLevel='untrusted_inbound', forcing the HITL approval gate
// and the SSRF allow-list in the tool gateway).
//
// This is the canonical home for the trigger discriminated union.
// ──────────────────────────────────────────────────────────────────────────

export type TriggerTrustLevel = 'trusted' | 'untrusted_inbound';

/** A single mutable trust cell shared by a run's tool catalog, ExecutionState, and
 *  the `context.trustLevel` getter — so a mid-run taint upgrade (read_agent_messages
 *  returning untrusted content) is visible to every downstream consumer (gate,
 *  SSRF/URL scan, audit attribution, delegate/spawn/schedule inheritance) without
 *  per-site changes. Created once per run before catalog construction. */
export interface TrustRef {
  current: TriggerTrustLevel;
  /** Set to an in-flight taint-producing read's (read_agent_messages) fetch+upgrade
   *  promise while it runs. An effectful call's HITL gate awaits this before
   *  classifying, so a write emitted in the SAME turn as a taint-producing read is
   *  gated against the post-read trust (the same-batch race the getter alone can't
   *  close, since the SDK adapter gates per-tool with no batch visibility). Cleared
   *  when the read resolves. */
  pendingTaintRead?: Promise<void>;
}

export interface CronTrigger {
  kind: 'cron';
  schedule?: string;
}

export interface ManualTrigger {
  kind: 'manual';
  /** Firebase UID of the human who pressed Run. */
  userId?: string;
}

export interface AgentDelegationTrigger {
  kind: 'agent';
  /** ID of the delegating agent. */
  fromAgentId: string;
}

export interface ConnectorEventTrigger {
  kind: 'connector_event';
  source: string;
  entityType: string;
  /** Set when the connector's records are authored by an external party (e.g. a
   *  GitHub issue/PR/comment). Absent for internal/first-party connector sources,
   *  which stay trusted. When present, trustLevelFor() reports untrusted_inbound
   *  so the injection screen + SSRF gate engage on the payload. */
  contentTrust?: 'untrusted_inbound';
}

/** Custom inbound webhook → agent invocation. trustLevel is always
 *  'untrusted_inbound' on this variant (open ingestion, closed execution). */
export interface CustomEventTrigger {
  kind: 'custom_event';
  trustLevel: 'untrusted_inbound';
  source: {
    sourceId: string;
    sourceName: string;
    triggerRuleId: string;
    deliveryId: string;
  };
  event: {
    eventId: string;
    eventType: string;
    occurredAt: string;
    subject?: unknown;
    actor?: unknown;
    data?: unknown;
    contentRedacted: boolean;
  };
  receivedAt: string;
}

export type AgentTrigger =
  | CronTrigger
  | ManualTrigger
  | AgentDelegationTrigger
  | ConnectorEventTrigger
  | CustomEventTrigger;

/** Connectors whose record CONTENT is authored by people outside the workspace.
 *
 *  A GitHub pull request title or body is written by whoever opened the PR,
 *  which on a public repository is anyone at all. Content from these sources
 *  enters a run as untrusted_inbound so the injection screen and the SSRF gate
 *  key off it.
 *
 *  Shared deliberately. This was a module-local const in reactive-subscriptions/
 *  fire.ts, so only the subscription path applied it — the same GitHub event
 *  arriving through the eventTopic dispatcher carried no trigger at all and was
 *  therefore treated as trusted. One event, two trust levels, decided by which
 *  dispatcher happened to route it. */
export const EXTERNAL_AUTHORED_CONNECTORS: ReadonlySet<string> = new Set([
  'github',
  // Inbound customer mail and tickets are written by whoever sent them — the
  // least trustworthy content the platform ingests, and the content a support
  // agent is specifically built to read and act on. They were absent while
  // GitHub (often a teammate, in a private repository) was present, so the
  // invariant was applied to the safer half of the problem and not the riskier.
  'google_mail',
  'microsoft_outlook_mail',
  'zendesk',
  'intercom',
]);

/** Build the trigger for a connector-sourced run.
 *
 *  Both dispatch paths must produce the SAME shape: the reactive-subscription
 *  path (reactive-subscriptions/fire.ts) and the eventTopic registry path
 *  (scheduling/event-trigger.ts). They deliver the same events, so a run's
 *  trust level and its resolvable host must not depend on which one routed it.
 *
 *  `source` is the connector TYPE ('github'), which is what a workflow step
 *  resolves against when it names an operation instead of a host. */
export function connectorEventTrigger(source: string, entityType: string): AgentTrigger {
  return {
    kind: 'connector_event',
    source,
    entityType: entityType ?? '',
    ...(EXTERNAL_AUTHORED_CONNECTORS.has(source)
      ? { contentTrust: 'untrusted_inbound' as const }
      : {}),
  };
}

/** Returns the trust level implied by the trigger shape. Trusted by default;
 *  custom_event always carries an explicit untrusted_inbound level, and a
 *  connector_event is untrusted only when its content is external-authored
 *  (contentTrust set — e.g. a GitHub webhook). */
export function trustLevelFor(trigger: AgentTrigger | undefined): TriggerTrustLevel {
  if (!trigger) return 'trusted';
  if (trigger.kind === 'custom_event') return trigger.trustLevel;
  if (trigger.kind === 'connector_event') {
    return trigger.contentTrust === 'untrusted_inbound' ? 'untrusted_inbound' : 'trusted';
  }
  return 'trusted';
}

// Per Section 8: Lifecycle states.
// 'DELETED' is a terminal tombstone written by the canonical-reconciler when
// the upstream internal agent has been deleted (orphan-gate in
// canonical-reconciler.ts). It is distinct from 'ARCHIVED' (a user/admin
// archive) and, like it, has no outgoing transitions. It was previously
// written to the agents table via raw SQL without being part of this union or
// VALID_LIFECYCLE_TRANSITIONS — which crashed archive() (undefined.includes).
export type AgentLifecycle = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'ARCHIVED' | 'DELETED';

// Per Section 8: Runtime status
export type AgentRuntimeStatus =
  | 'IDLE'
  | 'RUNNING'
  | 'WAITING_FOR_EVENT'
  | 'WAITING_FOR_HUMAN'
  | 'STOPPING'
  | 'FAILED';

export interface CreateAgentInput {
  tenantId: string;
  name: string;
}
