// registerRoutineProposal — the tool path onto the consent rail.
//
// Three properties carry the design:
//  * it records WITHOUT delivering, and stamps the thread, because the model
//    asks the question in its own voice and the reply interception matches on
//    that stamp;
//  * its refusals are honest and name which rule declined;
//  * it composes the SAME proposal text and dedup key as the teaching path,
//    which is the mechanism that collapses the two when both fire on one turn
//    (the second createSuggestion hits the budget or the latch and returns
//    null — no second proposal exists to deliver).

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../internal-agents/service', () => ({
  internalAgentService: { getById: jest.fn(), update: jest.fn() },
}));
jest.mock('../../internal-agents/redistill-service', () => ({
  redistillAgent: jest.fn(),
}));

const mockCreateSuggestion = jest.fn();
const mockGetOpenSuggestion = jest.fn();
const mockMarkOffered = jest.fn();
const mockMarkDecided = jest.fn();
const mockDeliverSuggestion = jest.fn();
jest.mock('../suggestion-service', () => ({
  createSuggestion: (...a: unknown[]) => mockCreateSuggestion(...a),
  getOpenSuggestion: (...a: unknown[]) => mockGetOpenSuggestion(...a),
  markOffered: (...a: unknown[]) => mockMarkOffered(...a),
  markDecided: (...a: unknown[]) => mockMarkDecided(...a),
  deliverSuggestion: (...a: unknown[]) => mockDeliverSuggestion(...a),
  claimForAcceptance: jest.fn(),
  classifyResponse: jest.fn(),
  releaseClaim: jest.fn(),
}));

import { proposeRoutineFromChat, registerRoutineProposal } from '../suggestion-flow';

const TENANT = '00000000-0000-0000-0000-0000000000aa';
const AGENT = '00000000-0000-0000-0000-0000000000bb';
const THREAD = '00000000-0000-0000-0000-0000000000cc';
const PROSE = 'Every Monday at 9am, compile the overdue invoices and post the list here.';

beforeEach(() => {
  jest.clearAllMocks();
  mockCreateSuggestion.mockResolvedValue({ id: 's1', tenantId: TENANT, agentId: AGENT });
  mockGetOpenSuggestion.mockResolvedValue(null);
  mockMarkOffered.mockResolvedValue(undefined);
  mockMarkDecided.mockResolvedValue(undefined);
});

describe('registerRoutineProposal', () => {
  it('records, stamps the thread as offered, and delivers nothing', async () => {
    const outcome = await registerRoutineProposal({
      tenantId: TENANT, agentId: AGENT, threadId: THREAD, routineProse: PROSE,
    });

    expect(outcome).toEqual({ registered: true });
    expect(mockMarkOffered).toHaveBeenCalledWith(TENANT, 's1', THREAD);
    expect(mockDeliverSuggestion).not.toHaveBeenCalled();
  });

  it('names the budget when an open proposal already holds it', async () => {
    mockCreateSuggestion.mockResolvedValue(null);
    mockGetOpenSuggestion.mockResolvedValue({ id: 'other' });

    const outcome = await registerRoutineProposal({
      tenantId: TENANT, agentId: AGENT, threadId: THREAD, routineProse: PROSE,
    });
    expect(outcome).toEqual({ registered: false, reason: 'open_proposal_exists' });
    expect(mockMarkOffered).not.toHaveBeenCalled();
  });

  it('names the latch when the same idea was offered before', async () => {
    mockCreateSuggestion.mockResolvedValue(null);
    mockGetOpenSuggestion.mockResolvedValue(null);

    const outcome = await registerRoutineProposal({
      tenantId: TENANT, agentId: AGENT, threadId: THREAD, routineProse: PROSE,
    });
    expect(outcome).toEqual({ registered: false, reason: 'already_offered' });
  });

  it('releases an unstamped proposal rather than letting it hold the budget', async () => {
    mockMarkOffered.mockRejectedValue(new Error('db went away'));

    const outcome = await registerRoutineProposal({
      tenantId: TENANT, agentId: AGENT, threadId: THREAD, routineProse: PROSE,
    });
    expect(outcome).toEqual({ registered: false, reason: 'not_recorded' });
    // Same release deliverSuggestion applies to a proposal nobody saw:
    // immediate cooldown, so the idea can be offered again.
    expect(mockMarkDecided).toHaveBeenCalledWith(TENANT, 's1', 'cooldown', 0);
  });

  it('composes the same proposal text and dedup key as the teaching path', async () => {
    await registerRoutineProposal({
      tenantId: TENANT, agentId: AGENT, threadId: THREAD, routineProse: PROSE,
    });
    await proposeRoutineFromChat({
      tenantId: TENANT, agentId: AGENT, threadId: THREAD, routineProse: PROSE,
    });

    const [toolPath, lessonPath] = mockCreateSuggestion.mock.calls.map((c) => c[0] as {
      dedupKey: string; proposalText: string; source: string;
    });
    // Identical keys are what make the database collapse the two when both
    // paths fire on the same turn; identical text is what keeps the reply
    // classifier reading one question, whoever asked it.
    expect(toolPath.dedupKey).toBe(lessonPath.dedupKey);
    expect(toolPath.proposalText).toBe(lessonPath.proposalText);
    expect(toolPath.source).toBe('chat');
    expect(lessonPath.source).toBe('chat');
  });
});
