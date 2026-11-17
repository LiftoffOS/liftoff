// Report Service
// Generates VisualizationBlock[] from live data — no LLM call.
// Phase A of the hybrid loading strategy: data loads instantly.

import { resolveTimeRange, getComparisonPeriod } from './time-range';
import { log } from '../infrastructure/logging';
import { tenantRuntimeClient } from '../connectors/tenant-runtime-client';
import type { TimeRangeInput } from './shared-types';
import type { VisualizationBlock, MetricCardBlock, BarChartBlock, TrendChartBlock, TableBlock, TextBlock } from './shared-types';
import type { TimeGrouping, AuditLogAggregation, ExternalAgentStats, MemberActivity, AgentCostEntry } from './types';
import type { AgentLLMCost, AgentlessLLMCost, ClaudeCodeProxyCost } from './data-providers/llm-usage-provider';
import type { InternalAgentRow } from './data-providers/internal-agents-provider';
import type { WebToolCost } from './data-providers/web-tools-cost-provider';
import type { SandboxCost } from './data-providers/sandbox-cost-provider';
import type { DataSourceCost } from './data-providers/data-sources-cost-provider';
import type { AgentVoiceCost } from './data-providers/voice-cost-provider';
import * as providers from './data-providers';
import { getWebToolCosts } from './data-providers/web-tools-cost-provider';
import { getSandboxCosts } from './data-providers/sandbox-cost-provider';
import { getDataSourceCosts } from './data-providers/data-sources-cost-provider';
import { getAgentVoiceCosts } from './data-providers/voice-cost-provider';
import { getAssistantActivity } from './data-providers/assistant-activity-provider';
import type { AssistantActivity } from './data-providers/assistant-activity-provider';
import { assistantForPurpose, ASSISTANT_LABELS, UNATTRIBUTED_LABEL, type AssistantKey } from './platform-assistants';
import { getInsightsCounts } from './counts-service';

/**
 * Empty-state text shown when a tenant has no agents, no invocations, and no
 * audit log entries — i.e. a brand-new workspace. Exported so the /counts
 * router can return the same copy without duplicating the string.
 */
export const EMPTY_INSIGHTS_TEXT =
  'No insights yet. Once your agents start working, you will see the performance metrics for your whole workspace here.';

// ── Workforce total helpers ─────────────────────────────────────────────
// Both totals are computed twice (current + comparison) so the metric card
// trends are honest. The cost computation also feeds the Cost Breakdown
// table so the card and the table reconcile by construction.

interface AgentLLMBuckets {
  creation: number;
  updates: number;
  discovery: number;
  discoveryUpdates: number;
  /** User interactions with this agent: agent_chat turns, rolling
   *  summaries on those threads, observer context absorption, and
   *  AI-generated thread titles for agent-chat threads. Visible as the
   *  per-agent "Interactions" line on /insights. */
  interactions: number;
  /** The model calls the WORK makes that the tenant runtime does not record as
   *  the invocation itself: a run's browser steps, the oversight and memory
   *  checks around them, and the retrieval queries the work runs. They reach
   *  this map rather than `getAgentCosts` because they are reported through
   *  the platform's usage route, so they carry `source='platform_llm'` — but
   *  they are the cost of running the agent, not of talking to it. Shown on
   *  the per-agent "Invocations" line beside the runtime's own figure, which
   *  is where a reader looks for what a run cost. */
  runWork: number;
  /** Charged work whose purpose no case names yet.
   *
   *  An unmapped purpose must not be added to NOTHING: logging an error and
   *  dropping the money is the defect this whole area exists to remove. A
   *  purpose can be unmapped because it is new, or because its emitter was
   *  removed while its rows were kept.
   *
   *  A log is the wrong enforcement for money. It fires once, in production,
   *  while somebody is already reading an understated number — and only if a
   *  report happens to cover the window those rows fall in, so it can go unseen
   *  for months. Counting it is what makes the total true; the log stays, as
   *  the signal to give it a real category. */
  other: number;
}
type AgentLLMMap = Record<string, AgentLLMBuckets>;

/** Every bucket at zero. One literal, so a bucket added to the type cannot be
 *  forgotten in the half-dozen places a missing agent used to be spelled out. */
const EMPTY_BUCKETS: Readonly<AgentLLMBuckets> = Object.freeze({
  creation: 0, updates: 0, discovery: 0, discoveryUpdates: 0, interactions: 0, runWork: 0, other: 0,
});

export function buildAgentLLMMap(agentLLMCosts: AgentLLMCost[]): { usd: AgentLLMMap; ous: AgentLLMMap } {
  const usd: AgentLLMMap = {};
  const ous: AgentLLMMap = {};
  function ensure(map: AgentLLMMap, agentId: string): AgentLLMBuckets {
    if (!map[agentId]) {
      map[agentId] = { creation: 0, updates: 0, discovery: 0, discoveryUpdates: 0, interactions: 0, runWork: 0, other: 0 };
    }
    return map[agentId];
  }
  for (const entry of agentLLMCosts) {
    const u = ensure(usd, entry.agentId);
    const o = ensure(ous, entry.agentId);
    const dollars = entry.estimatedCostUsd;
    const ouCount = entry.ouConsumed;
    switch (entry.purpose) {
      case 'distill':
      case 'distill_semantic_validation':
        u.creation += dollars;
        o.creation += ouCount;
        break;
      case 'distill_update':
      case 'distill_semantic_validation_update':
        u.updates += dollars;
        o.updates += ouCount;
        break;
      case 'capability_analysis':
      case 'manual_capability_analysis':
        u.discovery += dollars;
        o.discovery += ouCount;
        break;
      // Changing what an agent knows: the embedding pass that decides
      // whether a new skill duplicates one it already has, the reading of what
      // an imported artifact IS on the way in, and the trailing call that
      // renders the team's workflow diagram
      // (internal-agents/workflow-visualization-steps-service.ts). The same
      // family as a distill update, and "Updates" is the line a reader looks
      // at for what changing an agent cost.
      //
      // The diagram call runs after a creation OR an update and its purpose
      // does not say which, so Updates is a choice rather than a reading —
      // beside a distill on a first creation it is a rounding error either
      // way, and it was reaching no bucket at all until now.
      case 'skill_dedup':
      case 'absorption_classification':
      case 'workflow_visualization_steps_generation':
        u.updates += dollars;
        o.updates += ouCount;
        break;
      // One chat exchange, all of it: the turn, its summary and title, what the
      // turn taught the agent, the routine the thread suggests and the reading
      // of the person's answer to it, the recall query that finds the thread's
      // own history, and an inbound message arriving through the routing rung.
      // (A routing request that chose nobody is `route_message_none`, which the
      // platform absorbs and this query never sees.)
      case 'agent_chat':
      case 'agent_chat_summarization':
      case 'context_absorption':
      case 'thread_title_generation':
      case 'chat-feedback-extraction':
      case 'suggestion_generation':
      case 'suggestion_response_classification':
      case 'chat_learning_classification':
      case 'conversation_recall_query':
      case 'route_message':
        u.interactions += dollars;
        o.interactions += ouCount;
        break;
      // What the work itself costs, reported through the platform's usage
      // route: a run's browser steps, the oversight and memory checks around
      // them, the semantic screen over the content it fetched, and the
      // retrieval queries the work runs. The batch embeddings that build those
      // indexes are platform overhead and never reach here.
      // See AgentLLMBuckets.runWork.
      case 'browser_step':
      case 'browser_goal_check':
      case 'pane_target':
      case 'work_done_check':
      case 'browser_task':
      case 'contract_check':
      case 'ask_check':
      case 'message_check':
      case 'memory_save':
      case 'memory_used':
      case 'untrusted_content':
      case 'run_now_intent':
      case 'file_check':
      case 'knowledge_embedding_query':
      case 'capability_embedding_query':
        u.runWork += dollars;
        o.runWork += ouCount;
        break;
      default:
        // Counted FIRST, then reported. The order is the point: the money is on
        // the page whether or not anyone reads the log, and the log is what
        // gets the purpose a real category later.
        u.other += dollars;
        o.other += ouCount;
        log.error(
          { agentId: entry.agentId, purpose: entry.purpose, costUsd: entry.estimatedCostUsd, ouConsumed: entry.ouConsumed },
          'Unknown LLM purpose in buildAgentLLMMap — counted as Other; add a case to give it a real bucket',
        );
    }
  }
  return { usd, ous };
}

// ── The cost model ──────────────────────────────────────────────────────
//
// One structure that both the Total Cost card and the Cost Breakdown table are
// derived FROM, rather than two sums computed in parallel and asserted to agree
// in a comment.
//
// They did not agree. `computeTotalCost` took ten positional parameters and the
// table was built separately from the same inputs, so every new cost source had
// to be added to both by hand — and twice it was not. Web-tool spend was added
// to the card while the table pooled it into one anonymous group; `runWork`
// (4f857030) was added to the card's money and the table's Operating Units and
// to neither the card's Operating Units nor anything else. Agentless platform
// spend was added to the card with no table row at all, under a comment
// asserting it would always be zero, which stopped being true the day the
// platform assistants got a browser.
//
// Deriving both from one model makes "the card equals the table" a property of
// the code instead of a claim about it, and `report-service.reconciliation`
// tests it.

/** One sub-row: what a named slice of an agent's cost was. */
interface CostLine {
  label: string;
  usd: number;
  /** null renders as an em dash — the source genuinely meters no Operating
   *  Units, as against metering zero of them. */
  ous: number | null;
}

/** One collapsible group: an agent, a person, a platform assistant. */
export interface CostGroupModel {
  label: string;
  usd: number;
  ous: number | null;
  lines: CostLine[];
  workforceType?: 'human' | 'ai';
  /** What this group IS. The table ignores it; every other reader groups by it
   *  rather than by matching the display label, so renaming a label cannot
   *  silently change what a category totals. */
  kind: 'ai_team' | 'external_collaborator' | 'person' | 'assistant' | 'developer_proxy' | 'unattributed';
  /** Set on an `ai_team` / `external_collaborator` group. */
  agentId?: string;
  /** Set on an `assistant` group. */
  assistant?: AssistantKey;
}

/** One named sub-row's total across every group, for readers that want a
 *  category rather than a spender. */
export function sumLineAcrossModel(model: CostGroupModel[], label: string): { usd: number; ous: number } {
  let usd = 0;
  let ous = 0;
  for (const group of model) {
    for (const line of group.lines) {
      if (line.label !== label) continue;
      usd += line.usd;
      ous += line.ous ?? 0;
    }
  }
  return { usd, ous };
}

/**
 * Money, to the cent — except an amount that is real but rounds away.
 *
 * A line that consumed Operating Units and cost a fraction of a cent renders
 * "$0.00", which reads as "this was free" when it means "this was small". That
 * is the same sentence the 132 empty rows were saying before they were dropped,
 * and a reader who has just been told to trust this table cannot tell the two
 * apart. So a non-zero amount below a cent says so rather than rounding to
 * nothing. Operator credits are negative and keep their sign.
 */
export function formatCostUsd(n: number): string {
  if (n !== 0 && Math.abs(n) < 0.005) return n > 0 ? '<$0.01' : '>-$0.01';
  // The sign goes outside the currency symbol. Interpolating a negative number
  // after the "$" produced "$-2.50", which is what an operator credit rendered
  // as — and `reload` rows really are negative in this ledger.
  const magnitude = Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? '-' : ''}$${magnitude}`;
}

export function sumModelUsd(model: CostGroupModel[]): number {
  return model.reduce((total, g) => total + g.usd, 0);
}

export function sumModelOus(model: CostGroupModel[]): number {
  return model.reduce((total, g) => total + (g.ous ?? 0), 0);
}

/** Per-spender tool spend, keyed the way `spenderKey` keys it. */
type ToolIndex = Record<string, { usd: number; ous: number; detail: Map<string, { usd: number; ous: number }> }>;

/** Marks spend that is the workspace's but belongs to no team and no
 *  recognisable surface. A key rather than a silent drop. */
const UNATTRIBUTED_KEY = '::unattributed';

const assistantSpenderKey = (key: AssistantKey) => `::assistant:${key}`;

/**
 * Who spent it.
 *
 * An agent id that resolves to a team in this workspace — live OR removed —
 * is that team's. Anything else is read off `purpose`, which is the only thing
 * that separates the three platform assistants. What resolves to neither is
 * reported as unattributed rather than dropped: an id the runtime never mapped
 * is still the workspace's money, and dropping it is how a total comes to
 * disagree with its own parts.
 */
function spenderKey(
  agentId: string | null,
  surface: string | null,
  knownAgentIds: ReadonlySet<string>,
): string {
  if (agentId != null && knownAgentIds.has(agentId)) return agentId;
  if (agentId == null) {
    const assistant = assistantForPurpose(surface);
    if (assistant) return assistantSpenderKey(assistant);
  }
  return UNATTRIBUTED_KEY;
}

function indexToolSpend(
  rows: Array<{ agentId: string | null; surface?: string | null; usd: number; ous: number; detail: string }>,
  knownAgentIds: ReadonlySet<string>,
): ToolIndex {
  const index: ToolIndex = {};
  for (const row of rows) {
    const key = spenderKey(row.agentId, row.surface ?? null, knownAgentIds);
    const entry = index[key] ??= { usd: 0, ous: 0, detail: new Map() };
    entry.usd += row.usd;
    entry.ous += row.ous;
    const line = entry.detail.get(row.detail) ?? { usd: 0, ous: 0 };
    line.usd += row.usd;
    line.ous += row.ous;
    entry.detail.set(row.detail, line);
  }
  return index;
}

const toolAt = (index: ToolIndex, key: string) => index[key] ?? { usd: 0, ous: 0, detail: new Map() };

export interface CostModelInput {
  agents: InternalAgentRow[];
  externalAgentStats: ExternalAgentStats[];
  agentInvocationCosts: Record<string, AgentCostEntry>;
  agentLLMMap: AgentLLMMap;
  agentLLMMapOus: AgentLLMMap;
  agentlessLLMCosts: AgentlessLLMCost[];
  claudeCodeProxyCosts: ClaudeCodeProxyCost[];
  webToolCosts: WebToolCost[];
  sandboxCosts: SandboxCost[];
  dataSourceCosts: DataSourceCost[];
  voiceCosts: AgentVoiceCost[];
}

/**
 * Every charged dollar in the window, on the line of whoever spent it.
 */
export function buildCostModel(input: CostModelInput): CostGroupModel[] {
  const knownAgentIds = new Set(input.agents.map(a => a.id));
  for (const ea of input.externalAgentStats) knownAgentIds.add(ea.agentId);

  const web = indexToolSpend(input.webToolCosts.map(w => ({
    agentId: w.agentId, surface: w.surface, usd: w.totalCostUsd, ous: w.ouConsumed, detail: w.toolName,
  })), knownAgentIds);
  const sandbox = indexToolSpend(input.sandboxCosts.map(s => ({
    agentId: s.agentId, usd: s.totalCostUsd, ous: s.ouConsumed, detail: 'Sandbox',
  })), knownAgentIds);
  const dataSources = indexToolSpend(input.dataSourceCosts.map(d => ({
    agentId: d.agentId, surface: d.surface, usd: d.totalCostUsd, ous: d.ouConsumed, detail: d.connector,
  })), knownAgentIds);
  const voice = indexToolSpend(input.voiceCosts.map(v => ({
    agentId: v.agentId, usd: v.totalCostUsd, ous: v.ouConsumed, detail: 'Voice',
  })), knownAgentIds);

  const groups: CostGroupModel[] = [];

  /** The three tool lines every spender can carry. Shared so an agent, a
   *  platform assistant and the unattributed group cannot describe the same
   *  spend differently. */
  const toolLines = (key: string): CostLine[] => [
    { label: 'Web & browser', usd: toolAt(web, key).usd,         ous: toolAt(web, key).ous },
    { label: 'Data Sources',  usd: toolAt(dataSources, key).usd, ous: toolAt(dataSources, key).ous },
    { label: 'Sandbox',       usd: toolAt(sandbox, key).usd,     ous: toolAt(sandbox, key).ous },
  ];
  const toolTotals = (key: string) => ({
    usd: toolAt(web, key).usd + toolAt(dataSources, key).usd + toolAt(sandbox, key).usd,
    ous: toolAt(web, key).ous + toolAt(dataSources, key).ous + toolAt(sandbox, key).ous,
  });

  // ── Internal agents ────────────────────────────────────────────────
  // Removed teams included: money already spent does not stop having been
  // spent because the team that spent it was deleted afterwards.
  for (const agent of input.agents) {
    const invCostUsd = input.agentInvocationCosts[agent.id]?.totalCostUsd ?? 0;
    const invOus     = input.agentInvocationCosts[agent.id]?.ouConsumed   ?? 0;
    const llm        = input.agentLLMMap[agent.id]    ?? EMPTY_BUCKETS;
    const llmOus     = input.agentLLMMapOus[agent.id] ?? EMPTY_BUCKETS;
    // What running this agent cost: the runtime's own invocation figure plus
    // the run's model calls the runtime reports through the platform's usage
    // route (AgentLLMBuckets.runWork). One line, because to a reader they are
    // one thing — the cost of the work, as against creating, updating or
    // talking to the agent.
    const runUsd = invCostUsd + llm.runWork;
    const runOus = invOus     + llmOus.runWork;
    const tools  = toolTotals(agent.id);
    const voiceSpend = toolAt(voice, agent.id);

    const lines: CostLine[] = [
      { label: 'Creation',     usd: llm.creation,     ous: llmOus.creation },
      { label: 'Updates',      usd: llm.updates,      ous: llmOus.updates },
      { label: 'Interactions', usd: llm.interactions, ous: llmOus.interactions },
      { label: 'Voice',        usd: voiceSpend.usd,   ous: voiceSpend.ous },
      { label: 'Invocations',  usd: runUsd,           ous: runOus },
      ...toolLines(agent.id),
      // Last, because it is a cleanup queue rather than a category: what a
      // reader sees here is spend nobody has classified yet, not a kind of
      // work. Empty for every agent whose purposes are all mapped, and the
      // empty-line filter then drops it.
      { label: 'Other', usd: llm.other, ous: llmOus.other },
    ];
    groups.push({
      label: agent.deletedAt ? `${agent.name} (removed)` : agent.name,
      usd:  runUsd + llm.creation + llm.updates + llm.interactions + llm.other + voiceSpend.usd + tools.usd,
      ous:  runOus + llmOus.creation + llmOus.updates + llmOus.interactions + llmOus.other + voiceSpend.ous + tools.ous,
      lines,
      workforceType: 'ai',
      kind: 'ai_team',
      agentId: agent.id,
    });
  }

  // ── External agents ───────────────────────────────────────────
  for (const ea of input.externalAgentStats) {
    const llm    = input.agentLLMMap[ea.agentId]    ?? EMPTY_BUCKETS;
    const llmOus = input.agentLLMMapOus[ea.agentId] ?? EMPTY_BUCKETS;
    const tools  = toolTotals(ea.agentId);
    groups.push({
      label: ea.agentName,
      usd: ea.computedCostUsd + llm.discovery + llm.discoveryUpdates + tools.usd,
      ous: llmOus.discovery + llmOus.discoveryUpdates + tools.ous,
      lines: [
        { label: 'Creation',    usd: llm.discovery,        ous: llmOus.discovery },
        { label: 'Updates',     usd: llm.discoveryUpdates, ous: llmOus.discoveryUpdates },
        { label: 'Invocations', usd: ea.computedCostUsd,   ous: null },
        ...toolLines(ea.agentId),
      ],
      workforceType: 'ai',
      kind: 'external_collaborator',
      agentId: ea.agentId,
    });
  }

  // ── The three platform assistants ────────────────────────────────────
  //
  // They have no internal_agents row, so they were invisible here while being
  // charged: their browser sessions book cost_bucket='included' and drain
  // Operating Units, and all three pooled into one unnamed "Web Tools" line.
  // Their model calls now do the same wherever the platform does not absorb
  // the purpose. `purpose` is what tells them apart, on both halves of the
  // ledger.
  const assistantLLM = new Map<AssistantKey, { usd: number; ous: number }>();
  let unattributedLLM = { usd: 0, ous: 0 };
  for (const row of input.agentlessLLMCosts) {
    const assistant = assistantForPurpose(row.purpose);
    if (!assistant) {
      unattributedLLM = {
        usd: unattributedLLM.usd + row.estimatedCostUsd,
        ous: unattributedLLM.ous + row.ouConsumed,
      };
      continue;
    }
    const acc = assistantLLM.get(assistant) ?? { usd: 0, ous: 0 };
    assistantLLM.set(assistant, { usd: acc.usd + row.estimatedCostUsd, ous: acc.ous + row.ouConsumed });
  }

  for (const key of Object.keys(ASSISTANT_LABELS) as AssistantKey[]) {
    const spender = assistantSpenderKey(key);
    const llm     = assistantLLM.get(key) ?? { usd: 0, ous: 0 };
    const tools   = toolTotals(spender);
    const usd = llm.usd + tools.usd;
    const ous = llm.ous + tools.ous;
    groups.push({
      label: ASSISTANT_LABELS[key],
      usd,
      ous,
      lines: [
        { label: 'Interactions', usd: llm.usd, ous: llm.ous },
        ...toolLines(spender),
      ],
      workforceType: 'ai',
      kind: 'assistant',
      assistant: key,
    });
  }

  // ── Claude Code / Codex proxy — one row per member ───────────────────
  for (const proxy of input.claudeCodeProxyCosts) {
    if (proxy.estimatedCostUsd <= 0 && proxy.requestCount <= 0) continue;
    groups.push({
      label: `Claude Code (${proxy.displayName})`,
      usd: proxy.estimatedCostUsd,
      ous: null,
      lines: [],
      kind: 'developer_proxy',
    });
  }

  // ── Whatever is left ─────────────────────────────────────────────────
  // Charged to the workspace, with no team and no surface to name. Shown so
  // the parts still add up to the total; silence here is what a missing
  // attribution used to look like.
  const leftoverTools = toolTotals(UNATTRIBUTED_KEY);
  const leftoverUsd = leftoverTools.usd + unattributedLLM.usd + toolAt(voice, UNATTRIBUTED_KEY).usd;
  const leftoverOus = leftoverTools.ous + unattributedLLM.ous + toolAt(voice, UNATTRIBUTED_KEY).ous;
  if (leftoverUsd !== 0 || leftoverOus !== 0) {
    groups.push({
      label: UNATTRIBUTED_LABEL,
      usd: leftoverUsd,
      ous: leftoverOus,
      lines: [
        { label: 'Interactions', usd: unattributedLLM.usd, ous: unattributedLLM.ous },
        { label: 'Voice',        usd: toolAt(voice, UNATTRIBUTED_KEY).usd, ous: toolAt(voice, UNATTRIBUTED_KEY).ous },
        ...toolLines(UNATTRIBUTED_KEY),
      ],
      kind: 'unattributed',
    });
  }

  // A group that spent nothing in this window is not rendered.
  //
  // The Cost Breakdown answers one question — where the money went — and a row
  // of zeroes is not an answer to it. This was already true for the platform
  // assistants (an absorbed surface costs the workspace nothing) and it is the
  // same rule for everyone; keeping it in one place is what stopped it being
  // three slightly different rules.
  //
  // It matters most because removed agents render. Including them is right —
  // a team deleted mid-period still spent money and dropping it understates
  // the page — but it means EVERY team the workspace has ever removed gets a
  // row. A long-lived workspace can have far more removed teams than teams
  // with spend, burying the real money among rows of "$0.00 / 0.0% / —". A
  // page that shows everything shows nothing.
  //
  // Zero OUs is required as well as zero dollars, so a row that consumed
  // Operating Units at no charge — BYOK, or an absorbed bucket — still appears.
  // Those are the rows a reader most needs to see and least expects: usage that
  // happened and cost nothing.
  // The same rule, one level down.
  //
  // Dropping empty GROUPS took the table from 139 rows to 10 and left every
  // kept group still listing all eight of its lines — so a team that did no
  // browsing, held no conversation and ran no sandbox this week still showed
  // "Voice — $0.00", "Sandbox — $0.00", "Data Sources — $0.00". The fix
  // stopped one level short of the thing it was fixing.
  //
  // A line is kept on the same test as a group: money, or Operating Units. A
  // line that metered usage at no charge stays, because that is a fact about
  // the period and not an absence.
  const hasContent = (usd: number, ous: number | null) => usd !== 0 || (ous ?? 0) !== 0;
  return groups
    .filter(g => hasContent(g.usd, g.ous))
    .map(g => ({ ...g, lines: g.lines.filter(l => hasContent(l.usd, l.ous)) }));
}

function computeTotalTasks(
  auditAggregation: AuditLogAggregation | null,
  externalAgentStats: ExternalAgentStats[],
  memberActivity: MemberActivity[],
  assistantActivity: AssistantActivity[] = [],
): number {
  // AI internal: agent_audit_logs rows where triggered_by NOT LIKE 'human:%'
  // (excluding human corrections, which are counted under memberActivity).
  const aiInternal = auditAggregation
    ? auditAggregation.timeBreakdown.reduce((s, b) => s + b.aiCount, 0)
    : 0;
  // AI external: per-agent task counts from Tenant Runtime audit_logs.
  const aiExternal = externalAgentStats.reduce((s, e) => s + e.taskCount, 0);
  // Human: HITL in-time + HITL late + corrections, unified via getHumanTaskCounts.
  const human = memberActivity.reduce((s, m) => s + m.approvalCount + m.correctionCount, 0);
  // The three platform assistants. They have no `internal_agents` row and
  // write no audit rows, so every term above is blind to them; without this
  // term the card reads as though they had done nothing, counting real work
  // as zero.
  const assistants = assistantActivity.reduce((s, a) => s + a.actionCount, 0);
  return aiInternal + aiExternal + human + assistants;
}

/**
 * Generate a full insights report as VisualizationBlock[].
 * Aggregates data from all providers into typed chart blocks.
 */
export async function generateReport(
  tenantId: string,
  periodInput: TimeRangeInput,
): Promise<VisualizationBlock[]> {
  // Cheap all-time probe BEFORE the 12-query fan-out. A brand-new workspace
  // has nothing for the heavy queries to aggregate; running them would burn
  // ~2-3s of DB time only to fall through to the empty-state branch below.
  // Same all-time semantics as /api/insights/counts so the two stay in sync.
  const counts = await getInsightsCounts(tenantId);
  if (counts.isEmpty) {
    return [{ type: 'text', content: EMPTY_INSIGHTS_TEXT } satisfies TextBlock];
  }

  const range = resolveTimeRange(periodInput);
  const comparisonRange = getComparisonPeriod(range);
  const rangeDays = Math.max(1, Math.ceil((range.end.getTime() - range.start.getTime()) / (24 * 60 * 60 * 1000)));

  // Choose time grouping based on range duration
  let timeGrouping: TimeGrouping;
  if (rangeDays <= 1) {
    timeGrouping = 'hour';
  } else if (rangeDays <= 60) {
    timeGrouping = 'day';
  } else {
    timeGrouping = 'month';
  }
  const volumeTitle = 'Task Volume';

  const comparisonRangeDays = Math.max(
    1,
    Math.ceil((comparisonRange.end.getTime() - comparisonRange.start.getTime()) / (24 * 60 * 60 * 1000)),
  );

  // Fetch all data in parallel — current period AND comparison period.
  // Comparison fetches are needed so the metric-card trends are honest:
  // both Tasks Completed and Total Cost reflect the WHOLE workforce, so we
  // need every workforce-cost source for the comparison period too.
  const [
    // Current period
    agents,
    agentInvocationCosts,
    auditAggregation,
    externalAgentStats,
    memberActivity,
    agentLLMCosts,
    agentlessLLMCosts,
    claudeCodeProxyCosts,
    webToolCosts,
    sandboxCosts,
    dataSourceCosts,
    agentVoiceCosts,
    assistantActivity,
    // Comparison period
    comparisonAgents,
    comparisonAgentInvocationCosts,
    comparisonAuditAggregation,
    comparisonExternalAgentStats,
    comparisonMemberActivity,
    comparisonAgentLLMCosts,
    comparisonAgentlessLLMCosts,
    comparisonClaudeCodeProxyCosts,
    comparisonWebToolCosts,
    comparisonSandboxCosts,
    comparisonDataSourceCosts,
    comparisonAgentVoiceCosts,
    comparisonAssistantActivity,
  ] = await Promise.all([
    // Current period.
    //
    // `includeDeleted` is what keeps a removed agent's spend on the page.
    // Both the table and the total iterate this list, so filtering it to live
    // teams would delete their cost along with them — charged and rendered
    // nowhere.
    providers.getInternalAgents(tenantId, { includeDeleted: true }),
    providers.getAgentCosts(tenantId, range),
    providers.getAuditLogAggregation(tenantId, range, timeGrouping),
    tenantRuntimeClient
      .getExternalAgentTaskCounts(tenantId, range.start, range.end)
      .then(taskCounts => providers.getExternalAgentStats(tenantId, taskCounts, rangeDays)),
    providers.getMemberActivity(tenantId, range),
    providers.getAgentLLMCosts(tenantId, range),
    providers.getAgentlessLLMCosts(tenantId, range),
    providers.getClaudeCodeProxyCosts(tenantId, range),
    getWebToolCosts(tenantId, range),
    getSandboxCosts(tenantId, range),
    getDataSourceCosts(tenantId, range),
    getAgentVoiceCosts(tenantId, range),
    getAssistantActivity(tenantId, range, timeGrouping),
    // Comparison period. The roster is fetched again rather than reused:
    // a team deleted between the two windows still spent money in the earlier
    // one, and the comparison figure is what the trend arrow is measured
    // against.
    providers.getInternalAgents(tenantId, { includeDeleted: true }),
    providers.getAgentCosts(tenantId, comparisonRange),
    providers.getAuditLogAggregation(tenantId, comparisonRange, timeGrouping),
    tenantRuntimeClient
      .getExternalAgentTaskCounts(tenantId, comparisonRange.start, comparisonRange.end)
      .then(taskCounts => providers.getExternalAgentStats(tenantId, taskCounts, comparisonRangeDays)),
    providers.getMemberActivity(tenantId, comparisonRange),
    providers.getAgentLLMCosts(tenantId, comparisonRange),
    providers.getAgentlessLLMCosts(tenantId, comparisonRange),
    providers.getClaudeCodeProxyCosts(tenantId, comparisonRange),
    getWebToolCosts(tenantId, comparisonRange),
    getSandboxCosts(tenantId, comparisonRange),
    getDataSourceCosts(tenantId, comparisonRange),
    getAgentVoiceCosts(tenantId, comparisonRange),
    getAssistantActivity(tenantId, comparisonRange, timeGrouping),
  ]);

  const blocks: VisualizationBlock[] = [];

  // Empty-state handled by the all-time short-circuit at the top of this
  // function; the fan-out below assumes at least one of agents / invocations
  // / audit logs exists for this tenant.

  // ── Metric Cards ──────────────────────────────────────────────────────
  // All 4 cards always show. Zero is valid data — never hide cards.

  // Helper: compute trend between two values from the same source.
  // Deltas within ±1% are reported as "flat" so the card shows a neutral
  // "Same as previous period" line instead of misleading green/red.
  function computeTrend(current: number, comparison: number): { trend: 'up' | 'down' | 'flat'; trendText?: string } {
    if (comparison <= 0) {
      if (current <= 0) {
        return { trend: 'flat', trendText: 'Same as previous period' };
      }
      return { trend: 'up' };
    }
    const delta = ((current - comparison) / comparison) * 100;
    if (Math.abs(delta) < 1) {
      return { trend: 'flat', trendText: 'Same as previous period' };
    }
    return {
      trend: delta >= 0 ? 'up' : 'down',
      trendText: `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}% vs previous period`,
    };
  }

  // Build per-period agent LLM cost lookups (used for both totalCost and the
  // Cost Breakdown table below). Returns USD and OU views derived from the
  // single canonical ledger; both are summed verbatim — no division here.
  const agentLLMMaps = buildAgentLLMMap(agentLLMCosts);
  const comparisonAgentLLMMaps = buildAgentLLMMap(comparisonAgentLLMCosts);
  const agentLLMMap = agentLLMMaps.usd;
  const comparisonAgentLLMMap = comparisonAgentLLMMaps.usd;
  const llmMapOus = agentLLMMaps.ous;
  const comparisonLLMMapOus = comparisonAgentLLMMaps.ous;

  // OU and USD come from cost_attribution_events directly (llm-usage-provider /
  // invocations-provider). Both surfaces sum the columns; nothing here divides.
  const fmtOus = (ous: number | null) => ous != null && ous > 0 ? ous.toLocaleString() : '—';

  // One model per period. The Total Cost card, the Operating Units card and
  // the Cost Breakdown table are all read off it, so the three cannot disagree:
  // a cost source that reaches the table reaches both cards by construction,
  // and one that reaches neither is visible as a missing group rather than as
  // a total nobody can account for.
  const costModel = buildCostModel({
    agents,
    externalAgentStats,
    agentInvocationCosts: agentInvocationCosts || {},
    agentLLMMap,
    agentLLMMapOus: llmMapOus,
    agentlessLLMCosts,
    claudeCodeProxyCosts,
    webToolCosts,
    sandboxCosts,
    dataSourceCosts,
    voiceCosts: agentVoiceCosts,
  });
  const comparisonCostModel = buildCostModel({
    agents: comparisonAgents,
    externalAgentStats: comparisonExternalAgentStats,
    agentInvocationCosts: comparisonAgentInvocationCosts || {},
    agentLLMMap: comparisonAgentLLMMap,
    agentLLMMapOus: comparisonLLMMapOus,
    agentlessLLMCosts: comparisonAgentlessLLMCosts,
    claudeCodeProxyCosts: comparisonClaudeCodeProxyCosts,
    webToolCosts: comparisonWebToolCosts,
    sandboxCosts: comparisonSandboxCosts,
    dataSourceCosts: comparisonDataSourceCosts,
    voiceCosts: comparisonAgentVoiceCosts,
  });

  const currentOus    = sumModelOus(costModel);
  const comparisonOus = sumModelOus(comparisonCostModel);
  const currentCost    = sumModelUsd(costModel);
  const comparisonCost = sumModelUsd(comparisonCostModel);

  // Tasks Completed = AI internal + AI external + human (whole workforce).
  const currentTasks = computeTotalTasks(
    auditAggregation, externalAgentStats, memberActivity, assistantActivity,
  );
  const comparisonTasks = computeTotalTasks(
    comparisonAuditAggregation,
    comparisonExternalAgentStats,
    comparisonMemberActivity,
    comparisonAssistantActivity,
  );

  const auditTotal = auditAggregation?.totalActions || 0;
  const successRate = auditTotal > 0
    ? (auditAggregation!.totalSuccess / auditTotal) * 100
    : 0;

  blocks.push(
    {
      type: 'metric_card',
      label: 'Tasks Completed',
      value: currentTasks.toLocaleString(),
      ...computeTrend(currentTasks, comparisonTasks),
    } satisfies MetricCardBlock,
    {
      type: 'metric_card',
      label: 'Operating Units Used',
      value: currentOus.toLocaleString(),
      ...computeTrend(currentOus, comparisonOus),
    } satisfies MetricCardBlock,
    {
      type: 'metric_card',
      label: 'Total Cost',
      value: `$${currentCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      ...computeTrend(currentCost, comparisonCost),
      lowerIsBetter: true,
    } satisfies MetricCardBlock,
    {
      type: 'metric_card',
      label: 'Success Rate',
      value: `${successRate.toFixed(1)}%`,
      trend: successRate >= 90 ? 'up' : 'down',
    } satisfies MetricCardBlock,
  );

  // ── AI Workforce Activity (bar chart) ──────────────────────────────────
  //
  // The agents, then the platform assistants. The assistants were absent and
  // not by a filter: `topAgents` is built from `internal_agents UNION
  // external_agents`, and an assistant has a row in neither, which is what
  // makes it a platform assistant. So the workspace's three busiest AI workers
  // could not appear on the chart of what its AI workers did. See
  // `getAssistantActivity` for what an assistant's count is and how it differs
  // from a team's.
  const agentData = auditAggregation?.topAgents || [];
  const assistantData = assistantActivity
    .filter(a => a.actionCount > 0)
    .map(a => ({ label: ASSISTANT_LABELS[a.assistant], value: a.actionCount }));
  const activityData = [
    ...agentData.map(a => ({ label: a.agentName, value: a.actionCount })),
    ...assistantData,
  ].sort((a, b) => b.value - a.value);

  if (activityData.length > 0) {
    const maxActions = Math.max(1, ...activityData.map(a => a.value));
    blocks.push({
      type: 'bar_chart',
      title: 'AI Workforce Activity',
      data: activityData.map(a => ({ label: a.label, value: a.value, max: maxActions })),
      variant: 'horizontal',
      valueSuffix: 'tasks',
    } satisfies BarChartBlock);
  }

  // ── Human Workforce Activity (bar chart) — right after AI workforce ───
  if (memberActivity.length > 0) {
    const maxActivity = Math.max(1, ...memberActivity.map(m => m.approvalCount + m.correctionCount));
    blocks.push({
      type: 'bar_chart',
      title: 'Human Workforce Activity',
      data: memberActivity.map(m => ({
        label: m.displayName,
        value: m.approvalCount + m.correctionCount,
        max: maxActivity,
      })),
      variant: 'horizontal',
      valueSuffix: 'tasks',
    } satisfies BarChartBlock);
  }

  // ── Task Volume (trend chart with AI/human stacked segments) ──────────
  // Format date labels based on grouping
  function formatLabel(dateStr: string): string {
    const d = new Date(dateStr);
    switch (timeGrouping) {
      case 'hour':
        return d.toLocaleTimeString('en-US', { hour: 'numeric', hour12: true });
      case 'day':
        return rangeDays <= 7
          ? d.toLocaleDateString('en-US', { weekday: 'short' })
          : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      case 'month':
        return d.toLocaleDateString('en-US', { month: 'short' });
    }
  }

  // Task Volume. The assistants' work joins the AI segment bucket by bucket,
  // so this chart and the Tasks Completed card above it count the same thing.
  // Adding them to one and not the other is how the page came to disagree with
  // itself elsewhere.
  const assistantByBucket = new Map<string, number>();
  for (const assistant of assistantActivity) {
    for (const bucket of assistant.timeBreakdown) {
      const key = new Date(bucket.date).toISOString();
      assistantByBucket.set(key, (assistantByBucket.get(key) ?? 0) + bucket.count);
    }
  }
  const assistantAt = (date: string) => assistantByBucket.get(new Date(date).toISOString()) ?? 0;

  const auditBuckets = auditAggregation?.timeBreakdown || [];
  // A bucket in which ONLY an assistant worked has no audit row, so it is
  // absent from the audit breakdown entirely and the chart would skip the day.
  const bucketKeys = new Set(auditBuckets.map(d => new Date(d.date).toISOString()));
  const assistantOnlyBuckets = [...assistantByBucket.keys()]
    .filter(k => !bucketKeys.has(k))
    .map(k => ({ date: k, count: 0, successCount: 0, errorCount: 0, humanCount: 0, aiCount: 0 }));

  const timeData = [...auditBuckets, ...assistantOnlyBuckets]
    .map(d => ({
      ...d,
      count:   d.count   + assistantAt(d.date),
      aiCount: d.aiCount + assistantAt(d.date),
    }))
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  const maxCount = Math.max(1, ...timeData.map(d => d.count));

  blocks.push({
    type: 'trend_chart',
    title: volumeTitle,
    data: timeData.map(d => ({
      label: formatLabel(d.date),
      value: d.count,
      max: maxCount,
      segments: [
        { label: 'AI Workforce', value: d.aiCount, color: 'var(--color-black)' },
        { label: 'Human Workforce', value: d.humanCount, color: 'var(--color-gray-300)' },
      ],
    })),
  } satisfies TrendChartBlock);

  // ── Cost Breakdown (table) ─────────────────────────────────────────────
  //
  // A rendering of `costModel`, nothing more. Every figure here was already
  // counted into the two cards above, which is what makes the page internally
  // consistent: the percentages sum to 100 because the parts ARE the total.

  const pct = (amount: number) => currentCost > 0 ? `${((amount / currentCost) * 100).toFixed(1)}%` : '0.0%';

  // Sorted on the model's own numbers. The previous version sorted by parsing
  // the formatted strings back out of the rendered rows, which is a round trip
  // through `$1,234.56` that exists only because the total was computed
  // somewhere else.
  const ordered = [...costModel].sort((a, b) => b.usd - a.usd);

  const groups: import('./shared-types').TableGroupRow[] = ordered.map(group => ({
    label: group.label,
    summary: {
      category: group.label,
      ous:      fmtOus(group.ous),
      amount:   formatCostUsd(group.usd),
      percent:  pct(group.usd),
    },
    rows: group.lines.map(line => ({
      category: line.label,
      ous:      fmtOus(line.ous),
      amount:   formatCostUsd(line.usd),
      percent:  pct(line.usd),
    })),
    ...(group.workforceType ? { workforceType: group.workforceType } : {}),
  }));

  blocks.push({
    type: 'table',
    title: 'Cost Breakdown',
    columns: [
      { key: 'category', label: 'Category' },
      { key: 'ous', label: 'Operating Units Used' },
      { key: 'amount', label: 'Cost' },
      { key: 'percent', label: '% of Total' },
    ],
    rows: [],
    groups,
  } satisfies TableBlock);

  return blocks;
}
