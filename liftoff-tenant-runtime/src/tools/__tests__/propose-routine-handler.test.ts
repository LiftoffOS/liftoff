// propose_routine — the standing-request tool's handler.
//
// The properties that carry it: a run with nobody present refuses (there is
// no one to consent); a platform refusal is an ANSWER relayed to the model,
// not a failure; and no path can end with the model believing a schedule
// exists when nothing was registered.

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockRegister = jest.fn();
jest.mock('../../platform-callback/client', () => ({
  registerRoutineProposal: (...a: unknown[]) => mockRegister(...a),
}));

import { handleProposeRoutine } from '../propose-routine-handler';
import type { StandardToolContext } from '../standard-tool-handler';

const TENANT = '00000000-0000-0000-0000-0000000000aa';
const AGENT = '00000000-0000-0000-0000-0000000000bb';
const THREAD = '00000000-0000-0000-0000-0000000000cc';
const ROUTINE = 'Every Monday at 9am, compile the overdue invoices and post the list here.';

function ctx(overrides: Partial<StandardToolContext> = {}): StandardToolContext {
  return {
    tenantId: TENANT,
    agentId: AGENT,
    memoryScope: {},
    threadId: THREAD,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRegister.mockResolvedValue({ registered: true });
});

it('refuses an empty routine before touching the platform', async () => {
  const result = await handleProposeRoutine({}, ctx());
  expect(result.success).toBe(false);
  expect(mockRegister).not.toHaveBeenCalled();
});

it('refuses when no person is present (no chat thread)', async () => {
  const result = await handleProposeRoutine({ routine: ROUTINE }, ctx({ threadId: undefined }));
  expect(result.success).toBe(false);
  expect(result.error).toMatch(/conversation/i);
  expect(mockRegister).not.toHaveBeenCalled();
});

it('registers and tells the model to ask for confirmation', async () => {
  const result = await handleProposeRoutine({ routine: ROUTINE }, ctx());
  expect(mockRegister).toHaveBeenCalledWith({
    tenantId: TENANT,
    agentId: AGENT,
    threadId: THREAD,
    routineProse: ROUTINE,
    action: 'start',
  });
  expect(result.success).toBe(true);
  expect(result.result).toMatchObject({ registered: true });
  expect(JSON.stringify(result.result)).toMatch(/confirmation/i);
});

it('relays a budget refusal as an answer, not a failure', async () => {
  mockRegister.mockResolvedValue({ registered: false, reason: 'open_proposal_exists' });
  const result = await handleProposeRoutine({ routine: ROUTINE }, ctx());
  expect(result.success).toBe(true);
  expect(result.result).toMatchObject({ registered: false, reason: 'open_proposal_exists' });
});

it('relays the dedup latch the same way', async () => {
  mockRegister.mockResolvedValue({ registered: false, reason: 'already_offered' });
  const result = await handleProposeRoutine({ routine: ROUTINE }, ctx());
  expect(result.success).toBe(true);
  expect(result.result).toMatchObject({ registered: false, reason: 'already_offered' });
});

it('refuses a change without a target before touching the platform', async () => {
  const result = await handleProposeRoutine({ routine: ROUTINE, action: 'change' }, ctx());
  expect(result.success).toBe(false);
  expect(result.error).toMatch(/requires `target`/);
  expect(mockRegister).not.toHaveBeenCalled();
});

it('lets a stop travel with only a target, carrying the action through', async () => {
  const result = await handleProposeRoutine(
    { action: 'stop', target: 'the friday reminder' },
    ctx(),
  );
  expect(result.success).toBe(true);
  expect(mockRegister).toHaveBeenCalledWith(
    expect.objectContaining({ action: 'stop', target: 'the friday reminder' }),
  );
  expect(mockRegister.mock.calls[0][0]).not.toHaveProperty('routineProse');
  expect(JSON.stringify(result.result)).toMatch(/stops only when they agree/i);
});

it('relays an ambiguous target with the candidate names', async () => {
  mockRegister.mockResolvedValue({
    registered: false,
    reason: 'ambiguous_target',
    candidates: ['friday-most-urgent-item', 'midweek-material-move-check'],
  });
  const result = await handleProposeRoutine(
    { action: 'stop', target: 'the check' },
    ctx(),
  );
  expect(result.success).toBe(true);
  expect(result.result).toMatchObject({ registered: false, reason: 'ambiguous_target' });
  expect(JSON.stringify(result.result)).toContain('friday-most-urgent-item');
  expect(JSON.stringify(result.result)).toContain('Ask the person which they mean');
});

it('fails honestly when the platform is unavailable', async () => {
  mockRegister.mockResolvedValue({ registered: false, reason: 'unavailable' });
  const result = await handleProposeRoutine({ routine: ROUTINE }, ctx());
  expect(result.success).toBe(false);
  expect(result.error).toMatch(/do not imply a schedule exists/i);
});

it('relays a precise refusal when the platform does not recognise the conversation', async () => {
  // The autonomous-run edge: a runtime-minted thread id reaches PB, PB
  // answers 404, and the model must hear "not from here", not "unreachable".
  mockRegister.mockResolvedValue({ registered: false, reason: 'not_registerable' });
  const result = await handleProposeRoutine({ routine: ROUTINE }, ctx());
  expect(result.success).toBe(false);
  expect(result.error).toMatch(/does not recognise this conversation/i);
  expect(result.error).toMatch(/do not imply a schedule exists/i);
});

it('fails honestly when the callback throws', async () => {
  mockRegister.mockRejectedValue(new Error('HTTP 503'));
  const result = await handleProposeRoutine({ routine: ROUTINE }, ctx());
  expect(result.success).toBe(false);
  expect(result.error).toMatch(/do not imply a schedule exists/i);
});
