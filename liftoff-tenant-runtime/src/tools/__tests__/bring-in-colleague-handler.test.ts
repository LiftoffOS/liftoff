// bring_in_colleague hands an ask to one of the three platform assistants
// through the platform's colleague rail. The handler's job is to relay every
// outcome honestly: a registered ask promises only that the colleague will
// post here; an inline answer is returned as the colleague's; a refusal is
// an answer to relay; an unreachable platform is a plain failure. The Chief
// AI Officer needs a person in the conversation, so no thread means no ask.

import type { StandardToolContext } from '../standard-tool-handler';

const mockRegister = jest.fn();
jest.mock('../../platform-callback/client', () => ({
  registerColleagueRequest: (...a: unknown[]) => mockRegister(...a),
}));

import { handleBringInColleague } from '../bring-in-colleague-handler';

const TENANT = 't-1';
const AGENT = 'a-1';
const THREAD = 'thread-1';
const CHANGE = 'Pull ten posts per hashtag instead of five and include view counts.';
const QUESTION = 'How many runs did this workspace do this week, and what did they cost?';

function ctx(overrides: Partial<StandardToolContext> = {}): StandardToolContext {
  return { tenantId: TENANT, agentId: AGENT, memoryScope: {}, threadId: THREAD, ...overrides };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRegister.mockResolvedValue({ registered: true });
});

it('hands a change to the Chief AI Officer and tells the model to promise only the preview', async () => {
  const out = await handleBringInColleague({ colleague: 'caio', request: CHANGE, area: 'workflow' }, ctx());
  expect(out.success).toBe(true);
  expect(mockRegister).toHaveBeenCalledWith({
    tenantId: TENANT, agentId: AGENT, threadId: THREAD, colleague: 'caio', request: CHANGE, area: 'workflow',
  });
  const result = out.result as { registered: boolean; colleague: string; nextStep: string };
  expect(result).toMatchObject({ registered: true, colleague: 'caio' });
  expect(result.nextStep).toMatch(/Chief AI Officer will post here shortly what would change/);
  expect(result.nextStep).toMatch(/only when they agree/);
  expect(result.nextStep).toMatch(/do not describe the change as made/);
});

it('hands a question to the Insights Manager in a chat and tells the model not to guess', async () => {
  const out = await handleBringInColleague({ colleague: 'insights', request: QUESTION }, ctx());
  expect(out.success).toBe(true);
  expect(mockRegister).toHaveBeenCalledWith({
    tenantId: TENANT, agentId: AGENT, threadId: THREAD, colleague: 'insights', request: QUESTION,
  });
  const result = out.result as { nextStep: string };
  expect(result.nextStep).toMatch(/Insights Manager will post the answer here shortly/);
  expect(result.nextStep).toMatch(/Do not guess/);
});

it('returns an inline answer from an unattended run as the colleague\'s reply', async () => {
  mockRegister.mockResolvedValueOnce({ answered: true, reply: '14 runs this week, 3.2 Operating Units.' });
  const out = await handleBringInColleague({ colleague: 'insights', request: QUESTION }, ctx({ threadId: undefined }));
  expect(out.success).toBe(true);
  expect(out.result).toEqual({ answered: true, colleague: 'insights', reply: '14 runs this week, 3.2 Operating Units.' });
  expect(mockRegister).toHaveBeenCalledWith({
    tenantId: TENANT, agentId: AGENT, colleague: 'insights', request: QUESTION,
  });
  expect(mockRegister.mock.calls[0][0]).not.toHaveProperty('threadId');
});

it('reports an inline answer that did not come as a failure, never an invented reply', async () => {
  mockRegister.mockResolvedValueOnce({ answered: false, reason: 'turn_failed' });
  const out = await handleBringInColleague({ colleague: 'liftoff', request: QUESTION }, ctx({ threadId: undefined }));
  expect(out.success).toBe(false);
  expect(out.error).toMatch(/could not be reached/);
  expect(out.error).toMatch(/do not invent an answer/);
});

it('refuses without a colleague, without a request, and the Chief AI Officer outside a conversation', async () => {
  expect((await handleBringInColleague({ request: CHANGE }, ctx())).error).toMatch(/requires `colleague`/);
  expect((await handleBringInColleague({ colleague: 'someone', request: CHANGE }, ctx())).error).toMatch(/requires `colleague`/);
  expect((await handleBringInColleague({ colleague: 'caio' }, ctx())).error).toMatch(/requires `request`/);
  const out = await handleBringInColleague({ colleague: 'caio', request: CHANGE }, ctx({ threadId: undefined }));
  expect(out.success).toBe(false);
  expect(out.error).toMatch(/only be brought in from a conversation/);
  expect(out.error).toMatch(/do not imply anything changed/);
  expect(mockRegister).not.toHaveBeenCalled();
});

it('relays the rail\'s refusals as answers, not failures', async () => {
  mockRegister.mockResolvedValueOnce({ registered: false, reason: 'open_proposal_exists' });
  const open = await handleBringInColleague({ colleague: 'caio', request: CHANGE }, ctx());
  expect(open.success).toBe(true);
  expect(open.result).toMatchObject({ registered: false, reason: 'open_proposal_exists' });
  expect((open.result as { explanation: string }).explanation).toMatch(/still waiting for your answer/);

  mockRegister.mockResolvedValueOnce({ registered: false, reason: 'already_offered' });
  const offered = await handleBringInColleague({ colleague: 'caio', request: CHANGE }, ctx());
  expect((offered.result as { explanation: string }).explanation).toMatch(/already put to you before/);

  mockRegister.mockResolvedValueOnce({ registered: false, reason: 'needs_the_person' });
  const nobody = await handleBringInColleague({ colleague: 'caio', request: CHANGE }, ctx());
  expect((nobody.result as { explanation: string }).explanation).toMatch(/nobody is in a conversation with me/);
});

it('answers a platform that does not recognise the conversation, and an unreachable one, without implying anything', async () => {
  mockRegister.mockResolvedValueOnce({ registered: false, reason: 'not_registerable' });
  expect((await handleBringInColleague({ colleague: 'insights', request: QUESTION }, ctx())).error)
    .toMatch(/does not recognise this conversation/);
  mockRegister.mockResolvedValueOnce({ registered: false, reason: 'unavailable' });
  expect((await handleBringInColleague({ colleague: 'insights', request: QUESTION }, ctx())).error)
    .toMatch(/could not be reached/);
  mockRegister.mockRejectedValueOnce(new Error('boom'));
  const out = await handleBringInColleague({ colleague: 'liftoff', request: QUESTION }, ctx());
  expect(out.success).toBe(false);
  expect(out.error).toMatch(/could not be reached/);
});
