// Changing and stopping routines through the consent rail (migration 429).
//
// The load-bearing properties: a change or stop must resolve to exactly ONE
// real routine before anything is written (a yes to "whichever you meant" is
// a yes to the wrong schedule); a line this rail wrote is rewritten or
// removed IN PLACE, while a distill-born cadence gets a superseding line the
// distiller is taught to honour; and the dedup key carries the action so a
// stop is never latched behind the start that created the routine.

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockGetById = jest.fn();
const mockUpdate = jest.fn();
jest.mock('../../internal-agents/service', () => ({
  internalAgentService: {
    getById: (...a: unknown[]) => mockGetById(...a),
    update: (...a: unknown[]) => mockUpdate(...a),
  },
}));
jest.mock('../../internal-agents/redistill-service', () => ({
  redistillAgent: jest.fn(),
}));

const mockEnqueue = jest.fn();
jest.mock('../chat-turn-dispatch', () => ({
  enqueueRedistillAcceptTask: (...a: unknown[]) => mockEnqueue(...a),
}));

const mockLatestUserMsg = jest.fn();
jest.mock('../chat-repository', () => ({
  latestUserMessageContent: (...a: unknown[]) => mockLatestUserMsg(...a),
}));

const mockCreateSuggestion = jest.fn();
const mockGetOpen = jest.fn();
const mockListAccepted = jest.fn();
const mockClaim = jest.fn();
const mockClassify = jest.fn();
jest.mock('../suggestion-service', () => ({
  createSuggestion: (...a: unknown[]) => mockCreateSuggestion(...a),
  getOpenSuggestion: (...a: unknown[]) => mockGetOpen(...a),
  listAcceptedRoutineProse: (...a: unknown[]) => mockListAccepted(...a),
  claimForAcceptance: (...a: unknown[]) => mockClaim(...a),
  classifyResponse: (...a: unknown[]) => mockClassify(...a),
  markOffered: jest.fn().mockResolvedValue(undefined),
  markDecided: jest.fn(),
  releaseClaim: jest.fn(),
  deliverSuggestion: jest.fn(),
}));

import {
  handlePossibleSuggestionReply,
  registerRoutineProposal,
  resolveRoutineTarget,
} from '../suggestion-flow';

const TENANT = '00000000-0000-0000-0000-0000000000aa';
const AGENT = '00000000-0000-0000-0000-0000000000bb';
const THREAD = '00000000-0000-0000-0000-0000000000cc';

const FRIDAY_LINE = 'Every Friday at 4pm, post the most urgent open item here.';

const TRIGGER = {
  type: 'cron',
  cronExpr: '0 8 * * 1',
  reasoning: 'Responsibilities specify a Monday morning competitor sweep.',
  companionCrons: [
    { label: 'midweek-material-move-check', cronExpr: '0 8 * * 4', objective: 'Material moves only since Monday.' },
    { label: 'friday-most-urgent-item', cronExpr: '0 16 * * 5', objective: 'Post the single most urgent open item.' },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetById.mockResolvedValue({
    id: AGENT,
    triggerConfig: TRIGGER,
    additionalContext: `Some standing guidance.\n\n${FRIDAY_LINE}`,
  });
  mockListAccepted.mockResolvedValue([FRIDAY_LINE]);
  mockLatestUserMsg.mockResolvedValue(null);
  mockCreateSuggestion.mockImplementation(async (p: Record<string, unknown>) => ({
    id: 's1', tenantId: TENANT, agentId: AGENT, threadId: null, status: 'pending',
    ...p,
  }));
});

describe('resolveRoutineTarget', () => {
  it('resolves a companion by its label', async () => {
    const r = await resolveRoutineTarget(TENANT, AGENT, 'midweek material move check');
    expect(r).toEqual({
      resolved: true,
      targetLabel: 'midweek-material-move-check',
      replacesProse: null,
      currentCronExpr: '0 8 * * 4',
    });
  });

  it('resolves a chat-born routine to the exact line it wrote', async () => {
    const r = await resolveRoutineTarget(TENANT, AGENT, 'the friday most urgent item');
    expect(r.resolved).toBe(true);
    if (r.resolved) {
      // Matched by label against the companion, or by prose against the
      // accepted line — either way one target; the accepted line carries the
      // rewrite handle when it is the match.
      expect(r.targetLabel.toLowerCase()).toContain('friday');
    }
  });

  it('a weekday in the target vetoes candidates that run on another day', async () => {
    // The mis-resolution this guards: "the monday one" can match the THURSDAY
    // midweek check because its objective says "since Monday". The person's
    // yes then goes to a mislabeled question and the Thursday check is
    // superseded away. A named day must match the candidate's own cadence.
    const r = await resolveRoutineTarget(TENANT, AGENT, 'the monday one');
    expect(r.resolved).toBe(true);
    if (r.resolved) {
      expect(r.targetLabel).toBe('primary schedule');
      expect(r.currentCronExpr).toBe('0 8 * * 1');
    }
  });

  it('hands back candidates when the name could mean several routines', async () => {
    const r = await resolveRoutineTarget(TENANT, AGENT, 'routine');
    expect(r.resolved).toBe(false);
    if (!r.resolved) expect(r.candidates.length).toBeGreaterThan(1);
  });

  it('a superseded start row is history: a stop resolves after an accepted change', async () => {
    const newLine = 'Every Friday at 10am, post the most urgent open item here.';
    mockGetById.mockResolvedValue({
      id: AGENT,
      triggerConfig: TRIGGER,
      // The accepted change rewrote the 4pm line in place.
      additionalContext: `Some standing guidance.\n\n${newLine}`,
    });
    // Both accepts are on the record; only the rewritten line is still live.
    mockListAccepted.mockResolvedValue([newLine, FRIDAY_LINE]);

    const r = await resolveRoutineTarget(TENANT, AGENT, 'friday most urgent item');
    expect(r).toEqual({
      resolved: true,
      targetLabel: expect.stringContaining('Friday at 10am'),
      replacesProse: newLine,
      currentCronExpr: '0 10 * * 5',
    });
  });

  it('acts on the whole guidance block, so an amendment suffix goes with its line', async () => {
    const amended = `${FRIDAY_LINE} (start at 3pm instead)`;
    mockGetById.mockResolvedValue({
      id: AGENT,
      triggerConfig: TRIGGER,
      additionalContext: `Some standing guidance.\n\n${amended}`,
    });
    mockListAccepted.mockResolvedValue([FRIDAY_LINE]);

    const r = await resolveRoutineTarget(TENANT, AGENT, 'friday most urgent item');
    expect(r.resolved).toBe(true);
    if (r.resolved) expect(r.replacesProse).toBe(amended);
  });
});

describe('registerRoutineProposal actions', () => {
  it('registers a change with the action-scoped dedup key and the resolved target', async () => {
    const outcome = await registerRoutineProposal({
      tenantId: TENANT, agentId: AGENT, threadId: THREAD,
      action: 'change',
      target: 'friday most urgent item',
      routineProse: 'Every Friday at 10am, post the most urgent open item here.',
    });
    expect(outcome).toEqual({ registered: true });

    const created = mockCreateSuggestion.mock.calls[0][0] as Record<string, unknown>;
    expect(created.action).toBe('change');
    expect(String(created.dedupKey)).toMatch(/^chat:change:/);
    expect(String(created.proposalText)).toMatch(/change that routine/i);
    expect(String(created.targetLabel).toLowerCase()).toContain('friday');
  });

  it('composes the stop prose itself and keys on the target', async () => {
    const outcome = await registerRoutineProposal({
      tenantId: TENANT, agentId: AGENT, threadId: THREAD,
      action: 'stop',
      target: 'midweek material move check',
    });
    expect(outcome).toEqual({ registered: true });

    const created = mockCreateSuggestion.mock.calls[0][0] as Record<string, unknown>;
    expect(created.action).toBe('stop');
    expect(String(created.dedupKey)).toMatch(/^chat:stop:/);
    expect(String(created.routineProse)).toMatch(/must no longer run/);
    expect(String(created.proposalText)).toMatch(/stop the midweek-material-move-check routine/i);
  });

  it("auto-applies a change the person's own words stated exactly", async () => {
    mockLatestUserMsg.mockResolvedValue('Change the friday one from 4pm to 10am');
    mockClaim.mockResolvedValue(true);
    const outcome = await registerRoutineProposal({
      tenantId: TENANT, agentId: AGENT, threadId: THREAD,
      action: 'change',
      target: 'friday most urgent item',
      routineProse: 'Every Friday at 10am, post the most urgent open item here.',
    });
    expect(outcome).toEqual({ registered: true, autoAccepted: true });
    // Applied means the guidance edit and the redistill both happened, the
    // same path a spoken yes takes.
    const fields = mockUpdate.mock.calls[0][2] as { additionalContext: string };
    expect(fields.additionalContext).toContain('Every Friday at 10am');
    expect(fields.additionalContext).not.toContain(FRIDAY_LINE);
    expect(mockEnqueue).toHaveBeenCalled();
    expect((mockEnqueue.mock.calls[0][0] as Record<string, unknown>).action).toBe('change');
  });

  it('keeps the confirmation when the words do not pin the change', async () => {
    mockLatestUserMsg.mockResolvedValue('can you make the friday one a bit later?');
    const outcome = await registerRoutineProposal({
      tenantId: TENANT, agentId: AGENT, threadId: THREAD,
      action: 'change',
      target: 'friday most urgent item',
      routineProse: 'Every Friday at 10am, post the most urgent open item here.',
    });
    expect(outcome).toEqual({ registered: true });
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('never auto-accepts a stop, however explicit the words', async () => {
    mockLatestUserMsg.mockResolvedValue('stop the midweek material move check');
    const outcome = await registerRoutineProposal({
      tenantId: TENANT, agentId: AGENT, threadId: THREAD,
      action: 'stop',
      target: 'midweek material move check',
    });
    expect(outcome).toEqual({ registered: true });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('refuses an ambiguous target with the candidates, writing nothing', async () => {
    const outcome = await registerRoutineProposal({
      tenantId: TENANT, agentId: AGENT, threadId: THREAD,
      action: 'stop',
      target: 'routine',
    });
    expect(outcome.registered).toBe(false);
    if (!outcome.registered && outcome.reason === 'ambiguous_target') {
      expect(outcome.candidates.length).toBeGreaterThan(1);
    } else {
      throw new Error('expected ambiguous_target');
    }
    expect(mockCreateSuggestion).not.toHaveBeenCalled();
  });
});

describe('accepting a change or stop', () => {
  function openSuggestion(overrides: Record<string, unknown>) {
    mockGetOpen.mockResolvedValue({
      id: 's1', tenantId: TENANT, agentId: AGENT, dedupKey: 'k', source: 'chat',
      proposalText: 'x', provenanceNote: null, status: 'pending', threadId: THREAD,
      targetLabel: 'friday-most-urgent-item', ...overrides,
    });
    mockClassify.mockResolvedValue({ intent: 'accept', amendment: undefined });
    mockClaim.mockResolvedValue(true);
    mockUpdate.mockResolvedValue({});
    mockEnqueue.mockResolvedValue(undefined);
  }

  it('rewrites the chat-born line in place on a change', async () => {
    const newLine = 'Every Friday at 10am, post the most urgent open item here.';
    openSuggestion({ action: 'change', routineProse: newLine, replacesProse: FRIDAY_LINE });

    await handlePossibleSuggestionReply({
      tenantId: TENANT, agentId: AGENT, threadId: THREAD, content: 'yes',
    });

    const fields = mockUpdate.mock.calls[0][2] as { additionalContext: string };
    expect(fields.additionalContext).toContain(newLine);
    expect(fields.additionalContext).not.toContain(FRIDAY_LINE);
  });

  it('removes the chat-born line on a stop', async () => {
    openSuggestion({
      action: 'stop',
      routineProse: 'Stop the friday-most-urgent-item routine; it must no longer run.',
      replacesProse: FRIDAY_LINE,
    });

    await handlePossibleSuggestionReply({
      tenantId: TENANT, agentId: AGENT, threadId: THREAD, content: 'yes',
    });

    const fields = mockUpdate.mock.calls[0][2] as { additionalContext: string };
    expect(fields.additionalContext).not.toContain(FRIDAY_LINE);
    expect(fields.additionalContext).toContain('Some standing guidance.');
  });

  it('appends a superseding line when the cadence is distill-born', async () => {
    const newLine = 'Every Tuesday at 9am, run the competitor sweep.';
    openSuggestion({ action: 'change', routineProse: newLine, replacesProse: null, targetLabel: 'primary schedule' });

    await handlePossibleSuggestionReply({
      tenantId: TENANT, agentId: AGENT, threadId: THREAD, content: 'yes',
    });

    const fields = mockUpdate.mock.calls[0][2] as { additionalContext: string };
    expect(fields.additionalContext).toContain(newLine);
    expect(fields.additionalContext).toMatch(/replaces the earlier primary schedule instruction/);
    // The original guidance survives untouched.
    expect(fields.additionalContext).toContain(FRIDAY_LINE);
  });

  it('carries the action to the worker so the confirmation reads right', async () => {
    openSuggestion({
      action: 'stop',
      routineProse: 'Stop the friday-most-urgent-item routine; it must no longer run.',
      replacesProse: FRIDAY_LINE,
    });

    const outcome = await handlePossibleSuggestionReply({
      tenantId: TENANT, agentId: AGENT, threadId: THREAD, content: 'yes',
    });

    expect(outcome.reply).toMatch(/Taking it out of my schedule/);
    const task = mockEnqueue.mock.calls[0][0] as Record<string, unknown>;
    expect(task.action).toBe('stop');
    expect(task.targetLabel).toBe('friday-most-urgent-item');
    // The removed line rides along: the worker parses the stopped cadence
    // from it so the redistill can be told what must NOT appear.
    expect(task.replacesProse).toBe(FRIDAY_LINE);
  });
});
