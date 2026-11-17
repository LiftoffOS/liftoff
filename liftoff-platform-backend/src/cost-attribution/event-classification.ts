// Classifies a cost-attribution event as customer-chargeable vs Liftoff-absorbed
// platform overhead.
//
// The split exists because some platform LLM consumption is the user's
// workload (agent invocations, agent chat, sandbox runs) and other consumption
// is the platform doing internal work on the user's behalf (CAIO planning,
// HRBP analysis, distillation, /insights chat). The latter is a fixed cost
// of running Liftoff that's folded into the subscription margin — never a
// per-event customer charge.
//
// Wire-up: the boundary layer (ingestEventWithBuckets / spend-subscriber)
// calls classifyChargeability() once per source event. Platform-overhead
// events still get a cost_attribution_events row (so ops can track per-tenant
// platform spend) but with customer_cost_usd=0 and cost_bucket='platform_overhead',
// and they do NOT increment billing_controls.ous_consumed_this_period, do NOT
// drain reload_balance_usd, do NOT fire Stripe meter events.

// A third outcome, `byok_customer_funded`, exists for calls the customer's own
// provider key paid for. Doing nothing for those is not neutral — it is a
// double charge that lands the moment the first key is saved, because the
// customer has already paid Anthropic (or OpenAI, or Google, or xAI) directly
// for the same tokens. So the row is still written, with real token counts, and
// only one thing changes: customer_cost_usd goes to zero, no OUs are consumed,
// no reload balance drains, and no Stripe meter event fires.
//
// The bucket is decided by WHICH KEY ACTUALLY SERVED the request, not by
// whether the tenant has a key on file. A turn that falls back to a managed key
// mid-run is normal customer consumption and bills as it does today — Liftoff's
// key paid for it. That is why the gateway is the thing that reports it.
export type Chargeability = 'customer' | 'platform_overhead' | 'byok_customer_funded';

/**
 * Purpose tags on the ledger row for a dictated utterance, one per surface.
 *
 * Both are exported and enumerated in the sets below rather than left to the
 * agentId fallthrough, so that where dictation lands is a decision rather than a
 * consequence. They are declared here, above the sets, because a const used
 * before its declaration line is a load-time ReferenceError.
 *
 * `voice_dictation` — spoken into an agent's thread. The person's own workload,
 * charged to them against that agent.
 *
 * `voice_dictation_platform` — spoken into a platform surface such as the Chief
 * AI Officer planning chat, which has no internal agent. That surface's own
 * model calls are already absorbed (`caio_workforce_planning`, ...), so the
 * dictation feeding it is absorbed too rather than becoming the single charged
 * line on an otherwise free page.
 */
export const VOICE_DICTATION_PURPOSE = 'voice_dictation';
export const VOICE_DICTATION_PLATFORM_PURPOSE = 'voice_dictation_platform';

/**
 * The speaking half, split the same way and for the same reason.
 *
 * `voice_speech` — an agent speaking its reply in its own thread. Part of the
 * turn the person asked for, charged to them against that agent.
 *
 * `voice_speech_platform` — a platform surface reading something aloud. Absorbed,
 * matching the dictation side, so that turning voice on never converts a free
 * page into a charged one.
 */
export const VOICE_SPEECH_PURPOSE = 'voice_speech';
export const VOICE_SPEECH_PLATFORM_PURPOSE = 'voice_speech_platform';

// platform_llm purposes that are Liftoff facilitating agent creation,
// internal workforce planning, or platform-side dashboard tools. Adding a
// new platform-internal LLM call site? Add its `purpose` value here.
//
// We list these even when they typically run with `agent_id IS NULL` (the
// `agent_id === null` fallthrough below would catch them anyway) because
// listing them explicitly:
//   1. Makes the classifier resilient to a call site that someday tags an
//      agent_id (e.g. injection_guard always has an agent_id).
//   2. Documents the full set of platform-overhead purposes in one place.
const PLATFORM_OVERHEAD_PURPOSES = new Set<string>([
  // Agent creation pipeline (distillation refines agent instructions/role).
  'distill',
  'distill_update',
  'distill_semantic_validation',
  'distill_semantic_validation_update',
  // The distiller's patch rung: a medium-tier call that repairs the named
  // fields of a rejected graph instead of regenerating the artifact. Same
  // class as the distillation it belongs to. Load-bearing on a redistill,
  // which carries an agentId: without this entry the call falls through to
  // the defensive "charge it" branch below and the customer pays for the
  // platform repairing its own output.
  'distill_patch',
  // Agent capability discovery (HRBP analyzes what the agent can do).
  'capability_analysis',
  'manual_capability_analysis',
  // (The Chief AI Officer's own planning conversation used to sit here. It is
  // charged now — see PLATFORM_ASSISTANT_PURPOSES below.)
  //
  // HRBP provisioning stays absorbed: the CAIO plans the org, HRBP builds each
  // spec into a draft agent, and the customer is charged for the building of
  // neither. ADR-050's "building an agent is free" is unchanged by the
  // assistant charge — what changed is that TALKING to an assistant is running
  // something, because the assistants acquired browsers and data sources.
  //
  // This landed 'platform_overhead' before it was enumerated, but only via the
  // agent_id-null fallthrough below, because workforce-service tags its relay
  // calls with tenantId and purpose and no agentId. That was incidental, not
  // decided: the moment anything tagged an agent_id on this path it would have
  // dropped through to the defensive "charge it" branch instead. Naming it
  // here makes the absorption a stated policy, which matters now that the
  // internal LLM relay reads this same set to decide what it will serve to a
  // tenant with no subscription.
  'hrbp_provision_spec',
  VOICE_DICTATION_PLATFORM_PURPOSE,
  VOICE_SPEECH_PLATFORM_PURPOSE,
  // The /insights work that runs when a person merely OPENS the page: the
  // opening summary and the observations beside it. Absorbed deliberately and
  // this is the line — opening a page is never billable, asking a question is.
  // Charging these would bill someone for arriving, and would take a workspace
  // that has no plan yet off its own dashboard, since the relay's execution
  // gate is derived from this very set.
  //
  // Their conversational siblings ('insights_chat', 'liftoff_chat', …) are
  // charged; see PLATFORM_ASSISTANT_PURPOSES below.
  'insights_observation',
  'insights_intro',
  // Capability discovery's fit judge — one batched call per discovery query,
  // ranking building blocks for distillation and the platform assistants.
  // Platform work facilitating agent creation, same class as distillation.
  'capability_discovery_judge',
  // The blueprint analyzer that compiles an adopted external automation's
  // listing into our own procedure. Same class.
  'capability_blueprint_analyzer',
  // Platform middleware that runs on every agent turn — protects the platform,
  // not user workload. injection_guard ALWAYS has agent_id so this entry is
  // load-bearing (the agent_id-null fallthrough wouldn't catch it).
  'injection_guard',
  // Background services from the LLM client's purposeToGroup() background
  // bucket. These are platform-side, not per-user-interaction. The
  // chat-feedback-extraction case is documented separately in
  // CUSTOMER_INTERACTION_PURPOSES because that one IS user-facing
  // (per-agent-chat feedback) — kept there to make the precedence ordering
  // (interaction match wins) trivial to read.
  'rolling_summary',
  'title_generation',
  // Background batch embeddings run on the platform's schedule regardless of
  // whether a specific agent triggers a search — Liftoff absorbs these to
  // amortize across the corpus, while the query-time variants
  // ('knowledge_embedding_query', 'capability_embedding_query',
  // 'conversation_recall_query') stay customer-chargeable via the defensive
  // agent-attributed fallthrough. 'conversation_recall_query' is DELIBERATELY
  // not enumerated in either set — do not "fix" that: it carries agent_id and
  // must land 'customer' through the fallthrough, identical policy to the
  // other *_embedding_query purposes.
  'knowledge_embedding',
  'capability_embedding',
  'conversation_recall',
  // The Jev tool classifier (src/typesafe/, Phase 1). Onboarding work — what
  // today's unattributed classification rows should have been. The global
  // connector inventory writes these with no tenant at all.
  'tool_classification',
  // The distiller's bind rung (internal-agents/distill-bind.ts): the platform
  // repairing its own distillation output, beside distill_patch. Load-bearing
  // on a redistill, which carries an agentId.
  'distill_bind',
  // A routing request that picked nobody (Phase 9): `none`, a sub-threshold
  // answer, or a failed call. The platform's, not the workspace's. Also the
  // default purpose when the call fails.
  'route_message_none',
]);

/**
 * Runtime purposes that are customer usage WHETHER OR NOT an agent id is
 * present, checked before the agent-id rule below.
 *
 * A run's own work — its browser steps, its oversight checks, its memory — is
 * the workspace's usage because the workspace is the payer for what its
 * assistant or its teams do. A platform-assistant browser task has no agent id
 * at all, and a team run's id can miss the runtime→control-plane mapping
 * (resolveInternalAgentId never falls back); without this set every such row
 * would fall to the `agentId === null` arm and be absorbed as overhead. A miss
 * changes attribution (no agent breakdown), never chargeability.
 *
 * `browser_task` is the Stagehand loop's own model calls, recorded per request
 * at the model-call boundary; the rest are the runtime's TypeSafe set ids,
 * derived server-side by the usage record route from the set the runtime
 * names. None of these is in CUSTOMER_INTERACTION_PURPOSES, which requires an
 * agent id.
 */
/**
 * The three platform assistants' own model calls, which the workspace pays for.
 *
 * Liftoff, the Insights Manager and the Chief AI Officer used to be absorbed
 * outright. That was true to what they were — three surfaces that answered
 * questions about the product — and it stopped being true when they acquired
 * browsers, data sources, sandboxes and the ability to do a person's work.
 * Their TOOL calls were already charged (a browser session books
 * cost_bucket='included' and drains Operating Units); only the model half was
 * free, which made "use the assistants and never build a team" a way to run on
 * the platform indefinitely without a subscription.
 *
 * Two things follow from moving them here rather than merely deleting them
 * from PLATFORM_OVERHEAD_PURPOSES, and both are load-bearing:
 *
 *   1. They run with NO agent id — the assistants have no `internal_agents`
 *      row. Deleting them from the absorbed set alone would drop them through
 *      to the `agentId === null` arm below and absorb them exactly as before,
 *      silently. They have to be named ABOVE that rule, which is what this set
 *      and CUSTOMER_PURPOSES_WITHOUT_AGENT both are.
 *
 *   2. `isPlatformAbsorbedPurpose` is what the internal LLM relay skips its
 *      billing gate on (internal-api/llm-router.ts). Leaving this set out of
 *      that predicate is what turns the gate ON for these purposes: a
 *      workspace with no plan and no prepaid balance now meets a 402 on the
 *      Chief AI Officer instead of running for free. That coupling is
 *      deliberate and is why the policy is stated once, here.
 *
 * What is NOT here: the build funnel (distill*, capability_*,
 * hrbp_provision_spec) and the two /insights purposes that auto-run on page
 * load. Building an agent is still free, and opening a page is still free.
 */
export const PLATFORM_ASSISTANT_PURPOSES = new Set<string>([
  // Liftoff, the general assistant.
  'liftoff_chat',
  'liftoff_summarization',
  // The Insights Manager, when a person ASKS it something. Its page-load work
  // ('insights_intro', 'insights_observation') stays absorbed.
  'insights_chat',
  'insights_summarization',
  // The Chief AI Officer. Its planning conversation designs and changes AI
  // teams, and it browses and reads data sources to do it.
  'caio_workforce_planning',
  'caio_workforce_planning_summarization',
  'caio_workforce_planning_title_generation',

  // Reading a parked dataset on an assistant's behalf: `dataset_extract` runs
  // the model over the records so the assistant does not have to read them.
  //
  // These were absorbed while the chat turns above charged, which is the same
  // split this whole change exists to remove — the tool half of an assistant
  // free while its conversation half bills: `insights_dataset_extract` booked
  // platform_overhead even where `insights_chat` was already charging.
  //
  // It also contradicted what the product tells the model. `datasets/render.ts`
  // and `datasets/tools.ts` both describe dataset_extract as using "the model
  // and is metered like any answer" — so the copy promised metering the code
  // did not do. An AGENT's extraction (`agent_dataset_extract`) already
  // charges, because it carries an agent id; only the assistants' three were
  // free, and only because they carry none.
  'liftoff_dataset_extract',
  'insights_dataset_extract',
  'caio_dataset_extract',
]);

const CUSTOMER_PURPOSES_WITHOUT_AGENT = new Set<string>([
  'browser_task',
  'browser_step',
  'browser_goal_check',
  'pane_target',
  'work_done_check',
  'contract_check',
  'ask_check',
  'memory_save',
  'memory_used',
  'message_check',
  // The semantic screen over untrusted content a run fetched. It belongs with
  // the run's other own-work purposes and not in the overhead set above: the
  // content is the customer's work product arriving, and the screen is part of
  // what running that work costs.
  'untrusted_content',
]);

// platform_llm purposes that ARE user-driven interactions with their agent.
// These stay customer-chargeable even though source='platform_llm'.


const CUSTOMER_INTERACTION_PURPOSES = new Set<string>([
  'agent_chat',
  'agent_chat_summarization',
  'context_absorption',
  'thread_title_generation',
  'chat-feedback-extraction',
  // Someone speaking their message instead of typing it. As user-facing as the
  // typing it replaces.
  VOICE_DICTATION_PURPOSE,
  // The agent speaking its reply back. The other half of the same conversation.
  VOICE_SPEECH_PURPOSE,
  // Enumerated rather than left on the defensive fallthrough below.
  //
  // Both carry an agentId, so they already reach 'customer' — but only via the
  // "unknown purpose, charge it" branch, which is a default rather than a
  // decision. A future refactor could move that branch without anyone noticing
  // these two rode on it. Naming them here fixes the answer.
  //
  // They belong HERE and not in PLATFORM_OVERHEAD_PURPOSES: adding them there
  // would silently stop charging for them, which is a pricing change wearing a
  // tidy-up's clothes.
  'absorption_classification',
  'chat_learning_classification',
  // A routing request that chose a team (Phase 9). The chosen team's
  // internal_agents.id is set by `ask`'s finalize callback, so the row carries
  // an agent id by construction; a request that chose nobody is written under
  // route_message_none instead, in the overhead set.
  'route_message',
]);

/**
 * True when the platform absorbs this purpose's cost outright.
 *
 * Exported so the one place that decides whether a tenant is charged for a
 * purpose is also the place other code asks. The internal LLM relay
 * (internal-api/llm-router) uses it to skip its billing gate: refusing a call
 * that would be booked at customer_cost_usd=0 protects no revenue, it only
 * breaks the surface. Keeping that decision derived from this set means the
 * two cannot drift into a state where the relay charges for something the
 * ledger absorbs, or refuses something nobody pays for.
 *
 * A predicate rather than the Set itself so callers cannot mutate it.
 */
export function isPlatformAbsorbedPurpose(purpose: string | null | undefined): boolean {
  return purpose != null && PLATFORM_OVERHEAD_PURPOSES.has(purpose);
}

/**
 * Every purpose this file charges to a workspace by NAME, in one list.
 *
 * A charged purpose that carries an agent id reaches the per-agent Insights
 * breakdown, where it has to land in a bucket; one that lands nowhere is
 * charged, metered, and missing from the page the customer reads. Exported so
 * `src/insights/__tests__/purpose-coverage.test.ts` can hold the two files to
 * each other instead of trusting that whoever adds a purpose here remembers
 * the switch over there. A copy, not the sets, so a caller cannot mutate them.
 *
 * Underscored because the ratchet over unreachable exports is right about it:
 * its only caller is that test, and it is a view of this file rather than a
 * seam anything in production reads.
 */
export function _chargedPurposesByName(): string[] {
  return [
    ...CUSTOMER_PURPOSES_WITHOUT_AGENT,
    ...CUSTOMER_INTERACTION_PURPOSES,
    ...PLATFORM_ASSISTANT_PURPOSES,
  ];
}

export interface ClassificationInput {
  source: string;
  purpose: string | null;
  agentId: string | null;
  /**
   * True when the customer's OWN provider key served this request.
   *
   * Reported by the BYOK gateway, which is the only component that knows which
   * key actually went out on the wire — not by whether the tenant has a key on
   * file, and not by the resolver's answer, because a turn can resolve to BYOK
   * and still be served by the managed key after a mid-run fallback.
   *
   * It can only ever DOWNGRADE a 'customer' outcome to zero-rated. It cannot
   * make an absorbed call chargeable, and it cannot fire on an absorbed call at
   * all: the BYOK resolver's first test is this very function returning
   * 'customer', so a platform_overhead purpose never reaches a customer key.
   */
  byokFunded?: boolean;
}

/**
 * Who pays for this event.
 *
 * One function, three answers, and it stays the only place this is decided —
 * that is the property which keeps the relay, the gateway and the ledger from
 * drifting apart.
 */
export function classifyChargeability(opts: ClassificationInput): Chargeability {
  const base = classifyWhoseWorkload(opts);
  // The zero-rating rides on TOP of the base answer rather than replacing it,
  // so an absorbed call cannot be turned into a BYOK line by a mis-set flag,
  // and a BYOK line is always a call we would otherwise have charged for.
  if (base === 'customer' && opts.byokFunded === true) return 'byok_customer_funded';
  return base;
}

function classifyWhoseWorkload(opts: ClassificationInput): 'customer' | 'platform_overhead' {
  // gcp_billing_platform is the sentinel for unlabeled GCP infra cost; no
  // single tenant pays for it.
  if (opts.source === 'gcp_billing_platform') return 'platform_overhead';

  if (opts.source === 'platform_llm') {
    // A run's own work is the workspace's usage with or without an agent id.
    // Checked FIRST: the agent-id rule below would absorb every no-agent row.
    if (opts.purpose !== null && CUSTOMER_PURPOSES_WITHOUT_AGENT.has(opts.purpose)) {
      return 'customer';
    }
    // A platform assistant's own model calls. Checked here for the same reason
    // as the set above: the assistants carry no agent id, so the rule further
    // down would absorb every one of them.
    if (opts.purpose !== null && PLATFORM_ASSISTANT_PURPOSES.has(opts.purpose)) {
      return 'customer';
    }
    // Per-agent user interactions: customer-chargeable. These have agent_id
    // and a known interaction purpose.
    if (opts.agentId !== null
        && opts.purpose !== null
        && CUSTOMER_INTERACTION_PURPOSES.has(opts.purpose)) {
      return 'customer';
    }
    // Agent-creation / workforce-planning / known-platform purposes:
    // Liftoff-absorbed regardless of whether an agent_id was tagged.
    if (opts.purpose !== null && PLATFORM_OVERHEAD_PURPOSES.has(opts.purpose)) {
      return 'platform_overhead';
    }
    // Anything else from platform_llm (insights chat — no agent_id, no
    // purpose set on that path) is a platform tool, not user workload.
    if (opts.agentId === null) return 'platform_overhead';
    // Defensive fallthrough: an agent-attributed platform_llm event with an
    // unknown purpose is most likely a future user-facing interaction we
    // haven't enumerated yet. Charge it; if that's wrong we'll learn from
    // the support ticket faster than from a silent miss.
    return 'customer';
  }

  // An operator credit is charged to the customer as a NEGATIVE amount, so it
  // has to move their counter the way a charge does. Stated explicitly rather
  // than left to the fallthrough below: that fallthrough means "user workload",
  // and a credit is not workload, so a future narrowing of it would silently
  // stop crediting anyone.
  if (opts.source === 'operator_credit') return 'customer';

  // Everything else — tenant_runtime, governance, developer_proxy, sandbox,
  // gcp_billing (tenant-tagged), …  — is user workload by definition.
  return 'customer';
}
