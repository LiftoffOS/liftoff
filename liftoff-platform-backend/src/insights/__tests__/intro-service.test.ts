// Intro service tests
//
// Mirrors observation-service.test.ts. Covers happy path, the
// "degrades to null on failure" contract, and each helper function
// (hasMeaningfulData, summarizer, JSON parser, period label).

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
import { _test, generateInsightsIntro } from '../intro-service';
import type { VisualizationBlock } from '../shared-types';

const llmComplete = llmClient.complete as jest.Mock;
const mockGenerateReport = generateReport as jest.Mock;

const METRIC_BLOCK = {
  type: 'metric_card' as const,
  label: 'Tasks Completed',
  value: '1,245',
  trend: 'up' as const,
  trendText: '+12% vs previous period',
};

const BAR_BLOCK = {
  type: 'bar_chart' as const,
  title: 'AI Workforce Activity',
  data: [
    { label: 'Salesforce Sync', value: 420 },
    { label: 'Inbox Triage', value: 305 },
  ],
};

const REPORT_WITH_DATA: VisualizationBlock[] = [
  METRIC_BLOCK,
  BAR_BLOCK,
];

const EMPTY_REPORT: VisualizationBlock[] = [
  METRIC_BLOCK,
  { type: 'text', content: 'No data yet. Start by creating agents.' },
];

const FAKE_LLM_RESPONSE = {
  content: JSON.stringify({
    intro:
      'Salesforce Sync owned the week, handling 420 of your 725 completed tasks while costs ticked down 7% — your AI throughput is improving.',
  }),
  model: 'claude-sonnet-4-6',
  provider: 'anthropic' as const,
  usage: { inputTokens: 200, outputTokens: 60 },
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('generateInsightsIntro — happy path', () => {
  it('returns the parsed intro string when the LLM responds with valid JSON', async () => {
    mockGenerateReport.mockResolvedValue(REPORT_WITH_DATA);
    llmComplete.mockResolvedValue(FAKE_LLM_RESPONSE);

    const result = await generateInsightsIntro('tenant-1', { preset: 'this_week' });

    expect(result).toBe(
      'Salesforce Sync owned the week, handling 420 of your 725 completed tasks while costs ticked down 7% — your AI throughput is improving.',
    );
  });

  it('passes insights_intro as the llm_usage_log purpose', async () => {
    mockGenerateReport.mockResolvedValue(REPORT_WITH_DATA);
    llmComplete.mockResolvedValue(FAKE_LLM_RESPONSE);

    await generateInsightsIntro('tenant-1', { preset: 'this_week' });

    expect(llmComplete).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      expect.objectContaining({
        tenantId: 'tenant-1',
        purpose: 'insights_intro',
      }),
    );
  });

  it('uses responseSchema so the LLM returns structured JSON', async () => {
    mockGenerateReport.mockResolvedValue(REPORT_WITH_DATA);
    llmComplete.mockResolvedValue(FAKE_LLM_RESPONSE);

    await generateInsightsIntro('tenant-1', { preset: 'this_week' });

    const request = llmComplete.mock.calls[0][0];
    expect(request.responseSchema).toBeDefined();
    expect(request.responseSchema.name).toBe('insights_intro');
    expect(request.responseSchema.schema.required).toEqual(['intro']);
  });

  it('passes the period label into the user prompt', async () => {
    mockGenerateReport.mockResolvedValue(REPORT_WITH_DATA);
    llmComplete.mockResolvedValue(FAKE_LLM_RESPONSE);

    await generateInsightsIntro('tenant-1', { preset: 'last_quarter' });

    const request = llmComplete.mock.calls[0][0];
    const userMsg = request.messages.find((m: { role: string }) => m.role === 'user');
    expect(userMsg.content).toContain('Period: last quarter');
  });
});

describe('generateInsightsIntro — graceful degradation', () => {
  it('returns null when generateReport throws', async () => {
    mockGenerateReport.mockRejectedValue(new Error('db connection lost'));
    const result = await generateInsightsIntro('t', { preset: 'this_week' });
    expect(result).toBeNull();
    expect(llmComplete).not.toHaveBeenCalled();
  });

  it('returns null when the report has no meaningful data (no LLM call made)', async () => {
    mockGenerateReport.mockResolvedValue(EMPTY_REPORT);
    const result = await generateInsightsIntro('t', { preset: 'this_week' });
    expect(result).toBeNull();
    expect(llmComplete).not.toHaveBeenCalled();
  });

  it('returns null when the LLM call throws', async () => {
    mockGenerateReport.mockResolvedValue(REPORT_WITH_DATA);
    llmComplete.mockRejectedValue(new Error('provider timeout'));
    const result = await generateInsightsIntro('t', { preset: 'this_week' });
    expect(result).toBeNull();
  });

  it('returns null on malformed JSON response', async () => {
    mockGenerateReport.mockResolvedValue(REPORT_WITH_DATA);
    llmComplete.mockResolvedValue({
      ...FAKE_LLM_RESPONSE,
      content: 'not valid json',
    });
    const result = await generateInsightsIntro('t', { preset: 'this_week' });
    expect(result).toBeNull();
  });

  it('returns null when intro field is missing', async () => {
    mockGenerateReport.mockResolvedValue(REPORT_WITH_DATA);
    llmComplete.mockResolvedValue({
      ...FAKE_LLM_RESPONSE,
      content: JSON.stringify({ wrongField: 'oops' }),
    });
    const result = await generateInsightsIntro('t', { preset: 'this_week' });
    expect(result).toBeNull();
  });

  it('returns null when intro is empty after trimming', async () => {
    mockGenerateReport.mockResolvedValue(REPORT_WITH_DATA);
    llmComplete.mockResolvedValue({
      ...FAKE_LLM_RESPONSE,
      content: JSON.stringify({ intro: '   \n  \t  ' }),
    });
    const result = await generateInsightsIntro('t', { preset: 'this_week' });
    expect(result).toBeNull();
  });

  it('truncates intro at 280 chars with ellipsis if the LLM ignores the cap', async () => {
    const longIntro = 'A'.repeat(400);
    mockGenerateReport.mockResolvedValue(REPORT_WITH_DATA);
    llmComplete.mockResolvedValue({
      ...FAKE_LLM_RESPONSE,
      content: JSON.stringify({ intro: longIntro }),
    });
    const result = await generateInsightsIntro('t', { preset: 'this_week' });
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(281); // 280 + ellipsis
    expect(result!.endsWith('…')).toBe(true);
  });
});

describe('_test.hasMeaningfulData', () => {
  it('returns true when a bar chart has rows', () => {
    expect(_test.hasMeaningfulData([BAR_BLOCK])).toBe(true);
  });

  it('returns false when only metric cards are present', () => {
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
  it('includes metric card labels with trend text', () => {
    const text = _test.summarizeBlocksForPrompt([METRIC_BLOCK]);
    expect(text).toContain('Tasks Completed: 1,245');
    expect(text).toContain('+12% vs previous period');
  });

  it('renders bar charts with label/value lines', () => {
    const text = _test.summarizeBlocksForPrompt([BAR_BLOCK]);
    expect(text).toContain('AI Workforce Activity');
    expect(text).toContain('Salesforce Sync: 420');
    expect(text).toContain('Inbox Triage: 305');
  });

  it('renders table groups with summary rows when present', () => {
    const tableBlock = {
      type: 'table' as const,
      title: 'Cost Breakdown',
      columns: [
        { key: 'category', label: 'Category' },
        { key: 'amount', label: 'Amount' },
      ],
      rows: [],
      groups: [
        {
          label: 'Salesforce Sync',
          summary: { category: 'Salesforce Sync', amount: '$845.00' },
          rows: [],
        },
      ],
    };
    const text = _test.summarizeBlocksForPrompt([tableBlock]);
    expect(text).toContain('Cost Breakdown');
    expect(text).toContain('Salesforce Sync | $845.00');
  });
});

describe('_test.formatPeriodLabel', () => {
  it('converts a preset to "this week" style', () => {
    expect(_test.formatPeriodLabel({ preset: 'this_week' })).toBe('this week');
    expect(_test.formatPeriodLabel({ preset: 'last_quarter' })).toBe('last quarter');
  });

  it('renders custom date ranges', () => {
    expect(
      _test.formatPeriodLabel({
        start: '2026-04-01T00:00:00Z',
        end: '2026-04-08T00:00:00Z',
      }),
    ).toBe('2026-04-01 to 2026-04-08');
  });

  it('falls back to "this period" for unknown shapes', () => {
    expect(_test.formatPeriodLabel({})).toBe('this period');
  });
});

describe('_test.safeParseIntroResponse', () => {
  it('returns null for malformed JSON', () => {
    expect(_test.safeParseIntroResponse('nope')).toBeNull();
  });

  it('returns null when top level is not an object', () => {
    expect(_test.safeParseIntroResponse('"a string"')).toBeNull();
  });

  it('returns null when intro is missing', () => {
    expect(_test.safeParseIntroResponse('{}')).toBeNull();
  });

  it('returns null when intro is not a string', () => {
    expect(_test.safeParseIntroResponse('{"intro": 42}')).toBeNull();
  });

  it('returns the trimmed intro on a valid response', () => {
    expect(
      _test.safeParseIntroResponse(JSON.stringify({ intro: '  Hello world.  ' })),
    ).toBe('Hello world.');
  });

  it('truncates at a word boundary close to 280 chars', () => {
    const intro = 'word '.repeat(80); // 400 chars total, plenty over the cap
    const result = _test.safeParseIntroResponse(JSON.stringify({ intro }));
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(281);
    expect(result!.endsWith('…')).toBe(true);
    // Should NOT cut a word in half — should end at "word" not "wor"
    expect(result!).not.toMatch(/wor…$/);
  });
});
