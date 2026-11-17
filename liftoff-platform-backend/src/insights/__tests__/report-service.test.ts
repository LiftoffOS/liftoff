// Report Service Snapshot Tests
// Tests: empty state, metric card generation, bar charts, tables

jest.mock('../../infrastructure/database', () => ({
  getPool: () => ({
    query: jest.fn().mockImplementation((sql: string) => {
      return (global as any).__queryHandler(sql);
    }),
  }),
  // tenant-members-provider now wraps the in-window query in withTenantScope.
  withTenantScope: jest.fn(
    async (_tenantId: string, fn: (client: { query: (sql: string) => unknown }) => Promise<unknown>) =>
      fn({ query: (sql: string) => (global as any).__queryHandler(sql) }),
  ),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

// Mock tenant runtime client
const mockGetInvocationStats = jest.fn();
const mockGetInvocationStatsForRange = jest.fn();
const mockGetExternalAgentTaskCounts = jest.fn();
const mockGetHitlDecisionCounts = jest.fn();

jest.mock('../../connectors/tenant-runtime-client', () => ({
  tenantRuntimeClient: {
    getInvocationStats: (...args: unknown[]) => mockGetInvocationStats(...args),
    getInvocationStatsForRange: (...args: unknown[]) => mockGetInvocationStatsForRange(...args),
    getExternalAgentTaskCounts: (...args: unknown[]) => mockGetExternalAgentTaskCounts(...args),
    getHitlDecisionCounts: (...args: unknown[]) => mockGetHitlDecisionCounts(...args),
    getBurnState: jest.fn().mockResolvedValue(null),
    getActionsByConnector: jest.fn().mockResolvedValue([]),
  },
}));

import { generateReport } from '../report-service';

const tenantId = '123e4567-e89b-12d3-a456-426614174000';

describe('generateReport', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function setupQueryHandler(options: { hasAgents?: boolean; hasAudit?: boolean; hasMembers?: boolean } = {}) {
    const { hasAgents = false, hasAudit = false, hasMembers = false } = options;

    (global as any).__queryHandler = (sql: string) => {
      // Counts-service probes — must come BEFORE any of the FROM-table
      // matchers below because the count queries reuse the same table names
      // (internal_agents, cost_attribution_events, agent_audit_logs) but
      // return a single { count } row.
      if (sql.includes('COUNT(*)::text AS count') && sql.includes('FROM internal_agents')) {
        return Promise.resolve({ rows: [{ count: hasAgents ? '1' : '0' }] });
      }
      if (sql.includes('COUNT(*)::text AS count') && sql.includes('FROM cost_attribution_events')) {
        return Promise.resolve({ rows: [{ count: hasAudit ? '1' : '0' }] });
      }
      if (sql.includes('COUNT(*)::text AS count') && sql.includes('FROM agent_audit_logs')) {
        return Promise.resolve({ rows: [{ count: hasAudit ? '1' : '0' }] });
      }
      // Audit top agents — must come BEFORE the simple `FROM internal_agents`
      // check below because the topAgents query has `FROM internal_agents`
      // inside its UNION subquery, and the simpler check would otherwise
      // hijack the row shape.
      if (sql.includes('action_count') && sql.includes('success_rate') && sql.includes('GROUP BY')) {
        return Promise.resolve({
          rows: hasAudit
            ? [{ agent_id: 'a1', agent_name: 'Sales Bot', action_count: '110', success_rate: '0.94' }]
            : [],
        });
      }
      // Internal agents (simple list query)
      if (sql.includes('FROM internal_agents')) {
        return Promise.resolve({
          rows: hasAgents
            ? [{ id: 'a1', role: 'Sales Bot', status: 'active', created_at: new Date() }]
            : [],
        });
      }
      // Audit daily breakdown
      if (sql.includes('DATE(created_at) as date')) {
        return Promise.resolve({
          rows: hasAudit
            ? [
                { date: new Date('2024-06-10'), count: '50', success_count: '45', error_count: '5', human_count: '0', ai_count: '50' },
                { date: new Date('2024-06-11'), count: '60', success_count: '58', error_count: '2', human_count: '0', ai_count: '60' },
              ]
            : [],
        });
      }
      // Audit totals
      if (sql.includes('total_actions') && sql.includes('total_success') && sql.includes('total_errors') && !sql.includes('GROUP BY')) {
        return Promise.resolve({
          rows: [{ total_actions: hasAudit ? '110' : '0', total_success: hasAudit ? '103' : '0', total_errors: hasAudit ? '7' : '0', avg_duration_ms: hasAudit ? '3200' : null }],
        });
      }
      // Per-agent audit stats
      if (sql.includes('agent_id') && sql.includes('total_count') && sql.includes('GROUP BY agent_id')) {
        return Promise.resolve({
          rows: hasAudit
            ? [{ agent_id: 'a1', total_count: '110', success_count: '103', error_count: '7' }]
            : [],
        });
      }
      // External agents
      if (sql.includes('FROM external_agents')) {
        return Promise.resolve({ rows: [] });
      }
      // Members in window (insights getMemberActivity baseline query)
      if (sql.includes('members_in_window')) {
        return Promise.resolve({
          rows: hasMembers
            ? [{ account_id: 'u1', display_name: 'Sarah' }]
            : [],
        });
      }
      // Late HITL feedback counts (human-task-counts helper)
      if (sql.includes('FROM hitl_late_feedback')) {
        return Promise.resolve({
          rows: hasMembers
            ? [{ account_id: 'u1', cnt: 12 }]
            : [],
        });
      }
      // Correction counts (human-task-counts helper)
      if (sql.includes('correction_of IS NOT NULL') && sql.includes("LIKE 'human:%'")) {
        return Promise.resolve({
          rows: hasMembers
            ? [{ account_id: 'u1', cnt: 3 }]
            : [],
        });
      }
      // Contractor payments
      if (sql.includes('contractor_payments')) {
        return Promise.resolve({
          rows: [{ contractor_count: '2', total_payments: '10000' }],
        });
      }
      // Default
      return Promise.resolve({ rows: [] });
    };

    // Setup tenant runtime mocks
    mockGetInvocationStats.mockResolvedValue(
      hasAudit
        ? { totalCostUsd: 150.50, totalInputTokens: 500000, totalOutputTokens: 100000, invocationCount: 250 }
        : { totalCostUsd: 0, totalInputTokens: 0, totalOutputTokens: 0, invocationCount: 0 },
    );
    mockGetInvocationStatsForRange.mockResolvedValue(
      hasAudit ? { a1: { totalCostUsd: 100, invocationCount: 200 } } : {},
    );
    mockGetExternalAgentTaskCounts.mockResolvedValue({});
    mockGetHitlDecisionCounts.mockResolvedValue(
      hasMembers ? { u1: { decisionCount: 5 } } : {},
    );
  }

  it('should return text block for empty state (no data)', async () => {
    setupQueryHandler({ hasAgents: false, hasAudit: false });

    const blocks = await generateReport(tenantId, { preset: 'this_week' });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('text');
    expect((blocks[0] as any).content).toContain('No insights yet');
  });

  it('short-circuits before the heavy fan-out when counts are empty', async () => {
    // Counts probe returns all zeros; the 12-query report fan-out (audit
    // aggregation, external agents, etc.) must NOT fire. We verify
    // by spying on the queryHandler and asserting that no SQL touched any
    // of the heavy tables.
    setupQueryHandler({ hasAgents: false, hasAudit: false });
    const seenQueries: string[] = [];
    const innerHandler = (global as any).__queryHandler;
    (global as any).__queryHandler = (sql: string) => {
      seenQueries.push(sql);
      return innerHandler(sql);
    };

    await generateReport(tenantId, { preset: 'this_week' });

    // The three count probes are expected; nothing else.
    expect(seenQueries).toHaveLength(3);
    expect(seenQueries.every(s => s.includes('COUNT(*)::text AS count'))).toBe(true);
    // None of the heavy report queries should have been issued.
    expect(seenQueries.some(s => s.includes('hitl_late_feedback'))).toBe(false);
    expect(seenQueries.some(s => s.includes('action_count') && s.includes('success_rate'))).toBe(false);
    // External-agent RPC (the only TR call inside the fan-out) must skip too.
    expect(mockGetExternalAgentTaskCounts).not.toHaveBeenCalled();
  });

  it('should return metric cards with data', async () => {
    setupQueryHandler({ hasAgents: true, hasAudit: true, hasMembers: true });

    const blocks = await generateReport(tenantId, { preset: 'this_week' });
    const metricCards = blocks.filter(b => b.type === 'metric_card');

    expect(metricCards.length).toBeGreaterThanOrEqual(3);

    const labels = metricCards.map(b => (b as any).label);
    expect(labels).toContain('Tasks Completed');
    expect(labels).toContain('Operating Units Used');
    expect(labels).toContain('Total Cost');
    expect(labels).toContain('Success Rate');
  });

  it('should return bar chart for tasks by agent', async () => {
    setupQueryHandler({ hasAgents: true, hasAudit: true });

    const blocks = await generateReport(tenantId, { preset: 'this_week' });
    const barCharts = blocks.filter(b => b.type === 'bar_chart');

    expect(barCharts.length).toBeGreaterThanOrEqual(1);
    const taskChart = barCharts.find(b => (b as any).title === 'AI Workforce Activity');
    expect(taskChart).toBeDefined();
  });

  it('should return trend chart for daily volume', async () => {
    setupQueryHandler({ hasAgents: true, hasAudit: true });

    const blocks = await generateReport(tenantId, { preset: 'this_week' });
    const trendCharts = blocks.filter(b => b.type === 'trend_chart');

    expect(trendCharts.length).toBeGreaterThanOrEqual(1);
    const volumeChart = trendCharts.find(b => (b as any).title === 'Task Volume');
    expect(volumeChart).toBeDefined();
  });

  it('should include human workforce activity bar chart', async () => {
    setupQueryHandler({ hasAgents: true, hasAudit: true, hasMembers: true });

    const blocks = await generateReport(tenantId, { preset: 'this_week' });
    const barCharts = blocks.filter(b => b.type === 'bar_chart');
    const humanChart = barCharts.find(b => (b as any).title === 'Human Workforce Activity');
    expect(humanChart).toBeDefined();
  });

  it('snapshot: block types with data', async () => {
    setupQueryHandler({ hasAgents: true, hasAudit: true, hasMembers: true });

    const blocks = await generateReport(tenantId, { preset: 'this_week' });
    const blockTypes = blocks.map(b => b.type);

    expect(blockTypes).toMatchSnapshot();
  });
});


const { buildAgentLLMMap, buildCostModel, sumModelUsd } = require('../report-service');

describe('buildAgentLLMMap', () => {
  // Implementation returns `{ usd, ous }` — two parallel maps, one keyed on
  // dollars (estimatedCostUsd), one on OU units (ouConsumed). Tests assert
  // against both axes where natural; the entry fixtures always carry both
  // `estimatedCostUsd` and `ouConsumed` to keep the ous map deterministic.

  it("buckets 'distill' into creation and 'distill_update' into updates", () => {
    const { usd, ous } = buildAgentLLMMap([
      {
        agentId: 'a1',
        purpose: 'distill',
        totalInputTokens: 0,
        totalOutputTokens: 0,
        estimatedCostUsd: 0.1,
        rawModelCostUsd: 0.1,
        ouConsumed: 10,
        failedAttemptsCostUsd: 0,
      },
      {
        agentId: 'a1',
        purpose: 'distill_update',
        totalInputTokens: 0,
        totalOutputTokens: 0,
        estimatedCostUsd: 0.07,
        rawModelCostUsd: 0.07,
        ouConsumed: 7,
        failedAttemptsCostUsd: 0,
      },
    ]);
    expect(usd.a1).toEqual({
      creation: 0.1,
      updates: 0.07,
      discovery: 0,
      discoveryUpdates: 0,
      interactions: 0,
      runWork: 0, other: 0,
    });
    expect(ous.a1).toEqual({
      creation: 10,
      updates: 7,
      discovery: 0,
      discoveryUpdates: 0,
      interactions: 0,
      runWork: 0, other: 0,
    });
  });

  it("buckets 'distill_semantic_validation' into creation and _update into updates", () => {
    const { usd } = buildAgentLLMMap([
      {
        agentId: 'a1',
        purpose: 'distill_semantic_validation',
        totalInputTokens: 0,
        totalOutputTokens: 0,
        estimatedCostUsd: 0.02,
        rawModelCostUsd: 0.02,
        ouConsumed: 2,
        failedAttemptsCostUsd: 0,
      },
      {
        agentId: 'a1',
        purpose: 'distill_semantic_validation_update',
        totalInputTokens: 0,
        totalOutputTokens: 0,
        estimatedCostUsd: 0.01,
        rawModelCostUsd: 0.01,
        ouConsumed: 1,
        failedAttemptsCostUsd: 0,
      },
    ]);
    expect(usd.a1.creation).toBe(0.02);
    expect(usd.a1.updates).toBe(0.01);
  });

  it("buckets capability_analysis and manual_capability_analysis into discovery", () => {
    const { usd } = buildAgentLLMMap([
      {
        agentId: 'e1',
        purpose: 'capability_analysis',
        totalInputTokens: 0,
        totalOutputTokens: 0,
        estimatedCostUsd: 0.02,
        rawModelCostUsd: 0.02,
        ouConsumed: 2,
        failedAttemptsCostUsd: 0,
      },
      {
        agentId: 'e2',
        purpose: 'manual_capability_analysis',
        totalInputTokens: 0,
        totalOutputTokens: 0,
        estimatedCostUsd: 0.03,
        rawModelCostUsd: 0.03,
        ouConsumed: 3,
        failedAttemptsCostUsd: 0,
      },
    ]);
    expect(usd.e1.discovery).toBe(0.02);
    expect(usd.e2.discovery).toBe(0.03);
  });

  it('counts an unknown purpose as Other rather than dropping it', () => {
    const { usd } = buildAgentLLMMap([
      {
        agentId: 'a1',
        purpose: 'some_future_purpose',
        totalInputTokens: 0,
        totalOutputTokens: 0,
        estimatedCostUsd: 99,
        rawModelCostUsd: 99,
        ouConsumed: 99,
        failedAttemptsCostUsd: 0,
      },
    ]);
    // Incrementing nothing would log the money and drop it, inside the
    // function whose job is to make sure money is not. The log stays as the
    // signal to give the purpose a real bucket, but the amount is on the page
    // either way.
    expect(usd.a1).toEqual({
      creation: 0,
      updates: 0,
      discovery: 0,
      discoveryUpdates: 0,
      interactions: 0,
      runWork: 0,
      other: 99,
    });
  });

  it("buckets 'agent_chat' into the per-agent interactions bucket", () => {
    const { usd } = buildAgentLLMMap([
      {
        agentId: 'a1',
        purpose: 'agent_chat',
        totalInputTokens: 0,
        totalOutputTokens: 0,
        estimatedCostUsd: 0.04,
        rawModelCostUsd: 0.04,
        ouConsumed: 4,
        failedAttemptsCostUsd: 0,
      },
    ]);
    expect(usd.a1.interactions).toBe(0.04);
    expect(usd.a1.creation).toBe(0);
    expect(usd.a1.updates).toBe(0);
  });

  it("buckets 'agent_chat_summarization' into interactions", () => {
    const { usd } = buildAgentLLMMap([
      {
        agentId: 'a1',
        purpose: 'agent_chat_summarization',
        totalInputTokens: 0,
        totalOutputTokens: 0,
        estimatedCostUsd: 0.005,
        rawModelCostUsd: 0.005,
        ouConsumed: 0.5,
        failedAttemptsCostUsd: 0,
      },
    ]);
    expect(usd.a1.interactions).toBe(0.005);
  });

  it("buckets 'context_absorption' into interactions", () => {
    const { usd } = buildAgentLLMMap([
      {
        agentId: 'a1',
        purpose: 'context_absorption',
        totalInputTokens: 0,
        totalOutputTokens: 0,
        estimatedCostUsd: 0.002,
        rawModelCostUsd: 0.002,
        ouConsumed: 0.2,
        failedAttemptsCostUsd: 0,
      },
    ]);
    expect(usd.a1.interactions).toBe(0.002);
  });

  it("buckets 'thread_title_generation' (with agent_id) into interactions", () => {
    // getAgentLLMCosts only returns rows where agent_id IS NOT NULL, so any
    // thread_title_generation row that reaches buildAgentLLMMap is from an
    // agent-chat thread (insights/CAIO title rows have agent_id NULL and
    // never appear here).
    const { usd } = buildAgentLLMMap([
      {
        agentId: 'a1',
        purpose: 'thread_title_generation',
        totalInputTokens: 0,
        totalOutputTokens: 0,
        estimatedCostUsd: 0.001,
        rawModelCostUsd: 0.001,
        ouConsumed: 0.1,
        failedAttemptsCostUsd: 0,
      },
    ]);
    expect(usd.a1.interactions).toBe(0.001);
  });

  it('sums multiple interaction purposes per agent', () => {
    const { usd } = buildAgentLLMMap([
      { agentId: 'a1', purpose: 'agent_chat',               totalInputTokens: 0, totalOutputTokens: 0, estimatedCostUsd: 0.10,  rawModelCostUsd: 0.10,  ouConsumed: 10, failedAttemptsCostUsd: 0 },
      { agentId: 'a1', purpose: 'agent_chat_summarization', totalInputTokens: 0, totalOutputTokens: 0, estimatedCostUsd: 0.02,  rawModelCostUsd: 0.02,  ouConsumed: 2,  failedAttemptsCostUsd: 0 },
      { agentId: 'a1', purpose: 'thread_title_generation',  totalInputTokens: 0, totalOutputTokens: 0, estimatedCostUsd: 0.001, rawModelCostUsd: 0.001, ouConsumed: 0.1, failedAttemptsCostUsd: 0 },
      { agentId: 'a1', purpose: 'context_absorption',       totalInputTokens: 0, totalOutputTokens: 0, estimatedCostUsd: 0.003, rawModelCostUsd: 0.003, ouConsumed: 0.3, failedAttemptsCostUsd: 0 },
    ]);
    expect(usd.a1.interactions).toBeCloseTo(0.124, 5);
  });

  it('does NOT mix interaction purposes into creation/updates/discovery', () => {
    const { usd } = buildAgentLLMMap([
      { agentId: 'a1', purpose: 'agent_chat', totalInputTokens: 0, totalOutputTokens: 0, estimatedCostUsd: 1,   rawModelCostUsd: 1,   ouConsumed: 100, failedAttemptsCostUsd: 0 },
      { agentId: 'a1', purpose: 'distill',    totalInputTokens: 0, totalOutputTokens: 0, estimatedCostUsd: 0.5, rawModelCostUsd: 0.5, ouConsumed: 50,  failedAttemptsCostUsd: 0 },
    ]);
    expect(usd.a1.creation).toBe(0.5);
    expect(usd.a1.interactions).toBe(1);
    expect(usd.a1.updates).toBe(0);
  });
});

describe('the total cost', () => {
  // `computeTotalCost` used to take ten positional parameters and add them up
  // beside a table built separately from the same inputs. Both are now derived
  // from `buildCostModel`, so these assert the same properties through the one
  // computation the page actually renders.
  const NO_BUCKETS = { creation: 0, updates: 0, discovery: 0, discoveryUpdates: 0, interactions: 0, runWork: 0, other: 0 };

  const base = (over = {}) => ({
    agents: [],
    externalAgentStats: [],
    agentInvocationCosts: {},
    agentLLMMap: {},
    agentLLMMapOus: {},
    agentlessLLMCosts: [],
    claudeCodeProxyCosts: [],
    webToolCosts: [],
    sandboxCosts: [],
    dataSourceCosts: [],
    voiceCosts: [],
    ...over,
  });
  const team = (id: string, name = 'Team') => ({ id, name, role: name, status: 'active', deletedAt: null });
  const total = (over = {}) => sumModelUsd(buildCostModel(base(over)));

  it('includes the platform assistants', () => {
    expect(total({
      agentlessLLMCosts: [
        { purpose: 'liftoff_chat', totalInputTokens: 0, totalOutputTokens: 0,
          estimatedCostUsd: 10, rawModelCostUsd: 9, ouConsumed: 0 },
        { purpose: 'caio_workforce_planning', totalInputTokens: 0, totalOutputTokens: 0,
          estimatedCostUsd: 2.5, rawModelCostUsd: 2, ouConsumed: 0 },
      ],
    })).toBeCloseTo(12.5, 10);
  });

  it('sums invocations, LLM buckets, external agents and the developer proxy', () => {
    expect(total({
      agents: [team('a1')],
      externalAgentStats: [{
        agentId: 'e1', agentName: 'X', costType: 'per_month' as const,
        costAmount: 50, taskCount: 0, computedCostUsd: 50,
      }],
      agentInvocationCosts: { a1: { totalCostUsd: 1, invocationCount: 5 } },
      agentLLMMap: { a1: { ...NO_BUCKETS, creation: 0.5, updates: 0.25, interactions: 0.4 } },
      agentlessLLMCosts: [
        { purpose: 'insights_chat', totalInputTokens: 0, totalOutputTokens: 0,
          estimatedCostUsd: 3, rawModelCostUsd: 2, ouConsumed: 0 },
        { purpose: 'caio_workforce_planning', totalInputTokens: 0, totalOutputTokens: 0,
          estimatedCostUsd: 7, rawModelCostUsd: 6, ouConsumed: 0 },
      ],
      claudeCodeProxyCosts: [{
        proxyKeyId: 'k1', keyHint: 'x', accountId: 'a', displayName: 'Dev',
        totalInputTokens: 0, totalOutputTokens: 0, cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0, estimatedCostUsd: 2, requestCount: 1,
      }],
    })).toBeCloseTo(64.15, 4);
  });

  it('includes per-agent interactions', () => {
    expect(total({
      agents: [team('a1')],
      agentLLMMap: { a1: { ...NO_BUCKETS, interactions: 5 } },
    })).toBeCloseTo(5, 10);
  });

  it("includes what a run's own model calls cost", () => {
    // A run's browser steps, oversight checks, memory checks and retrieval
    // queries are charged and OU-metered, and until they were bucketed they
    // reached neither this total nor the table under it.
    expect(total({
      agents: [team('a1')],
      agentInvocationCosts: { a1: { totalCostUsd: 4, ouConsumed: 0, invocationCount: 0 } },
      agentLLMMap: { a1: { ...NO_BUCKETS, runWork: 1.5 } },
    })).toBeCloseTo(5.5, 10);
  });

  it('includes voice', () => {
    // Voice was charged and OU-metered while being absent from every total.
    const without = total({
      agents: [team('a1')],
      agentInvocationCosts: { a1: { totalCostUsd: 4, ouConsumed: 0, invocationCount: 0 } },
      agentLLMMap: { a1: { ...NO_BUCKETS, creation: 1, interactions: 2 } },
    });
    const withVoice = total({
      agents: [team('a1')],
      agentInvocationCosts: { a1: { totalCostUsd: 4, ouConsumed: 0, invocationCount: 0 } },
      agentLLMMap: { a1: { ...NO_BUCKETS, creation: 1, interactions: 2 } },
      voiceCosts: [{ agentId: 'a1', totalCostUsd: 3.5, ouConsumed: 0 }],
    });
    expect(without).toBeCloseTo(7, 6);
    expect(withVoice).toBeCloseTo(10.5, 6);
  });

  it('includes the tool spend that used to reach no line at all', () => {
    // Web, data-source and sandbox spend: charged, OU-metered, and invisible.
    expect(total({
      agents: [team('a1')],
      webToolCosts: [{ agentId: 'a1', surface: null, toolName: 'web_research', callCount: 1, totalCostUsd: 2, ouConsumed: 0 }],
      dataSourceCosts: [{ agentId: 'a1', surface: null, connector: 'apify', callCount: 1, totalCostUsd: 3, ouConsumed: 0 }],
      sandboxCosts: [{ agentId: 'a1', runCount: 1, totalCostUsd: 4, ouConsumed: 0 }],
    })).toBeCloseTo(9, 10);
  });
});
