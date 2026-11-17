// Accepting a routine no longer makes the person sit through the redistill.
//
// The properties: a yes lands the guidance line synchronously (durable), then
// ENQUEUES the redistill and acknowledges immediately; the enqueue failing
// falls back to exactly the old synchronous shape, never worse; an amendment
// rides inside the routine line the worker will confirm.

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockUpdate = jest.fn();
const mockGetById = jest.fn();
jest.mock('../../internal-agents/service', () => ({
  internalAgentService: {
    getById: (...a: unknown[]) => mockGetById(...a),
    update: (...a: unknown[]) => mockUpdate(...a),
  },
}));

const mockRedistill = jest.fn();
jest.mock('../../internal-agents/redistill-service', () => ({
  redistillAgent: (...a: unknown[]) => mockRedistill(...a),
}));

const mockEnqueue = jest.fn();
jest.mock('../chat-turn-dispatch', () => ({
  enqueueRedistillAcceptTask: (...a: unknown[]) => mockEnqueue(...a),
}));

const mockClaim = jest.fn();
const mockClassify = jest.fn();
const mockGetOpen = jest.fn();
jest.mock('../suggestion-service', () => ({
  claimForAcceptance: (...a: unknown[]) => mockClaim(...a),
  classifyResponse: (...a: unknown[]) => mockClassify(...a),
  getOpenSuggestion: (...a: unknown[]) => mockGetOpen(...a),
  markDecided: jest.fn(),
  markOffered: jest.fn(),
  createSuggestion: jest.fn(),
  releaseClaim: jest.fn(),
  deliverSuggestion: jest.fn(),
}));

import { handlePossibleSuggestionReply } from '../suggestion-flow';

const TENANT = '00000000-0000-0000-0000-0000000000aa';
const AGENT = '00000000-0000-0000-0000-0000000000bb';
const THREAD = '00000000-0000-0000-0000-0000000000cc';

const SUGGESTION = {
  id: '00000000-0000-0000-0000-0000000000dd',
  tenantId: TENANT,
  agentId: AGENT,
  dedupKey: 'chat:x',
  source: 'chat' as const,
  proposalText: 'I can make that part of my routine: ...',
  routineProse: 'Every Friday at 4pm, post the most urgent open item here.',
  provenanceNote: null,
  status: 'pending' as const,
  threadId: THREAD,
  action: 'start' as const,
  targetLabel: null,
  replacesProse: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetOpen.mockResolvedValue(SUGGESTION);
  mockClassify.mockResolvedValue({ intent: 'accept', amendment: undefined });
  mockClaim.mockResolvedValue(true);
  mockGetById.mockResolvedValue({ id: AGENT, additionalContext: 'Existing guidance.' });
  mockUpdate.mockResolvedValue({});
  mockEnqueue.mockResolvedValue(undefined);
});

it('lands the guidance, enqueues the redistill, and acknowledges without waiting', async () => {
  const outcome = await handlePossibleSuggestionReply({
    tenantId: TENANT, agentId: AGENT, threadId: THREAD, content: 'yes please',
  });

  expect(outcome.handled).toBe(true);
  expect(outcome.reply).toMatch(/takes a few minutes/i);
  expect(outcome.reply).toMatch(/confirm here when it is live/i);

  // Guidance landed synchronously, before any acknowledgement.
  const [, , fields] = mockUpdate.mock.calls[0];
  expect((fields as { additionalContext: string }).additionalContext)
    .toContain(SUGGESTION.routineProse);

  expect(mockEnqueue).toHaveBeenCalledWith(
    {
      tenantId: TENANT,
      agentId: AGENT,
      suggestionId: SUGGESTION.id,
      threadId: THREAD,
      routineProse: SUGGESTION.routineProse,
      action: 'start',
      targetLabel: undefined,
    },
    `redistill-accept:${SUGGESTION.id}`,
  );
  // The whole point: the slow call does not run in the turn.
  expect(mockRedistill).not.toHaveBeenCalled();
});

it('folds an amendment into the routine line the worker will confirm', async () => {
  mockClassify.mockResolvedValue({ intent: 'accept', amendment: 'make it 10am' });
  await handlePossibleSuggestionReply({
    tenantId: TENANT, agentId: AGENT, threadId: THREAD, content: 'yes, but 10am',
  });
  const task = mockEnqueue.mock.calls[0][0] as { routineProse: string };
  expect(task.routineProse).toBe(`${SUGGESTION.routineProse} (make it 10am)`);
});

it('falls back to the synchronous redistill when the enqueue fails', async () => {
  mockEnqueue.mockRejectedValue(new Error('no queue here'));
  mockRedistill.mockResolvedValue({});

  const outcome = await handlePossibleSuggestionReply({
    tenantId: TENANT, agentId: AGENT, threadId: THREAD, content: 'yes',
  });

  expect(mockRedistill).toHaveBeenCalledWith(AGENT, TENANT, undefined);
  expect(outcome.reply).toMatch(/^Done\./);
});
