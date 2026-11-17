// Conversation summarization tests
//
// Covers:
//   - shouldSummarize() threshold + interval logic
//   - generateRollingSummary() happy path with mocked LLM
//   - generateRollingSummary() falls back to previous summary on LLM error
//   - generateRollingSummary() only summarizes older messages (excludes last 6)
//   - formatSummaryForPrompt() text rendering

jest.mock('../../llm', () => ({
  llmClient: {
    complete: jest.fn(),
  },
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { llmClient } from '../../llm';
import {
  shouldSummarize,
  generateRollingSummary,
  formatSummaryForPrompt,
  type SummarizationInput,
  type SummarizationMessage,
} from '../conversation-summarization';
import type { ConversationSummary } from '../types';

const llmComplete = llmClient.complete as jest.Mock;

function makeMessages(count: number, startCreatedAt = Date.parse('2026-04-01T00:00:00Z')): SummarizationMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `msg-${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: i % 2 === 0 ? `Question ${i}` : `Answer ${i}`,
    createdAt: new Date(startCreatedAt + i * 60_000).toISOString(),
  }));
}

const FAKE_LLM_RESPONSE = {
  content: JSON.stringify({
    user_intent: 'Investigating cost spike on Salesforce Sync',
    key_facts: ['Cost spiked 34% week-over-week starting 2026-03-15'],
    open_questions: ['Was there a config change on 2026-03-15?'],
    previous_findings: ['Top cost driver: extra retries from rate limiting'],
    next_steps: ['Compare against pre-March connector_health'],
  }),
  model: 'claude-sonnet-4-6',
  provider: 'anthropic' as const,
  usage: { inputTokens: 500, outputTokens: 150 },
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('shouldSummarize', () => {
  it('returns false for threads under the threshold', () => {
    const input: SummarizationInput = {
      threadId: 't1',
      tenantId: 'tenant',
      allMessages: makeMessages(9),
      previousSummary: null,
    };
    expect(shouldSummarize(input)).toBe(false);
  });

  it('returns true for threads at the threshold with no previous summary', () => {
    const input: SummarizationInput = {
      threadId: 't1',
      tenantId: 'tenant',
      allMessages: makeMessages(10),
      previousSummary: null,
    };
    expect(shouldSummarize(input)).toBe(true);
  });

  it('returns false when less than SUMMARIZATION_INTERVAL (5) new messages since last summary', () => {
    const prevSummary: ConversationSummary = {
      userIntent: 'old',
      keyFacts: [],
      openQuestions: [],
      previousFindings: [],
      nextSteps: [],
      summarizedThrough: new Date().toISOString(),
      messageCount: 10,
    };
    const input: SummarizationInput = {
      threadId: 't1',
      tenantId: 'tenant',
      allMessages: makeMessages(14), // only 4 new since last summary
      previousSummary: prevSummary,
    };
    expect(shouldSummarize(input)).toBe(false);
  });

  it('returns true once SUMMARIZATION_INTERVAL new messages have accumulated', () => {
    const prevSummary: ConversationSummary = {
      userIntent: 'old',
      keyFacts: [],
      openQuestions: [],
      previousFindings: [],
      nextSteps: [],
      summarizedThrough: new Date().toISOString(),
      messageCount: 10,
    };
    const input: SummarizationInput = {
      threadId: 't1',
      tenantId: 'tenant',
      allMessages: makeMessages(15), // 5 new
      previousSummary: prevSummary,
    };
    expect(shouldSummarize(input)).toBe(true);
  });
});

describe('generateRollingSummary', () => {
  it('returns parsed ConversationSummary on successful LLM call', async () => {
    llmComplete.mockResolvedValue(FAKE_LLM_RESPONSE);

    const messages = makeMessages(12);
    const result = await generateRollingSummary({
      threadId: 't1',
      tenantId: 'tenant',
      allMessages: messages,
      previousSummary: null,
    });

    expect(result).not.toBeNull();
    expect(result?.userIntent).toBe('Investigating cost spike on Salesforce Sync');
    expect(result?.keyFacts).toEqual(['Cost spiked 34% week-over-week starting 2026-03-15']);
    expect(result?.openQuestions).toEqual(['Was there a config change on 2026-03-15?']);
    expect(result?.previousFindings).toEqual(['Top cost driver: extra retries from rate limiting']);
    expect(result?.nextSteps).toEqual(['Compare against pre-March connector_health']);
    // Covered messages = 12 - 6 (recent) = 6
    expect(result?.messageCount).toBe(6);
    // summarizedThrough should be the 6th message's timestamp
    expect(result?.summarizedThrough).toBe(messages[5].createdAt);
  });

  it('excludes the last 6 messages from summarization (they go in raw history)', async () => {
    llmComplete.mockResolvedValue(FAKE_LLM_RESPONSE);
    const messages = makeMessages(20);

    await generateRollingSummary({
      threadId: 't1',
      tenantId: 'tenant',
      allMessages: messages,
      previousSummary: null,
    });

    // Inspect the prompt that was sent to the LLM
    expect(llmComplete).toHaveBeenCalledTimes(1);
    const [request] = llmComplete.mock.calls[0];
    const userMessage = request.messages.find((m: { role: string }) => m.role === 'user');
    const userContent = userMessage?.content ?? '';

    // Messages 0..13 should be in the summary, 14..19 should NOT be
    expect(userContent).toContain('Question 0');
    expect(userContent).toContain('Answer 13');
    expect(userContent).not.toContain('Question 14');
    expect(userContent).not.toContain('Answer 19');
  });

  it('falls back to previous summary when LLM call throws', async () => {
    llmComplete.mockRejectedValue(new Error('provider unavailable'));

    const prevSummary: ConversationSummary = {
      userIntent: 'previous intent',
      keyFacts: ['prev fact'],
      openQuestions: [],
      previousFindings: [],
      nextSteps: [],
      summarizedThrough: '2026-04-01T00:00:00Z',
      messageCount: 8,
    };

    const result = await generateRollingSummary({
      threadId: 't1',
      tenantId: 'tenant',
      allMessages: makeMessages(15),
      previousSummary: prevSummary,
    });

    expect(result).toEqual(prevSummary);
  });

  it('falls back to previous summary on malformed JSON from the LLM', async () => {
    llmComplete.mockResolvedValue({
      ...FAKE_LLM_RESPONSE,
      content: 'not valid json at all',
    });

    const prevSummary: ConversationSummary = {
      userIntent: 'prev',
      keyFacts: [],
      openQuestions: [],
      previousFindings: [],
      nextSteps: [],
      summarizedThrough: '2026-04-01T00:00:00Z',
      messageCount: 5,
    };

    const result = await generateRollingSummary({
      threadId: 't1',
      tenantId: 'tenant',
      allMessages: makeMessages(12),
      previousSummary: prevSummary,
    });

    expect(result).toEqual(prevSummary);
  });

  it('returns previous summary (without calling LLM) when there are 6 or fewer messages', async () => {
    // With 6 messages, toSummarize = 6 - 6 = 0 messages → skip LLM
    const result = await generateRollingSummary({
      threadId: 't1',
      tenantId: 'tenant',
      allMessages: makeMessages(6),
      previousSummary: null,
    });
    expect(result).toBeNull();
    expect(llmComplete).not.toHaveBeenCalled();
  });

  it('passes insights_summarization purpose by default in the usage context for llm_usage_log', async () => {
    llmComplete.mockResolvedValue(FAKE_LLM_RESPONSE);

    await generateRollingSummary({
      threadId: 't1',
      tenantId: 'tenant-abc',
      allMessages: makeMessages(12),
      previousSummary: null,
    });

    expect(llmComplete).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      expect.objectContaining({
        tenantId: 'tenant-abc',
        purpose: 'insights_summarization',
      }),
    );
  });

  it('honors a caller-provided purpose override (used by CAIO chat)', async () => {
    llmComplete.mockResolvedValue(FAKE_LLM_RESPONSE);

    await generateRollingSummary({
      threadId: 't1',
      tenantId: 'tenant-abc',
      allMessages: makeMessages(12),
      previousSummary: null,
      purpose: 'caio_workforce_planning_summarization',
    });

    expect(llmComplete).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      expect.objectContaining({
        tenantId: 'tenant-abc',
        purpose: 'caio_workforce_planning_summarization',
      }),
    );
  });

  it('passes responseSchema so the LLM returns structured JSON', async () => {
    llmComplete.mockResolvedValue(FAKE_LLM_RESPONSE);

    await generateRollingSummary({
      threadId: 't1',
      tenantId: 'tenant',
      allMessages: makeMessages(12),
      previousSummary: null,
    });

    const [request] = llmComplete.mock.calls[0];
    expect(request.responseSchema).toBeDefined();
    expect(request.responseSchema.name).toBe('conversation_summary');
    expect(request.responseSchema.schema.required).toEqual([
      'user_intent',
      'key_facts',
      'open_questions',
      'previous_findings',
      'next_steps',
    ]);
  });

  it('includes the previous summary in the LLM prompt so it extends rather than restarts', async () => {
    llmComplete.mockResolvedValue(FAKE_LLM_RESPONSE);

    const prevSummary: ConversationSummary = {
      userIntent: 'Previously investigating something specific',
      keyFacts: ['Fact A', 'Fact B'],
      openQuestions: [],
      previousFindings: [],
      nextSteps: [],
      summarizedThrough: '2026-04-01T00:00:00Z',
      messageCount: 8,
    };

    await generateRollingSummary({
      threadId: 't1',
      tenantId: 'tenant',
      allMessages: makeMessages(15),
      previousSummary: prevSummary,
    });

    const [request] = llmComplete.mock.calls[0];
    const userMessage = request.messages.find((m: { role: string }) => m.role === 'user');
    expect(userMessage.content).toContain('PREVIOUS SUMMARY');
    expect(userMessage.content).toContain('Previously investigating something specific');
  });
});

describe('formatSummaryForPrompt', () => {
  it('renders all sections when all fields are populated', () => {
    const summary: ConversationSummary = {
      userIntent: 'Investigating agent costs',
      keyFacts: ['Cost up 20%', 'Errors up 50%'],
      openQuestions: ['Why the spike?'],
      previousFindings: ['Related to deploy on Monday'],
      nextSteps: ['Check deploy logs'],
      summarizedThrough: '2026-04-05T12:00:00Z',
      messageCount: 8,
    };
    const text = formatSummaryForPrompt(summary);
    expect(text).toContain('User intent: Investigating agent costs');
    expect(text).toContain('Key facts:\n- Cost up 20%\n- Errors up 50%');
    expect(text).toContain('Previous findings:\n- Related to deploy on Monday');
    expect(text).toContain('Open questions:\n- Why the spike?');
    expect(text).toContain('Suggested next steps:\n- Check deploy logs');
  });

  it('omits empty sections', () => {
    const summary: ConversationSummary = {
      userIntent: 'Just asking',
      keyFacts: [],
      openQuestions: [],
      previousFindings: [],
      nextSteps: [],
      summarizedThrough: '2026-04-05T12:00:00Z',
      messageCount: 8,
    };
    const text = formatSummaryForPrompt(summary);
    expect(text).toBe('User intent: Just asking');
    expect(text).not.toContain('Key facts');
    expect(text).not.toContain('Open questions');
  });
});
