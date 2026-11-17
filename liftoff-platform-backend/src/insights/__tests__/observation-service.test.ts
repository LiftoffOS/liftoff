// Observation service tests — Phase 7
//
// Covers the happy path, the "degrades to empty on failure" contract,
// and each of the helper functions (hasMeaningfulData, summarizer,
// JSON parser).

jest.mock('../../llm', () => ({
  llmClient: { complete: jest.fn() },
}));

jest.mock('../report-service', () => ({
  generateReport: jest.fn(),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { llmClient } from '../../llm';
import { generateReport } from '../report-service';
import {
  _test,
  generateInsightsObservations,
} from '../observation-service';
import type { VisualizationBlock } from '../shared-types';

const llmComplete = llmClient.complete as jest.Mock;
const mockGenerateReport = generateReport as jest.Mock;

const METRIC_BLOCK = {
  type: 'metric_card' as const,
  label: 'Total Tasks',
  value: '1,245',
  trend: 'up' as const,
  trendText: '+12% vs last week',
};

const BAR_BLOCK = {
  type: 'bar_chart' as const,
  title: 'Tasks by Agent',
  data: [
    { label: 'Salesforce Sync', value: 420 },
    { label: 'Inbox Triage', value: 305 },
  ],
};

const TABLE_BLOCK = {
  type: 'table' as const,
  title: 'Cost Breakdown',
  columns: [
    { key: 'category', label: 'Category' },
    { key: 'amount', label: 'Amount' },
  ],
  rows: [
    { category: 'LLM', amount: '$1,200' },
    { category: 'Human', amount: '$14,500' },
  ],
};

const REPORT_WITH_DATA: VisualizationBlock[] = [
  METRIC_BLOCK,
  BAR_BLOCK,
  TABLE_BLOCK,
];

const EMPTY_REPORT: VisualizationBlock[] = [
  METRIC_BLOCK,
  { type: 'text', content: 'No data yet. Start by creating agents.' },
];

const FAKE_LLM_RESPONSE = {
  content: JSON.stringify({
    observations: [
      { icon: '+', content: 'Salesforce Sync tasks up 34% week-over-week' },
      { icon: '!', content: 'External agent costs spiked on April 5' },
      { icon: '-', content: 'Error rate for Inbox Triage climbing' },
    ],
  }),
  model: 'claude-sonnet-4-6',
  provider: 'anthropic' as const,
  usage: { inputTokens: 200, outputTokens: 80 },
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('generateInsightsObservations — happy path', () => {
  it('returns parsed observations when the LLM responds with valid JSON', async () => {
    mockGenerateReport.mockResolvedValue(REPORT_WITH_DATA);
    llmComplete.mockResolvedValue(FAKE_LLM_RESPONSE);

    const result = await generateInsightsObservations('tenant-1', { preset: 'this_week' });

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({
      type: 'observation',
      icon: '+',
      content: 'Salesforce Sync tasks up 34% week-over-week',
    });
    expect(result[1].icon).toBe('!');
    expect(result[2].icon).toBe('-');
  });

  it('passes insights_observation as the llm_usage_log purpose', async () => {
    mockGenerateReport.mockResolvedValue(REPORT_WITH_DATA);
    llmComplete.mockResolvedValue(FAKE_LLM_RESPONSE);

    await generateInsightsObservations('tenant-1', { preset: 'this_week' });

    expect(llmComplete).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      expect.objectContaining({
        tenantId: 'tenant-1',
        purpose: 'insights_observation',
      }),
    );
  });

  it('uses responseSchema so the LLM returns structured JSON', async () => {
    mockGenerateReport.mockResolvedValue(REPORT_WITH_DATA);
    llmComplete.mockResolvedValue(FAKE_LLM_RESPONSE);

    await generateInsightsObservations('tenant-1', { preset: 'this_week' });

    const request = llmComplete.mock.calls[0][0];
    expect(request.responseSchema).toBeDefined();
    expect(request.responseSchema.name).toBe('insights_observations');
  });

  it('clamps to a max of 5 observations', async () => {
    mockGenerateReport.mockResolvedValue(REPORT_WITH_DATA);
    llmComplete.mockResolvedValue({
      content: JSON.stringify({
        observations: [
          { icon: '+', content: 'one' },
          { icon: '+', content: 'two' },
          { icon: '+', content: 'three' },
          { icon: '+', content: 'four' },
          { icon: '+', content: 'five' },
          { icon: '+', content: 'six' },
          { icon: '+', content: 'seven' },
        ],
      }),
      model: 'claude-sonnet-4-6',
      provider: 'anthropic' as const,
      usage: { inputTokens: 10, outputTokens: 10 },
    });

    const result = await generateInsightsObservations('t', { preset: 'this_week' });
    expect(result).toHaveLength(5);
  });
});

describe('generateInsightsObservations — graceful degradation', () => {
  it('returns [] when generateReport throws', async () => {
    mockGenerateReport.mockRejectedValue(new Error('db connection lost'));
    const result = await generateInsightsObservations('t', { preset: 'this_week' });
    expect(result).toEqual([]);
    expect(llmComplete).not.toHaveBeenCalled();
  });

  it('returns [] when the report has no meaningful data', async () => {
    mockGenerateReport.mockResolvedValue(EMPTY_REPORT);
    const result = await generateInsightsObservations('t', { preset: 'this_week' });
    expect(result).toEqual([]);
    // Should not have called the LLM — no point observing empty data
    expect(llmComplete).not.toHaveBeenCalled();
  });

  it('returns [] when the LLM call throws', async () => {
    mockGenerateReport.mockResolvedValue(REPORT_WITH_DATA);
    llmComplete.mockRejectedValue(new Error('provider timeout'));
    const result = await generateInsightsObservations('t', { preset: 'this_week' });
    expect(result).toEqual([]);
  });

  it('returns [] on malformed JSON response', async () => {
    mockGenerateReport.mockResolvedValue(REPORT_WITH_DATA);
    llmComplete.mockResolvedValue({
      content: 'not valid json',
      model: 'x',
      provider: 'anthropic' as const,
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const result = await generateInsightsObservations('t', { preset: 'this_week' });
    expect(result).toEqual([]);
  });

  it('drops observations with invalid icons but keeps valid siblings', async () => {
    mockGenerateReport.mockResolvedValue(REPORT_WITH_DATA);
    llmComplete.mockResolvedValue({
      content: JSON.stringify({
        observations: [
          { icon: '+', content: 'good one' },
          { icon: '🚀', content: 'bad icon' },
          { icon: '?', content: 'question' },
        ],
      }),
      model: 'x',
      provider: 'anthropic' as const,
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const result = await generateInsightsObservations('t', { preset: 'this_week' });
    expect(result).toHaveLength(2);
    expect(result.map(r => r.icon)).toEqual(['+', '?']);
  });

  it('drops observations with missing or empty content', async () => {
    mockGenerateReport.mockResolvedValue(REPORT_WITH_DATA);
    llmComplete.mockResolvedValue({
      content: JSON.stringify({
        observations: [
          { icon: '+', content: '   ' },
          { icon: '!' },
          { icon: '+', content: 'real one' },
        ],
      }),
      model: 'x',
      provider: 'anthropic' as const,
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const result = await generateInsightsObservations('t', { preset: 'this_week' });
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('real one');
  });
});

describe('_test.hasMeaningfulData', () => {
  it('returns true when a bar chart has rows', () => {
    expect(_test.hasMeaningfulData([BAR_BLOCK])).toBe(true);
  });

  it('returns true when a table has rows', () => {
    expect(_test.hasMeaningfulData([TABLE_BLOCK])).toBe(true);
  });

  it('returns false when only metric cards are present (even with data)', () => {
    expect(_test.hasMeaningfulData([METRIC_BLOCK])).toBe(false);
  });

  it('returns false when a bar chart is empty', () => {
    const empty = { ...BAR_BLOCK, data: [] };
    expect(_test.hasMeaningfulData([empty])).toBe(false);
  });

  it('returns false on an empty report', () => {
    expect(_test.hasMeaningfulData([])).toBe(false);
  });
});

describe('_test.summarizeBlocksForPrompt', () => {
  it('includes metric card labels, values, and trend text', () => {
    const text = _test.summarizeBlocksForPrompt([METRIC_BLOCK]);
    expect(text).toContain('Total Tasks: 1,245');
    expect(text).toContain('+12% vs last week');
  });

  it('renders bar charts with label/value lines', () => {
    const text = _test.summarizeBlocksForPrompt([BAR_BLOCK]);
    expect(text).toContain('Tasks by Agent');
    expect(text).toContain('Salesforce Sync: 420');
    expect(text).toContain('Inbox Triage: 305');
  });

  it('renders tables with a pipe-separated header and rows', () => {
    const text = _test.summarizeBlocksForPrompt([TABLE_BLOCK]);
    expect(text).toContain('Cost Breakdown');
    expect(text).toContain('Category | Amount');
    expect(text).toContain('LLM | $1,200');
    expect(text).toContain('Human | $14,500');
  });

  it('truncates long bar chart data to 15 entries', () => {
    const bigBar = {
      ...BAR_BLOCK,
      data: Array.from({ length: 40 }, (_, i) => ({ label: `Agent ${i}`, value: i })),
    };
    const text = _test.summarizeBlocksForPrompt([bigBar]);
    expect(text).toContain('Agent 14');
    expect(text).not.toContain('Agent 15');
  });
});

describe('_test.safeParseObservationsResponse', () => {
  it('returns [] for malformed JSON', () => {
    expect(_test.safeParseObservationsResponse('nope')).toEqual([]);
  });

  it('returns [] when top level is not an object', () => {
    expect(_test.safeParseObservationsResponse('[]')).toEqual([]);
  });

  it('returns [] when observations field is missing', () => {
    expect(_test.safeParseObservationsResponse('{"foo": "bar"}')).toEqual([]);
  });

  it('returns [] when observations is not an array', () => {
    expect(
      _test.safeParseObservationsResponse('{"observations": "nope"}'),
    ).toEqual([]);
  });

  it('parses a valid response', () => {
    const result = _test.safeParseObservationsResponse(
      JSON.stringify({
        observations: [{ icon: '+', content: 'Good' }],
      }),
    );
    expect(result).toEqual([{ type: 'observation', icon: '+', content: 'Good' }]);
  });
});
