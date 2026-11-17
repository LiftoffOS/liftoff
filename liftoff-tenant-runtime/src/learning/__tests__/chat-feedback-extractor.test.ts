const mockQuery = jest.fn();
const mockSaveMemory = jest.fn().mockResolvedValue({ memoryId: 'mem-new', deduplicated: false });
const mockLlmComplete = jest.fn();
const mockGetModelForTask = jest.fn().mockResolvedValue(null);

jest.mock('../../entitlements-client/service', () => ({
  getEntitlementsClient: () => ({ getModelForTask: mockGetModelForTask }),
}));
jest.mock('../../infrastructure/database', () => ({
  getPoolForService: () => ({ query: mockQuery }),
}));

jest.mock('../../memory/service', () => ({
  memoryService: { saveMemory: (...args: any[]) => mockSaveMemory(...args) },
}));

jest.mock('../../llm/client', () => ({
  llmClient: { modelSelectionFor: (p: any) => (p?.model ? { provider: p.provider ?? 'anthropic', model: p.model } : (p?.provider ? { provider: p.provider } : {})), complete: (...args: any[]) => mockLlmComplete(...args) },
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { extractChatFeedback } from '../chat-feedback-extractor';

const VALID_EXTRACTION = JSON.stringify({
  learnings: [
    {
      category: 'correction',
      summary: 'Always CC compliance when sending legal emails',
      confidence: 0.9,
      suggestedAction: 'memory',
    },
  ],
});

const FEEDBACK_ITEMS = [
  { id: 'fb-1', tenant_id: 'tenant-1', agent_id: 'agent-1', thread_id: 'th-1', message_id: 'msg-1', feedback_type: 'correction', content: 'You forgot to CC compliance', user_id: 'user-1', created_at: new Date() },
  { id: 'fb-2', tenant_id: 'tenant-1', agent_id: 'agent-1', thread_id: 'th-1', message_id: 'msg-2', feedback_type: 'correction', content: 'This happened again', user_id: 'user-1', created_at: new Date() },
  { id: 'fb-3', tenant_id: 'tenant-1', agent_id: 'agent-1', thread_id: 'th-2', message_id: 'msg-3', feedback_type: 'correction', content: 'Third instance', user_id: 'user-1', created_at: new Date() },
];

function setupMocks(overrides: { items?: any[]; llmResponse?: string; agentRows?: any[] } = {}) {
  const agentRows = overrides.agentRows ?? [{ agent_id: 'agent-1', item_count: '3' }];
  const items = overrides.items ?? FEEDBACK_ITEMS;
  const llmResponse = overrides.llmResponse ?? VALID_EXTRACTION;

  mockQuery
    .mockResolvedValueOnce({ rows: agentRows })         // agents with feedback
    .mockResolvedValueOnce({ rows: items })              // fetch items for agent
    .mockResolvedValueOnce({ rows: [] })                 // mark processed
    .mockResolvedValueOnce({ rows: [] });                // any extra queries

  mockLlmComplete.mockResolvedValueOnce({ content: llmResponse });
}

beforeEach(() => {
  jest.resetAllMocks();
  // Re-apply the persistent resolved value that was wiped by resetAllMocks
  mockSaveMemory.mockResolvedValue({ memoryId: 'mem-new', deduplicated: false });
});

describe('extractChatFeedback', () => {
  it('returns early with zero counts when no agents have enough feedback', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const result = await extractChatFeedback('tenant-1');
    expect(result).toEqual({
      agentsProcessed: 0,
      feedbackItemsProcessed: 0,
      memoriesCreated: 0,
      suggestionsCreated: 0,
      errors: 0,
    });
    expect(mockSaveMemory).not.toHaveBeenCalled();
  });

  it('auto-applies high-confidence memory learning with correct source', async () => {
    setupMocks();
    const result = await extractChatFeedback('tenant-1');

    expect(result.memoriesCreated).toBe(1);
    expect(mockSaveMemory).toHaveBeenCalledTimes(1);

    const saveCall = mockSaveMemory.mock.calls[0][0];
    expect(saveCall.tenantId).toBe('tenant-1');
    expect(saveCall.agentId).toBe('agent-1');
    expect(saveCall.layer).toBe('individual');
    expect(saveCall.content).toBe('Always CC compliance when sending legal emails');

    // Provenance source
    expect(saveCall.source).toBeDefined();
    expect(saveCall.source.nodeType).toBe('chat_feedback');
    expect(typeof saveCall.source.refId).toBe('string'); // batchId UUID
    expect(saveCall.source.agentId).toBe('agent-1');
    expect(saveCall.source.metadata.feedbackItemIds).toEqual(['fb-1', 'fb-2', 'fb-3']);
    expect(saveCall.source.metadata.learningCategory).toBe('correction');
  });

  it('all auto-applied memories in one batch share the same batchId (refId)', async () => {
    const multiLearning = JSON.stringify({
      learnings: [
        { category: 'correction', summary: 'Lesson 1', confidence: 0.9, suggestedAction: 'memory' },
        { category: 'preference', summary: 'Lesson 2', confidence: 0.85, suggestedAction: 'memory' },
      ],
    });
    mockQuery
      .mockResolvedValueOnce({ rows: [{ agent_id: 'agent-1', item_count: '3' }] })
      .mockResolvedValueOnce({ rows: FEEDBACK_ITEMS })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    mockLlmComplete.mockResolvedValueOnce({ content: multiLearning });

    await extractChatFeedback('tenant-1');
    expect(mockSaveMemory).toHaveBeenCalledTimes(2);

    const batchId1 = mockSaveMemory.mock.calls[0][0].source.refId;
    const batchId2 = mockSaveMemory.mock.calls[1][0].source.refId;
    expect(batchId1).toBe(batchId2);
    expect(typeof batchId1).toBe('string');
    expect(batchId1.length).toBeGreaterThan(0);
  });

  it('routes low-confidence memory learnings to suggestions (no saveMemory)', async () => {
    const lowConfidence = JSON.stringify({
      learnings: [{ category: 'correction', summary: 'Low confidence', confidence: 0.7, suggestedAction: 'memory' }],
    });
    mockQuery
      .mockResolvedValueOnce({ rows: [{ agent_id: 'agent-1', item_count: '3' }] })
      .mockResolvedValueOnce({ rows: FEEDBACK_ITEMS })
      .mockResolvedValueOnce({ rows: [] }) // reflection_suggestions insert
      .mockResolvedValueOnce({ rows: [] }); // mark processed
    mockLlmComplete.mockResolvedValueOnce({ content: lowConfidence });

    const result = await extractChatFeedback('tenant-1');
    expect(result.memoriesCreated).toBe(0);
    expect(result.suggestionsCreated).toBe(1);
    expect(mockSaveMemory).not.toHaveBeenCalled();
  });

  it('skips no_action learnings', async () => {
    const noAction = JSON.stringify({
      learnings: [{ category: 'positive', summary: 'Good job', confidence: 0.95, suggestedAction: 'no_action' }],
    });
    mockQuery
      .mockResolvedValueOnce({ rows: [{ agent_id: 'agent-1', item_count: '3' }] })
      .mockResolvedValueOnce({ rows: FEEDBACK_ITEMS })
      .mockResolvedValueOnce({ rows: [] }); // mark processed
    mockLlmComplete.mockResolvedValueOnce({ content: noAction });

    const result = await extractChatFeedback('tenant-1');
    expect(result.memoriesCreated).toBe(0);
    expect(result.suggestionsCreated).toBe(0);
    expect(mockSaveMemory).not.toHaveBeenCalled();
  });

  it('processes multiple agents and aggregates results', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ agent_id: 'agent-1', item_count: '3' }, { agent_id: 'agent-2', item_count: '4' }] })
      .mockResolvedValueOnce({ rows: FEEDBACK_ITEMS })          // agent-1 items
      .mockResolvedValueOnce({ rows: [] })                      // agent-1 mark processed
      .mockResolvedValueOnce({ rows: FEEDBACK_ITEMS })          // agent-2 items
      .mockResolvedValueOnce({ rows: [] });                     // agent-2 mark processed
    mockLlmComplete
      .mockResolvedValueOnce({ content: VALID_EXTRACTION })
      .mockResolvedValueOnce({ content: VALID_EXTRACTION });

    const result = await extractChatFeedback('tenant-1');
    expect(result.agentsProcessed).toBe(2);
    expect(result.memoriesCreated).toBe(2);
    expect(mockSaveMemory).toHaveBeenCalledTimes(2);
  });
});

describe('extractChatFeedback — glossary alias extraction (Change 4c)', () => {
  it('persists each extracted alias as a global type:alias glossary memory (tab-delimited)', async () => {
    setupMocks({
      llmResponse: JSON.stringify({
        learnings: [],
        aliases: [
          { alias: 'PSR', canonical: 'Pipeline Status Report' },
          { alias: 'Phoenix', canonical: 'the database migration project' },
        ],
      }),
    });

    const result = await extractChatFeedback('tenant-1');

    const aliasCalls = mockSaveMemory.mock.calls
      .map(c => c[0])
      .filter(a => (a.tags ?? []).includes('type:alias'));
    expect(aliasCalls).toHaveLength(2);

    const psr = aliasCalls.find(a => a.content.startsWith('PSR'));
    expect(psr).toBeDefined();
    expect(psr.layer).toBe('global');
    expect(psr.scopeKey).toBe('glossary');
    expect(psr.content).toBe('PSR\tPipeline Status Report');
    expect(psr.tags).toEqual(['type:alias']);
    expect(psr.source.nodeType).toBe('chat_feedback');
    expect(psr.source.metadata.aliasFrom).toBe('chat-feedback');
    expect(result.memoriesCreated).toBe(2);
  });

  it('skips malformed aliases (missing alias or canonical)', async () => {
    setupMocks({
      llmResponse: JSON.stringify({
        learnings: [],
        aliases: [
          { alias: 'PSR', canonical: '' },
          { alias: '', canonical: 'Pipeline Status Report' },
        ],
      }),
    });

    await extractChatFeedback('tenant-1');

    const aliasCalls = mockSaveMemory.mock.calls
      .map(c => c[0])
      .filter(a => (a.tags ?? []).includes('type:alias'));
    expect(aliasCalls).toHaveLength(0);
  });

  it('does not write aliases when the LLM omits the field', async () => {
    setupMocks({ llmResponse: JSON.stringify({ learnings: [] }) });
    await extractChatFeedback('tenant-1');
    const aliasCalls = mockSaveMemory.mock.calls
      .map(c => c[0])
      .filter(a => (a.tags ?? []).includes('type:alias'));
    expect(aliasCalls).toHaveLength(0);
  });
});
