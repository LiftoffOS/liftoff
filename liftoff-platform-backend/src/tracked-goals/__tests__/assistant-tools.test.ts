// Holding onto a goal.
//
// The thing that makes a goal a goal rather than a row in a table is that it
// is read back into the assistant's context on EVERY turn. Storing one
// without that injection would be a table nobody reads, which is this
// estate's most common defect by a distance — so the section is pinned here
// as hard as the writes are.
//
// The other property worth pinning is what a goal is NOT. It runs nothing
// and schedules nothing, and a model told it is "tracking" something will
// otherwise tell the person it is working on it.

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const listGoals = jest.fn();
const createGoal = jest.fn();
const completeGoal = jest.fn();
const countActiveGoals = jest.fn();
jest.mock('../repository', () => ({
  listGoals: (...a: unknown[]) => listGoals(...(a as [])),
  createGoal: (...a: unknown[]) => createGoal(...(a as [])),
  completeGoal: (...a: unknown[]) => completeGoal(...(a as [])),
  countActiveGoals: (...a: unknown[]) => countActiveGoals(...(a as [])),
  MAX_ACTIVE_GOALS: 25,
}));

import {
  goalsSection, isTrackedGoalTool, runTrackedGoalTool, trackedGoalTools,
  GOAL_TRACK_TOOL, GOAL_FINISH_TOOL,
} from '../assistant-tools';

const ctx = { tenantId: 't-1', accountId: 'acc-1' };

beforeEach(() => {
  jest.clearAllMocks();
  countActiveGoals.mockResolvedValue(0);
  listGoals.mockResolvedValue([]);
});

describe('the tools', () => {
  it('offers holding one and finishing one, and nothing else', () => {
    expect(trackedGoalTools.map((t) => t.name)).toEqual([GOAL_TRACK_TOOL, GOAL_FINISH_TOOL]);
    expect(isTrackedGoalTool(GOAL_TRACK_TOOL)).toBe(true);
    expect(isTrackedGoalTool('run_capability')).toBe(false);
  });

  // A model told it is "tracking" something will tell the person it is
  // working on it unless the description says otherwise in as many words.
  it('says plainly that holding a goal does no work', () => {
    const track = trackedGoalTools.find((t) => t.name === GOAL_TRACK_TOOL)!;
    expect(track.description).toMatch(/THIS DOES NO WORK/);
    expect(track.description).toMatch(/agent on a schedule/);
  });

  it('holds a goal for the person who asked, and says what happens next', async () => {
    createGoal.mockResolvedValue({ id: 'g-1', title: 'Cut cloud spend by a fifth' });
    const out = await runTrackedGoalTool(GOAL_TRACK_TOOL, { title: 'Cut cloud spend by a fifth' }, ctx);
    expect(createGoal).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't-1', accountId: 'acc-1' }));
    expect(out).toMatch(/Held onto/);
    expect(out).toMatch(/Nothing runs because of it/);
  });

  it('needs something to hold', async () => {
    expect(await runTrackedGoalTool(GOAL_TRACK_TOOL, { title: '   ' }, ctx)).toMatch(/one short line/);
    expect(createGoal).not.toHaveBeenCalled();
  });

  // A goal filed under nobody is one nobody can be asked about or close.
  it('refuses to file a goal under nobody', async () => {
    const out = await runTrackedGoalTool(GOAL_TRACK_TOOL, { title: 'x' }, { tenantId: 't-1' });
    expect(out).toMatch(/only be held for a person/);
    expect(createGoal).not.toHaveBeenCalled();
  });

  // Every one of these is read into the context on every turn, so an
  // unbounded pile of them quietly spends the person's whole context and
  // looks like the assistant getting worse at everything else.
  it('stops at a number of open goals that is still useful to carry', async () => {
    countActiveGoals.mockResolvedValue(25);
    const out = await runTrackedGoalTool(GOAL_TRACK_TOOL, { title: 'one more' }, ctx);
    expect(out).toMatch(/already has 25 goals/);
    expect(createGoal).not.toHaveBeenCalled();
  });

  it('finishes one, and says it will not be read back again', async () => {
    completeGoal.mockResolvedValue({ id: 'g-1', title: 'Cut cloud spend by a fifth' });
    const out = await runTrackedGoalTool(GOAL_FINISH_TOOL, { goal_id: 'g-1' }, ctx);
    expect(completeGoal).toHaveBeenCalledWith('t-1', 'acc-1', 'g-1');
    expect(out).toMatch(/Finished/);
  });

  it('says so when there is no such goal of theirs still open', async () => {
    completeGoal.mockResolvedValue(null);
    expect(await runTrackedGoalTool(GOAL_FINISH_TOOL, { goal_id: 'g-9' }, ctx)).toMatch(/already be finished/);
  });

  it('never fabricates a success when the store fails', async () => {
    createGoal.mockRejectedValue(new Error('database away'));
    const out = await runTrackedGoalTool(GOAL_TRACK_TOOL, { title: 'x' }, ctx);
    expect(out).toMatch(/could not be done/);
    expect(out).not.toMatch(/Held onto/);
  });
});

describe('what the assistant is told every turn', () => {
  it('reads the goals back with their ids, so one can be finished', async () => {
    listGoals.mockResolvedValue([
      { id: 'g-1', title: 'Cut cloud spend by a fifth', description: 'by the end of the quarter' },
      { id: 'g-2', title: 'Hire a second reviewer', description: '' },
    ]);
    const section = await goalsSection('t-1', 'acc-1');
    expect(section).toContain('Cut cloud spend by a fifth: by the end of the quarter');
    expect(section).toContain('id g-1');
    expect(section).toContain('Hire a second reviewer');
    expect(section).toContain(GOAL_FINISH_TOOL);
  });

  // The same claim the tool makes, where the model will actually read it.
  it('says the goals are what is remembered, not work in progress', async () => {
    listGoals.mockResolvedValue([{ id: 'g-1', title: 'x', description: '' }]);
    expect(await goalsSection('t-1', 'acc-1')).toMatch(/Nothing runs because one of these exists/);
  });

  it('is empty for a person with none, so no turn carries a section about nothing', async () => {
    expect(await goalsSection('t-1', 'acc-1')).toBe('');
  });

  it('is empty when there is no person to have goals', async () => {
    expect(await goalsSection('t-1', undefined)).toBe('');
    expect(listGoals).not.toHaveBeenCalled();
  });

  // A turn never fails over its goals.
  it('is empty when the store cannot be read, rather than failing the turn', async () => {
    listGoals.mockRejectedValue(new Error('database away'));
    expect(await goalsSection('t-1', 'acc-1')).toBe('');
  });
});
