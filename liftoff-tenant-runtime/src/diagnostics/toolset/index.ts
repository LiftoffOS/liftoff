// Per-agent DESIGNED toolset loaders — the evaluation baseline.
//
// Tool-correctness, trajectory, and conformance are judged against each agent's
// deliberately-designed toolset. The three system agents have FIXED, verified
// catalogs (role matrices / HRBP_TOOLS / insights tools) that live in OTHER
// repos — tenant-runtime cannot import them, so they are replicated here as
// constants, each citing its source of truth. User-created agents assemble
// their catalog dynamically; the available set is not persisted, so it is
// RECONSTRUCTED (or, when reconstruction isn't available, left null and the
// out-of-set check is skipped with a logged coverage gap — see plan caveat).

import type { AgentKind, ReconstructedRun } from '../reconstruct/trace-model';

export interface DesignedToolset {
  agentKind: AgentKind;
  /** The full designed/available tool name set. null = unresolved (user-created
   *  without a reconstructed catalog) → out-of-set check is skipped. */
  tools: Set<string> | null;
  /** Whether `tools` is a TRUSTWORTHY complete set (the runtime-captured
   *  trajectory toolset, or a hardcoded system-agent catalog) vs a LOSSY
   *  re-derivation (the user-created reconstructed catalog, which misses
   *  dynamically-surfaced tools: deferred/ToolSearch, vendor-hosted MCP, adapter
   *  presets). Out-of-set is a violation only against a reliable set — against a
   *  lossy one it produces only false positives (the LLM API already guarantees
   *  a model can't call a tool it wasn't given), so the auditor downgrades it to
   *  a logged coverage gap. */
  reliable: boolean;
  /** Role-allowed predicate (CAIO / Insights matrices). undefined = no gate. */
  isRoleAllowed?: (tool: string, role: string) => boolean;
  /** Ordered designed-sequence stages; each inner array is a set of tools
   *  acceptable at that stage. A call from a later stage before an earlier
   *  stage's prerequisite is a sequence break. */
  designedSequence?: string[][];
  /** Required structured output marker for the conformance "expected outputs"
   *  check (Insights must render visualization blocks). */
  expectedOutputs?: 'visualization_blocks';
  /** Terminal-state tools (HRBP transition_to_blocker terminates the loop). */
  terminators?: Set<string>;
}

type Role = 'owner' | 'admin' | 'member' | 'viewer';
type Access = 'allow' | 'allow_own' | 'allow_read' | 'deny';

function allowed(access: Access | undefined): boolean {
  return access != null && access !== 'deny';
}

// ---------------------------------------------------------------------------
// CAIO — 9 tools, role-filtered.
// Source: liftoff-workforce-service/src/workforce-plans/tools/role-matrix.ts
//         (TOOL_ACCESS_MATRIX). Designed flow: gather → draft → commit → approve.
// ---------------------------------------------------------------------------
const CAIO_MATRIX: Record<string, Record<Role, Access>> = {
  workforce_plan__draft: { owner: 'allow', admin: 'allow', member: 'deny', viewer: 'deny' },
  workforce_plan__commit: { owner: 'allow', admin: 'allow', member: 'deny', viewer: 'deny' },
  workforce_plan__approve: { owner: 'allow', admin: 'allow', member: 'deny', viewer: 'deny' },
  org__get_existing_structure: { owner: 'allow', admin: 'allow', member: 'allow', viewer: 'allow' },
  connectors__list_available: { owner: 'allow', admin: 'allow', member: 'allow', viewer: 'allow' },
  agent_templates__list: { owner: 'allow', admin: 'allow', member: 'allow', viewer: 'allow' },
  agent_templates__get: { owner: 'allow', admin: 'allow', member: 'allow', viewer: 'allow' },
  memory_save: { owner: 'allow', admin: 'allow', member: 'deny', viewer: 'deny' },
  memory_retrieve: { owner: 'allow', admin: 'allow', member: 'allow', viewer: 'allow' },
};

const CAIO_TOOLSET: DesignedToolset = {
  agentKind: 'caio',
  tools: new Set(Object.keys(CAIO_MATRIX)),
  reliable: true,
  isRoleAllowed: (tool, role) => allowed(CAIO_MATRIX[tool]?.[role as Role]),
  designedSequence: [
    ['org__get_existing_structure', 'connectors__list_available', 'agent_templates__list', 'agent_templates__get', 'memory_retrieve', 'memory_save'],
    ['workforce_plan__draft'],
    ['workforce_plan__commit'],
    ['workforce_plan__approve'],
  ],
};

// ---------------------------------------------------------------------------
// HRBP — 6 fixed tools. Source: liftoff-workforce-service/src/platform-agent/
// hrbp/index.ts (HRBP_TOOLS). Designed sequence: distill → create →
// record/update; compensate = rollback; transition_to_blocker = terminator.
// ---------------------------------------------------------------------------
const HRBP_TOOLS = [
  'teambuilder__distill',
  'teambuilder__create',
  'provisioning__record_event',
  'provisioning__update_spec_status',
  'provisioning__compensate',
  'provisioning__transition_to_blocker',
];

const HRBP_TOOLSET: DesignedToolset = {
  agentKind: 'hrbp',
  tools: new Set(HRBP_TOOLS),
  reliable: true,
  designedSequence: [
    ['teambuilder__distill'],
    ['teambuilder__create'],
    ['provisioning__record_event', 'provisioning__update_spec_status', 'provisioning__compensate'],
  ],
  terminators: new Set(['provisioning__transition_to_blocker']),
};

// ---------------------------------------------------------------------------
// Insights — 9 read-only tools, role-filtered; must render visualization
// blocks. Source: liftoff-platform-backend/src/insights/tools/role-matrix.ts.
// ---------------------------------------------------------------------------
const INSIGHTS_MATRIX: Record<string, Record<Role, Access>> = {
  get_agent_performance: { owner: 'allow', admin: 'allow', member: 'allow', viewer: 'allow' },
  get_cost_breakdown: { owner: 'allow', admin: 'allow', member: 'allow', viewer: 'allow_read' },
  get_human_activity: { owner: 'allow', admin: 'allow', member: 'allow_own', viewer: 'deny' },
  get_payroll_summary: { owner: 'allow', admin: 'allow', member: 'deny', viewer: 'deny' },
  get_benefits_summary: { owner: 'allow', admin: 'allow', member: 'deny', viewer: 'deny' },
  get_oversight_config: { owner: 'allow', admin: 'allow', member: 'allow', viewer: 'allow' },
  get_workforce_composition: { owner: 'allow', admin: 'allow', member: 'allow', viewer: 'allow' },
  get_execution_trends: { owner: 'allow', admin: 'allow', member: 'allow', viewer: 'allow' },
  get_connector_health: { owner: 'allow', admin: 'allow', member: 'allow', viewer: 'allow' },
};

const INSIGHTS_TOOLSET: DesignedToolset = {
  agentKind: 'insights',
  tools: new Set(Object.keys(INSIGHTS_MATRIX)),
  reliable: true,
  isRoleAllowed: (tool, role) => allowed(INSIGHTS_MATRIX[tool]?.[role as Role]),
  expectedOutputs: 'visualization_blocks',
};

/** Standard tool families always available to user-created agents (memory /
 *  ask_user / search / delegation), used as a floor when the full catalog
 *  can't be reconstructed. Connector + sandbox + vendor-MCP tools are agent-
 *  specific and NOT enumerable here. */
const USER_STANDARD_TOOLS = new Set([
  'memory_save',
  'memory_retrieve',
  'corpus_search',
  'ask_user',
  'web_search',
  'delegate_to_agent', // single-target synchronous delegation (mcp-server.ts:1561)
  'delegate_task', // parallel fan-out delegation variant (mcp-server.ts:1618) — also always available
  'schedule_followup',
  'code_session',
]);

/**
 * Load the designed toolset for a reconstructed run.
 *
 * For user-created agents, the per-run available catalog is reconstructed by
 * re-running createToolGatewayMcpServer from the compiled instruction. That
 * reconstruction requires a live ToolGatewayDispatcher (read-only context can't
 * always build one); when `reconstructedCatalog` is supplied by the caller it
 * is used, otherwise `tools` is null (out-of-set check skipped, gap logged).
 */
export function loadDesignedToolset(
  run: ReconstructedRun,
  reconstructedCatalog?: string[],
): DesignedToolset {
  switch (run.ref.agentKind) {
    case 'caio':
      return CAIO_TOOLSET;
    case 'hrbp':
      return HRBP_TOOLSET;
    case 'insights':
      return INSIGHTS_TOOLSET;
    case 'user-created': {
      // Prefer the runtime-captured designed toolset (trajectory.tools) — the
      // GROUND TRUTH recorded at execution time (the agent's actual available
      // catalog: connectors + standard + sandbox/coding + vendor + delegation).
      // This is also scope-correct: a nested code_session trajectory carries ITS
      // OWN allowed tools, so it is judged against its own set, not the parent
      // agent's. The (lossy) reconstruction is a FALLBACK, used only when the
      // trajectory captured no toolset (raw-table / synthetic runs). null =
      // unresolved → out-of-set check skipped with a logged coverage gap.
      const captured = capturedToolset(run);
      if (captured.size > 0) {
        // Runtime-captured toolset = the ground truth → reliable.
        return { agentKind: 'user-created', tools: new Set([...USER_STANDARD_TOOLS, ...captured]), reliable: true };
      }
      // Reconstructed-only (raw-table run, no captured trajectory) = LOSSY → not
      // reliable; out-of-set is downgraded to a coverage gap. null = unresolved.
      return {
        agentKind: 'user-created',
        tools: reconstructedCatalog ? new Set([...USER_STANDARD_TOOLS, ...reconstructedCatalog]) : null,
        reliable: false,
      };
    }
  }
}

/** Tool names captured in the trajectory's runtime `tools` array — the
 *  ground-truth available set the agent was actually given at execution time
 *  (written by the canonical builder from the agent's resolved tool catalog).
 *  Includes the bare suffix for genuinely MCP-prefixed names (`mcp__srv__t` →
 *  `t`) so membership matches regardless of how the executed call was recorded.
 *  Empty when the trajectory captured no toolset (raw-table fallback or the
 *  synthetic system-agent trajectories that carry `tools: []`) — that emptiness
 *  is the signal to fall back to reconstruction. */
export function capturedToolset(run: ReconstructedRun): Set<string> {
  const names = new Set<string>();
  for (const t of run.trajectory.tools ?? []) {
    if (!t?.name) continue;
    names.add(t.name);
    if (t.name.startsWith('mcp__')) names.add(t.name.slice(t.name.lastIndexOf('__') + 2));
  }
  return names;
}

export { USER_STANDARD_TOOLS, CAIO_TOOLSET, HRBP_TOOLSET, INSIGHTS_TOOLSET };

// ---------------------------------------------------------------------------
// Replicated system-agent tool INPUT SCHEMAS — the deterministic arg-validity
// baseline for CAIO + Insights. User-created runs carry their tool schemas on
// the trajectory (`trajectory.tools[].input_schema`); the two system-agent
// adapters emit `tools: []` (they reconstruct calls from audit logs, which
// carry the args but not the schemas), so the schemas are replicated here as
// constants — same "replicated catalog citing source of truth" pattern as the
// name catalogs above. A FAITHFUL replica including prose descriptions, so it
// matches the real tool contract the model is shown (and any future judge that
// reads schemas gets the same guidance for system agents as for user-created
// ones). Re-sync from the sources below when the tools change.
//
// Sources of truth:
//   CAIO     — liftoff-workforce-service/src/workforce-plans/tools/*.ts
//   Insights — liftoff-platform-backend/src/insights/tools/*.ts
//              (time_range/compare_to from insights/tools/tool-helpers.ts)
// ---------------------------------------------------------------------------

type JsonSchema = Record<string, unknown>;

/** insights/tools/tool-helpers.ts TIME_RANGE_SCHEMA. */
const TIME_RANGE_SCHEMA: JsonSchema = {
  type: 'object',
  description:
    'Required time range for the query. You MUST pass either a "preset" OR both "start" and "end" ISO date strings. Always ask the user for a time range if it is not clear from the question; do not guess.',
  properties: {
    preset: {
      type: 'string',
      description: 'A preset like "this_week", "last_30_days", "this_quarter".',
      enum: [
        'today', 'yesterday',
        'this_week', 'last_week',
        'this_month', 'last_month',
        'last_7_days', 'last_30_days', 'last_90_days',
        'this_quarter', 'last_quarter',
        'this_year', 'last_year',
      ],
    },
    start: { type: 'string', description: 'Start ISO timestamp (inclusive). Use with "end" for custom ranges.' },
    end: { type: 'string', description: 'End ISO timestamp (exclusive). Use with "start" for custom ranges.' },
  },
};
/** insights/tools/tool-helpers.ts COMPARE_TO_SCHEMA (same shape, optional). */
const COMPARE_TO_SCHEMA: JsonSchema = {
  ...TIME_RANGE_SCHEMA,
  description:
    'Optional comparison period for delta calculations. Same shape as time_range. Omit unless the user explicitly asks to compare two periods.',
};

/** The four range-based Insights tools share `{time_range, compare_to}`. */
const TIME_RANGE_TOOL_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { time_range: TIME_RANGE_SCHEMA, compare_to: COMPARE_TO_SCHEMA },
  required: ['time_range'],
};
const EMPTY_OBJECT_SCHEMA: JsonSchema = { type: 'object', properties: {} };

const INSIGHTS_TOOL_SCHEMAS: Record<string, JsonSchema> = {
  get_agent_performance: TIME_RANGE_TOOL_SCHEMA,
  get_cost_breakdown: TIME_RANGE_TOOL_SCHEMA,
  get_human_activity: TIME_RANGE_TOOL_SCHEMA,
  get_payroll_summary: TIME_RANGE_TOOL_SCHEMA,
  get_connector_health: TIME_RANGE_TOOL_SCHEMA,
  get_execution_trends: {
    type: 'object',
    properties: {
      time_range: TIME_RANGE_SCHEMA,
      compare_to: COMPARE_TO_SCHEMA,
      grouping: {
        type: 'string',
        description:
          'How to bucket the time series. Defaults to "hour" for ranges ≤48h, "day" for ranges ≤90d, "month" for longer. Override only when the user explicitly asks for a different granularity.',
        enum: ['hour', 'day', 'month'],
      },
    },
    required: ['time_range'],
  },
  get_benefits_summary: EMPTY_OBJECT_SCHEMA,
  get_oversight_config: EMPTY_OBJECT_SCHEMA,
  get_workforce_composition: EMPTY_OBJECT_SCHEMA,
};

const CAIO_TOOL_SCHEMAS: Record<string, JsonSchema> = {
  workforce_plan__draft: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short human-readable title for the plan (e.g. "Customer Ops team" or "Q2 AI workforce"). Max 500 chars.' },
      agents: {
        type: 'array',
        description: 'The full list of agent specifications (1-50 items). Each entry describes one agent to provision.',
        items: {
          type: 'object',
          properties: {
            specId: { type: 'string', description: 'Stable identifier for this spec across drafts. Use a short slug like "customer-success-01".' },
            name: { type: 'string', description: 'Human-readable agent name.' },
            agentType: { type: 'string', enum: ['agent', 'workflow'], description: 'agent=dynamic LLM loop (best for advisory or task work), workflow=predetermined step graph (best for cron-driven data movement).' },
            department: { type: 'string', description: 'Department this agent belongs to.' },
            roleSummary: { type: 'string', description: 'One to two sentence summary of the agent\'s role.' },
            responsibilities: { type: 'string', description: 'Detailed description of what the agent is responsible for.' },
            connectors: { type: 'array', items: { type: 'string' }, description: 'Connector type names this agent should use (e.g. ["google_calendar", "hubspot"]). Check connectors__list_available first.' },
          },
          required: ['specId', 'name', 'agentType', 'roleSummary'],
        },
      },
      orgChart: {
        type: 'object',
        description: 'Optional org chart showing how the agents relate. Nodes are the agents (plus humans they report to); edges define reporting lines.',
        properties: {
          nodes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                label: { type: 'string' },
                type: { type: 'string' },
                department: { type: 'string' },
              },
              required: ['id', 'label'],
            },
          },
          edges: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                from: { type: 'string' },
                to: { type: 'string' },
                label: { type: 'string' },
              },
              required: ['from', 'to'],
            },
          },
        },
        required: ['nodes', 'edges'],
      },
    },
    required: ['agents'],
  },
  workforce_plan__commit: EMPTY_OBJECT_SCHEMA,
  workforce_plan__approve: EMPTY_OBJECT_SCHEMA,
  org__get_existing_structure: {
    type: 'object',
    properties: { includeInactive: { type: 'boolean', description: 'Whether to include paused agents in the result. Default false.' } },
  },
  connectors__list_available: EMPTY_OBJECT_SCHEMA,
  agent_templates__list: {
    type: 'object',
    properties: {
      departmentCategory: {
        type: 'string',
        description: 'Filter by department. Omit to browse all departments.',
        enum: ['customer_support', 'sales', 'marketing', 'finance', 'hr', 'legal', 'operations', 'engineering', 'other'],
      },
      cursor: { type: 'string', description: 'Pagination cursor from a previous call\'s nextCursor. Only use when hasMore was true.' },
    },
  },
  agent_templates__get: {
    type: 'object',
    properties: { templateId: { type: 'string', description: 'The template id to fetch. Get available ids from agent_templates__list.' } },
    required: ['templateId'],
  },
  memory_save: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'The memory content to persist (max 4000 chars). A concise factual statement, not a transcript.' },
      layer: { type: 'string', enum: ['global', 'role'], description: 'global = tenant-wide, role = CAIO-scoped planning context.' },
      scopeKey: { type: 'string', description: 'Optional stable kebab-case key for this memory (e.g. "q2-2026" or "user-preference"). Defaults to "workforce-planning" when omitted. Must match /^[a-zA-Z0-9_-]+$/.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for filtering on retrieval (max 20 items).' },
    },
    required: ['content', 'layer'],
  },
  memory_retrieve: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Natural-language query describing what you want to recall (max 2000 chars).' },
      layers: { type: 'array', items: { type: 'string', enum: ['global', 'role'] }, description: 'Optional layers to search. Defaults to both global and role.' },
      topK: { type: 'number', description: 'Number of memories to return (1-20, default 8).' },
    },
    required: ['query'],
  },
};

// Source: liftoff-workforce-service/src/platform-agent/hrbp/tools/*.ts
const HRBP_TOOL_SCHEMAS: Record<string, JsonSchema> = {
  teambuilder__distill: {
    type: 'object',
    properties: {
      role: { type: 'string', description: 'Agent role/name from the spec.' },
      responsibilities: { type: 'string', description: 'Agent responsibilities from the spec.' },
      integrations: {
        type: 'array',
        description: 'Connected integration objects to bind to this agent.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            type: { type: 'string' },
            name: { type: 'string' },
          },
        },
      },
      additionalContext: { type: 'string', description: 'Optional template/context hint.' },
      sessionId: { type: 'string', description: 'Distill session id for cost attribution.' },
    },
    required: ['role', 'responsibilities'],
  },
  teambuilder__create: {
    type: 'object',
    properties: {
      role: { type: 'string' },
      responsibilities: { type: 'string' },
      agentType: { type: 'string', enum: ['agent', 'workflow'] },
      summary: { type: 'string' },
      systemPrompt: { type: 'string' },
      userInstructions: { type: 'string' },
      integrations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            integrationId: { type: 'string' },
            selectedObjects: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      pendingIntegrations: { type: 'array', items: { type: 'string' } },
      triggerConfig: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['cron', 'event', 'manual'] },
          cronExpr: { type: 'string' },
          eventTopic: { type: 'string' },
        },
      },
      distillSessionId: { type: 'string' },
    },
    required: ['role', 'systemPrompt'],
  },
  provisioning__record_event: {
    type: 'object',
    properties: {
      step: { type: 'string', enum: ['distill', 'create_agent', 'update_agent', 'attribute_session'] },
      status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'failed'] },
      internalAgentId: { type: 'string', description: 'UUID of the internal_agent row, when known.' },
      idempotencyKey: { type: 'string', description: 'Optional idempotency key carried with the upstream call.' },
      errorMessage: { type: 'string', description: 'Required when status="failed". Free text.' },
    },
    required: ['step', 'status'],
  },
  provisioning__update_spec_status: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['completed', 'failed', 'skipped'] },
      internalAgentId: { type: 'string', description: 'The agent UUID; required for "completed".' },
      errorMessage: { type: 'string', description: 'Why the spec failed (for status=failed).' },
    },
    required: ['status'],
  },
  provisioning__compensate: {
    type: 'object',
    properties: {
      internalAgentId: { type: 'string', description: 'The agent UUID to soft-delete.' },
      reason: { type: 'string', description: 'Why compensation is needed (audit trail).' },
    },
    required: ['internalAgentId', 'reason'],
  },
  provisioning__transition_to_blocker: {
    type: 'object',
    properties: {
      reason: { type: 'string', description: 'Short blocker reason (e.g. "name_collision").' },
      detail: { type: 'string', description: 'User-facing one-line explanation.' },
      options: { type: 'array', items: { type: 'string' }, description: 'Suggested actions for CAIO to present to the user.' },
    },
    required: ['reason', 'detail'],
  },
};

/**
 * Replicated designed INPUT SCHEMAS by tool name for the system agents.
 * Empty only for user-created: it carries its real schemas on the trajectory
 * (the arg-validity critic merges over these, trajectory-authoritative). CAIO,
 * Insights AND HRBP are replicated — HRBP's adapter now recovers the real tool
 * args from agent_audit_logs (falling back to inputs_reliable=false when it
 * can't, so validity nulls instead of scoring synthetic args).
 */
export function designedInputSchemas(agentKind: AgentKind): Map<string, JsonSchema> {
  switch (agentKind) {
    case 'caio':
      return new Map(Object.entries(CAIO_TOOL_SCHEMAS));
    case 'insights':
      return new Map(Object.entries(INSIGHTS_TOOL_SCHEMAS));
    case 'hrbp':
      return new Map(Object.entries(HRBP_TOOL_SCHEMAS));
    case 'user-created':
      return new Map();
  }
}
