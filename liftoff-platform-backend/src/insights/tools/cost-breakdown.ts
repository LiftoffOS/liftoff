// get_cost_breakdown Tool
//
// Answers questions like:
//   "Where is my money going?"
//   "What did agents cost me last month vs this month?"
//   "Which external tools are most expensive per task?"
//
// Cost categories returned (any may be zero):
//   - internalAgentInvocations: per-agent LLM token costs from Tenant Runtime
//   - agentLLMOperations: distill + capability_analysis costs from Platform Backend
//     llm_usage_log (one-time agent creation costs and ongoing updates)
//   - interactions: agent_chat turns + agent_chat summarization + observer
//     context absorption + agent-chat thread title generation, attributed to
//     specific agents via agent_id (not the same as platformLLMOperations)
//   - externalAgents: per-month + per-task computed costs (per_task multiplies
//     costAmount by the actual task count from agent_audit_logs)
//   - voice: dictation and spoken replies on agent threads (voice_stt +
//     voice_tts), per agent. Absorbed voice on the Chief AI Officer plan and on
//     insights is excluded by cost_bucket, so it is charged usage only.
//   - platformLLMOperations: insights chat + observation tokens from
//     Platform Backend llm_usage_log where agent_id IS NULL, EXCLUDING
//     CAIO workforce planning
//   - workforcePlanning: CAIO chat + CAIO rolling summarization costs
//
// The math here mirrors report-service.ts so the LLM-driven answers
// reconcile with the dashboard view by construction.

import {
  getInternalAgents,
  getAgentCosts,
  getExternalAgentStats,
  getAgentLLMCosts,
  getAgentlessLLMCosts,
} from '../data-providers';
import { getWebToolCosts } from '../data-providers/web-tools-cost-provider';
import { getSandboxCosts } from '../data-providers/sandbox-cost-provider';
import { getDataSourceCosts } from '../data-providers/data-sources-cost-provider';
import { getAgentVoiceCosts } from '../data-providers/voice-cost-provider';

import {
  buildAgentLLMMap,
  buildCostModel,
  sumModelUsd,
  sumModelOus,
  sumLineAcrossModel,
} from '../report-service';
import { ASSISTANT_LABELS, type AssistantKey } from '../platform-assistants';
import { tenantRuntimeClient } from '../../connectors/tenant-runtime-client';
import { log } from '../../infrastructure/logging';
import { COMPARE_TO_SCHEMA, TIME_RANGE_SCHEMA, formatTimeRangeForOutput, parseCompareToArg, parseTimeRangeArg } from './tool-helpers';
import type { InsightsTool, InsightsToolContext } from './types';
import type { ExternalAgentStats, TimeRange } from '../types';

interface CostBreakdownPeriod {
  period: { start: string; end: string };
  /** Runs that consumed tokens and reported NO cost, because the model was not
   *  in the rate table. They are already inside the counts above at zero
   *  dollars, so a non-zero figure here means totalUsd is a floor rather than a
   *  total. Kept out of totalUsd deliberately: an estimate derived from a
   *  guessed rate cannot reproduce request-level pricing, and putting one in the
   *  same field as measured spend would make the number less trustworthy, not
   *  more complete. */
  uncosted: {
    invocations: number;
    inputTokens: number;
    outputTokens: number;
  };
  /** Every charged dollar in the window. The same figure the Cost Breakdown
   *  page shows, because both are `sumModelUsd` over the same model. */
  totalUsd: number;
  totalOus: number;
  byCategory: {
    internalAgentInvocations: number;
    agentLLMOperations: number;
    interactions: number;
    externalAgents: number;
    /** The three platform assistants: their own model calls plus the browser,
     *  data-source and sandbox work they do on the workspace's behalf. */
    platformAssistants: number;
    webTools: number;
    dataSources: number;
    sandbox: number;
    voice: number;
    developerProxy: number;
    /** Charged to the workspace with no team and no surface to name it. A
     *  non-zero figure here is attribution to chase, not an error. */
    unattributed: number;
  };
  webToolsByTool: Array<{
    toolName: string;
    callCount: number;
    totalCostUsd: number;
  }>;
  /** Per data source: the aggregator rungs and connectors the workspace pays
   *  per call for. */
  dataSourcesByConnector: Array<{
    connector: string;
    callCount: number;
    totalCostUsd: number;
  }>;
  /** One row per platform assistant that spent anything. */
  platformAssistantsByName: Array<{
    assistant: string;
    costUsd: number;
    ouConsumed: number;
  }>;
  byCategoryOus: {
    internalAgentInvocations: number;
    agentLLMOperations: number;
    interactions: number;
    platformAssistants: number;
    webTools: number;
    dataSources: number;
    sandbox: number;
    voice: number;
  };
  externalAgents: Array<{
    agentId: string;
    agentName: string;
    costType: 'per_task' | 'per_month' | null;
    taskCount: number;
    computedCostUsd: number;
  }>;
  /** Ranked by TOTAL cost — model calls, browser and web work, data sources,
   *  sandbox and voice. Ranking on the invocation figure alone put a team that
   *  spends most of its money on browsing below one that does not. */
  topInternalAgents: Array<{
    agentId: string;
    agentName: string;
    costUsd: number;
    taskCount: number;
  }>;
}

interface CostBreakdownOutput {
  current: CostBreakdownPeriod;
  comparison?: CostBreakdownPeriod;
}

async function loadPeriod(tenantId: string, range: TimeRange): Promise<CostBreakdownPeriod> {
  const rangeDays = Math.max(
    1,
    Math.round((range.end.getTime() - range.start.getTime()) / (24 * 60 * 60 * 1000)),
  );

  // External agent task counts proxied from Tenant Runtime audit logs.
  // Failure here just means external_agents with cost_type='per_task' will
  // show 0 cost — better than crashing the whole tool.
  let externalTaskCounts: Record<string, { taskCount: number }> = {};
  try {
    externalTaskCounts = await tenantRuntimeClient.getExternalAgentTaskCounts(
      tenantId,
      range.start,
      range.end,
    );
  } catch (err) {
    log.warn(
      { tenantId, error: (err as Error).message },
      'get_cost_breakdown: failed to fetch external agent task counts',
    );
  }

  const [
    internalAgents,
    agentCosts,
    externalAgentStats,
    agentLLMCosts,
    agentlessLLMCosts,
    webToolCosts,
    sandboxCosts,
    dataSourceCosts,
    agentVoiceCosts,
  ] = await Promise.all([
    // Removed agents included, for the same reason the page includes them:
    // their spend inside the window is still the workspace's.
    getInternalAgents(tenantId, { includeDeleted: true }),
    getAgentCosts(tenantId, range),
    getExternalAgentStats(tenantId, externalTaskCounts, rangeDays),
    getAgentLLMCosts(tenantId, range),
    getAgentlessLLMCosts(tenantId, range),
    getWebToolCosts(tenantId, range),
    getSandboxCosts(tenantId, range),
    getDataSourceCosts(tenantId, range),
    getAgentVoiceCosts(tenantId, range),
  ]);

  // Internal agent invocation costs (sum of per-agent costs from Tenant Runtime)
  const internalAgentInvocationsFromRuntime = Object.values(agentCosts ?? {}).reduce(
    (sum, entry) => sum + entry.totalCostUsd,
    0,
  );

  // Bucket per-agent LLM costs by purpose so we can split agentLLMOperations
  // (creation/updates/discovery) from interactions (chat/summary/absorption/
  // title generation). buildAgentLLMMap is the single source of truth for this
  // mapping — same function the dashboard uses.
  const agentLLMMaps = buildAgentLLMMap(agentLLMCosts);
  const agentLLMMap = agentLLMMaps.usd;
  const agentLLMMapOus = agentLLMMaps.ous;
  let agentLLMOperations = 0;
  let interactions = 0;
  // A run's own model calls reported through the platform's usage route. They
  // join internalAgentInvocations below, which is the same line the dashboard
  // shows them on, so the two surfaces answer the same question the same way.
  let runWork = 0;
  for (const buckets of Object.values(agentLLMMap)) {
    agentLLMOperations += buckets.creation + buckets.updates
      + buckets.discovery + buckets.discoveryUpdates;
    interactions += buckets.interactions;
    runWork += buckets.runWork;
  }
  let agentLLMOperationsOus = 0;
  let interactionsOus = 0;
  let runWorkOus = 0;
  for (const buckets of Object.values(agentLLMMapOus)) {
    agentLLMOperationsOus += buckets.creation + buckets.updates
      + buckets.discovery + buckets.discoveryUpdates;
    interactionsOus += buckets.interactions;
    runWorkOus += buckets.runWork;
  }
  const internalAgentInvocations = internalAgentInvocationsFromRuntime + runWork;

  // The page's own model, built from the same rows the page builds it from.
  //
  // `totalUsd` and `totalOus` below are sums over THIS, not a second addition
  // of the categories underneath. That is what keeps the Insights Manager's
  // answer and the rendered Cost Breakdown identical: the two cannot drift,
  // because there is only one computation and both read it.
  const model = buildCostModel({
    agents: internalAgents,
    externalAgentStats,
    agentInvocationCosts: agentCosts ?? {},
    agentLLMMap,
    agentLLMMapOus,
    agentlessLLMCosts,
    claudeCodeProxyCosts: [],
    webToolCosts,
    sandboxCosts,
    dataSourceCosts,
    voiceCosts: agentVoiceCosts,
  });

  // External agents — sum of computed costs (per_task multiplied by task count,
  // per_month prorated for partial months — both done inside getExternalAgentStats)
  const externalAgents = externalAgentStats.reduce(
    (sum: number, ea: ExternalAgentStats) => sum + ea.computedCostUsd,
    0,
  );

  // The three tool categories, read off the model's own sub-rows so a category
  // total and the per-team lines that make it up can never disagree.
  const webToolsLine   = sumLineAcrossModel(model, 'Web & browser');
  const dataSourceLine = sumLineAcrossModel(model, 'Data Sources');
  const sandboxLine    = sumLineAcrossModel(model, 'Sandbox');
  const voiceLine      = sumLineAcrossModel(model, 'Voice');

  const assistantGroups = model.filter(g => g.kind === 'assistant');
  const platformAssistants    = assistantGroups.reduce((sum, g) => sum + g.usd, 0);
  const platformAssistantsOus = assistantGroups.reduce((sum, g) => sum + (g.ous ?? 0), 0);
  const platformAssistantsByName = assistantGroups.map(g => ({
    assistant: g.assistant ? ASSISTANT_LABELS[g.assistant as AssistantKey] : g.label,
    costUsd: g.usd,
    ouConsumed: g.ous ?? 0,
  }));

  const unattributed = model
    .filter(g => g.kind === 'unattributed')
    .reduce((sum, g) => sum + g.usd, 0);
  const developerProxy = model
    .filter(g => g.kind === 'developer_proxy')
    .reduce((sum, g) => sum + g.usd, 0);

  // Top agents by TOTAL cost, from the model — so a team whose spend is
  // mostly browser time ranks where it belongs. Ranking on the invocation
  // figure alone is what hid that.
  const topInternalAgents = model
    .filter(g => g.kind === 'ai_team')
    .map(g => ({
      agentId: g.agentId ?? '',
      agentName: g.label,
      costUsd: g.usd,
      taskCount: agentCosts?.[g.agentId ?? '']?.invocationCount ?? 0,
    }))
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, 10);

  const internalAgentInvocationsOus = Object.values(agentCosts ?? {}).reduce(
    (sum, entry) => sum + (entry.ouConsumed ?? 0),
    0,
  ) + runWorkOus;
  const byCategoryOus = {
    internalAgentInvocations: internalAgentInvocationsOus,
    agentLLMOperations:       agentLLMOperationsOus,
    interactions:             interactionsOus,
    platformAssistants:       platformAssistantsOus,
    webTools:                 webToolsLine.ous,
    dataSources:              dataSourceLine.ous,
    sandbox:                  sandboxLine.ous,
    voice:                    voiceLine.ous,
  };

  // How much of internalAgentInvocations is measured, and how much is silence.
  //
  // A run whose model is missing from the rate table records real tokens at zero
  // dollars, so it lands in the total as if it were free. Without this the
  // number reads as a complete answer; with it, a reader can see when part of
  // the period was never priced at all. Deliberately NOT folded into totalUsd:
  // a token count times a guessed rate cannot reproduce request-level pricing
  // tiers, and an estimate sitting in the same field as measured figures is
  // worse than an honest gap.
  const uncosted = Object.values(agentCosts ?? {}).reduce(
    (acc, entry) => ({
      invocations: acc.invocations + (entry.uncostedInvocationCount ?? 0),
      inputTokens: acc.inputTokens + (entry.uncostedInputTokens ?? 0),
      outputTokens: acc.outputTokens + (entry.uncostedOutputTokens ?? 0),
    }),
    { invocations: 0, inputTokens: 0, outputTokens: 0 },
  );

  return {
    period: formatTimeRangeForOutput(range),
    /** Runs that consumed tokens and reported no cost. Zero means the period is
     *  fully priced; anything else means totalUsd is a floor, not a total. */
    uncosted,
    // Summed over the model rather than by re-adding the categories below.
    // Adding up the categories is how a source that belongs to none of them
    // goes missing, which is exactly what sandbox and data-source spend did.
    totalUsd: sumModelUsd(model),
    totalOus: sumModelOus(model),
    byCategory: {
      internalAgentInvocations,
      agentLLMOperations,
      interactions,
      externalAgents,
      platformAssistants,
      webTools:    webToolsLine.usd,
      dataSources: dataSourceLine.usd,
      sandbox:     sandboxLine.usd,
      voice:       voiceLine.usd,
      developerProxy,
      unattributed,
    },
    webToolsByTool: webToolCosts.map(w => ({
      toolName:     w.toolName,
      callCount:    w.callCount,
      totalCostUsd: w.totalCostUsd,
    })),
    dataSourcesByConnector: dataSourceCosts.map(d => ({
      connector:    d.connector,
      callCount:    d.callCount,
      totalCostUsd: d.totalCostUsd,
    })),
    platformAssistantsByName,
    byCategoryOus,
    externalAgents: externalAgentStats.map(ea => ({
      agentId: ea.agentId,
      agentName: ea.agentName,
      costType: ea.costType,
      taskCount: ea.taskCount,
      computedCostUsd: ea.computedCostUsd,
    })),
    topInternalAgents,
  };
}

export const getCostBreakdownTool: InsightsTool = {
  definition: {
    name: 'get_cost_breakdown',
    description:
      'Total workforce cost broken down by category: the agents\' LLM invocations, their LLM operations (distill/capability), interactions (chat turns with an agent + observer absorption + AI title generation), external agent subscriptions and per-task fees, platform LLM operations (insights chat), and workforce planning (CAIO). Returns both USD (totalUsd, byCategory) and Operating Units (totalOus, byCategoryOus): OUs cover AI compute only, not external agent flat fees. Includes the top agents by cost. Use this when the user asks where money is going, total costs, OU consumption, or to compare costs across periods. Supports compare_to.',
    input_schema: {
      type: 'object',
      properties: {
        time_range: TIME_RANGE_SCHEMA,
        compare_to: COMPARE_TO_SCHEMA,
      },
      required: ['time_range'],
    },
  },
  async execute(input, ctx: InsightsToolContext): Promise<CostBreakdownOutput> {
    const range = parseTimeRangeArg(input.time_range);
    const compareRange = parseCompareToArg(input.compare_to);

    const current = await loadPeriod(ctx.tenantId, range);

    if (compareRange) {
      const comparison = await loadPeriod(ctx.tenantId, compareRange);
      return { current, comparison };
    }

    return { current };
  },
};
