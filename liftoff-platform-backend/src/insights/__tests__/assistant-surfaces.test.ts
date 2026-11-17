// An assistant that did work reaches all three surfaces, or this fails.
//
// The gap was one omission with three faces: the bar chart, the trend and the
// card each got their AI numbers from `agent_audit_logs`, which the platform
// assistants never write to. Fixing one and not the others would look fixed
// from whichever surface you happened to check — which is how the Cost
// Breakdown and its own metric card drifted apart twice.

jest.mock('../counts-service', () => ({
  getInsightsCounts: jest.fn().mockResolvedValue({ isEmpty: false }),
}));

const providerStubs = {
  getInternalAgents: jest.fn().mockResolvedValue([]),
  getAgentCosts: jest.fn().mockResolvedValue({}),
  getAuditLogAggregation: jest.fn().mockResolvedValue(null),
  getExternalAgentStats: jest.fn().mockResolvedValue([]),
  getMemberActivity: jest.fn().mockResolvedValue([]),
  getAgentLLMCosts: jest.fn().mockResolvedValue([]),
  getAgentlessLLMCosts: jest.fn().mockResolvedValue([]),
  getClaudeCodeProxyCosts: jest.fn().mockResolvedValue([]),
};
jest.mock('../data-providers', () => providerStubs);

const mockAssistantActivity = jest.fn();
jest.mock('../data-providers/assistant-activity-provider', () => ({
  getAssistantActivity: (...args: unknown[]) => mockAssistantActivity(...args),
}));
jest.mock('../data-providers/web-tools-cost-provider', () => ({ getWebToolCosts: jest.fn().mockResolvedValue([]) }));
jest.mock('../data-providers/sandbox-cost-provider', () => ({ getSandboxCosts: jest.fn().mockResolvedValue([]) }));
jest.mock('../data-providers/data-sources-cost-provider', () => ({ getDataSourceCosts: jest.fn().mockResolvedValue([]) }));
jest.mock('../data-providers/voice-cost-provider', () => ({ getAgentVoiceCosts: jest.fn().mockResolvedValue([]) }));

jest.mock('../../connectors/tenant-runtime-client', () => ({
  tenantRuntimeClient: { getExternalAgentTaskCounts: jest.fn().mockResolvedValue({}) },
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

import { generateReport } from '../report-service';
import type { VisualizationBlock } from '../shared-types';

const TENANT = '123e4567-e89b-12d3-a456-426614174000';

/** Liftoff worked on two days and nobody else did anything at all. */
const LIFTOFF_ONLY = [{
  assistant: 'liftoff' as const,
  actionCount: 12,
  timeBreakdown: [
    { date: '2026-09-10T00:00:00.000Z', count: 5 },
    { date: '2026-09-11T00:00:00.000Z', count: 7 },
  ],
}];

async function report(): Promise<VisualizationBlock[]> {
  return generateReport(TENANT, { preset: 'this_month' });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAssistantActivity.mockResolvedValue([]);
});

describe('a platform assistant that worked', () => {
  beforeEach(() => {
    // Current period has the work; the comparison period is empty, so the
    // trend is measured against nothing rather than against itself.
    mockAssistantActivity
      .mockResolvedValueOnce(LIFTOFF_ONLY)
      .mockResolvedValueOnce([]);
  });

  it('appears on the AI Workforce Activity chart', async () => {
    const chart = (await report()).find(b => b.type === 'bar_chart' && b.title === 'AI Workforce Activity');
    expect(chart).toBeDefined();
    expect((chart as { data: Array<{ label: string; value: number }> }).data)
      .toContainEqual(expect.objectContaining({ label: 'Liftoff', value: 12 }));
  });

  it('is counted in Tasks Completed', async () => {
    const card = (await report()).find(b => b.type === 'metric_card' && b.label === 'Tasks Completed');
    expect((card as { value: string }).value).toBe('12');
  });

  it('shows up in Task Volume on the days it worked', async () => {
    // There are no audit rows at all here, so without the assistant-only
    // buckets these days would be missing from the chart entirely rather than
    // showing zero — a silent hole rather than a visible one.
    const trend = (await report()).find(b => b.type === 'trend_chart');
    const data = (trend as { data: Array<{ value: number; segments: Array<{ label: string; value: number }> }> }).data;
    expect(data.map(d => d.value)).toEqual([5, 7]);
    for (const point of data) {
      const ai = point.segments.find(s => s.label === 'AI Workforce');
      expect(ai!.value).toBe(point.value);
    }
  });

  it('agrees with itself: the chart, the trend and the card are one number', async () => {
    const blocks = await report();
    const chart = blocks.find(b => b.type === 'bar_chart' && b.title === 'AI Workforce Activity');
    const trend = blocks.find(b => b.type === 'trend_chart');
    const card  = blocks.find(b => b.type === 'metric_card' && b.label === 'Tasks Completed');

    const chartTotal = (chart as { data: Array<{ value: number }> }).data
      .reduce((s, d) => s + d.value, 0);
    const trendTotal = (trend as { data: Array<{ value: number }> }).data
      .reduce((s, d) => s + d.value, 0);
    const cardTotal = parseInt((card as { value: string }).value.replace(/,/g, ''));

    expect(chartTotal).toBe(cardTotal);
    expect(trendTotal).toBe(cardTotal);
  });
});

describe('an assistant that did nothing', () => {
  it('gets no bar, rather than a bar of zero', async () => {
    mockAssistantActivity.mockResolvedValue([
      { assistant: 'insights' as const, actionCount: 0, timeBreakdown: [] },
    ]);
    const chart = (await report()).find(b => b.type === 'bar_chart' && b.title === 'AI Workforce Activity');
    // No agents and no assistant work means no chart at all.
    expect(chart).toBeUndefined();
  });
});
