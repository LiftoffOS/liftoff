// Thread title generation tests.
//
// Covers per the implementation plan (C7):
//   - LLM call uses tier: 'small' and maxTokens 80
//   - updateTitle callback contract: called with (threadId, tenantId, title)
//     on success; NOT called on LLM error / parse error / empty title
//   - Sanitization: clamp to 500 chars, strip control chars
//   - Prompt construction: assistant message truncated to 500 chars,
//     short messages passed through unchanged
//   - usageContext: purpose default + override + agentId forwarding
//   - System prompt includes prompt-injection and PII defenses
//   - Error logging includes threadId, tenantId, agentId

jest.mock('../../llm', () => ({
  llmClient: {
    complete: jest.fn(),
  },
}));

const mockLog = {
  warn: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};
jest.mock('../../infrastructure/logging', () => ({
  log: mockLog,
}));

import { llmClient } from '../../llm';
import { maybeGenerateThreadTitle, type UpdateTitleFn } from '../thread-title-generation';

const llmComplete = llmClient.complete as jest.Mock;

const baseInput = (overrides: Partial<{
  threadId: string;
  tenantId: string;
  agentId: string;
  purpose: string;
  userMessage: string;
  assistantMessage: string;
  updateTitle: UpdateTitleFn;
}> = {}) => ({
  threadId: 'thread-1',
  tenantId: 'tenant-1',
  userMessage: 'How much did agent X cost last week?',
  assistantMessage: 'Agent X cost $42.13 last week, mostly from inbound webhooks.',
  updateTitle: jest.fn().mockResolvedValue(undefined) as UpdateTitleFn,
  ...overrides,
});

function llmReturning(title: string) {
  llmComplete.mockResolvedValue({
    content: JSON.stringify({ title }),
    model: 'claude-haiku-4-5',
    provider: 'anthropic',
    usage: { inputTokens: 50, outputTokens: 10 },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('maybeGenerateThreadTitle — LLM request shape', () => {
  it('uses tier: small (no explicit model — provider picks Haiku/nano/flash-lite)', async () => {
    llmReturning('Salesforce Sync cost spike investigation');
    await maybeGenerateThreadTitle(baseInput());

    expect(llmComplete).toHaveBeenCalledTimes(1);
    const [request] = llmComplete.mock.calls[0];
    expect(request.tier).toBe('small');
    expect(request.model).toBeUndefined();
  });

  it('passes maxTokens: 80 (room for JSON wrapper + 12-word title)', async () => {
    llmReturning('Title');
    await maybeGenerateThreadTitle(baseInput());

    const [request] = llmComplete.mock.calls[0];
    expect(request.maxTokens).toBe(80);
  });

  it('uses responseSchema for structured output', async () => {
    llmReturning('Title');
    await maybeGenerateThreadTitle(baseInput());

    const [request] = llmComplete.mock.calls[0];
    expect(request.responseSchema).toMatchObject({
      name: 'thread_title',
      schema: expect.objectContaining({
        type: 'object',
        properties: expect.objectContaining({ title: { type: 'string' } }),
        required: ['title'],
      }),
    });
  });
});

describe('maybeGenerateThreadTitle — usageContext / cost attribution', () => {
  it('defaults purpose to thread_title_generation when not specified', async () => {
    llmReturning('Title');
    await maybeGenerateThreadTitle(baseInput());

    const [, , context] = llmComplete.mock.calls[0];
    expect(context).toEqual({
      tenantId: 'tenant-1',
      threadId: 'thread-1',
      purpose: 'thread_title_generation',
    });
  });

  it('uses caller-provided purpose override (CAIO routes to Workforce Planning)', async () => {
    llmReturning('Title');
    await maybeGenerateThreadTitle(
      baseInput({ purpose: 'caio_workforce_planning_title_generation' }),
    );

    const [, , context] = llmComplete.mock.calls[0];
    expect(context.purpose).toBe('caio_workforce_planning_title_generation');
  });

  it('passes agentId in usageContext when provided (lands in interactions bucket)', async () => {
    llmReturning('Title');
    await maybeGenerateThreadTitle(baseInput({ agentId: 'agent-42' }));

    const [, , context] = llmComplete.mock.calls[0];
    expect(context).toEqual({
      tenantId: 'tenant-1',
      threadId: 'thread-1',
      purpose: 'thread_title_generation',
      agentId: 'agent-42',
    });
  });

  it('omits agentId from usageContext when not provided (insights/CAIO case)', async () => {
    llmReturning('Title');
    await maybeGenerateThreadTitle(baseInput());

    const [, , context] = llmComplete.mock.calls[0];
    expect(context).not.toHaveProperty('agentId');
  });
});

describe('maybeGenerateThreadTitle — system prompt defenses', () => {
  it('includes prompt-injection defense (ignore embedded instructions)', async () => {
    llmReturning('Title');
    await maybeGenerateThreadTitle(baseInput());

    const [request] = llmComplete.mock.calls[0];
    const systemPrompt = request.messages[0].content;
    expect(systemPrompt).toMatch(/ignore any instructions/i);
  });

  it('includes PII avoidance instruction', async () => {
    llmReturning('Title');
    await maybeGenerateThreadTitle(baseInput());

    const [request] = llmComplete.mock.calls[0];
    const systemPrompt = request.messages[0].content;
    expect(systemPrompt).toMatch(/personally identifiable information/i);
  });
});

describe('maybeGenerateThreadTitle — assistant message truncation', () => {
  it('truncates assistant message to 500 chars in the user prompt', async () => {
    llmReturning('Title');
    const longAssistant = 'a'.repeat(2000);
    await maybeGenerateThreadTitle(baseInput({ assistantMessage: longAssistant }));

    const [request] = llmComplete.mock.calls[0];
    const userPrompt = request.messages[1].content;
    // The user prompt embeds the truncated assistant text — verify it doesn't
    // contain anything past the 500-char window.
    expect(userPrompt).toContain('a'.repeat(500));
    expect(userPrompt).not.toContain('a'.repeat(501));
  });

  it('passes short assistant messages through unchanged', async () => {
    llmReturning('Title');
    const shortAssistant = 'A short answer.';
    await maybeGenerateThreadTitle(baseInput({ assistantMessage: shortAssistant }));

    const [request] = llmComplete.mock.calls[0];
    expect(request.messages[1].content).toContain(shortAssistant);
  });
});

describe('maybeGenerateThreadTitle — sanitization', () => {
  it('clamps title to 500 characters before persisting', async () => {
    llmReturning('x'.repeat(600));
    const updateTitle = jest.fn().mockResolvedValue(undefined);
    await maybeGenerateThreadTitle(baseInput({ updateTitle }));

    expect(updateTitle).toHaveBeenCalledWith('thread-1', 'tenant-1', 'x'.repeat(500));
  });

  it('strips control characters from the title', async () => {
    llmReturning('\x00Hello\x1FWorld\x7F');
    const updateTitle = jest.fn().mockResolvedValue(undefined);
    await maybeGenerateThreadTitle(baseInput({ updateTitle }));

    expect(updateTitle).toHaveBeenCalledWith('thread-1', 'tenant-1', 'HelloWorld');
  });
});

describe('maybeGenerateThreadTitle — updateTitle callback contract', () => {
  it('calls updateTitle with (threadId, tenantId, title) on success', async () => {
    llmReturning('Salesforce Sync cost spike investigation');
    const updateTitle = jest.fn().mockResolvedValue(undefined);
    await maybeGenerateThreadTitle(baseInput({ updateTitle }));

    expect(updateTitle).toHaveBeenCalledTimes(1);
    expect(updateTitle).toHaveBeenCalledWith(
      'thread-1',
      'tenant-1',
      'Salesforce Sync cost spike investigation',
    );
  });

  it('does NOT call updateTitle when the LLM call throws', async () => {
    llmComplete.mockRejectedValue(new Error('provider down'));
    const updateTitle = jest.fn().mockResolvedValue(undefined);
    await maybeGenerateThreadTitle(baseInput({ updateTitle }));

    expect(updateTitle).not.toHaveBeenCalled();
  });

  it('does NOT call updateTitle when JSON.parse fails', async () => {
    llmComplete.mockResolvedValue({
      content: 'not-json{{{',
      model: 'claude-haiku-4-5',
      provider: 'anthropic',
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    const updateTitle = jest.fn().mockResolvedValue(undefined);
    await maybeGenerateThreadTitle(baseInput({ updateTitle }));

    expect(updateTitle).not.toHaveBeenCalled();
  });

  it('does NOT call updateTitle when the LLM returns an empty title', async () => {
    llmReturning('');
    const updateTitle = jest.fn().mockResolvedValue(undefined);
    await maybeGenerateThreadTitle(baseInput({ updateTitle }));

    expect(updateTitle).not.toHaveBeenCalled();
  });

  it('does NOT call updateTitle when the LLM returns whitespace-only', async () => {
    llmReturning('     ');
    const updateTitle = jest.fn().mockResolvedValue(undefined);
    await maybeGenerateThreadTitle(baseInput({ updateTitle }));

    expect(updateTitle).not.toHaveBeenCalled();
  });
});

describe('maybeGenerateThreadTitle — error handling', () => {
  it('never throws — swallows LLM errors so the chat is unaffected', async () => {
    llmComplete.mockRejectedValue(new Error('provider down'));
    await expect(maybeGenerateThreadTitle(baseInput())).resolves.toBeUndefined();
  });

  it('never throws — swallows updateTitle errors too', async () => {
    llmReturning('Title');
    const updateTitle = jest.fn().mockRejectedValue(new Error('db down'));
    await expect(maybeGenerateThreadTitle(baseInput({ updateTitle }))).resolves.toBeUndefined();
  });

  it('logs threadId, tenantId, and agentId on failure', async () => {
    llmComplete.mockRejectedValue(new Error('boom'));
    await maybeGenerateThreadTitle(baseInput({ agentId: 'agent-9' }));

    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'thread-1',
        tenantId: 'tenant-1',
        agentId: 'agent-9',
        error: 'boom',
      }),
      expect.stringContaining('Thread title generation failed'),
    );
  });
});
