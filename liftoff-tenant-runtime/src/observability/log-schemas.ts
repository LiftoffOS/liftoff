/**
 * R5 Fix 12 (TE-R4-009): Zod schemas for every structured log event.
 *
 * The scrubLogger validates fields against these schemas in non-production
 * builds. The custom ESLint rule `log-event-must-be-literal` enforces that
 * every log call uses a string-literal event name present as a key here.
 */
import { z } from 'zod';

const UuidSchema = z.string().uuid();
const SeveritySchema = z.enum(['INFO', 'WARN', 'ERROR', 'DEBUG']).optional();

const Base = {
  severity: SeveritySchema,
};

export const LogSchemas = {
  // One line per canary run over REAL recorded conversations. `healthy` is a
  // field rather than something a reader infers from findingCount, so an alert
  // can fire on it without parsing a log message.
  //
  // `halfConversations` is separate from the finding count on purpose: a record
  // with no user turn is a fault in the WRITER, and one occurrence means every
  // record written since is suspect, not just that one. A translation failure is
  // a bug in one mapper; this is a bug in what we stored.
  // What progressive disclosure costs, measured rather than assumed. The two
  // pass rates are reported side by side because neither is interpretable
  // alone: a disclosed rate is only meaningful against the inline rate on the
  // same tasks, and a low inline rate means the eval set is broken.
  skill_disclosure_eval: z.object({
    ...Base,
    event: z.literal('skill_disclosure_eval'),
    inlinePassRate: z.number(),
    disclosedPassRate: z.number(),
    readRate: z.number(),
    brokenTasks: z.number(),
    /** Tasks whose own skill retrieval never surfaced — excluded from both
     *  rates, because neither arm was asked the question. */
    skillNeverRetrieved: z.number(),
    failedWithoutReading: z.number(),
    failedAfterReading: z.number(),
    inlineTokens: z.number(),
    disclosedTokens: z.number(),
    message: z.string().optional(),
  }),
  skill_disclosure_eval_seeded: z.object({
    ...Base,
    event: z.literal('skill_disclosure_eval_seeded'),
    /** Rows the database reported written, not the number of statements sent. */
    skills: z.number(),
    tasks: z.number(),
    message: z.string().optional(),
  }),
  // Would each agent's stored workflow actually run? Answerable only in the
  // runtime, because UNRESOLVABLE_TOOL needs the catalog assembled per agent
  // from connector manifests, bindings, capability tier and vendor flags.
  workflow_steps_audit: z.object({
    ...Base,
    event: z.literal('workflow_steps_audit'),
    agentsWithSteps: z.number(),
    wouldRun: z.number(),
    wouldFail: z.number(),
    /** Agents whose tool names went unchecked. Separate from wouldRun so a
     *  degraded run cannot read as a passing one. */
    structuralOnly: z.number(),
    message: z.string().optional(),
  }),
  /** Emitted when EVERY verdict is structural-only: no tool name was checked
   *  for any agent, so wouldRun/wouldFail describe structure alone. Its own
   *  event because that outcome reads like good news — `wouldFail: 0` — and the
   *  only thing distinguishing it is a counter. */
  workflow_steps_audit_degraded: z.object({
    ...Base,
    event: z.literal('workflow_steps_audit_degraded'),
    agentsWithSteps: z.number(),
    message: z.string().optional(),
  }),
  workflow_steps_audit_finding: z.object({
    ...Base,
    event: z.literal('workflow_steps_audit_finding'),
    agentId: z.string(),
    codes: z.string(),
    stepCount: z.number(),
    toolCatalogChecked: z.boolean(),
    message: z.string().optional(),
  }),
  workflow_steps_audit_catalog_failed: z.object({
    ...Base,
    event: z.literal('workflow_steps_audit_catalog_failed'),
    agentId: z.string(),
    problem: z.string(),
    message: z.string().optional(),
  }),
  canonical_rebuild_canary: z.object({
    ...Base,
    event: z.literal('canonical_rebuild_canary'),
    sampled: z.number(),
    rebuildsAttempted: z.number(),
    findingCount: z.number(),
    halfConversations: z.number(),
    healthy: z.boolean(),
    message: z.string().optional(),
  }),
  // One line per finding, at ERROR so it is visible without the aggregate.
  // Deliberately carries no thread id or agent id: the canary reads real
  // customer conversations, and which conversation failed to rebuild is not
  // needed to act on a defect that is systemic by nature.
  canonical_rebuild_canary_finding: z.object({
    ...Base,
    event: z.literal('canonical_rebuild_canary_finding'),
    scope: z.enum(['chat', 'autonomous']),
    sourceEngine: z.string(),
    targetEngine: z.string().nullable(),
    problem: z.string(),
    message: z.string().optional(),
  }),
  // In-run context measurement, one sample per provider usage event.
  //
  // `contextWindowSource` travels with the number and is not optional: a ratio
  // against a provider-family FLOOR is a weaker claim than one against the
  // model's recorded window, and only the latter is allowed to end a run. A
  // reader that cannot tell them apart would draw a conclusion the data does not
  // support — the Anthropic floor is 200,000 while claude-opus-5[1m] holds
  // 1,000,000, so a healthy run reads as saturated against the floor.
  //
  // `managesOwnContext` records whether we could have ACTED on the reading.
  // Measurement is deliberately not gated on it; the nudge still is.
  context_pressure: z.object({
    ...Base,
    event: z.literal('context_pressure'),
    metric: z.string().optional(),
    tenantId: z.string().optional(),
    agentId: z.string().optional(),
    invocationId: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    turn: z.number().optional(),
    usedTokens: z.number().optional(),
    contextWindow: z.number().optional(),
    contextWindowSource: z.enum(['registry', 'provider_floor']).optional(),
    usedRatio: z.number().optional(),
    managesOwnContext: z.boolean().optional(),
    message: z.string().optional(),
    // The pre-invoke seed check emits under this event name too, with its own
    // char-based fields.
    level: z.string().optional(),
    historyChars: z.number().optional(),
    windowChars: z.number().optional(),
    messages: z.number().optional(),
  }),
  // One line per compaction that actually fired, on the engines whose history
  // the platform holds. `levelBefore` / `levelAfter` are the pair that says what
  // it bought: an `exceeded` run that comes back `pressure` or `ok` is one that
  // carried on instead of being escalated.
  //
  // These fields are the denominator for the flag's exit condition
  // (docs/agent-service-flags.md), which is why they are named here rather than
  // left to whatever the call site happened to pass.
  history_compacted: z.object({
    ...Base,
    event: z.literal('history_compacted'),
    tenantId: z.string().optional(),
    agentId: z.string().optional(),
    invocationId: z.string().optional(),
    provider: z.string().optional(),
    levelBefore: z.string(),
    levelAfter: z.string(),
    summarizedMessages: z.number(),
    /** Oldest turns that even the chunked fold could not reach. Named in the
     *  summary the model reads, and counted here, because a cap nobody is told
     *  about reads as complete coverage. Zero in every ordinary case. */
    droppedMessages: z.number(),
    /** Summarizer passes spent folding the older turns. One ordinarily; more
     *  means the head needed chunking, and each pass carries its own 10s
     *  ceiling, so this is also the added-latency figure. */
    summaryPasses: z.number(),
    beforeChars: z.number(),
    afterChars: z.number(),
    usedRatioAfter: z.number().optional(),
    message: z.string().optional(),
  }),
  // The other half of that denominator: a run that reached compaction and did
  // not get it. Without this, "compaction is rare" and "compaction is broken"
  // look identical, which is the failure the verify-on-stop gate spent a quarter
  // in.
  history_compaction_declined: z.object({
    ...Base,
    event: z.literal('history_compaction_declined'),
    tenantId: z.string().optional(),
    agentId: z.string().optional(),
    invocationId: z.string().optional(),
    candidateMessages: z.number(),
    /** `semantic_compression_disabled` is the one that means MISCONFIGURED:
     *  compaction is switched on and the summarizer it depends on is not, so it
     *  can never fire. The other two are properties of a particular run. */
    reason: z.enum(['semantic_compression_disabled', 'no_semantic_summary', 'nothing_to_compact']),
    message: z.string().optional(),
  }),
  // Agent id-space translation misses (INV-TR-010). A miss means a query or
  // write was about to use an id from the wrong space; previously this was
  // silent (zero rows, no error), which can hide a regression such as "No
  // learned context yet" for weeks. `fellBack: true` is the lenient read path
  // returning the input id; `false` is the strict write path refusing.
  agent_id_mapping_miss: z.object({
    ...Base,
    event: z.literal('agent_id_mapping_miss'),
    tenantId: UuidSchema,
    internalAgentId: z.string(),
    caller: z.string(),
    fellBack: z.boolean(),
  }),
  // Reverse direction: TR agents.id -> PB internal_agents.id found no mapping.
  agent_id_reverse_mapping_miss: z.object({
    ...Base,
    event: z.literal('agent_id_reverse_mapping_miss'),
    tenantId: UuidSchema,
    runtimeAgentId: z.string(),
    caller: z.string(),
  }),
  // The platform refused to register a file the team created in, or found in,
  // a connector — a non-2xx from POST /api/generated-files/register-connector-
  // native. The caller falls back to the link and no card, which is a failure
  // nobody is looking for, so the status and body are logged at error here.
  connector_native_registration_failed: z.object({
    ...Base,
    event: z.literal('connector_native_registration_failed'),
    status: z.number(),
    body: z.string(),
    tenantId: UuidSchema,
    threadId: z.string().optional(),
    outputType: z.string(),
    connectorId: z.string().optional(),
  }),
  // The platform refused an uploaded document — a non-2xx from POST
  // /api/generated-files — for a file the team generated itself. The upload
  // to the connector still goes ahead and the file gets no card, so this is
  // the only place the refusal shows.
  generated_file_registration_failed: z.object({
    ...Base,
    event: z.literal('generated_file_registration_failed'),
    status: z.number(),
    body: z.string(),
    tenantId: UuidSchema,
    threadId: z.string().optional(),
    outputType: z.string(),
  }),
  // Recall tool (plan v13 Change 4): registration skipped and why —
  // mapping miss / lookup failure must never abort catalog construction.
  recall_conversations_skipped: z.object({
    ...Base,
    event: z.literal('recall_conversations_skipped'),
    tenantId: UuidSchema,
    reason: z.string(),
  }),
  // Chat turn lifecycle
  chat_turn_open: z.object({
    ...Base,
    event: z.literal('chat_turn_open'),
    tenantId: UuidSchema,
    threadId: UuidSchema,
    agentId: UuidSchema,
    invocationId: UuidSchema,
    turnId: UuidSchema,
  }),
  chat_turn_close: z.object({
    ...Base,
    event: z.literal('chat_turn_close'),
    tenantId: UuidSchema,
    threadId: UuidSchema,
    agentId: UuidSchema,
    turnId: UuidSchema,
    durationMs: z.number(),
    toolCallsExecuted: z.number().optional(),
    sessionResumed: z.boolean().optional(),
  }),
  chat_turn_failed: z.object({
    ...Base,
    event: z.literal('chat_turn_failed'),
    tenantId: UuidSchema.optional(),
    threadId: UuidSchema.optional(),
    turnId: UuidSchema.optional(),
    error: z.string(),
    stage: z.string().optional(),
  }),

  // Security: path traversal + native tool invocation audit
  path_traversal_blocked: z.object({
    ...Base,
    event: z.literal('path_traversal_blocked'),
    tool: z.string(),
    reason: z.string(),
    input: z.unknown().optional(),
    turnId: UuidSchema.optional(),
  }),
  native_tool_invocation: z.object({
    ...Base,
    event: z.literal('native_tool_invocation'),
    tenantId: UuidSchema,
    threadId: UuidSchema,
    turnId: UuidSchema.optional(),
    tool: z.string(),
    args: z.string().max(2048).optional(),
  }),

  // Lock lifecycle
  lock_acquired: z.object({
    ...Base,
    event: z.literal('lock_acquired'),
    tenantId: UuidSchema,
    threadId: UuidSchema,
    invocationId: UuidSchema,
  }),
  lock_heartbeat_failed: z.object({
    ...Base,
    event: z.literal('lock_heartbeat_failed'),
    err: z.string(),
    consecutiveFailures: z.number(),
  }),
  lock_lost: z.object({
    ...Base,
    event: z.literal('lock_lost'),
    tenantId: UuidSchema,
    threadId: UuidSchema,
    invocationId: UuidSchema,
  }),
  lock_released: z.object({
    ...Base,
    event: z.literal('lock_released'),
    tenantId: UuidSchema,
    threadId: UuidSchema,
    invocationId: UuidSchema,
  }),
  lock_acquire_db_error: z.object({
    ...Base,
    event: z.literal('lock_acquire_db_error'),
    err: z.string(),
  }),
  chat_turn_locks_table_missing: z.object({
    ...Base,
    event: z.literal('chat_turn_locks_table_missing'),
  }),

  // Per-agent execution concurrency lock (agent-lock.ts)
  agent_execution_locks_table_missing: z.object({
    ...Base,
    event: z.literal('agent_execution_locks_table_missing'),
  }),
  agent_lock_acquired: z.object({
    ...Base,
    event: z.literal('agent_lock_acquired'),
    tenantId: z.string(),
    agentId: z.string(),
  }),
  // Live calibration signal for the tool-result budget. The 50,000 threshold was
  // calibrated once, against a 30-day query (n=6043: p50=350, p95=3268,
  // p99=33275, max=77530), and that query is not repeatable from anything the
  // system stores. This makes the distribution continuously observable, so the
  // next revision of the threshold reads a live denominator instead of a
  // one-off measurement that ages silently.
  tool_result_size_observed: z.object({
    ...Base,
    event: z.literal('tool_result_size_observed'),
    metric: z.literal('tool_result.chars'),
    chars: z.number(),
    budget: z.number(),
    exceeded: z.boolean(),
    /** Whether an oversized result was written somewhere the agent can still
     *  query it. Optional because the older emitter in mcp-bridge predates the
     *  field and does not know the answer — it bounds and does not park. An
     *  entry with `exceeded: true` and `parked: false` is the one that matters:
     *  the remainder is gone. */
    parked: z.boolean().optional(),
    /** Which tool produced it. Absent from the mcp-bridge emitter. */
    toolName: z.string().optional(),
    /** True for a DIRECT MCP result — a vendor-hosted server or a workspace's
     *  own custom MCP server, seen at the Claude Agent SDK's PostToolUse hook.
     *  Those dispatch over the SDK's transport and never reach the in-process
     *  gateway, so nothing parks or bounds them; this is the field that keeps
     *  their distribution separable from the gateway's, which is what the
     *  decision about whether to park them will be taken from. */
    direct: z.boolean().optional(),
    invocationId: z.string().optional(),
  }),
  // The AGGREGATE half of the same protection. A per-result cap cannot see the
  // shape that actually overflows a window: sixty results, each comfortably
  // under the cap, summing to hundreds of thousands of characters across one
  // turn -- enough
  // for a long research run to die on its wall clock. Emitted when a turn
  // crosses the budget and later results start
  // being bounded hard, so "this turn was truncated for volume, not for one big
  // result" is answerable from logs rather than inferred.
  tool_result_turn_budget_exceeded: z.object({
    ...Base,
    event: z.literal('tool_result_turn_budget_exceeded'),
    metric: z.literal('tool_result.turn_budget_exceeded'),
    /** Characters accumulated across this turn's tool results so far. */
    used: z.number(),
    budget: z.number(),
    invocationId: z.string(),
    /** The tool whose result crossed the line. Not the cause on its own -- the
     *  cause is the total -- but the place to start reading. */
    toolName: z.string(),
  }),
  // An oversized tool result kept as a queryable dataset of this job rather
  // than cut. The counterpart of `tool_result_size_observed`'s `parked: true`,
  // with what was kept: this is the line that says the remainder is still
  // reachable, and how much of it there is.
  /** The engine server exited while a run was still using it.
   *
   *  Its stdout, stderr and exit code were all discarded once startup finished,
   *  so a server that died mid-run left nothing behind and the only later
   *  signal was a request failing with `fetch failed` — indistinguishable from
   *  that request simply timing out. */
  opencode_server_exited: z.object({
    ...Base,
    event: z.literal('opencode_server_exited'),
    exitCode: z.number().nullable(),
    signal: z.string().nullable(),
    /** The tail of what the process said, bounded. Its last words are the
     *  whole point: a crash explains itself there or nowhere. */
    recentOutput: z.string(),
    msg: z.string(),
  }),

  /** The engine process raised an error after startup, rather than exiting. */
  opencode_server_error: z.object({
    ...Base,
    event: z.literal('opencode_server_error'),
    err: z.string(),
    recentOutput: z.string(),
    msg: z.string(),
  }),

  tool_result_parked: z.object({
    ...Base,
    event: z.literal('tool_result_parked'),
    metric: z.literal('tool_result.parked'),
    toolName: z.string(),
    invocationId: z.string().optional(),
    /** Datasets written for this one result: one per oversized text block. */
    datasets: z.number(),
    /** Records across them. */
    records: z.number(),
  }),
  // A park that could not happen, with the reason. NOT a failure of the tool
  // call — the result falls back to the spill, and then to the bound — but it
  // is the difference between an agent that can still read its result and one
  // that cannot, so the reason is recorded rather than swallowed.
  tool_result_park_failed: z.object({
    ...Base,
    event: z.literal('tool_result_park_failed'),
    metric: z.literal('tool_result.park_failed'),
    toolName: z.string(),
    invocationId: z.string().optional(),
    reason: z.string(),
  }),
  // The same signal for the value handed from one workflow step to the next.
  // Nothing persists a step output, so its distribution could not be queried at
  // all — the budget had to be derived from the tool-result distribution
  // upstream of it (see engine/prompt-budgets.ts). This is what makes the next
  // revision a measurement of the actual quantity.
  step_output_size_observed: z.object({
    ...Base,
    event: z.literal('step_output_size_observed'),
    metric: z.literal('step_output.chars'),
    chars: z.number(),
    budget: z.number(),
    exceeded: z.boolean(),
    /** Whether the oversized value was parked in the workspace. False means the
     *  agent had no filesystem, so the summary was all it got. */
    offloaded: z.boolean(),
  }),
  // The same signal for the section of a step prompt that carries EVERY earlier
  // step's output, not just the predecessor's. The predecessor's hand-off is
  // measured above; this section had no measurement at all while it was being
  // cut, which is why its budget (engine/prompt-budgets.ts,
  // EARLIER_OUTPUTS_BUDGET) is a first derivation and this is what turns the
  // next revision into a measurement.
  earlier_outputs_section_observed: z.object({
    ...Base,
    event: z.literal('earlier_outputs_section_observed'),
    stepId: z.string(),
    /** Earlier entries considered. */
    steps: z.number(),
    /** Rendered in full. */
    shown: z.number(),
    stubbed: z.number(),
    /** Counted only in the omission notice: stubs alone did not fit. */
    omitted: z.number(),
    /** Final section length, after enforcement. */
    chars: z.number(),
    ceiling: z.number(),
    /** Compressions/offloads this call actually ran. */
    prepared: z.number(),
    /** The resolved objective line, the other data path into the same prompt. */
    objectiveChars: z.number(),
    tenantId: z.string().optional(),
    agentId: z.string().optional(),
    invocationId: z.string().optional(),
  }),
  agent_lock_released: z.object({
    ...Base,
    event: z.literal('agent_lock_released'),
    tenantId: z.string(),
    agentId: z.string(),
  }),
  agent_lock_heartbeat_failed: z.object({
    ...Base,
    event: z.literal('agent_lock_heartbeat_failed'),
    err: z.string(),
  }),
  agent_lock_release_failed: z.object({
    ...Base,
    event: z.literal('agent_lock_release_failed'),
    err: z.string(),
  }),

  // Reaper
  reaper_sweep_complete: z.object({
    ...Base,
    event: z.literal('reaper_sweep_complete'),
    evicted: z.number(),
    skippedLive: z.number(),
    remaining: z.number(),
    durationMs: z.number(),
  }),
  reaper_tombstone_tx_failed: z.object({
    ...Base,
    event: z.literal('reaper_tombstone_tx_failed'),
    tenantId: UuidSchema,
    threadId: UuidSchema,
    err: z.string(),
  }),
  reaper_tombstone_release_failed: z.object({
    ...Base,
    event: z.literal('reaper_tombstone_release_failed'),
    tenantId: UuidSchema,
    threadId: UuidSchema,
    err: z.string(),
  }),
  reaper_rm_failed: z.object({
    ...Base,
    event: z.literal('reaper_rm_failed'),
    wsPath: z.string(),
    err: z.string(),
  }),

  // Startup + lifecycle
  startup_complete: z.object({
    ...Base,
    event: z.literal('startup_complete'),
    evicted: z.number().optional(),
    skippedLive: z.number().optional(),
    remaining: z.number().optional(),
  }),
  startup_reaper_complete: z.object({
    ...Base,
    event: z.literal('startup_reaper_complete'),
    evicted: z.number(),
    skippedLive: z.number(),
    remaining: z.number(),
    durationMs: z.number(),
  }),
  interval_reaper_failed: z.object({
    ...Base,
    event: z.literal('interval_reaper_failed'),
    err: z.string(),
  }),
  sigterm_received: z.object({
    ...Base,
    event: z.literal('sigterm_received'),
    inFlight: z.number(),
  }),
  sigterm_release_failed: z.object({
    ...Base,
    event: z.literal('sigterm_release_failed'),
    tenantId: UuidSchema.optional(),
    threadId: UuidSchema.optional(),
    err: z.string(),
  }),
  // One line a minute, whatever is happening — the record that survives a
  // memory kill, because it was written before it. `limit_mb` and `used_pct`
  // are nullable rather than absent when no container limit can be read: "no
  // limit known" is a different fact from "using none of it".
  runtime_memory: z.object({
    ...Base,
    event: z.literal('runtime_memory'),
    rss_mb: z.number(),
    heap_used_mb: z.number(),
    heap_total_mb: z.number(),
    external_mb: z.number(),
    limit_mb: z.number().nullable(),
    used_pct: z.number().nullable(),
    message: z.string().optional(),
  }),
  schema_check_ready: z.object({
    ...Base,
    event: z.literal('schema_check_ready'),
    attempts: z.number(),
  }),
  schema_check_timeout: z.object({
    ...Base,
    event: z.literal('schema_check_timeout'),
    attempts: z.number(),
  }),

  // Untrusted wrapper / secrets
  // One line per write that named an identifier the run had not read.
  //
  // In shadow mode this is the whole product: it is both the measurement that
  // decides whether enforce is defensible and the false-positive alarm that
  // can veto it. A legitimate pattern lighting this up is a pattern to declare
  // on the catalog, not a write to start refusing.
  provenance_would_block: z.object({
    ...Base,
    event: z.literal('provenance_would_block'),
    metric: z.literal('provenance.would_block'),
    connector: z.string(),
    actionType: z.string(),
    /** How the verdict was reached, so a spike can be read without re-deriving
     *  it: `declared_id_args` is a real finding, anything else is not judged. */
    basis: z.string(),
    unseenCount: z.number(),
    mode: z.string(),
    tenantId: z.string().optional(),
    agentId: z.string().optional(),
    message: z.string().optional(),
  }),
  // One line per tool whose traffic keeps returning id-bearing paths its
  // `returnsIds` does not name — the precision layer's backlog, learned from
  // real responses because a response shape is not in an input schema.
  //
  // PATHS, NEVER VALUES. The store behind this records the shape of a result
  // and nothing else, so this line carries no customer data.
  //
  // `declarable` splits the two answers: true means the paths go into the
  // registry row beside the tool, false means there is no row to put them on
  // (a vendor-hosted MCP tool, enumerated at runtime) and the heuristic floor
  // is the coverage that tool gets.
  provenance_shape_proposal: z.object({
    ...Base,
    event: z.literal('provenance_shape_proposal'),
    tool: z.string(),
    connectorType: z.string(),
    actionType: z.string(),
    undeclaredPaths: z.array(z.string()),
    /** Total observed-but-undeclared paths, which can exceed the listed ones. */
    undeclaredCount: z.number(),
    declarable: z.boolean(),
    message: z.string().optional(),
  }),
  untrusted_frame_escape_neutralized: z.object({
    ...Base,
    event: z.literal('untrusted_frame_escape_neutralized'),
    filepath: z.string(),
    count: z.number(),
    /** Replacements the sanitizer made in the payload: invisible and bidi
     *  characters, controls, speaker labels marked as quoted, and transcript
     *  tags. Separate from `count`, which is delimiter forgeries. */
    sanitized: z.number().optional(),
    /** Set when sanitizing ran out of passes while still changing the text, so
     *  the payload the model saw is not a fixpoint. Unreachable with today's
     *  patterns; present so a future one cannot fail silently. */
    sanitizeUnsettled: z.boolean().optional(),
    turnId: UuidSchema.optional(),
  }),
  awaiting_input_emitted: z.object({
    ...Base,
    event: z.literal('awaiting_input_emitted'),
    tenantId: UuidSchema,
    threadId: UuidSchema,
  }),
  awaiting_input_rate_limited: z.object({
    ...Base,
    event: z.literal('awaiting_input_rate_limited'),
    tenantId: UuidSchema,
    threadId: UuidSchema,
    window: z.enum(['hourly', 'daily']),
  }),

  // Workspace operations
  workspace_reset_detected: z.object({
    ...Base,
    event: z.literal('workspace_reset_detected'),
    tenantId: UuidSchema,
    threadId: UuidSchema,
  }),
  workspace_deleted: z.object({
    ...Base,
    event: z.literal('workspace_deleted'),
    tenantId: UuidSchema,
    threadId: UuidSchema,
  }),

  // Git mirror
  mirror_fetch_failed: z.object({
    ...Base,
    event: z.literal('mirror_fetch_failed'),
    owner: z.string(),
    repo: z.string(),
    err: z.string(),
  }),
  mirror_lock_lost: z.object({
    ...Base,
    event: z.literal('mirror_lock_lost'),
    tenantId: UuidSchema,
    owner: z.string(),
    repo: z.string(),
  }),
  mirror_init_failed: z.object({
    ...Base,
    event: z.literal('mirror_init_failed'),
    owner: z.string(),
    repo: z.string(),
    tenantId: UuidSchema,
    err: z.string(),
  }),
  escaping_symlink_removed: z.object({
    ...Base,
    event: z.literal('escaping_symlink_removed'),
    path: z.string(),
    target: z.string(),
  }),
  git_clone_executable_inventory: z.object({
    ...Base,
    event: z.literal('git_clone_executable_inventory'),
    tenantId: UuidSchema,
    threadId: UuidSchema,
    agentId: UuidSchema,
    repo: z.string(),
    executable_count: z.number(),
    build_files: z.array(z.unknown()),
  }),

  // SSE connection lifecycle
  chat_turn_sse_open: z.object({
    ...Base,
    event: z.literal('chat_turn_sse_open'),
    tenantId: UuidSchema,
    agentId: UuidSchema,
    threadId: UuidSchema,
  }),
  chat_turn_sse_close: z.object({
    ...Base,
    event: z.literal('chat_turn_sse_close'),
    tenantId: UuidSchema,
    agentId: UuidSchema,
    threadId: UuidSchema,
    durationMs: z.number(),
  }),
  chat_turn_sse_error: z.object({
    ...Base,
    event: z.literal('chat_turn_sse_error'),
    error: z.string(),
    durationMs: z.number(),
  }),
  unknown_sse_event_type: z.object({
    ...Base,
    event: z.literal('unknown_sse_event_type'),
    raw: z.unknown(),
  }),

  // SDK contract
  sdk_contract_test_failure: z.object({
    ...Base,
    event: z.literal('sdk_contract_test_failure'),
    reason: z.string(),
  }),

  // WS-1.3 — events added for the no-stubs-reliability plan.
  stub_fallback_fired: z.object({
    ...Base,
    event: z.literal('stub_fallback_fired'),
    tool_name: z.string(),
    dispatch_path: z.enum(['legacy_loop', 'mcp_server']),
  }),
  secret_load_failed: z.object({
    ...Base,
    event: z.literal('secret_load_failed'),
    secret_name: z.string(),
    required: z.boolean(),
    error: z.string().optional(),
  }),
  pool_saturation_503: z.object({
    ...Base,
    event: z.literal('pool_saturation_503'),
    endpoint: z.string(),
    pool_name: z.string().optional(),
  }),
  dlp_quarantine_recorded: z.object({
    ...Base,
    event: z.literal('dlp_quarantine_recorded'),
    detector: z.enum(['layer1_redactor', 'layer2_deep_scan']),
    tenant_id: UuidSchema,
    memory_id: UuidSchema,
    finding_kinds: z.array(z.string()),
  }),
  connector_binding_dispatchable: z.object({
    ...Base,
    event: z.literal('connector_binding_dispatchable'),
    tenant_id: UuidSchema,
    connector_instance_id: UuidSchema,
    connector_type: z.string(),
    ok: z.boolean(),
    category: z.string().optional(), // legacy pre-A.2 field
    probe_kind: z.string().nullable().optional(),
    error_code: z.string().nullable().optional(),
    latency_ms: z.number().optional(),
  }),
  // C.2 — per-tenant connector-tool smoke run summary. Emitted once per
  // hourly cron tick; gives ops visibility into how many bindings each
  // bucket covers and what the overall pass rate is.
  connector_tool_smoke_run: z.object({
    ...Base,
    event: z.literal('connector_tool_smoke_run'),
    bucket: z.number(),
    probed: z.number(),
    ok: z.number(),
    failed: z.number(),
    skipped_no_read_function: z.number(),
  }),
  canary_run_outcome: z.object({
    ...Base,
    event: z.literal('canary_run_outcome'),
    canary_tenant_id: UuidSchema,
    outcome: z.enum(['success', 'error', 'escalated']),
    failed_tools: z.array(z.string()).optional(),
  }),
  pool_connect_failed: z.object({
    ...Base,
    event: z.literal('pool_connect_failed'),
    service: z.string(),
    err: z.string(),
    captureStack: z.string().optional(),
  }),
  pool_connect_unexpected_resolve: z.object({
    ...Base,
    event: z.literal('pool_connect_unexpected_resolve'),
    service: z.string(),
    client: z.string(),
    captureStack: z.string().optional(),
  }),
  // One line per resume DECISION — a HITL approval picked back up, a wake
  // firing, a delegation fan-in, a clarification answered — carrying what the
  // resume restored and how it entered. This is
  // the evidence for a resumed run: read from the log of one run, not
  // inferred from traffic.
  resume_decision: z.object({
    ...Base,
    event: z.literal('resume_decision'),
    resume_kind: z.enum(['hitl_approval', 'self_wake', 'delegation', 'ask_user']),
    tenant_id: z.string(),
    agent_id: z.string(),
    invocation_id: z.string().nullable(),
    /** The approval (HITL) or the scheduled-invocation row (wake). */
    approval_id: z.string().nullable(),
    scheduled_invocation_id: z.string().nullable(),
    previous_trigger_key: z.string().nullable(),
    trigger_key: z.string().nullable(),
    /** `canonical`: the paused run restored; `legacy_fallback`: a payload that
     *  predates the fields, run as a fresh task. */
    resume_mode: z.enum(['canonical', 'legacy_fallback']),
    execution_engine: z.string().nullable(),
    provider: z.string().nullable(),
    model: z.string().nullable(),
    saved_resume_after_step_id: z.string().nullable(),
    restored_resume_after_step_id: z.string().nullable(),
    saved_step_count: z.number(),
    restored_step_count: z.number(),
    admission: z.enum(['allowed', 'denied', 'not_checked']),
    admission_reason: z.string().nullable(),
    /** How the resumed half runs. HITL: the persisted SDK session continued
     *  (`structured_session`) or the approved calls dispatched and the
     *  transcript replayed (`snapshot_replay`, `snapshot_replay_rejected` for
     *  a rejection). Wake: the chat-origin native session restored beside the
     *  canonical transcript (`native_session`) or the transcript alone
     *  (`canonical_replay`). Null when admission denied the resume. */
    strategy: z.enum(['structured_session', 'snapshot_replay', 'snapshot_replay_rejected', 'native_session', 'canonical_replay']).nullable(),
    /** Which transcript the resumed half replays, on the paths that replay
     *  one. `checkpoint`: the pause's own checkpoint (pause_checkpoints, keyed
     *  by the resumed row), loaded and verified, with its sha and message
     *  count beside it. `snapshot`: the payload's conversationHistory, with
     *  the reason the checkpoint was not used (`workflow step`, a pause that
     *  predates it, a failed write, an id / sha / invocation mismatch, a
     *  pending call the record does not hold). Null where no transcript is
     *  replayed: a structured session resume, a denied admission. */
    transcript_source: z.enum(['checkpoint', 'snapshot']).nullable().optional(),
    transcript_reason: z.string().nullable().optional(),
    checkpoint_sha256: z.string().nullable().optional(),
    checkpoint_message_count: z.number().nullable().optional(),
    message: z.string().optional(),
  }),
  // One line when a resumed half finishes the invocation it continued: what
  // the continuation added to the row, and how the run ended. The evidence
  // that the resumed half was finalized at all — it used to write nothing.
  resume_finalized: z.object({
    ...Base,
    event: z.literal('resume_finalized'),
    resume_kind: z.enum(['hitl_approval', 'delegation', 'ask_user', 'delay', 'continuation']),
    tenant_id: z.string(),
    agent_id: z.string(),
    invocation_id: z.string(),
    terminal_state: z.string(),
    outcome: z.string(),
    /** The continuation's own spend, published as its own cost event. */
    input_tokens: z.number(),
    output_tokens: z.number(),
    tool_calls: z.number(),
    duration_ms: z.number(),
    message: z.string().optional(),
  }),
  // One line per operator-approved call dispatched by the HITL resume: who owns
  // the tool per the catalog, which path ran it, and how it ended.
  approved_dispatch: z.object({
    ...Base,
    event: z.literal('approved_dispatch'),
    tenant_id: z.string(),
    agent_id: z.string(),
    invocation_id: z.string().nullable(),
    approval_id: z.string(),
    tool_call_id: z.string(),
    tool_name: z.string(),
    resolved_name: z.string().nullable(),
    ownership: z.enum(['standard', 'connector', 'gateway', 'vendor_mcp', 'teammate', 'unresolved']),
    dispatch_path: z.enum(['execute_tool_calls', 'bridge', 'none']),
    success: z.boolean(),
    error: z.string().nullable(),
    message: z.string().optional(),
  }),
} as const;

export type LogEventName = keyof typeof LogSchemas;

export function isKnownEvent(name: string): name is LogEventName {
  return name in LogSchemas;
}

export function assertLogFieldsValid(event: string, fields: Record<string, unknown>): void {
  if (!isKnownEvent(event)) {
    throw new Error(`Unknown log event: ${event}. Add schema to src/observability/log-schemas.ts.`);
  }
  LogSchemas[event].parse(fields);
}
