// run_routine_now — the explicit bridge from conversation into the step graph.
//
// The properties that carry it: no cell means no interactive chat, and the
// answer is a truthful refusal, never a fabricated start; a graph the engine
// would refuse is refused here, with nothing armed; a second call in one turn
// refuses; and a successful call changes exactly one thing, the shared cell the
// engine's dispatch reads.

import { handleRunRoutineNow } from '../run-routine-now-handler';
import { readRunNowIntent } from '../run-now-intent';
import type { StandardToolContext } from '../standard-tool-handler';

const TENANT = '00000000-0000-0000-0000-0000000000aa';
const AGENT = '00000000-0000-0000-0000-0000000000bb';

function ctx(overrides: Partial<StandardToolContext> = {}): StandardToolContext {
  return {
    tenantId: TENANT,
    agentId: AGENT,
    memoryScope: {},
    ...overrides,
  };
}

it('refuses truthfully when there is no cell (autonomous run, or no workflow)', async () => {
  const res = await handleRunRoutineNow(ctx());
  expect(res.success).toBe(false);
  expect(res.error).toContain('Nothing was started');
});

it('flips the shared cell exactly once and tells the model what to say', async () => {
  const cell = { requested: false };
  const res = await handleRunRoutineNow(ctx({ workflowRunRef: cell }));
  expect(res.success).toBe(true);
  expect(cell.requested).toBe(true);
  expect(JSON.stringify(res.result)).toContain('progress will post in this conversation');
});

it('a second call in the same turn refuses instead of double-starting', async () => {
  const cell = { requested: false };
  await handleRunRoutineNow(ctx({ workflowRunRef: cell }));
  const second = await handleRunRoutineNow(ctx({ workflowRunRef: cell }));
  expect(second.success).toBe(false);
  expect(second.error).toContain('already starting');
  expect(cell.requested).toBe(true);
});

describe('a graph the engine would refuse', () => {
  it('blocks the tool before `requested` is set, and promises nothing', async () => {
    // The failure this exists for: the tool returning `started: true` for a
    // graph validation refuses one second later, with a result telling the
    // model to announce the start. Nothing may be armed and nothing may be promised.
    const cell = {
      requested: false,
      preflight: jest.fn().mockResolvedValue({
        ok: false,
        blockedReason:
          'Workflow graph validation failed: [NESTED_LOOP] Step "s15" has a loop inside the body of loop step "s14".',
      }),
    };
    const res = await handleRunRoutineNow(ctx({ workflowRunRef: cell }));
    expect(res.success).toBe(false);
    expect(cell.requested).toBe(false);
    expect(res.error).toContain('nothing was started');
    expect(res.error).not.toContain('starting now');
    // The blocking sentence is the engine's own and names its mechanism; the
    // person never sees it. INV-PB-015: no identifier, no code, no step id.
    expect(res.error).not.toContain('NESTED_LOOP');
    expect(res.error).not.toContain('s15');
  });

  it('is asked BEFORE the second-call refusal, so a refusal never arms the cell', async () => {
    const preflight = jest.fn().mockResolvedValue({ ok: false, blockedReason: 'nope' });
    const cell = { requested: false, preflight };
    await handleRunRoutineNow(ctx({ workflowRunRef: cell }));
    await handleRunRoutineNow(ctx({ workflowRunRef: cell }));
    // Both calls refused on the graph, not the second on "already starting":
    // a first call that armed nothing must not block the second.
    expect(cell.requested).toBe(false);
    expect(preflight).toHaveBeenCalledTimes(2);
  });

  it('arms the cell when the preflight passes', async () => {
    const cell = { requested: false, preflight: jest.fn().mockResolvedValue({ ok: true }) };
    const res = await handleRunRoutineNow(ctx({ workflowRunRef: cell }));
    expect(res.success).toBe(true);
    expect(cell.requested).toBe(true);
  });

  it('keeps the existing behaviour for a cell with no preflight installed', async () => {
    const cell = { requested: false };
    const res = await handleRunRoutineNow(ctx({ workflowRunRef: cell }));
    expect(res.success).toBe(true);
    expect(cell.requested).toBe(true);
  });
});

// WHAT THE PERSON ACTUALLY ASKED FOR.
//
// For example: a sweep has just produced a battle card. The person writes "so
// where is my report". The model searches, finds the battle card, and calls this
// tool in the same turn. Without the check it arms a second sweep and returns the
// fresh-start note, so the reply is the same canned line as the original request
// and the document the turn is holding a link to goes unmentioned.
//
// The tool cannot know a run already happened: it sees the preflight and nothing
// else. What it can be given is the message.
describe('a run is armed only when the person asked for one', () => {
  it('refuses "so where is my report", and arms nothing', async () => {
    const cell = { requested: false, personMessage: 'so where is my report' };
    const res = await handleRunRoutineNow(ctx({ workflowRunRef: cell }));
    expect(res.success).toBe(false);
    expect(cell.requested).toBe(false);
    // And says what to do instead: answer from what this turn already holds.
    expect(res.error).toContain('asks about work, not for a new run');
    expect(res.error).toContain('naming each document or message and where it is');
    // Never the fresh-start note, which is the sentence that made the reply wrong.
    expect(res.error).not.toContain('about to begin');
  });

  it('arms on an explicit ask, and keeps the fresh-start note there', async () => {
    const cell = { requested: false, personMessage: 'run the competitor sweep now please' };
    const res = await handleRunRoutineNow(ctx({ workflowRunRef: cell }));
    expect(res.success).toBe(true);
    expect(cell.requested).toBe(true);
    expect(JSON.stringify(res.result)).toContain('Do not describe any work as done.');
  });

  it('refuses a message that asks for neither, rather than guessing', async () => {
    // Fail closed. A sweep nobody asked for costs a person a wrong answer and
    // the workspace a whole run; declining one they did ask for costs a sentence.
    const cell = { requested: false, personMessage: 'thanks, that looks good' };
    const res = await handleRunRoutineNow(ctx({ workflowRunRef: cell }));
    expect(res.success).toBe(false);
    expect(cell.requested).toBe(false);
    expect(res.error).toContain('does not ask for the routine to run now');
  });

  it('is asked BEFORE the second-call refusal, so a refusal never arms the cell', async () => {
    const cell = { requested: false, personMessage: 'where is the digest' };
    await handleRunRoutineNow(ctx({ workflowRunRef: cell }));
    const second = await handleRunRoutineNow(ctx({ workflowRunRef: cell }));
    expect(second.error).toContain('asks about work');
    expect(cell.requested).toBe(false);
  });

  it('is asked AFTER the preflight, so an unrunnable graph still reports itself', async () => {
    // The two refusals are not interchangeable: "this routine cannot run as
    // configured" is a fact about the team the person needs, and "you did not ask
    // for a run" is not a substitute for it.
    const cell = {
      requested: false,
      personMessage: 'run it now',
      preflight: jest.fn().mockResolvedValue({ ok: false, blockedReason: 'nope' }),
    };
    const res = await handleRunRoutineNow(ctx({ workflowRunRef: cell }));
    expect(res.error).toContain('cannot run as it is currently configured');
    expect(cell.requested).toBe(false);
  });

  it('keeps the previous behaviour for a cell that carries no message', async () => {
    // A caller that predates the field keeps the tool rather than losing it.
    const cell = { requested: false };
    const res = await handleRunRoutineNow(ctx({ workflowRunRef: cell }));
    expect(res.success).toBe(true);
    expect(cell.requested).toBe(true);
  });

  it('refuses an empty message', async () => {
    const cell = { requested: false, personMessage: '   ' };
    const res = await handleRunRoutineNow(ctx({ workflowRunRef: cell }));
    expect(res.success).toBe(false);
    expect(cell.requested).toBe(false);
  });
});

describe('readRunNowIntent', () => {
  it.each([
    'so where is my report',
    'where is the digest?',
    'did you run the sweep',
    'have you finished the cards',
    'is it done yet',
    'any update on the report',
    'what happened to the digest',
    'status?',
    "how's it going",
    'I never received the report',
  ])('reads %p as a question about work', (m) => {
    expect(readRunNowIntent(m)).toBe('asks_about_work');
  });

  it.each([
    'run it now',
    'please run the competitor sweep',
    'can you run this again',
    'start the sweep',
    'kick it off',
    'kickoff the routine',
    'go ahead',
    'trigger the weekly sweep',
    're-run it',
    'what I want is for you to run the sweep now',
  ])('reads %p as an ask for a run', (m) => {
    expect(readRunNowIntent(m)).toBe('start');
  });

  it.each([
    '',
    '   ',
    'thanks',
    'who are our competitors',
    'add Corvid Route to the watch list',
  ])('reads %p as unclear, which arms nothing', (m) => {
    expect(readRunNowIntent(m)).toBe('unclear');
  });

  it('puts the question first, because one word separates the two', () => {
    // "did you run it" and "run it" both contain the run verb and mean opposite
    // things, so the question has to be recognised before the verb is.
    expect(readRunNowIntent('did you run it')).toBe('asks_about_work');
    expect(readRunNowIntent('run it')).toBe('start');
  });
});
