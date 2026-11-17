// Starting work without waiting for it.
//
// An agent can be handed a background objective; the three platform
// assistants could not — they are conversational surfaces with no task
// queue, so anything slow happened inside the turn, and a turn is the person
// waiting.
//
// It rides the CONTINUATION rails rather than a mechanism of its own
// (migration 550). The first version of this ran the child in-process: it
// died with the instance, and a later turn on another instance would have
// waited forever. What is pinned here is that starting it is a durable row
// and a queued task, in that order, and that nothing is collected — the
// answer arrives on its own.

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const enqueueBackgroundWork = jest.fn();
jest.mock('../../chat-continuations/store', () => ({
  enqueueBackgroundWork: (...a: unknown[]) => enqueueBackgroundWork(...(a as [])),
}));
const enqueueContinuationTask = jest.fn();
jest.mock('../../chat-continuations/dispatch', () => ({
  enqueueContinuationTask: (...a: unknown[]) => enqueueContinuationTask(...(a as [])),
}));

import {
  backgroundWorkTools, isBackgroundWorkTool, runBackgroundWorkTool, START_BACKGROUND_WORK_TOOL,
} from '../assistant-tools';

const ctx = {
  tenantId: 't-1',
  threadId: 'thread-1',
  surface: 'liftoff' as const,
  accountId: 'acc-1',
  originMessageId: 'msg-1',
};

beforeEach(() => {
  jest.clearAllMocks();
  enqueueBackgroundWork.mockResolvedValue({ id: 'row-1' });
  enqueueContinuationTask.mockResolvedValue(undefined);
});

describe('the tool', () => {
  // One tool, not two. There is nothing to collect: the answer is posted
  // into the conversation when the work is done.
  it('offers starting and nothing else', () => {
    expect(backgroundWorkTools.map((t) => t.name)).toEqual([START_BACKGROUND_WORK_TOOL]);
    expect(isBackgroundWorkTool(START_BACKGROUND_WORK_TOOL)).toBe(true);
    expect(isBackgroundWorkTool('run_capability')).toBe(false);
  });

  it('tells the model not to wait for it and not to do the job itself', () => {
    const start = backgroundWorkTools[0];
    expect(start.description).toMatch(/do NOT collect the result/);
    expect(start.description).toMatch(/posted\s+into this conversation on its own/);
  });

  // The brief crosses into a turn that does not see this conversation as it
  // is now, and one that assumes it does is a job half-briefed.
  it('tells the model the brief has to stand on its own', () => {
    expect(backgroundWorkTools[0].description).toMatch(/stand on its own/);
    expect(backgroundWorkTools[0].description).toMatch(/what finished looks like/);
  });

  it('points at an agent first, when one does this kind of work', () => {
    expect(backgroundWorkTools[0].description).toMatch(/bring that team in instead/);
  });
});

describe('starting it', () => {
  // The row first, the task second: a row with no task is picked up by
  // nothing and is visible as queued, where a task with no row would run
  // against nothing at all.
  it('writes the durable row, then queues the task for it', async () => {
    const out = await runBackgroundWorkTool({ brief: 'read all three reports' }, ctx);
    expect(enqueueBackgroundWork).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 't-1', surface: 'liftoff', threadId: 'thread-1', accountId: 'acc-1',
      originMessageId: 'msg-1', brief: 'read all three reports',
    }));
    expect(enqueueContinuationTask).toHaveBeenCalledWith('row-1', 't-1');
    expect(out).toMatch(/Set going/);
    expect(out).toMatch(/do not wait for it/);
  });

  it('needs the job in words', async () => {
    expect(await runBackgroundWorkTool({ brief: '  ' }, ctx)).toMatch(/whole job in words/);
    expect(enqueueBackgroundWork).not.toHaveBeenCalled();
  });

  // The row hangs off the person's own message. A turn with none is not one
  // that can set work going on their behalf.
  it('will not start work with nothing of the person\'s to hang it off', async () => {
    const out = await runBackgroundWorkTool({ brief: 'x' }, { ...ctx, originMessageId: '' });
    expect(out).toMatch(/only be started from something the person asked for/);
    expect(enqueueBackgroundWork).not.toHaveBeenCalled();
  });

  it('never fabricates a start when the row cannot be written', async () => {
    enqueueBackgroundWork.mockRejectedValue(new Error('database away'));
    const out = await runBackgroundWorkTool({ brief: 'x' }, ctx);
    expect(out).toMatch(/could not be set going/);
    expect(out).not.toMatch(/Set going/);
  });

  it('never fabricates a start when the task cannot be queued', async () => {
    enqueueContinuationTask.mockRejectedValue(new Error('queue away'));
    const out = await runBackgroundWorkTool({ brief: 'x' }, ctx);
    expect(out).toMatch(/could not be set going/);
  });
});
