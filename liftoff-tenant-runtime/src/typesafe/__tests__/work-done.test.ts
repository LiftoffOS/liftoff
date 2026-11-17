// A step saying it finished is not evidence that it finished.
//
// The checks around this one are structural: a declared output field is
// present or it is not. Neither can disagree with a step that described the
// work convincingly and did not do it, and the usual remedy — a second large
// model grading the first — doubles every step's latency to buy an opinion
// from the same kind of thing that just gave one.
//
// What is pinned here is mostly what happens when the check CANNOT answer.
// No opinion must read as "the step stands": failing closed would turn a
// vendor outage into a runtime that cannot finish a step, which is worse
// than the defect being guarded against.

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockAsk = jest.fn();
jest.mock('../client', () => ({ ask: (...a: unknown[]) => mockAsk(...a) }));

import { checkWorkDone, WORK_DONE_TIMEOUT_MS } from '../work-done';
import { WORK_DONE_CHECK_SET } from '../questions';

const input = {
  objective: 'Send the weekly summary to the finance mailbox',
  said: 'I have sent the weekly summary to finance.',
  did: ['gmail__send_email'],
  tenantId: 't-1',
  deadlineMs: WORK_DONE_TIMEOUT_MS,
};

const answered = (noul: number) => mockAsk.mockResolvedValueOnce({ answers: { work_done: { noul } } });

beforeEach(() => jest.clearAllMocks());

describe('the work a step claims to have done', () => {
  it('passes a step whose evidence shows the work', async () => {
    answered(0.9);
    expect(await checkWorkDone(input)).toEqual({ done: true, probability: 0.9 });
  });

  it('fails a step that described the work and did not do it', async () => {
    answered(0.1);
    const verdict = await checkWorkDone({ ...input, did: [], said: 'I will send the weekly summary to finance.' });
    expect(verdict).toEqual({ done: false, probability: 0.1 });
  });

  it('reads the threshold from the set rather than a number of its own', async () => {
    const t = WORK_DONE_CHECK_SET.thresholds.DONE_T as number;
    answered(t);
    expect((await checkWorkDone(input))?.done).toBe(true);
    answered(t - 0.01);
    expect((await checkWorkDone(input))?.done).toBe(false);
  });

  it('has no opinion when the vendor did not answer, and the step stands', async () => {
    mockAsk.mockResolvedValueOnce(null);
    expect(await checkWorkDone(input)).toBeNull();
  });

  it('has no opinion on an answer that is not a number', async () => {
    mockAsk.mockResolvedValueOnce({ answers: { work_done: { noul: 'yes' } } });
    expect(await checkWorkDone(input)).toBeNull();
  });

  it('has no opinion when the step has no objective to be judged against', async () => {
    expect(await checkWorkDone({ ...input, objective: '   ' })).toBeNull();
    expect(mockAsk).not.toHaveBeenCalled();
  });

  // The question is what was done, not with what: an argument carries a
  // person's data and has no business in this request.
  it('sends the tools by name and never their arguments', async () => {
    answered(0.9);
    await checkWorkDone({ ...input, did: ['gmail__send_email', 'sheets__append_row'] });
    const sent = JSON.stringify(mockAsk.mock.calls[0]);
    expect(sent).toContain('gmail__send_email');
    expect(sent).toContain('sheets__append_row');
    expect(sent).not.toContain('finance@');
  });

  it('bounds a step that called a great many tools', async () => {
    answered(0.9);
    const many = Array.from({ length: 200 }, (_, i) => `tool_${i}`);
    await checkWorkDone({ ...input, did: many });
    const sent = JSON.stringify(mockAsk.mock.calls[0]);
    expect(sent).not.toContain('tool_0"');
    expect(sent).toContain('tool_199');
  });

  it('carries the workspace, the team and the task for the record and the ledger', async () => {
    answered(0.9);
    await checkWorkDone({ ...input, runtimeAgentId: 'agent-1', invocationId: 'inv-1' });
    expect(mockAsk.mock.calls[0][2]).toMatchObject({
      tenantId: 't-1', runtimeAgentId: 'agent-1', invocationId: 'inv-1', deadlineMs: WORK_DONE_TIMEOUT_MS,
    });
  });
});
