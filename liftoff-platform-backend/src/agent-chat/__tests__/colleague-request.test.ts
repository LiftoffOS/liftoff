// A team hands a change to what it IS to the Chief AI Officer: the ask is
// recorded on the one-open-proposal rail as a design proposal, stamped on the
// thread it was made in, and handed to the Chief AI Officer as a Cloud Task;
// the person's answer is carried the same way, and this rail never touches the
// team's guidance for it.

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../internal-agents/service', () => ({ internalAgentService: { getById: jest.fn(), update: jest.fn() } }));
jest.mock('../../internal-agents/redistill-service', () => ({ redistillAgent: jest.fn() }));

const mockCreateSuggestion = jest.fn();
const mockGetOpenSuggestion = jest.fn();
const mockMarkOffered = jest.fn();
const mockMarkDecided = jest.fn();
const mockClaim = jest.fn();
const mockRelease = jest.fn();
const mockClassifyResponse = jest.fn();
jest.mock('../suggestion-service', () => ({
  createSuggestion: (...a: unknown[]) => mockCreateSuggestion(...a),
  getOpenSuggestion: (...a: unknown[]) => mockGetOpenSuggestion(...a),
  markOffered: (...a: unknown[]) => mockMarkOffered(...a),
  markDecided: (...a: unknown[]) => mockMarkDecided(...a),
  claimForAcceptance: (...a: unknown[]) => mockClaim(...a),
  releaseClaim: (...a: unknown[]) => mockRelease(...a),
  classifyResponse: (...a: unknown[]) => mockClassifyResponse(...a),
  deliverSuggestion: jest.fn(),
  listAcceptedRoutineProse: jest.fn(),
}));

const mockEnqueueDesign = jest.fn();
const mockEnqueueRedistill = jest.fn();
jest.mock('../chat-turn-dispatch', () => ({
  enqueueColleagueTask: (...a: unknown[]) => mockEnqueueDesign(...a),
  enqueueRedistillAcceptTask: (...a: unknown[]) => mockEnqueueRedistill(...a),
}));
jest.mock('../chat-repository', () => ({ latestUserMessageContent: jest.fn() }));
const mockQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  withTenantScope: (_t: string, fn: (c: { query: typeof mockQuery }) => unknown) => fn({ query: mockQuery }),
}));

import { designChangeJustRegistered, pairColleagueThread, registerColleagueQuestion, registerDesignChange } from '../colleague-request';
import { handlePossibleSuggestionReply } from '../suggestion-flow';

const TENANT = '22222222-2222-2222-2222-222222222222';
const AGENT = '55555555-5555-5555-5555-555555555555';
const THREAD = '66666666-6666-6666-6666-666666666666';
const CHANGE = 'Step 3 should filter listings by price before summarising.';

beforeEach(() => {
  jest.clearAllMocks();
  mockCreateSuggestion.mockResolvedValue({ id: 's1', tenantId: TENANT, agentId: AGENT });
  mockGetOpenSuggestion.mockResolvedValue(null);
  mockMarkOffered.mockResolvedValue(undefined);
  mockMarkDecided.mockResolvedValue(undefined);
  mockEnqueueDesign.mockResolvedValue(undefined);
  mockClaim.mockResolvedValue(true);
  mockRelease.mockResolvedValue(undefined);
});

describe('registerDesignChange', () => {
  it('records a design proposal, stamps the thread, and hands the preview to the Chief AI Officer', async () => {
    const out = await registerDesignChange({ tenantId: TENANT, agentId: AGENT, threadId: THREAD, change: CHANGE, area: 'workflow' });
    expect(out).toEqual({ registered: true });
    expect(mockCreateSuggestion).toHaveBeenCalledWith(expect.objectContaining({
      proposalKind: 'design', action: 'change', routineProse: CHANGE, source: 'chat', targetLabel: 'workflow',
    }));
    expect(mockMarkOffered).toHaveBeenCalledWith(TENANT, 's1', THREAD);
    expect(mockEnqueueDesign).toHaveBeenCalledWith(
      { tenantId: TENANT, agentId: AGENT, threadId: THREAD, colleague: 'caio', phase: 'preview', request: CHANGE, suggestionId: 's1' },
      'design-preview:s1',
    );
  });

  it('answers the budget and the latch as the routine rail does', async () => {
    mockCreateSuggestion.mockResolvedValueOnce(null);
    mockGetOpenSuggestion.mockResolvedValueOnce({ id: 'other' });
    expect(await registerDesignChange({ tenantId: TENANT, agentId: AGENT, threadId: THREAD, change: CHANGE }))
      .toEqual({ registered: false, reason: 'open_proposal_exists' });
    mockCreateSuggestion.mockResolvedValueOnce(null);
    expect(await registerDesignChange({ tenantId: TENANT, agentId: AGENT, threadId: THREAD, change: CHANGE }))
      .toEqual({ registered: false, reason: 'already_offered' });
  });

  // A proposal the Chief AI Officer will never see must not hold the budget.
  it('releases the proposal when it cannot be handed over', async () => {
    mockEnqueueDesign.mockRejectedValueOnce(new Error('queue down'));
    expect(await registerDesignChange({ tenantId: TENANT, agentId: AGENT, threadId: THREAD, change: CHANGE }))
      .toEqual({ registered: false, reason: 'not_recorded' });
    expect(mockMarkDecided).toHaveBeenCalledWith(TENANT, 's1', 'cooldown', 0);
  });
});

describe('the person answers in the team\'s chat', () => {
  const design = {
    id: 's1', tenantId: TENANT, agentId: AGENT, threadId: THREAD, proposalKind: 'design', action: 'change',
    proposalText: 'x', routineProse: CHANGE, status: 'pending', dedupKey: 'k', source: 'chat', provenanceNote: null, targetLabel: null, replacesProse: null,
  };

  it('carries a yes to the Chief AI Officer and never touches guidance', async () => {
    mockGetOpenSuggestion.mockResolvedValueOnce(design);
    mockClassifyResponse.mockResolvedValueOnce({ intent: 'accept', amendment: 'but keep the old order' });
    const out = await handlePossibleSuggestionReply({ tenantId: TENANT, agentId: AGENT, threadId: THREAD, content: 'yes, but keep the old order' });
    expect(out.handled).toBe(true);
    expect(out.reply).toMatch(/Chief AI Officer/);
    expect(mockClaim).toHaveBeenCalledWith(TENANT, 's1');
    expect(mockEnqueueDesign).toHaveBeenCalledWith(
      expect.objectContaining({ colleague: 'caio', phase: 'apply', decision: 'accept', amendment: 'but keep the old order', suggestionId: 's1', request: CHANGE }),
      'design-apply:s1:accept',
    );
    expect(mockEnqueueRedistill).not.toHaveBeenCalled();
  });

  it('carries a no to the Chief AI Officer so its thread is closed truthfully', async () => {
    mockGetOpenSuggestion.mockResolvedValueOnce(design);
    mockClassifyResponse.mockResolvedValueOnce({ intent: 'decline' });
    const out = await handlePossibleSuggestionReply({ tenantId: TENANT, agentId: AGENT, threadId: THREAD, content: 'no, leave it' });
    expect(out.handled).toBe(true);
    expect(mockEnqueueDesign).toHaveBeenCalledWith(expect.objectContaining({ phase: 'apply', decision: 'decline' }), 'design-apply:s1:decline');
  });

  it('lets an unrelated message run as a normal turn, and a "later" cool the proposal', async () => {
    mockGetOpenSuggestion.mockResolvedValueOnce(design);
    mockClassifyResponse.mockResolvedValueOnce({ intent: 'unrelated' });
    expect(await handlePossibleSuggestionReply({ tenantId: TENANT, agentId: AGENT, threadId: THREAD, content: 'what time is it' })).toEqual({ handled: false });
    mockGetOpenSuggestion.mockResolvedValueOnce(design);
    mockClassifyResponse.mockResolvedValueOnce({ intent: 'later' });
    expect(await handlePossibleSuggestionReply({ tenantId: TENANT, agentId: AGENT, threadId: THREAD, content: 'not now' })).toEqual({ handled: false });
    expect(mockMarkDecided).toHaveBeenCalledWith(TENANT, 's1', 'cooldown');
  });

  it('releases the claim when the answer cannot be carried', async () => {
    mockGetOpenSuggestion.mockResolvedValueOnce(design);
    mockClassifyResponse.mockResolvedValueOnce({ intent: 'accept' });
    mockEnqueueDesign.mockRejectedValueOnce(new Error('queue down'));
    expect(await handlePossibleSuggestionReply({ tenantId: TENANT, agentId: AGENT, threadId: THREAD, content: 'yes' })).toEqual({ handled: false });
    expect(mockRelease).toHaveBeenCalledWith(TENANT, 's1');
  });
});

// A question to the Insights Manager or Liftoff needs no yes: it holds no
// budget and goes straight to the colleague for an answer into the chat.
describe('registerColleagueQuestion', () => {
  it('hands a question to the colleague for an answer into the chat, with no proposal row', async () => {
    const out = await registerColleagueQuestion({ tenantId: TENANT, agentId: AGENT, threadId: THREAD, colleague: 'insights', request: 'How many runs today?' });
    expect(out).toEqual({ registered: true });
    expect(mockCreateSuggestion).not.toHaveBeenCalled();
    expect(mockEnqueueDesign).toHaveBeenCalledWith(
      { tenantId: TENANT, agentId: AGENT, threadId: THREAD, colleague: 'insights', phase: 'answer', request: 'How many runs today?' },
      expect.stringMatching(/^colleague-answer:/),
    );
  });

  it('says so when the question cannot be handed over', async () => {
    mockEnqueueDesign.mockRejectedValueOnce(new Error('queue down'));
    expect(await registerColleagueQuestion({ tenantId: TENANT, agentId: AGENT, threadId: THREAD, colleague: 'liftoff', request: 'x' }))
      .toEqual({ registered: false, reason: 'not_recorded' });
  });
});

describe('pairing and the learning skip', () => {
  it('keeps the first thread paired with a team chat, per colleague', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ colleague_thread_id: 'existing' }] });
    expect(await pairColleagueThread(TENANT, THREAD, 'caio', 'fresh')).toBe('existing');
    expect(mockQuery.mock.calls[0][0]).toMatch(/ON CONFLICT \(tenant_id, thread_id, colleague\) DO UPDATE SET colleague_thread_id = agent_chat_colleague_threads.colleague_thread_id/);
    expect(mockQuery.mock.calls[0][1]).toEqual([TENANT, THREAD, 'caio', 'fresh']);
  });

  it('reports a design proposal just opened on this thread, and nothing else', async () => {
    mockGetOpenSuggestion.mockResolvedValueOnce({ proposalKind: 'design', threadId: THREAD });
    expect(await designChangeJustRegistered(TENANT, AGENT, THREAD)).toBe(true);
    mockGetOpenSuggestion.mockResolvedValueOnce({ proposalKind: 'routine', threadId: THREAD });
    expect(await designChangeJustRegistered(TENANT, AGENT, THREAD)).toBe(false);
    mockGetOpenSuggestion.mockRejectedValueOnce(new Error('db'));
    expect(await designChangeJustRegistered(TENANT, AGENT, THREAD)).toBe(false);
  });
});
